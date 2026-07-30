import SwiftUI
import AppKit
import Charts

/// The monitor window: a SwiftUI dashboard over AppKit/C plumbing, opened from
/// the menu bar. The pane audit found nearly every *stateful* surface (thermal
/// chart, live agent list, guard state) trapped inside Settings — those are
/// things you glance at, not things you configure, so they live here instead.
///
/// Styling follows the Android app's control-center language (MonitorTheme is
/// a hex-for-hex port of ui/theme/Theme.kt): solid sheet surface, rounded
/// cards, ONE accent, pills for entities, SF Symbols instead of emoji.

// MARK: - Window controller

final class MonitorWindowController: NSWindowController, NSWindowDelegate {
    private let model: MonitorViewModel
    private var hasCentered = false

    init(store: StateStore, menuBar: MenuBarController) {
        let model = MonitorViewModel(store: store, menuBar: menuBar)
        self.model = model
        let hosting = NSHostingController(rootView: MonitorRootView(model: model))
        let window = NSWindow(contentViewController: hosting)
        window.title = NSL("monitor.title", "Monitor")
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.styleMask.insert(.fullSizeContentView)
        window.setContentSize(NSSize(width: 400, height: 640))
        window.minSize = NSSize(width: 360, height: 480)
        // Singleton window: closing hides it, reopening reuses it — state
        // (scroll position, centred frame) survives.
        window.isReleasedWhenClosed = false
        window.isMovableByWindowBackground = true
        super.init(window: window)
        window.delegate = self
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    func show() {
        guard let window else { return }
        if !hasCentered {
            window.center()
            hasCentered = true
        }
        // makeKeyAndOrderFront cannot un-minimize; without this both entry
        // points silently did nothing on a minimized window.
        if window.isMiniaturized { window.deminiaturize(nil) }
        model.setVisible(true)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func windowWillClose(_ notification: Notification) {
        // Stop the 1 Hz timer while hidden: a battery app has no business
        // polling sensors for a window nobody is looking at.
        model.setVisible(false)
    }

    // Minimizing is not closing — the timer must pause there too.
    func windowDidMiniaturize(_ notification: Notification) {
        model.setVisible(false)
    }

    func windowDidDeminiaturize(_ notification: Notification) {
        model.setVisible(true)
    }
}

// MARK: - Root view

private struct MonitorRootView: View {
    @ObservedObject var model: MonitorViewModel
    @Environment(\.colorScheme) private var colorScheme

    private var palette: MonitorPalette {
        colorScheme == .dark ? .dark : .light
    }

    /// Android compensates same-hex surfaces with elevation shadows; flat macOS
    /// gets a hairline instead, or light-mode cards blur into the sheet.
    private var cardBorder: Color { palette.textPrimary.opacity(0.07) }

    /// Cards read the same palette. Do NOT store this as @Environment injected
    /// inside our own body: a stored environment property resolves from the
    /// *parent* (NSHostingController, which injects nothing), so it silently
    /// kept the .dark default and light mode rendered dark cards on a light
    /// background. An injected value only reaches a child subtree.
    private var c: MonitorPalette { palette }

    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                statusCapsule
                guardCard
                HStack(alignment: .top, spacing: 12) {
                    thermalCard
                    batteryCard
                }
                agentsCard
                remoteCard
            }
            .padding(16)
            // Clear the overlaid traffic lights of the transparent title bar.
            .padding(.top, 12)
        }
        .scrollContentBackground(.hidden)
        .background(palette.sheet)
        .frame(minWidth: 340)
    }

    // MARK: Status capsule (pill-first, like Android's StatusCapsule)

    private var statusCapsule: some View {
        return HStack(alignment: .center, spacing: 10) {
            Circle()
                .fill(dotColor)
                .frame(width: 9, height: 9)
            Text(model.headline)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(c.textPrimary)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            if !model.elapsedText.isEmpty {
                Text(model.elapsedText)
                    .font(.system(.body, design: .monospaced).weight(.medium))
                    .foregroundStyle(c.textSecondary)
                    .contentTransition(.numericText())
                    .animation(.default, value: model.elapsedText)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(c.card, in: RoundedRectangle(cornerRadius: MonitorRadius.card))
        .overlay(RoundedRectangle(cornerRadius: MonitorRadius.card).strokeBorder(cardBorder, lineWidth: 0.5))
    }

    private var dotColor: Color {
        switch model.dotState {
        case .holding: return c.statusGreen
        case .attention: return c.statusAmber
        case .idle: return c.textTertiary
        }
    }

    // MARK: Guard rows — SF Symbols, never emoji

    private var guardCard: some View {
        let rows = model.guardLines.map(Self.splitSymbol)
        return Group {
            if rows.isEmpty {
                EmptyView()
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(rows, id: \.self) { row in
                        HStack(spacing: 8) {
                            if let symbol = row.symbol {
                                Image(systemName: symbol)
                                    .font(.system(size: 12))
                                    .foregroundStyle(row.isWarning ? c.statusAmber : c.textSecondary)
                                    .frame(width: 16, alignment: .center)
                            }
                            Text(row.text)
                                .font(.callout)
                                .foregroundStyle(row.isWarning ? c.textPrimary : c.textSecondary)
                            Spacer()
                        }
                    }
                }
                .padding(12)
                .background(c.card, in: RoundedRectangle(cornerRadius: MonitorRadius.card))
        .overlay(RoundedRectangle(cornerRadius: MonitorRadius.card).strokeBorder(cardBorder, lineWidth: 0.5))
            }
        }
    }

    /// A guard row's identity: the icon + the text (text alone can repeat —
    /// e.g. a calm and a warning battery line can share wording in edge cases).
    private struct GuardRow: Hashable {
        let symbol: String?
        let text: String
        let isWarning: Bool
    }

    /// Strip the leading status emoji (menu strings carry them as markers) and
    /// map it to an SF Symbol via the same table the menu uses.
    private static func splitSymbol(_ line: String) -> GuardRow {
        guard let first = line.first, let name = MonitorSymbols.name(for: first) else {
            return GuardRow(symbol: nil, text: line, isWarning: false)
        }
        // The warning mark is appended at the END of the line ("🔋 15% · guard
        // 20% ⚠️"), not at the front — checking the first character never fired
        // and left the emoji inline in the text.
        let isWarning = line.contains("⚠️")
        let rest = line.dropFirst().drop(while: { $0 == " " })
        let text = rest.replacingOccurrences(of: " ⚠️", with: "")
        return GuardRow(symbol: name, text: text, isWarning: isWarning)
    }

    // MARK: Thermal card (gradient area chart, accent-tinted)

    private var thermalCard: some View {
        return VStack(alignment: .leading, spacing: 8) {
            Label(NSL("monitor.temperature", "Temperature"), systemImage: "thermometer.medium")
                .font(.subheadline)
                .foregroundStyle(c.textSecondary)
            if model.samples.count > 1 {
                Chart(model.samples, id: \.at) { s in
                    if let cpu = s.cpuC {
                        AreaMark(x: .value("t", s.at), y: .value("°C", cpu))
                            .interpolationMethod(.catmullRom)
                            .foregroundStyle(.linearGradient(
                                colors: [thermalAccent.opacity(0.35), thermalAccent.opacity(0.02)],
                                startPoint: .top, endPoint: .bottom))
                        LineMark(x: .value("t", s.at), y: .value("°C", cpu))
                            .interpolationMethod(.catmullRom)
                            .foregroundStyle(thermalAccent)
                            .lineStyle(StrokeStyle(lineWidth: 1.5))
                    }
                }
                .chartXAxis(.hidden)
                .chartYScale(domain: .automatic(includesZero: false))
                .chartYAxis { AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) }
                .frame(height: 96)
                .clipped()
            } else {
                Text(NSL("monitor.collecting", "Collecting…"))
                    .font(.callout)
                    .foregroundStyle(c.textTertiary)
                    .frame(maxWidth: .infinity, minHeight: 96)
            }
            HStack(spacing: 12) {
                tempChip("CPU", model.cpuTemp)
                tempChip("GPU", model.gpuTemp)
                tempChip(NSL("monitor.batt", "Batt"), model.batteryTemp)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(c.card, in: RoundedRectangle(cornerRadius: MonitorRadius.card))
        .overlay(RoundedRectangle(cornerRadius: MonitorRadius.card).strokeBorder(cardBorder, lineWidth: 0.5))
    }

    /// The single accent is the baseline; thermal pressure escalates to amber
    /// then danger — status colours stay reserved for status.
    private var thermalAccent: Color {
        if model.thermalLevel >= 3 { return c.danger }
        if model.thermalLevel >= 2 { return c.statusAmber }
        return c.accentStroke
    }

    private func tempChip(_ label: String, _ value: Double?) -> some View {
        return HStack(spacing: 4) {
            Text(label).font(.caption).foregroundStyle(c.textTertiary)
            Text(value.map { String(format: "%.0f°", $0) } ?? "—")
                .font(.system(.callout, design: .rounded).monospacedDigit())
                .foregroundStyle(c.textPrimary)
        }
    }

    // MARK: Battery ring

    private var batteryCard: some View {
        return VStack(spacing: 10) {
            Label(NSL("monitor.battery", "Battery"), systemImage: "battery.75percent")
                .font(.subheadline)
                .foregroundStyle(c.textSecondary)
            ZStack {
                // Track in sheet (not card): a card-coloured track on a card
                // background is invisible, leaving the arc floating on nothing.
                Circle().stroke(c.sheet, lineWidth: 9)
                if let pct = model.batteryPercent {
                    Circle()
                        .trim(from: 0, to: CGFloat(pct) / 100)
                        .stroke(batteryColor(pct),
                                style: StrokeStyle(lineWidth: 9, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                        .animation(.easeInOut(duration: 0.4), value: pct)
                    Text("\(pct)%")
                        .font(.system(.title3, design: .rounded).weight(.semibold).monospacedDigit())
                        .foregroundStyle(c.textPrimary)
                } else {
                    Text("—")
                        .font(.title3)
                        .foregroundStyle(c.textTertiary)
                }
            }
            .frame(width: 92, height: 92)
            Text(NSLf("monitor.guardAt", "guard %d%%", model.batteryLowThreshold))
                .font(.caption)
                .foregroundStyle(c.textTertiary)
        }
        .padding(12)
        .frame(maxWidth: .infinity)
        .background(c.card, in: RoundedRectangle(cornerRadius: MonitorRadius.card))
        .overlay(RoundedRectangle(cornerRadius: MonitorRadius.card).strokeBorder(cardBorder, lineWidth: 0.5))
    }

    private func batteryColor(_ pct: Int) -> Color {
        if pct <= 10 { return c.danger }
        if pct <= model.batteryLowThreshold { return c.statusAmber }
        return c.statusGreen
    }

    // MARK: Agents (pills)

    private var agentsCard: some View {
        return VStack(alignment: .leading, spacing: 8) {
            Label(NSL("monitor.activeAgents", "Active agents"), systemImage: "cpu")
                .font(.subheadline)
                .foregroundStyle(c.textSecondary)
            if model.activeAgents.isEmpty {
                Text(NSL("monitor.noAgents", "None running"))
                    .font(.callout)
                    .foregroundStyle(c.textTertiary)
            } else {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 100), spacing: 8)], spacing: 8) {
                    ForEach(model.activeAgents, id: \.self) { name in
                        HStack(spacing: 6) {
                            Circle().fill(c.statusGreen).frame(width: 6, height: 6)
                            Text(name).font(.callout).foregroundStyle(c.textPrimary).lineLimit(1)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(c.sheet, in: Capsule())
                    }
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(c.card, in: RoundedRectangle(cornerRadius: MonitorRadius.card))
        .overlay(RoundedRectangle(cornerRadius: MonitorRadius.card).strokeBorder(cardBorder, lineWidth: 0.5))
    }

    // MARK: Remote channels

    private var remoteCard: some View {
        return VStack(alignment: .leading, spacing: 8) {
            Label(NSL("monitor.remote", "Remote sessions"), systemImage: "antenna.radiowaves.left.and.right")
                .font(.subheadline)
                .foregroundStyle(c.textSecondary)
            if model.remoteChannels.isEmpty {
                Text(NSL("monitor.noRemote", "No remote connections"))
                    .font(.callout)
                    .foregroundStyle(c.textTertiary)
            } else {
                ForEach(model.remoteChannels, id: \.self) { channel in
                    HStack(spacing: 8) {
                        Circle().fill(c.statusGreen).frame(width: 6, height: 6)
                        Text(channel).font(.callout).foregroundStyle(c.textPrimary).lineLimit(1)
                    }
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(c.card, in: RoundedRectangle(cornerRadius: MonitorRadius.card))
        .overlay(RoundedRectangle(cornerRadius: MonitorRadius.card).strokeBorder(cardBorder, lineWidth: 0.5))
    }
}
