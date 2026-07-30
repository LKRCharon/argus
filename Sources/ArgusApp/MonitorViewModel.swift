import Foundation
import Combine

/// Backs the SwiftUI monitor window.
///
/// The window is a dashboard, and a dashboard must never disagree with the
/// menu bar: the headline and guard lines come from `MenuBarController` (which
/// owns the 9-level reason priority and the guard wording), not from a second
/// copy of that logic here. What this model adds on top is the raw sensor
/// state the menu doesn't show (temperatures, sample history, agent list).
///
/// Polling at 1 Hz matches the project's existing idiom (the panes poll the
/// store too) and sidesteps the fact that `store.onChange` is single-owner.
/// The timer only runs while the window is visible — a hidden dashboard
/// burning a timer every second would be indefensible in a battery app.
@MainActor
final class MonitorViewModel: ObservableObject {

    enum DotState { case holding, idle, attention }

    /// Headline reuses MenuBarController's priority logic (helper dead, guard
    /// reasons, CLI hold, manual pin, remote, agents, …) verbatim.
    @Published private(set) var headline: String = ""
    @Published private(set) var dotState: DotState = .idle
    /// Live clock while awake ("1:34:07"); empty while asleep.
    @Published private(set) var elapsedText: String = ""
    /// The same guard lines the menu shows (battery/thermal/remote/timer).
    @Published private(set) var guardLines: [String] = []

    @Published private(set) var batteryPercent: Int?
    /// User-configured low-battery guard threshold, for the ring's colour.
    @Published private(set) var batteryLowThreshold: Int = 20

    @Published private(set) var cpuTemp: Double?
    @Published private(set) var gpuTemp: Double?
    @Published private(set) var batteryTemp: Double?
    /// 0 = nominal … 3 = critical, drives the thermal card's tint.
    @Published private(set) var thermalLevel: Int = 0
    @Published private(set) var samples: [StateStore.ThermalSample] = []

    @Published private(set) var activeAgents: [String] = []
    @Published private(set) var remoteChannels: [String] = []

    private let store: StateStore
    private let menuBar: MenuBarController
    private var timer: Timer?

    init(store: StateStore, menuBar: MenuBarController) {
        self.store = store
        self.menuBar = menuBar
        refresh()
    }

    /// The window controller calls this on show/hide/miniaturize.
    func setVisible(_ visible: Bool) {
        if visible {
            guard timer == nil else { return }
            refresh()
            timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
                Task { @MainActor [weak self] in self?.refresh() }
            }
        } else {
            timer?.invalidate()
            timer = nil
        }
    }

    private func refresh() {
        // Consume the menu's own verdicts, not a re-derivation: an earlier
        // half-copy disagreed on CLI holds (dot gray while the headline said
        // "Awake — CLI hold") and on unapproved installs (guard lines shown
        // where the menu shows none).
        headline = menuBar.headerString(
            for: store.registration, sleepDisabled: store.sleepDisabled).text
        guardLines = menuBar.isEnabled ? menuBar.guardStatusLines() : []

        switch menuBar.statusDotColor() {
        case .systemGreen: dotState = .holding
        case .systemOrange: dotState = .attention
        default: dotState = .idle
        }

        if store.shouldKeepAwake, let since = store.keepAwakeSince {
            elapsedText = Self.hms(Date().timeIntervalSince(since))
        } else {
            elapsedText = ""
        }

        batteryPercent = store.batteryPercentDisplay ?? store.batteryPercent
        batteryLowThreshold = store.safetySettings.batteryLow
        cpuTemp = store.cpuTempCelsius
        gpuTemp = store.gpuTempCelsius
        batteryTemp = store.batteryTempCelsius
        thermalLevel = store.thermalPressureLevel ?? 0
        samples = store.thermalHistory
        activeAgents = store.activeAgents.sorted()
        remoteChannels = store.remoteChannels.sorted()
    }

    /// H:MM:SS under an hour becomes MM:SS — matches the history pane's clock.
    private static func hms(_ t: TimeInterval) -> String {
        let s = Int(max(0, t))
        let h = s / 3600, m = (s % 3600) / 60, sec = s % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec)
                     : String(format: "%02d:%02d", m, sec)
    }
}
