import AppKit
import ApplicationServices
import OSLog

/// Types a remote message into the Qoder IDE's chat input, so a phone message
/// lands in the *current* IDE session instead of spawning a separate headless
/// one (`qodercli --resume` cannot reach IDE sessions: the CLI and the IDE keep
/// separate session namespaces, confirmed via `--list-sessions`).
///
/// Why keystrokes and not the accessibility tree: Qoder is Electron and does
/// not expose its web content to AX. `AXManualAccessibility` is accepted but
/// only menus ever materialise (~4000 AXMenuItem, zero editable elements), so
/// there is no text field to set a value on. Menus *are* exposed, which is what
/// makes this reliable rather than blind: the Quest window is brought forward
/// through its menu item before anything is typed.
enum QoderInjector {

    private static let log = Logger(subsystem: "com.kairong.argus", category: "inject")
    private static let bundleID = "com.qoder.ide"

    enum Failure: LocalizedError {
        case notRunning
        case noAccessibilityPermission
        case questWindowUnavailable

        var errorDescription: String? {
            switch self {
            case .notRunning:
                return NSL("inject.err.notRunning", "Qoder is not running on this Mac")
            case .noAccessibilityPermission:
                return NSL("inject.err.noPermission",
                           "Argus needs Accessibility permission to type into Qoder (System Settings → Privacy & Security → Accessibility)")
            case .questWindowUnavailable:
                return NSL("inject.err.noQuestWindow", "Qoder's Quest window could not be brought forward")
            }
        }
    }

    /// True when the app holds Accessibility rights (required to post events).
    static var hasPermission: Bool { AXIsProcessTrusted() }

    /// Opens the Accessibility pane so the user can grant the right.
    static func openPermissionSettings() {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") else { return }
        NSWorkspace.shared.open(url)
    }

    static var isQoderRunning: Bool {
        NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first != nil
    }

    /// Serialises injections and keeps the ~1.7s of settle time off the main
    /// thread — running this on the main queue froze the menu bar for the whole
    /// duration. Serial, so two phone messages arriving together cannot
    /// interleave their clipboard swaps.
    private static let queue = DispatchQueue(label: "com.kairong.argus.inject")

    /// Types `text` into Qoder's chat input and submits it. Returns immediately;
    /// `completion` reports the outcome on the main queue.
    static func send(_ text: String, completion: @escaping (Error?) -> Void) {
        queue.async {
            var failure: Error?
            do {
                try performSend(text)
            } catch {
                failure = error
            }
            DispatchQueue.main.async { completion(failure) }
        }
    }

    private static func performSend(_ text: String) throws {
        guard hasPermission else { throw Failure.noAccessibilityPermission }
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first else {
            throw Failure.notRunning
        }

        let previous = NSWorkspace.shared.frontmostApplication
        try focusQuestWindow(pid: app.processIdentifier)
        app.activate(options: [])
        // Activation and the window coming forward are both async; without a
        // settle window the keystrokes land in whatever was focused before.
        usleep(700_000)

        let pasteboard = NSPasteboard.general
        // `changeCount` guards the restore below: the user can copy something
        // during the ~1.7s this takes, and putting the old contents back would
        // then throw away what they just copied.
        let changeCountBefore = pasteboard.changeCount
        // Snapshot the whole item, not just the string: restoring only a string
        // would silently drop images or rich content the user had copied.
        let saved = pasteboard.pasteboardItems?.first.map { item -> [NSPasteboard.PasteboardType: Data] in
            var copy: [NSPasteboard.PasteboardType: Data] = [:]
            for type in item.types {
                if let data = item.data(forType: type) { copy[type] = data }
            }
            return copy
        }

        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
        let changeCountAfterWrite = pasteboard.changeCount

        postKey(keyV, flags: .maskCommand)   // paste
        usleep(250_000)
        postKey(keyReturn)                    // submit
        usleep(400_000)

        // Only restore when nothing else touched the clipboard in between — our
        // own write is the one change we expect to see.
        if pasteboard.changeCount == changeCountAfterWrite,
           changeCountBefore != changeCountAfterWrite,
           let saved = saved, !saved.isEmpty {
            pasteboard.clearContents()
            let item = NSPasteboardItem()
            for (type, data) in saved { item.setData(data, forType: type) }
            pasteboard.writeObjects([item])
        }

        // Hand focus back so an unattended injection does not leave Qoder in
        // front of whatever the user was actually using.
        if let previous = previous, previous.bundleIdentifier != bundleID {
            previous.activate(options: [])
        }
        log.info("injected \(text.count, privacy: .public) chars into Qoder")
    }

    /// Brings the Quest (chat) window forward through the menu bar. Menus are
    /// the one part of Qoder's UI that AX exposes, so this is deterministic —
    /// unlike sending a shortcut and hoping the right pane has focus.
    private static func focusQuestWindow(pid: pid_t) throws {
        let ax = AXUIElementCreateApplication(pid)
        // CFTypeRef bridges unconditionally to AXUIElement, so this uses an
        // unchecked cast rather than `as?` (which the compiler rejects).
        guard let menuBarRef = copyAttr(ax, kAXMenuBarAttribute) else {
            throw Failure.questWindowUnavailable
        }
        let menuBar = menuBarRef as! AXUIElement
        guard let topLevel = copyAttr(menuBar, kAXChildrenAttribute) as? [AXUIElement] else {
            throw Failure.questWindowUnavailable
        }
        for item in topLevel {
            guard let menus = copyAttr(item, kAXChildrenAttribute) as? [AXUIElement],
                  let menu = menus.first,
                  let entries = copyAttr(menu, kAXChildrenAttribute) as? [AXUIElement] else { continue }
            for entry in entries {
                let title = copyAttr(entry, kAXTitleAttribute) as? String
                guard title == "Quest Window" else { continue }
                if AXUIElementPerformAction(entry, kAXPressAction as CFString) == .success {
                    usleep(400_000)
                    return
                }
            }
        }
        throw Failure.questWindowUnavailable
    }

    // MARK: - Low level

    private static let keyV: CGKeyCode = 9
    private static let keyReturn: CGKeyCode = 36

    private static func postKey(_ code: CGKeyCode, flags: CGEventFlags = []) {
        let source = CGEventSource(stateID: .hidSystemState)
        let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)
        let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
        down?.flags = flags
        up?.flags = flags
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
    }

    private static func copyAttr(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success ? value : nil
    }
}
