import AppKit
import OSLog

/// Settings window — seven panes behind an NSToolbar in the dedicated
/// `.preference` style (HIG: settings windows use the toolbar pane switcher,
/// not a sidebar and not a hand-rolled segmented control).
final class SettingsWindowController: NSWindowController {

    // Raw value == tab index == toolbar order. History sits last: it is the
    // only read-only pane, and HIG convention puts data display after config.
    enum Pane: Int { case general = 0, agents = 1, remote = 2, safety = 3, notifications = 4, sync = 5, history = 6 }

    private static let paneOrder: [Pane] = [.general, .agents, .remote, .safety, .notifications, .sync, .history]
    private static let lastPaneKey = "settings.lastPane"

    private static let repoURLString = "https://github.com/kairong/argus"

    private let store: StateStore
    private let history: AwakeHistoryStore
    private let agentlinkBridge: AgentlinkBridge
    private let onRelocalize: () -> Void
    // var: relocalize() 가 새 언어로 패널을 통째로 재생성한다 (ADR-0011 §C v3).
    private var agentsViewController: AgentsPaneViewController
    private var remoteViewController: RemotePaneViewController
    private var safetyViewController: SafetyPaneViewController
    private var telegramViewController: TelegramPaneViewController
    private var historyViewController: HistoryPaneViewController
    private var syncViewController: RemoteSyncPaneViewController
    private var generalViewController: GeneralPaneViewController
    private let tabView = NSTabView()

