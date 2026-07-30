import Foundation
import OSLog

/// Manages the agentlink daemon subprocess.
/// Spawns `bun run daemon watch`, parses structured stdout JSON lines,
/// and publishes state changes via callback.
final class AgentlinkBridge {
    private let log = Logger(subsystem: "com.kairong.argus", category: "agentlink")
    private var process: Process?
    private var stdoutPipe: Pipe?
    private var relayURL: String = ""
    private var watchdogTimer: DispatchSourceTimer?

    /// Current connection state, updated from daemon stdout.
    private(set) var connectionState: String = "disconnected"
    /// Number of active agent sessions.
    private(set) var sessionCount: Int = 0
    /// Last error message from daemon.
    private(set) var lastError: String?
    /// Hook server port (from daemon output).
    private(set) var hookPort: Int = 9876
    /// Hook server secret (from daemon output).
    private(set) var hookSecret: String = ""

    /// Called on main thread whenever state changes.
    var onStateChange: (() -> Void)?

    /// Whether the daemon is currently running.
    var isRunning: Bool { process?.isRunning ?? false }

    /// Persisted "user wants sync on" flag — the daemon is restarted at launch
    /// when this is set, so the Qoder approval hook always has a listener.
    private static let autoStartKey = "AgentlinkAutoStart"
    static var autoStartEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: autoStartKey) }
        set { UserDefaults.standard.set(newValue, forKey: autoStartKey) }
    }

    /// True once the user asked for sync and until they stop it; drives the
    /// crash-restart watchdog (a daemon that dies on its own comes back).
    private var wantRunning = false
    /// Backoff for repeated crash restarts, so a permanently broken setup does
    /// not spawn a process every second.
    private var restartDelay: TimeInterval = 2

    init() {
        // No baked-in relay: an unconfigured install must refuse to start rather
        // than dial someone else's server. Settings -> Remote Sync fills this in.
        relayURL = UserDefaults.standard.string(forKey: "AgentlinkRelayURL") ?? ""
    }

    func setRelayURL(_ url: String) {
        relayURL = url
        UserDefaults.standard.set(url, forKey: "AgentlinkRelayURL")
    }

    func getRelayURL() -> String { relayURL }

    /// Where the agentlink source lives. Resolution order:
    /// 1. UserDefaults override (legacy Settings > Remote Sync > Choose)
    /// 2. `agentlink/` next to the source checkout (monorepo layout)
    /// 3. `Contents/Resources/agentlink/` inside the app bundle
    /// Empty string only if none of the above exist.
    static func projectDir() -> String {
        // Manual override (for development or non-standard layouts)
        if let manual = UserDefaults.standard.string(forKey: "AgentlinkProjectDir"),
           !manual.isEmpty {
            return (manual as NSString).expandingTildeInPath
        }
        // Monorepo: app lives at <repo>/build/Argus.app or /Applications/Argus.app
        // built from <repo>; the source checkout has agentlink/ at the repo root.
        if let exec = Bundle.main.executablePath {
            // <repo>/build/Argus.app/Contents/MacOS/Argus -> <repo>/agentlink
            let repo = ((((exec as NSString)
                .deletingLastPathComponent as NSString)  // MacOS
                .deletingLastPathComponent as NSString)  // Contents
                .deletingLastPathComponent as NSString)  // Argus.app
                .deletingLastPathComponent              // build
            let candidate = repo + "/agentlink"
            if FileManager.default.fileExists(atPath: candidate + "/packages/daemon/src/index.ts") {
                return candidate
            }
        }
        return ""
    }

    static func bunPath() -> String? {
        // GUI apps launched from Finder don't inherit the shell PATH, so a bare
        // "bun" (or a wrong single default) never resolves — probe the usual
        // install locations and take the first executable found.
        var candidates: [String] = []
        if let override = UserDefaults.standard.string(forKey: "AgentlinkBunPath") {
            candidates.append((override as NSString).expandingTildeInPath)
        }
        candidates += [
            NSHomeDirectory() + "/.bun/bin/bun",
            "/opt/homebrew/bin/bun",
            "/usr/local/bin/bun",
        ]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    /// The daemon entry point inside the project checkout.
    static func daemonEntry() -> String {
        projectDir() + "/packages/daemon/src/index.ts"
    }

    /// `nil` when everything needed to spawn the daemon is in place; otherwise
    /// a user-facing reason with the fix path spelled out. Checked before every
    /// spawn (watch and one-shot pair alike) so failures explain themselves
    /// instead of surfacing as a bare NSCocoaErrorDomain message.
    ///
    /// Neither the relay URL nor the project folder ships with a default, so
    /// both are checked here first — an empty relay would otherwise reach the
    /// daemon as `AGENTLINK_RELAY=`, which fails much later and far less
    /// legibly.
    static func preflightError(relayURL: String) -> String? {
        if relayURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return NSL("sync.err.relayMissing",
                       "Relay URL is not configured. Enter your relay's wss:// address above.")
        }
        if bunPath() == nil {
            return NSL("sync.err.bunMissing",
                       "Bun runtime not found. Install it (brew install oven-sh/bun/bun) or place it at ~/.bun/bin/bun.")
        }
        if projectDir().isEmpty || !FileManager.default.fileExists(atPath: daemonEntry()) {
            return NSLf("sync.err.projectMissing",
                        "agentlink not found (checked %@). Clone the repo so agentlink/ sits next to the build/ folder, or set the path manually in Settings.",
                        projectDir().isEmpty ? "<no path>" : projectDir())
        }
        return nil
    }

    /// Builds (but does not launch) a daemon invocation. Shared by `start()` and
    /// the Sync pane's one-shot `pair` run.
    static func makeDaemonProcess(arguments: [String], relayURL: String) -> Process {
        let p = Process()
        p.launchPath = bunPath() ?? NSHomeDirectory() + "/.bun/bin/bun"
        p.arguments = ["run", "packages/daemon/src/index.ts"] + arguments
        p.currentDirectoryPath = projectDir()
        var env = ProcessInfo.processInfo.environment
        env["AGENTLINK_RELAY"] = relayURL
        p.environment = env
        return p
    }

    /// Start the daemon watch process.
    func start() {
        guard !isRunning else { return }
        if let err = AgentlinkBridge.preflightError(relayURL: relayURL) {
            lastError = err
            onStateChange?()
            return
        }
        wantRunning = true
        AgentlinkBridge.autoStartEnabled = true
        let p = AgentlinkBridge.makeDaemonProcess(arguments: ["watch"], relayURL: relayURL)

        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe // capture stderr too for debugging

        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            for line in text.split(separator: "\n") {
                let trimmed = String(line).trimmingCharacters(in: .whitespaces)
                if trimmed.isEmpty { continue }
                if let output = AgentlinkDaemonOutput.parse(trimmed) {
                    self?.handleStructuredOutput(output)
                } else {
                    self?.log.info("daemon: \(trimmed, privacy: .public)")
                }
            }
        }

        p.terminationHandler = { [weak self] proc in
            self?.log.notice("daemon exited (code \(proc.terminationStatus))")
            DispatchQueue.main.async {
                guard let self = self else { return }
                // Identity check: on a quick stop->start the old process exits
                // *after* the new one is stored, and clearing unconditionally
                // orphaned the new daemon and then spawned a third.
                guard proc === self.process else {
                    self.log.info("ignoring exit of a superseded daemon")
                    return
                }
                self.connectionState = "disconnected"
                self.process = nil
                self.onStateChange?()
                // The daemon exits on relay drop by design, and the Qoder
                // approval hook needs a listener on 9876 whenever the IDE is
                // up — bring it back unless the user asked for it to stop.
                if self.wantRunning { self.scheduleRestart() }
            }
        }

        do {
            try p.run()
            process = p
            stdoutPipe = pipe
            connectionState = "connecting"
            // A successful start invalidates whatever failed before — without
            // this the old message stayed on screen forever.
            lastError = nil
            restartDelay = 2
            log.info("daemon started (pid \(p.processIdentifier))")
            onStateChange?()
        } catch {
            log.error("failed to start daemon: \(error.localizedDescription, privacy: .public)")
            lastError = "Failed to start: \(error.localizedDescription)"
            onStateChange?()
            if wantRunning { scheduleRestart() }
        }
    }

    /// Restart after a growing delay (2s → 60s cap). Cancels any pending one.
    private func scheduleRestart() {
        watchdogTimer?.cancel()
        let delay = restartDelay
        restartDelay = min(restartDelay * 2, 60)
        log.notice("daemon restart scheduled in \(delay, privacy: .public)s")
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + delay)
        timer.setEventHandler { [weak self] in
            guard let self = self, self.wantRunning, !self.isRunning else { return }
            self.start()
        }
        timer.resume()
        watchdogTimer = timer
    }

    /// Launch-time restore: bring the daemon back when the user had sync on.
    /// Called from AppDelegate so the approval hook is never left unanswered.
    func startIfPreviouslyRunning() {
        guard AgentlinkBridge.autoStartEnabled, !isRunning else { return }
        guard AgentlinkBridge.preflightError(relayURL: relayURL) == nil else {
            log.notice("auto-start skipped: agentlink prerequisites missing")
            return
        }
        log.info("auto-starting agentlink daemon (was running last session)")
        start()
    }

    /// Stop the daemon process.
    func stop() {
        // Explicit stop: no restart, and no auto-start next launch.
        wantRunning = false
        AgentlinkBridge.autoStartEnabled = false
        watchdogTimer?.cancel()
        watchdogTimer = nil
        guard let p = process, p.isRunning else {
            connectionState = "disconnected"
            onStateChange?()
            return
        }
        let dying = p
        p.terminate()
        // Give it 2s to clean up, then SIGKILL
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) { [weak self] in
            if dying.isRunning { kill(dying.processIdentifier, SIGKILL) }
            DispatchQueue.main.async {
                // Same identity check as terminationHandler, and it needs its own:
                // this block does not go through that handler, so fixing one does
                // not fix the other. Restarting within 2s would otherwise have its
                // process reference wiped by this late cleanup.
                guard let self = self, dying === self.process else { return }
                self.process = nil
            }
        }
        connectionState = "disconnected"
        onStateChange?()
    }

    /// Quit-time teardown: kill the daemon without clearing the auto-start
    /// preference, so sync comes back on the next launch. An orphaned watch
    /// process would hold the relay channel slot and make the next one fail.
    func shutdownForQuit() {
        wantRunning = false
        watchdogTimer?.cancel()
        watchdogTimer = nil
        guard let p = process, p.isRunning else { return }
        p.terminate()
        // Brief synchronous wait: the process must be gone before we exit, or
        // it survives us and keeps the channel occupied.
        let deadline = Date().addingTimeInterval(1.0)
        while p.isRunning && Date() < deadline {
            usleep(50_000)
        }
        if p.isRunning { kill(p.processIdentifier, SIGKILL) }
        process = nil
    }

    /// Types a phone message into Qoder. Failures surface as `lastError` (the
    /// Sync pane shows it) instead of vanishing — a silent no-op here would look
    /// exactly like a delivered message. The injector runs on its own serial
    /// queue, so this returns straight away.
    private func injectIntoIDE(_ text: String, session: String) {
        guard QoderInjector.isQoderRunning else {
            log.notice("injection skipped: Qoder not running")
            let message = QoderInjector.Failure.notRunning.localizedDescription
            lastError = message
            reportInjection(session: session, ok: false, note: message)
            onStateChange?()
            return
        }
        QoderInjector.send(text) { [weak self] error in
            guard let self = self else { return }
            if let error = error {
                self.log.error("injection failed: \(error.localizedDescription, privacy: .public)")
                self.lastError = error.localizedDescription
                self.reportInjection(session: session, ok: false, note: error.localizedDescription)
            } else {
                self.lastError = nil
                self.reportInjection(session: session, ok: true, note: NSL("inject.ok", "Typed into Qoder"))
            }
            self.onStateChange?()
        }
    }

    /// Tell the daemon what actually happened, so it can correct the phone's
    /// provisional "typing…" acknowledgement. Without this a failed injection
    /// looked like a delivered message on the phone.
    private func reportInjection(session: String, ok: Bool, note: String) {
        guard !session.isEmpty, !hookSecret.isEmpty,
              let url = URL(string: "http://127.0.0.1:\(hookPort)/inject-result") else { return }
        let secret = hookSecret
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 3
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(secret, forHTTPHeaderField: "X-Agentlink-Secret")
        req.httpBody = try? JSONSerialization.data(withJSONObject: [
            "sessionId": session, "ok": ok, "note": note,
        ])
        URLSession.shared.dataTask(with: req).resume()
    }

    private func handleStructuredOutput(_ output: AgentlinkDaemonOutput) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            switch output.type {
            case "status":
                if let conn = output.connection { self.connectionState = conn }
                if let sess = output.sessions { self.sessionCount = sess }
            case "hook_server":
                if let port = output.port { self.hookPort = port }
                if let secret = output.secret { self.hookSecret = secret }
            case "error":
                self.lastError = output.message ?? "unknown error"
            case "user_input":
                // A phone message: type it into the IDE's current session rather
                // than letting it sit in the daemon's inbox. `qodercli --resume`
                // cannot reach IDE sessions (separate namespaces), so keystroke
                // injection is the only way into the conversation the user is
                // actually looking at.
                if let text = output.text, !text.isEmpty {
                    self.injectIntoIDE(text, session: output.session ?? "")
                }
            default:
                break
            }
            self.onStateChange?()
        }
    }
}
