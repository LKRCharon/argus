import Darwin
import Foundation

// Tiny standalone Mach-O binary installed into ~/.claude/settings.json and
// ~/.codex/config.toml as a PreToolUse/PostToolUse hook.
//
// Usage: argus-hook <source>
//
// Two parallel channels (ADR-0006 §G + §L):
//   1) Privileged XPC ping → Argus helper daemon → Darwin notify fanout.
//   2) `touch <tmp>/argus_working_pids/<source>-<ppid>` for sandboxed cases
//      where Darwin notify is unavailable. AgentDetector polls + sweeps stale.
//
// Bounded by a 200ms XPC timeout — we never block tool execution waiting on
// the daemon. PID-file write is local and synchronous (<1ms).
//
// No AppKit. Foundation only.

let argv = CommandLine.arguments
guard argv.count >= 2 else {
    FileHandle.standardError.write(Data("usage: argus-hook <source>\n".utf8))
    exit(2)
}
let rawSource = argv[1]
let source = HelperServiceName.sanitizeActivitySource(rawSource)
guard !source.isEmpty else {
    FileHandle.standardError.write(Data("argus-hook: empty source after sanitize\n".utf8))
    exit(3)
}

// ---- Channel 2: PID-file IPC fallback (ADR-0006 §L) --------------------------
// Touch a tiny file in a per-user temp dir so AgentDetector can see us even
// when Darwin notify is blocked (sandbox, container). Filename format:
//   <source>-<ppid>
// The ppid is the agent (Claude/Codex) that invoked us; AgentDetector sweeps
// entries whose pid is no longer live or whose mtime is older than the TTL.
//
// Moved from `/tmp` (world-writable, shared
// across uids) to `NSTemporaryDirectory()/argus_working_pids` (per-user,
// sticky-bit-safe by construction). Filename format unchanged so the contract
// with `AgentDetector.scanPIDFiles` is single-source.
do {
    let base = NSTemporaryDirectory()
    let trimmed = base.hasSuffix("/") ? String(base.dropLast()) : base
    let dir = trimmed + "/argus_working_pids"
    let fm = FileManager.default
    if !fm.fileExists(atPath: dir) {
        // mkdir -p; per-user dir so mode 0o700 is enough — but keep best-effort.
        try? fm.createDirectory(atPath: dir, withIntermediateDirectories: true,
                                attributes: [.posixPermissions: 0o700])
    }
    let ppid = getppid()
    let path = "\(dir)/\(source)-\(ppid)"
    // Atomic write so the mtime always advances even if file pre-existed.
    let url = URL(fileURLWithPath: path)
    try? Data().write(to: url, options: .atomic)
}

// ---- Channel 1: XPC ping → Darwin notify (preferred) ------------------------
let connection = NSXPCConnection(
    machServiceName: HelperServiceName.mach,
    options: .privileged)
connection.remoteObjectInterface = NSXPCInterface(with: ArgusHelperProtocol.self)
connection.resume()
defer { connection.invalidate() }

let sem = DispatchSemaphore(value: 0)
// Lock-guarded (shared LockedBox): reply/error handler land on XPC queues;
// after the 0.2s timeout below this thread reads while a late callback may
// still write. A plain `var` here was a data race.
let pingError = LockedBox<Error?>(nil)

let proxy = connection.remoteObjectProxyWithErrorHandler { err in
    pingError.set(err)
    sem.signal()
} as? ArgusHelperProtocol

guard let remote = proxy else {
    FileHandle.standardError.write(Data("argus-hook: no proxy\n".utf8))
    exit(0)  // PID-file path already fired; don't fail tool execution.
}

remote.pingActivity(source: source) { err in
    pingError.set(err)
    sem.signal()
}

// Bounded wait; if daemon is dead, we still exit 0 (best-effort hook).
_ = sem.wait(timeout: .now() + 0.2)
if let err = pingError.get() {
    FileHandle.standardError.write(Data("argus-hook: \(err.localizedDescription)\n".utf8))
}
exit(0)
