import Foundation
import OSLog

/// proposal §1 — 외부 trace 선언 로더.
///
/// `~/.config/argus/traces.d/*.json` 의 `AgentTrace` JSON(단일 객체 또는
/// 배열)을 읽어 known pool 에 합류시킨다. 형식은 `AgentTrace` 의 Codable
/// 그대로: `id`/`label`/`globPattern` (+선택 `freshness`/`hookKey`/`comm`).
/// 새 에이전트를 코드 수정 없이 지원하는 통로이자 커뮤니티 기여 포맷
/// (`traces/README.md`).
///
/// - 잘못된 파일은 경고 로그 후 무시 (전체 로딩은 계속).
/// - `tracesToWatch()` 가 converge 마다 부르므로 5s 스로틀 캐시.
/// - 입력 cap (ADR-0023 정신): 파일 ≤64개, 합계 trace ≤128개, id 는
///   `sanitizeActivitySource` 통과 + 비어있지 않아야 채택.
enum ExternalTraces {
    private static let log = Logger(subsystem: "com.kairong.argus", category: "traces")
    private static let lock = NSLock()
    private static var cached: [AgentTrace] = []
    private static var lastScan: Date = .distantPast
    private static var loggedFiles: Set<String> = []

    static var directory: String { NSHomeDirectory() + "/.config/argus/traces.d" }

    /// pre-rename 마이그레이션 호환: 구이름 시절의 `~/.config/eclam/traces.d` 를
    /// 읽기 전용으로만 더 스캔한다 (새 경로가 없거나 비어 있을 때). 사용자의
    /// 기여 파일을 옮기거나 만들지 않고 불러오기만 한다.
    static var legacyDirectory: String { NSHomeDirectory() + "/.config/eclam/traces.d" }

    static func load(now: Date = Date()) -> [AgentTrace] {
        lock.lock(); defer { lock.unlock() }
        if now.timeIntervalSince(lastScan) < 30 { return cached }
        lastScan = now

        let fm = FileManager.default
        var out: [AgentTrace] = []
        let decoder = JSONDecoder()
        for dir in scanDirectories(fm) {
            for name in fileNames(in: dir, fm: fm) {
                let path = dir + "/" + name
                guard let data = fm.contents(atPath: path) else { continue }
                var traces: [AgentTrace] = []
                if let arr = try? decoder.decode([AgentTrace].self, from: data) {
                    traces = arr
                } else if let one = try? decoder.decode(AgentTrace.self, from: data) {
                    traces = [one]
                } else {
                    if !loggedFiles.contains(path) {
                        loggedFiles.insert(path)
                        log.warning("traces.d/\(name, privacy: .public): not valid AgentTrace JSON — skipped")
                    }
                    continue
                }
                for t in traces {
                    let cleanId = HelperServiceName.sanitizeActivitySource(t.id)
                    guard !cleanId.isEmpty, cleanId == t.id else {
                        if !loggedFiles.contains(path + ":" + t.id) {
                            loggedFiles.insert(path + ":" + t.id)
                            log.warning("traces.d/\(name, privacy: .public): id '\(t.id, privacy: .public)' rejected (lowercase [a-z0-9_-.] only)")
                        }
                        continue
                    }
                    out.append(t)
                    if out.count >= 128 { break }
                }
                if out.count >= 128 { break }
            }
            if out.count >= 128 { break }
        }
        if out.count != cached.count {
            log.info("external traces loaded: \(out.count, privacy: .public)")
        }
        cached = out
        return out
    }

    /// 새 경로 단독, 또는 새 경로가 비어 있거나 없을 때만 구 경로를 더한다.
    private static func scanDirectories(_ fm: FileManager) -> [String] {
        let primary = fileNames(in: directory, fm: fm)
        if !primary.isEmpty { return [directory] }
        // pre-rename 마이그레이션 호환 (읽기 전용 폴백).
        return [directory, legacyDirectory]
    }

    /// 정렬된 `.json` 파일명, 파일 수 cap 적용. 디렉터리 부재 시 빈 배열.
    private static func fileNames(in dir: String, fm: FileManager) -> [String] {
        guard let entries = try? fm.contentsOfDirectory(atPath: dir) else { return [] }
        return Array(entries.sorted().filter { $0.hasSuffix(".json") }.prefix(64))
    }
}
