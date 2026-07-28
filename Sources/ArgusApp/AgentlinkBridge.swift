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
                self?.connectionState = "disconnected"
                self?.process = nil
                self?.onStateChange?()
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
            log.info("daemon started (pid \(p.processIdentifier))")
            onStateChange?()
        } catch {
            log.error("failed to start daemon: \(error.localizedDescription, privacy: .public)")
            lastError = "Failed to start: \(error.localizedDescription)"
            onStateChange?()
        }
    }

    /// Stop the daemon process.
    func stop() {
        guard let p = process, p.isRunning else { return }
        p.terminate()
        // Give it 2s to clean up, then SIGKILL
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) { [weak self] in
            if p.isRunning { kill(p.processIdentifier, SIGKILL) }
            DispatchQueue.main.async { self?.process = nil }
        }
        connectionState = "disconnected"
        onStateChange?()
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
