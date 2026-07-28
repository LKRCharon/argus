import Foundation
import OSLog

/// User-level sleep prevention via `ProcessInfo.beginActivity`.
///
/// Apple's recommended API for "my app is doing something, don't idle-sleep".
/// Runs in-process — no root helper, no `caffeinate` subprocess, no code signing
/// requirements. The assertion dies with the process, so a crash can never leave
/// the Mac permanently awake (the failure mode the helper's watchdog existed to
/// prevent).
///
/// `.userInitiated` includes `idleSystemSleepDisabled` but deliberately does NOT
/// include `idleDisplaySleepDisabled`: the screen may still dim/sleep while an
/// agent runs, which is what we want for battery.
final class ActivityAssertion {
    private let log = Logger(subsystem: "com.kairong.argus", category: "activity")
    private var token: NSObjectProtocol?

    /// Whether the assertion is currently held.
    var isActive: Bool { token != nil }

    /// Begin preventing idle system sleep. Idempotent.
    func begin(reason: String) {
        guard token == nil else { return }
        token = ProcessInfo.processInfo.beginActivity(options: .userInitiated, reason: reason)
        log.info("activity begun: \(reason, privacy: .public)")
    }

    /// Release the assertion, letting macOS idle-sleep again. Idempotent.
    func end() {
        guard let t = token else { return }
        ProcessInfo.processInfo.endActivity(t)
        token = nil
        log.info("activity ended")
    }

    deinit { end() }
}