    init(store: StateStore, history: AwakeHistoryStore, agentlinkBridge: AgentlinkBridge, onRelocalize: @escaping () -> Void) {
        self.store = store
        self.history = history
        self.agentlinkBridge = agentlinkBridge
        self.onRelocalize = onRelocalize
        self.agentsViewController = AgentsPaneViewController(store: store)
        self.remoteViewController = RemotePaneViewController(store: store)
        self.safetyViewController = SafetyPaneViewController(store: store)
        self.telegramViewController = TelegramPaneViewController()
        self.historyViewController = HistoryPaneViewController(store: store, history: history)
        self.syncViewController = RemoteSyncPaneViewController(bridge: agentlinkBridge)
        self.generalViewController = GeneralPaneViewController(store: store, onLanguageChanged: onRelocalize)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 640, height: 560),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false)
        window.title = NSL("settings.title", "Argus Settings")
        window.isReleasedWhenClosed = false
        // Accessory (menu-bar) apps easily lose active status, and AppKit
        // suppresses tooltips in windows of inactive apps by default — so the
        // Settings tooltips never appeared even though every control sets one
        // (2026-06-11 사용자 보고).
        window.allowsToolTipsWhenApplicationIsInactive = true
        window.minSize = NSSize(width: 560, height: 480)
        super.init(window: window)
        buildContent()
    }

    required init?(coder: NSCoder) { fatalError("not supported") }

    /// ADR-0018 — re-render the General pane's permission row. Called on app
    /// reactivation so returning from System Settings updates the row live.
    func refreshGeneralPane() {
        generalViewController.refresh()
    }

    /// Shows the window. `nil` restores the most recently viewed pane (HIG:
    /// "Restore the last-displayed panel"); a concrete pane jumps straight there.
    func show(pane: Pane? = nil) {
        window?.center()
        let stored = Pane(rawValue: UserDefaults.standard.integer(forKey: Self.lastPaneKey)) ?? .general
        selectPane(at: (pane ?? stored).rawValue)
        agentsViewController.refresh()
        remoteViewController.refresh()
        safetyViewController.refresh()
        telegramViewController.refresh()
        historyViewController.refresh()
        generalViewController.refresh()
        showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: - Pane metadata

    private static func toolbarID(_ pane: Pane) -> NSToolbarItem.Identifier {
        switch pane {
        case .general: return NSToolbarItem.Identifier("pane.general")
        case .agents: return NSToolbarItem.Identifier("pane.agents")
        case .remote: return NSToolbarItem.Identifier("pane.remote")
        case .safety: return NSToolbarItem.Identifier("pane.safety")
        case .notifications: return NSToolbarItem.Identifier("pane.notifications")
        case .sync: return NSToolbarItem.Identifier("pane.sync")
        case .history: return NSToolbarItem.Identifier("pane.history")
        }
    }

    /// HIG: every settings toolbar item carries both an icon and a label.
    /// Remote (SSH/VNC into this Mac) and Sync (phone companion) have easily
    /// confused names — the network vs. iphone symbols carry the distinction.
    private static func symbol(for pane: Pane) -> String {
        switch pane {
        case .general: return "gearshape"
        case .agents: return "sparkles"
        case .remote: return "network"
        case .safety: return "shield"
        case .notifications: return "bell"
        case .sync: return "iphone"
        case .history: return "clock"
        }
    }

    private static func label(for pane: Pane) -> String {
        switch pane {
        case .general: return NSL("tab.general", "General")
        case .agents: return NSL("tab.agents", "Agents")
        case .remote: return NSL("tab.remote", "Remote")
        case .safety: return NSL("tab.safety", "Safety")
        case .notifications: return NSL("tab.notifications", "Notifications")
        case .sync: return NSL("tab.sync", "Sync")
        case .history: return NSL("tab.history", "History")
        }
    }

    private func viewController(for pane: Pane) -> NSViewController {
        switch pane {
        case .general: return generalViewController
        case .agents: return agentsViewController
        case .remote: return remoteViewController
        case .safety: return safetyViewController
        case .notifications: return telegramViewController
        case .sync: return syncViewController
        case .history: return historyViewController
        }
    }

    private func buildContent() {
        guard let window = window, let contentView = window.contentView else { return }
        tabView.translatesAutoresizingMaskIntoConstraints = false
        tabView.tabViewType = .noTabsNoBorder

        for pane in Self.paneOrder {
            let item = NSTabViewItem(identifier: Self.toolbarID(pane).rawValue)
            item.label = Self.label(for: pane)
            item.view = viewController(for: pane).view
            tabView.addTabViewItem(item)
        }

        window.toolbarStyle = .preference
        installToolbar()

        contentView.addSubview(tabView)
        NSLayoutConstraint.activate([
            tabView.topAnchor.constraint(equalTo: contentView.topAnchor),
            tabView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            tabView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            tabView.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
        ])
    }

    /// (Re)creates the toolbar. Called once at build time and again on language
    /// change, because item labels are baked in at creation.
    private func installToolbar() {
        let toolbar = NSToolbar(identifier: "settings.toolbar")
        toolbar.delegate = self
        toolbar.allowsUserCustomization = false   // HIG: settings toolbars are fixed
        toolbar.displayMode = .iconAndLabel
        window?.toolbar = toolbar
    }

    @objc private func toolbarPaneSelected(_ sender: NSToolbarItem) {
        if let pane = Self.paneOrder.first(where: { Self.toolbarID($0) == sender.itemIdentifier }) {
            selectPane(at: pane.rawValue)
        }
    }

    private func selectPane(at index: Int) {
        guard index >= 0, index < tabView.numberOfTabViewItems else { return }
        let pane = Pane(rawValue: index) ?? .general
        tabView.selectTabViewItem(at: index)
        window?.toolbar?.selectedItemIdentifier = Self.toolbarID(pane)
        // HIG: "Update the window title to match the currently displayed panel",
        // and remember the pane so the next open restores it.
        window?.title = Self.label(for: pane)
        UserDefaults.standard.set(index, forKey: Self.lastPaneKey)
        // AppKit's key-view handoff on tab switches moves focus to the first
        // focusable control of the new pane whenever the previous first
        // responder lived inside the old pane — a random control gets the
        // focus ring and starts eating Space/arrow keys (user feedback:
        // 切换页面都会选中第一个元素). Clear the first responder so switching is
        // focus-stable, matching System Settings behaviour. Done async too
        // because AppKit's handoff can land on the next runloop turn and
        // clobber a sync set.
        window?.makeFirstResponder(nil)
        DispatchQueue.main.async { [weak self] in
            self?.window?.makeFirstResponder(nil)
        }
    }

    /// ADR-0011 §C v3 — 재시작도, 창 재생성도 없는 라이브 언어 전환.
    /// 이전 구현은 창을 닫고 새로 만들었는데(탭 위치 유실 + 깜빡임), NSL 이
    /// loadView 시점에 박히는 구조라 패널 VC 만 새로 만들어 탭의 view 를
    /// 갈아끼우면 충분하다. 옛 view 가 윈도우에서 빠질 때 viewWillDisappear 가
    /// 발화해 TimedRefresh 타이머도 자연 정리된다. 선택 탭은 보존.
    func relocalize() {
        let selectedIndex = tabView.selectedTabViewItem.map { tabView.indexOfTabViewItem($0) } ?? 0

        agentsViewController = AgentsPaneViewController(store: store)
        remoteViewController = RemotePaneViewController(store: store)
        safetyViewController = SafetyPaneViewController(store: store)
        telegramViewController = TelegramPaneViewController()
        historyViewController = HistoryPaneViewController(store: store, history: history)
        // Sync 도 재생성 — 이전 구현은 6개만 갈아끼워 Sync 탭이 옛 언어로 남았다.
        syncViewController = RemoteSyncPaneViewController(bridge: agentlinkBridge)
        generalViewController = GeneralPaneViewController(store: store, onLanguageChanged: onRelocalize)

        for (i, pane) in Self.paneOrder.enumerated() {
            let item = tabView.tabViewItem(at: i)
            item.label = Self.label(for: pane)
            item.view = viewController(for: pane).view
        }
        // Toolbar item labels are set at creation — rebuild it in the new language.
        installToolbar()
        selectPane(at: selectedIndex)
        generalViewController.refresh()
    }
}

// MARK: - NSToolbarDelegate

extension SettingsWindowController: NSToolbarDelegate {
    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        Self.paneOrder.map { Self.toolbarID($0) }
    }

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        Self.paneOrder.map { Self.toolbarID($0) }
    }

    func toolbarSelectableItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        Self.paneOrder.map { Self.toolbarID($0) }
    }

    func toolbar(_ toolbar: NSToolbar,
                 itemForItemIdentifier itemIdentifier: NSToolbarItem.Identifier,
                 willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        guard let pane = Self.paneOrder.first(where: { Self.toolbarID($0) == itemIdentifier }) else { return nil }
        let item = NSToolbarItem(itemIdentifier: itemIdentifier)
        let label = Self.label(for: pane)
        item.label = label
        item.paletteLabel = label
        item.image = NSImage(systemSymbolName: Self.symbol(for: pane), accessibilityDescription: label)
        item.target = self
        item.action = #selector(toolbarPaneSelected(_:))
        return item
    }
}
