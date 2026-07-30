import SwiftUI
import AppKit
import Charts

/// The monitor window: a SwiftUI dashboard over AppKit/C plumbing, opened from
/// the menu bar. The pane audit found nearly every *stateful* surface (thermal
/// chart, live agent list, guard state) trapped inside Settings — those are
/// things you glance at, not things you configure, so they live here instead.
///
/// Design follows the 2025-era menu-bar-monitor idiom (Pulse, iStat Menus 7,
/// Sensei): material backdrop, rounded cards, gradient-filled area chart, a
/// ring gauge for the bounded value, threshold colours as the only loud
/// colours, monospaced digits so a ticking number never shifts the layout.

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

    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                statusCard
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
        .background(.regularMaterial)
        .frame(minWidth: 340)
    }

    // MARK: Status card

    private var statusCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 10) {
                Circle()
                    .fill(dotColor)
                    .frame(width: 10, height: 10)
                Text(model.headline)
                    .font(.headline)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                if !model.elapsedText.isEmpty {
                    Text(model.elapsedText)
                        .font(.system(.title3, design: .monospaced).weight(.medium))
                        .foregroundStyle(.secondary)
                        .contentTransition(.numericText())
                        .animation(.default, value: model.elapsedText)
                }
            }
            if !model.guardLines.isEmpty {
                Divider()
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(model.guardLines, id: \.self) { line in
                        Text(line)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(14)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
    }

    private var dotColor: Color {
        switch model.dotState {
        case .holding: return .green
        case .attention: return .orange
        case .idle: return .gray
        }
    }

    // MARK: Thermal card (gradient area chart)

    private var thermalCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(NSL("monitor.temperature", "Temperature"), systemImage: "thermometer.medium")
                .font(.subheadline)
                .foregroundStyle(.secondary)
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
                    .foregroundStyle(.tertiary)
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
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
    }

    /// Nominal stays orange (temperature's colour); pressure turns the whole
    /// card red so the glance answer changes before any number is read.
    private var thermalAccent: Color {
        model.thermalLevel >= 2 ? .red : .orange
    }

    private func tempChip(_ label: String, _ value: Double?) -> some View {
        HStack(spacing: 4) {
            Text(label).font(.caption).foregroundStyle(.tertiary)
            Text(value.map { String(format: "%.0f°", $0) } ?? "—")
                .font(.system(.callout, design: .rounded).monospacedDigit())
        }
    }

    // MARK: Battery ring

    private var batteryCard: some View {
        VStack(spacing: 10) {
            Label(NSL("monitor.battery", "Battery"), systemImage: "battery.75percent")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            ZStack {
                Circle().stroke(.quaternary, lineWidth: 9)
                if let pct = model.batteryPercent {
                    Circle()
                        .trim(from: 0, to: CGFloat(pct) / 100)
                        .stroke(batteryColor(pct),
                                style: StrokeStyle(lineWidth: 9, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                        .animation(.easeInOut(duration: 0.4), value: pct)
                    Text("\(pct)%")
                        .font(.system(.title3, design: .rounded).weight(.semibold).monospacedDigit())
                } else {
                    Text("—")
                        .font(.title3)
                        .foregroundStyle(.tertiary)
                }
            }
            .frame(width: 92, height: 92)
            Text(NSLf("monitor.guardAt", "guard %d%%", model.batteryLowThreshold))
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .padding(12)
        .frame(maxWidth: .infinity)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
    }

    private func batteryColor(_ pct: Int) -> Color {
        if pct <= 10 { return .red }
        if pct <= model.batteryLowThreshold { return .orange }
        return .green
    }

    // MARK: Agents

    private var agentsCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(NSL("monitor.activeAgents", "Active agents"), systemImage: "cpu")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            if model.activeAgents.isEmpty {
                Text(NSL("monitor.noAgents", "None running"))
                    .font(.callout)
                    .foregroundStyle(.tertiary)
            } else {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 100), spacing: 8)], spacing: 8) {
                    ForEach(model.activeAgents, id: \.self) { name in
                        HStack(spacing: 6) {
                            Circle().fill(.green).frame(width: 6, height: 6)
                            Text(name).font(.callout).lineLimit(1)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(.quaternary.opacity(0.5), in: Capsule())
                    }
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
    }

    // MARK: Remote channels

    private var remoteCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(NSL("monitor.remote", "Remote sessions"), systemImage: "network")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            if model.remoteChannels.isEmpty {
                Text(NSL("monitor.noRemote", "No remote connections"))
                    .font(.callout)
                    .foregroundStyle(.tertiary)
            } else {
                ForEach(model.remoteChannels, id: \.self) { channel in
                    HStack(spacing: 6) {
                        Circle().fill(.green).frame(width: 6, height: 6)
                        Text(channel).font(.callout).lineLimit(1)
                    }
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
    }
}
