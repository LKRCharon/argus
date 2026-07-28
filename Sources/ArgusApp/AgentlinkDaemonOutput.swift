import Foundation

/// Parsed structured JSON line from daemon stdout.
/// Lines starting with {"type": are structured; everything else is human-readable log.
struct AgentlinkDaemonOutput: Decodable {
    let type: String
    let connection: String?
    let sessions: Int?
    let session: String?
    let agent: String?
    let event: String?
    let message: String?
    let port: Int?
    let secret: String?
    /// `pair_code` — the NNNN-XXXXXX code the daemon generated.
    let code: String?
    /// `pair_code` — seconds until the code expires (drives the GUI countdown).
    let ttlSeconds: Int?
    /// `pair_done` — details of the device that just paired.
    let deviceName: String?
    let platform: String?
    let fingerprint: String?

    static func parse(_ line: String) -> AgentlinkDaemonOutput? {
        guard line.hasPrefix("{\"type\":") else { return nil }
        guard let data = line.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(AgentlinkDaemonOutput.self, from: data)
    }
}
