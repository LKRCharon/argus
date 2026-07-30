import Foundation

/// `argus monitor` — open the SwiftUI monitor window of the running app.
///
/// Status-item menus are invisible to System Events scripting (the status bar
/// is not part of the app's exposed menu bar), so this command is the only
/// scriptable way to open the dashboard — and it costs one line in the app.
enum MonitorCommand: CLISubcommand {
    static func run(args: [String]) -> Int32 {
        // Distributed notification: the first CLI→GUI signal in the project
        // (on/off/keep go through the helper over XPC instead — they mutate
        // power state; this one only asks the running app to show a window).
        DistributedNotificationCenter.default().postNotificationName(
            Notification.Name("com.kairong.argus.openMonitor"),
            object: nil,
            userInfo: nil,
            deliverImmediately: true)
        // A distributed notification cannot tell whether anyone heard it; say
        // so rather than letting exit 0 read as "the window is open".
        print("open request sent to Argus (no-op if the app is not running)")
        return 0
    }
}
