import Foundation

/// Codex plan usage, read off disk.
///
/// There is no API and no cache file for this: the CLI records a `token_count`
/// event carrying a `rate_limits` block into its own rollout transcript after
/// each turn, so the freshest snapshot available locally is the newest such
/// event across recent rollouts. That makes this a *snapshot*, not a live
/// reading — the UI must show its age rather than imply it is current.
///
/// Verified against real transcripts (2026-07-30): `{"type":"event_msg",
/// "payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":18.0,
/// "window_minutes":10080,"resets_at":1785292016},"plan_type":"plus",…}}}`.
/// Every field inside `rate_limits` can be null — a session that never hit the
/// backend writes the block with nothing but `limit_id` filled in.
enum CodexQuota {

    /// One rate-limit window (Codex reports a primary and, on some plans, a
    /// secondary with a different period).
    struct Window {
        let usedPercent: Double
        let windowMinutes: Int
        let resetsAt: Date?
    }

    struct Snapshot {
        /// "plus" / "pro" / "free" — passed through verbatim, never mapped: the
        /// set of plan names is OpenAI's to change.
        let plan: String?
        let primary: Window
        let secondary: Window?
        /// Only meaningful when the account actually carries credits.
        let creditBalance: String?
        /// When Codex wrote the snapshot, not when we read it.
        let capturedAt: Date
    }

    enum State {
        /// No `~/.codex` at all — the card stays hidden.
        case noCodex
        /// Signed in with an API key: usage is billed per token and no plan
        /// quota exists, so there is nothing to show a percentage for.
        case apiKeyMode
        /// Codex is here but has not recorded a rate-limit snapshot yet.
        case noSnapshot
        case quota(Snapshot)
    }

    private static var home: String { NSHomeDirectory() }
    private static var codexDir: String { home + "/.codex" }

    /// Reads the freshest snapshot. Cheap enough to call on a timer: it opens at
    /// most `maxFiles` transcripts and reads only the tail of each.
    ///
    /// Bounded deliberately — this directory holds hundreds of files and
    /// hundreds of megabytes on a working machine, and reading all of it to
    /// render one progress bar would be indefensible (the same mistake cost
    /// agentlink ~100ms per session-list refresh).
    static func current(maxFiles: Int = 8, tailBytes: Int = 256 * 1024) -> State {
        let fm = FileManager.default
        guard fm.fileExists(atPath: codexDir) else { return .noCodex }
        if isApiKeyMode() { return .apiKeyMode }

        var best: Snapshot?
        for path in recentRollouts(limit: maxFiles) {
            guard let snap = newestSnapshot(inTailOf: path, tailBytes: tailBytes) else { continue }
            if best == nil || snap.capturedAt > best!.capturedAt { best = snap }
        }
        guard let snapshot = best else { return .noSnapshot }
        return .quota(snapshot)
    }

    /// `auth.json` holds `OPENAI_API_KEY` for key sign-in and a `tokens` object
    /// for ChatGPT sign-in. Only the latter has a plan behind it.
    private static func isApiKeyMode() -> Bool {
        guard let data = FileManager.default.contents(atPath: codexDir + "/auth.json"),
              let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { return false }
        let hasTokens = (root["tokens"] as? [String: Any])?.isEmpty == false
        let hasKey = (root["OPENAI_API_KEY"] as? String)?.isEmpty == false
        return hasKey && !hasTokens
    }

    /// Newest rollout transcripts by modification time.
    ///
    /// Walks `sessions/YYYY/MM/DD` newest-first and stops as soon as `limit`
    /// files are in hand, so an archive going back months is never enumerated.
    private static func recentRollouts(limit: Int) -> [String] {
        let fm = FileManager.default
        let root = codexDir + "/sessions"
        var files: [String] = []

        func sortedChildren(_ dir: String) -> [String] {
            ((try? fm.contentsOfDirectory(atPath: dir)) ?? [])
                .filter { !$0.hasPrefix(".") }
                .sorted(by: >)
        }

        outer: for year in sortedChildren(root) {
            for month in sortedChildren("\(root)/\(year)") {
                for day in sortedChildren("\(root)/\(year)/\(month)") {
                    let dayDir = "\(root)/\(year)/\(month)/\(day)"
                    let rollouts = ((try? fm.contentsOfDirectory(atPath: dayDir)) ?? [])
                        .filter { $0.hasPrefix("rollout-") && $0.hasSuffix(".jsonl") }
                        .map { "\(dayDir)/\($0)" }
                        .sorted { mtime($0) > mtime($1) }
                    files.append(contentsOf: rollouts)
                    if files.count >= limit { break outer }
                }
            }
        }
        return Array(files.prefix(limit))
    }

