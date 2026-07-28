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
        relayURL = UserDefaults.standard.string(forKey: "AgentlinkRelayURL") ?? "wss://relay.limen.codes/ws"
    }

    func setRelayURL(_ url: String) {
        relayURL = url
        UserDefaults.standard.set(url, forKey: "AgentlinkRelayURL")
    }

    func getRelayURL() -> String { relayURL }

    /// Where the agentlink monorepo lives, and which bun runs it. Overridable via
    /// defaults so the app is not pinned to one checkout.
    static func projectDir() -> String {
        let dir = UserDefaults.standard.string(forKey: "AgentlinkProjectDir")
            ?? "~/Documents/Qoder/2026-07-26/chat-1/agentlink"
        return (dir as NSString).expandingTildeInPath
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
    static func preflightError() -> String? {
        if bunPath() == nil {
            return NSL("sync.err.bunMissing",
                       "Bun runtime not found. Install it (brew install oven-sh/bun/bun) or place it at ~/.bun/bin/bun.")
        }
        if !FileManager.default.fileExists(atPath: daemonEntry()) {
            return NSLf("sync.err.projectMissing",
                        "agentlink project not found at %@ — pick its folder in the Local daemon section below.",
                        projectDir())
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
        if let err = AgentlinkBridge.preflightError() {
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
        guard AgentlinkBridge.preflightError() == nil else {
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
        p.terminate()
        // Give it 2s to clean up, then SIGKILL
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) { [weak self] in
            if p.isRunning { kill(p.processIdentifier, SIGKILL) }
            DispatchQueue.main.async { self?.process = nil }
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
            default:
                break
            }
            self.onStateChange?()
        }
    }
}
