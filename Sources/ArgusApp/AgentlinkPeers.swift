import Foundation

/// Reads the paired-device list the daemon persists at `~/.agentlink/peers.json`.
/// The GUI only ever reads it; pairing and removal go through the daemon so both
/// sides keep a single source of truth.
enum AgentlinkPeers {
    struct Peer {
        let fingerprint: String
        let deviceName: String
        let platform: String
        /// Unix milliseconds, matching the daemon's JSON.
        let pairedAt: Double
    }

    static func peersFileURL() -> URL {
        let home = ProcessInfo.processInfo.environment["AGENTLINK_HOME"]
            ?? (NSHomeDirectory() + "/.agentlink")
        return URL(fileURLWithPath: home).appendingPathComponent("peers.json")
    }

    static func load() -> [Peer] {
        guard let data = try? Data(contentsOf: peersFileURL()),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return [] }
        return root.values.compactMap { value in
            guard let d = value as? [String: Any],
                  let fp = d["fingerprint"] as? String,
                  let name = d["deviceName"] as? String
            else { return nil }
            return Peer(
                fingerprint: fp,
                deviceName: name,
                platform: (d["platform"] as? String) ?? "",
                pairedAt: (d["pairedAt"] as? Double) ?? 0)
        }
    }
}