    private static func mtime(_ path: String) -> Date {
        (try? FileManager.default.attributesOfItem(atPath: path)[.modificationDate] as? Date)
            .flatMap { $0 } ?? .distantPast
    }

    /// Scans the last `tailBytes` of a transcript for the newest usable
    /// snapshot. The first line of the slice is dropped: seeking into the
    /// middle of a file lands mid-line, and a half line is not JSON.
    private static func newestSnapshot(inTailOf path: String, tailBytes: Int) -> Snapshot? {
        guard let handle = FileHandle(forReadingAtPath: path) else { return nil }
        defer { try? handle.close() }

        let size = (try? handle.seekToEnd()) ?? 0
        let start = size > UInt64(tailBytes) ? size - UInt64(tailBytes) : 0
        try? handle.seek(toOffset: start)
        guard let data = try? handle.readToEnd(), !data.isEmpty else { return nil }

        var lines = String(decoding: data, as: UTF8.self).split(separator: "\n").map(String.init)
        if start > 0, !lines.isEmpty { lines.removeFirst() }

        // Reverse order: the newest event in a transcript is the last one, so
        // the first match walking backwards is the freshest in this file.
        for line in lines.reversed() {
            guard line.contains("used_percent"), let snap = parse(line: line) else { continue }
            return snap
        }
        return nil
    }

    /// Parses one transcript line. Internal rather than private so the test
    /// program can drive it against captured fixtures.
    static func parse(line: String) -> Snapshot? {
        guard let data = line.data(using: .utf8),
              let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let payload = root["payload"] as? [String: Any],
              payload["type"] as? String == "token_count",
              let limits = payload["rate_limits"] as? [String: Any],
              let primary = window(limits["primary"])
        else { return nil }

        // The event timestamp is the snapshot's age. Without it we would be
        // presenting a possibly week-old percentage as the current one.
        guard let stamp = root["timestamp"] as? String,
              let captured = iso8601.date(from: stamp) ?? iso8601Plain.date(from: stamp)
        else { return nil }

        var credits: String?
        if let c = limits["credits"] as? [String: Any], c["has_credits"] as? Bool == true {
            credits = (c["unlimited"] as? Bool == true) ? "unlimited" : c["balance"] as? String
        }

        return Snapshot(plan: limits["plan_type"] as? String,
                        primary: primary,
                        secondary: window(limits["secondary"]),
                        creditBalance: credits,
                        capturedAt: captured)
    }

    private static func window(_ raw: Any?) -> Window? {
        guard let d = raw as? [String: Any],
              let used = d["used_percent"] as? Double,
              let minutes = d["window_minutes"] as? Int
        else { return nil }
        let resets = (d["resets_at"] as? Double).map { Date(timeIntervalSince1970: $0) }
        return Window(usedPercent: used, windowMinutes: minutes, resetsAt: resets)
    }

    private static let iso8601: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let iso8601Plain = ISO8601DateFormatter()

    // MARK: - Presentation helpers (shared by the window and the tests)

    /// 10080 minutes is the weekly window, 43200 the monthly one; anything else
    /// is spelled out in hours rather than guessed at.
    static func windowLabel(minutes: Int) -> String {
        switch minutes {
        case 10080: return NSL("monitor.codex.weekly", "Weekly")
        case 43200: return NSL("monitor.codex.monthly", "Monthly")
        default:
            let hours = max(1, minutes / 60)
            return NSLf("monitor.codex.windowHours", "%dh window", hours)
        }
    }

    /// Compact "2d 4h" / "3h" / "12m" — a reset five days out should not read
    /// as "120h".
    static func shortDuration(_ interval: TimeInterval) -> String {
        let total = Int(max(0, interval))
        let days = total / 86400, hours = (total % 86400) / 3600, minutes = (total % 3600) / 60
        if days > 0 { return hours > 0 ? "\(days)d \(hours)h" : "\(days)d" }
        if hours > 0 { return "\(hours)h" }
        return "\(minutes)m"
    }
}
