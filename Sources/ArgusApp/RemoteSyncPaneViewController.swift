import AppKit
import CoreImage

/// Sync pane — pairing, connection state and paired-device management for the
/// agentlink remote channel.
///
/// Cards: connection (relay + start/stop), pairing (button → popover with code
/// + QR) and devices (paired list). Pairing shells out to `daemon pair --json`
/// and reads the code off its structured stdout, so the user never touches a
/// terminal.
final class RemoteSyncPaneViewController: NSViewController, NSPopoverDelegate {
    private let bridge: AgentlinkBridge

    private let statusDot = Glass.statusDot()
    private let statusLabel = NSTextField(labelWithString: "")
    private let sessionLabel = NSTextField(labelWithString: "")
    private let relayURLField = NSTextField()
    private let startStopButton = NSButton()

    private let pairButton = NSButton()
    private let codeLabel = Glass.codeDisplay("")
    private let codeHint = Glass.caption("")
    private let qrImageView = NSImageView()
    // The code + QR live in a popover anchored to the pair button: the pane
    // itself stays clean once paired, and dismissing the popover cancels the
    // attempt (配对成功后隐藏，需要再配再显示).
    private var pairPopover: NSPopover?

    private var deviceListStack: NSStackView!
    private let noDevicesLabel = Glass.caption("")

    private let hookConfigField = NSTextView()
    private var hookCard: NSView!

    // Local daemon prerequisites — bun runtime + project checkout. Surfaced in
    // their own card so "Failed to start: bun not found" has a fix path in the UI.
    private let bunPathLabel = Glass.mono("")
    private let projectPathLabel = Glass.mono("")

    private let errorLabel = NSTextField(labelWithString: "")
    private var pairProcess: Process?
    // Pairing-code expiry: countdown driven by the daemon's ttlSeconds; when it
    // hits zero the process is torn down and a fresh code is minted, so the QR
    // on screen is always scannable (不然 GUI 上只能扫到过期码).
    private var pairCountdown: Timer?
    private var pairRemaining = 0
    private var pairSucceeded = false
    private var pairExpired = false

    init(bridge: AgentlinkBridge) {
        self.bridge = bridge
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not supported") }

    override func loadView() {
        // Sized + autoresizing like every other pane: NSTabView hands the item's
        // view a frame, not constraints, so a zero-sized constraint-driven root
        // renders as a blank tab.
        let container = NSView(frame: NSRect(x: 0, y: 0, width: 560, height: 440))
        container.autoresizingMask = [.width, .height]
        view = container
        buildContent()
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        bridge.onStateChange = { [weak self] in
            DispatchQueue.main.async { self?.refresh() }
        }
        relayURLField.stringValue = bridge.getRelayURL()
        refresh()
    }

    override func viewWillDisappear() {
        super.viewWillDisappear()
        // Leaving the pane ends the pairing attempt — otherwise the countdown
        // would keep minting fresh codes off-screen forever.
        pairPopover?.performClose(nil)
        stopPairCountdown()
        pairProcess?.terminate()
    }

    // MARK: - Refresh

    func refresh() {
        applyConnectionState()
        applyHookConfig()
        reloadDevices()
        refreshDaemonCard()
        startStopButton.title = bridge.isRunning
            ? NSL("sync.stop", "Stop watching")
            : NSL("sync.start", "Start watching")
        if let err = bridge.lastError {
            errorLabel.stringValue = err
            errorLabel.isHidden = false
        } else {
            errorLabel.isHidden = true
        }
    }

    private func applyConnectionState() {
        let text: String
        let color: NSColor
        switch bridge.connectionState {
        case "channel-ready":
            text = NSL("sync.state.connected", "Connected")
            color = .systemGreen
        case "connecting", "pairing":
            text = NSL("sync.state.connecting", "Connecting…")
            color = .systemOrange
        default:
            text = NSL("sync.state.offline", "Not connected")
            color = .systemGray
        }
        statusLabel.stringValue = text
        Glass.tint(statusDot, color)
        sessionLabel.stringValue = bridge.sessionCount > 0
            ? String(format: NSL("sync.sessions", "%d active session(s)"), bridge.sessionCount)
            : NSL("sync.noSessions", "No active sessions")
    }

    private func applyHookConfig() {
        guard !bridge.hookSecret.isEmpty else {
            hookCard.isHidden = true
            return
        }
        hookCard.isHidden = false
        hookConfigField.string = """
        {
          "PermissionRequest": [{
            "hooks": [{
              "type": "http",
              "url": "http://127.0.0.1:\(bridge.hookPort)/hook",
              "headers": { "X-Agentlink-Secret": "\(bridge.hookSecret)" }
            }]
          }]
        }
        """
    }

    private func refreshDaemonCard() {
        if let bun = AgentlinkBridge.bunPath() {
            bunPathLabel.stringValue = bun
            bunPathLabel.textColor = .secondaryLabelColor
        } else {
            bunPathLabel.stringValue = NSL("sync.bun.missing", "not found — brew install oven-sh/bun/bun")
            bunPathLabel.textColor = .systemRed
        }
        let project = AgentlinkBridge.projectDir()
        projectPathLabel.stringValue = project
        projectPathLabel.textColor = FileManager.default.fileExists(atPath: AgentlinkBridge.daemonEntry())
            ? .secondaryLabelColor : .systemRed
    }

    private func reloadDevices() {
        deviceListStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        let peers = AgentlinkPeers.load()
        noDevicesLabel.isHidden = !peers.isEmpty
        for peer in peers.sorted(by: { $0.pairedAt > $1.pairedAt }) {
            deviceListStack.addArrangedSubview(makeDeviceRow(peer))
        }
    }

    private func makeDeviceRow(_ peer: AgentlinkPeers.Peer) -> NSView {
        let icon = NSImageView()
        let symbol = peer.platform.contains("android") ? "candybarphone" : "iphone"
        icon.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
            ?? NSImage(systemSymbolName: "desktopcomputer", accessibilityDescription: nil)
        icon.contentTintColor = .secondaryLabelColor
        icon.translatesAutoresizingMaskIntoConstraints = false

        // Editable name — commits on Enter / focus loss via the text-field delegate.
        let name = NSTextField(string: peer.deviceName)
        name.font = .systemFont(ofSize: 12, weight: .medium)
        name.isBordered = false
        name.drawsBackground = false
        name.focusRingType = .default
        name.translatesAutoresizingMaskIntoConstraints = false
        name.target = self
        name.action = #selector(deviceNameCommitted(_:))
        // Carry the fingerprint on the control so the action knows which peer to rename.
        name.identifier = NSUserInterfaceItemIdentifier(peer.fingerprint)

        let when = Glass.caption(DateFormatter.localizedString(
            from: Date(timeIntervalSince1970: peer.pairedAt / 1000),
            dateStyle: .short, timeStyle: .short))

        let forget = NSButton(title: "", target: self, action: #selector(forgetDeviceTapped(_:)))
        forget.image = NSImage(systemSymbolName: "trash", accessibilityDescription: NSL("sync.forget", "Forget device"))
        forget.bezelStyle = .accessoryBarAction
        forget.isBordered = false
        forget.contentTintColor = .secondaryLabelColor
        forget.translatesAutoresizingMaskIntoConstraints = false
        forget.identifier = NSUserInterfaceItemIdentifier(peer.fingerprint)
        forget.toolTip = NSL("sync.forget", "Forget device")

        let text = Glass.vStack([name, Glass.mono(peer.fingerprint, size: 10), when], spacing: 2)
        let spacer = NSView()
        spacer.translatesAutoresizingMaskIntoConstraints = false
        let row = Glass.hStack([icon, text, spacer, forget], spacing: 10)
        name.widthAnchor.constraint(greaterThanOrEqualToConstant: 140).isActive = true
        return row
    }

    /// Renames a peer through the daemon so both sides read the same peers.json.
    @objc private func deviceNameCommitted(_ sender: NSTextField) {
        guard let fingerprint = sender.identifier?.rawValue else { return }
        let newName = sender.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !newName.isEmpty else { reloadDevices(); return }
        runDaemonOneShot(["rename", fingerprint, newName, "--json"])
    }

    @objc private func forgetDeviceTapped(_ sender: NSButton) {
        guard let fingerprint = sender.identifier?.rawValue else { return }
        let alert = NSAlert()
        alert.messageText = NSL("sync.forget.confirm", "Forget this device?")
        alert.informativeText = NSL("sync.forget.body",
                                    "The phone will need a new pairing code to reconnect.")
        alert.addButton(withTitle: NSL("sync.forget", "Forget"))
        alert.addButton(withTitle: NSL("common.cancel", "Cancel"))
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        runDaemonOneShot(["forget", fingerprint, "--json"])
    }

    /// Fire-and-wait daemon invocation for the short peers.json mutations.
    private func runDaemonOneShot(_ arguments: [String]) {
        let p = AgentlinkBridge.makeDaemonProcess(arguments: arguments,
                                                 relayURL: relayURLField.stringValue)
        p.standardOutput = Pipe()
        p.standardError = Pipe()
        p.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async { self?.reloadDevices() }
        }
        do {
            try p.run()
        } catch {
            errorLabel.stringValue = error.localizedDescription
            errorLabel.isHidden = false
        }
    }

    // MARK: - Layout

    private func buildContent() {
        startStopButton.title = NSL("sync.start", "Start watching")
        startStopButton.target = self
        startStopButton.action = #selector(startStopTapped)
        startStopButton.bezelStyle = .rounded
        startStopButton.controlSize = .large
        startStopButton.translatesAutoresizingMaskIntoConstraints = false

        pairButton.title = NSL("sync.pair", "Pair a device…")
        pairButton.target = self
        pairButton.action = #selector(pairTapped)
        pairButton.bezelStyle = .rounded
        pairButton.controlSize = .large
        pairButton.translatesAutoresizingMaskIntoConstraints = false

        errorLabel.textColor = .systemRed
        errorLabel.font = .systemFont(ofSize: 11)
        errorLabel.isHidden = true
        errorLabel.lineBreakMode = .byWordWrapping
        errorLabel.maximumNumberOfLines = 3

        hookCard = buildHookCard()

        // Shared page container — its documentView is flipped, so content hugs
        // the top. The hand-rolled scroll view this replaced used a default
        // (bottom-origin) clip view, which floated the whole pane to the bottom
        // and read as a huge dead zone above the first card.
        Glass.installPage([
            Glass.caption(NSL("sync.subtitle",
                              "Mirror agent sessions to your phone and approve tool calls remotely. End-to-end encrypted — the relay only ever sees ciphertext.")),
            buildConnectionCard(),
            buildPairingCard(),
            buildDevicesCard(),
            buildDaemonCard(),
            hookCard,
            errorLabel,
        ], in: view)
    }

    private func buildConnectionCard() -> NSView {
        statusLabel.font = .systemFont(ofSize: 15, weight: .semibold)
        sessionLabel.font = .systemFont(ofSize: 11)
        sessionLabel.textColor = .secondaryLabelColor

        relayURLField.placeholderString = "wss://relay.limen.codes/ws"
        relayURLField.translatesAutoresizingMaskIntoConstraints = false
        relayURLField.font = .monospacedSystemFont(ofSize: 11, weight: .regular)

        let content = Glass.vStack([
            Glass.hStack([statusDot, statusLabel], spacing: 8),
            sessionLabel,
            Glass.vStack([Glass.heading(NSL("sync.relayURL", "Relay URL")), relayURLField], spacing: 4),
            startStopButton,
        ], spacing: 12)
        let card = Glass.wrap(content)
        relayURLField.widthAnchor.constraint(greaterThanOrEqualToConstant: 260).isActive = true
        return card
    }

    private func buildPairingCard() -> NSView {
        let content = Glass.vStack([
            Glass.heading(NSL("sync.pairing", "Pairing")),
            Glass.caption(NSL("sync.pairing.help",
                              "Generate a code, then enter it in Argus on your phone (or scan the QR). Single-use, expires in 5 minutes.")),
            pairButton,
        ], spacing: 10)
        return Glass.wrap(content)
    }

    /// Popover hosting the pairing code + QR, anchored to the pair button.
    private func makePairPopover() -> NSPopover {
        qrImageView.translatesAutoresizingMaskIntoConstraints = false
        qrImageView.imageScaling = .scaleProportionallyUpOrDown
        qrImageView.wantsLayer = true
        qrImageView.layer?.cornerRadius = 8
        qrImageView.layer?.cornerCurve = .continuous
        qrImageView.layer?.backgroundColor = NSColor.white.cgColor

        let stack = Glass.vStack([codeLabel, codeHint, qrImageView], spacing: 8, alignment: .centerX)
        let vc = NSViewController()
        let root = NSView()
        root.addSubview(stack)
        NSLayoutConstraint.activate([
            qrImageView.widthAnchor.constraint(equalToConstant: 160),
            qrImageView.heightAnchor.constraint(equalToConstant: 160),
            stack.topAnchor.constraint(equalTo: root.topAnchor, constant: 16),
            stack.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -20),
            stack.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -16),
        ])
        vc.view = root
        let popover = NSPopover()
        popover.contentViewController = vc
        popover.behavior = .transient
        popover.delegate = self
        return popover
    }

    // NSPopoverDelegate — dismissing the popover cancels the pairing attempt
    // (unless it already finished; terminate on a dead process is a no-op).
    func popoverDidClose(_ notification: Notification) {
        stopPairCountdown()
        pairExpired = false
        pairProcess?.terminate()
        pairPopover = nil
    }

    private func buildDevicesCard() -> NSView {
        deviceListStack = Glass.vStack([], spacing: 12)
        noDevicesLabel.stringValue = NSL("sync.noDevices", "No paired devices yet.")
        let content = Glass.vStack([
            Glass.heading(NSL("sync.devices", "Paired devices")),
            noDevicesLabel,
            deviceListStack,
        ], spacing: 10)
        return Glass.wrap(content)
    }

    private func buildHookCard() -> NSView {
        hookConfigField.translatesAutoresizingMaskIntoConstraints = false
        hookConfigField.isEditable = false
        hookConfigField.font = .monospacedSystemFont(ofSize: 10, weight: .regular)
        hookConfigField.drawsBackground = false
        hookConfigField.textColor = .secondaryLabelColor

        let content = Glass.vStack([
            Glass.heading(NSL("sync.hook", "Qoder approval hook")),
            Glass.caption(NSL("sync.hook.help",
                              "Paste this into the hooks section of ~/.qoder/settings.json so approval prompts reach your phone.")),
            hookConfigField,
            Glass.secondaryButton(NSL("sync.copyHook", "Copy"), target: self, action: #selector(copyHookConfig)),
        ], spacing: 8)

        let card = Glass.wrap(content)
        NSLayoutConstraint.activate([
            hookConfigField.heightAnchor.constraint(equalToConstant: 120),
            hookConfigField.widthAnchor.constraint(greaterThanOrEqualToConstant: 260),
        ])
        card.isHidden = true
        return card
    }

    /// Prerequisites card: which bun runs the daemon, and where the agentlink
    /// checkout lives (changeable — the default is one machine's path).
    private func buildDaemonCard() -> NSView {
        let choose = Glass.secondaryButton(NSL("sync.choose", "Choose…"),
                                           target: self, action: #selector(chooseProjectTapped))
        choose.controlSize = .regular
        let content = Glass.vStack([
            Glass.heading(NSL("sync.daemon", "Local daemon")),
            Glass.caption(NSL("sync.daemon.help",
                              "The sync daemon runs from your agentlink checkout via the Bun runtime. Both must exist on this Mac.")),
            Glass.vStack([Glass.heading(NSL("sync.bun", "Bun")), bunPathLabel], spacing: 2),
            Glass.vStack([Glass.heading(NSL("sync.projectDir", "Project folder")),
                          projectPathLabel,
                          choose], spacing: 4),
        ], spacing: 8)
        return Glass.wrap(content)
    }

    @objc private func chooseProjectTapped() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.directoryURL = URL(fileURLWithPath: AgentlinkBridge.projectDir())
        panel.prompt = NSL("sync.choose", "Choose…")
        guard panel.runModal() == .OK, let url = panel.url else { return }
        UserDefaults.standard.set(url.path, forKey: "AgentlinkProjectDir")
        refresh()
    }

    // MARK: - Actions

    @objc private func startStopTapped() {
        if bridge.isRunning {
            bridge.stop()
        } else {
            bridge.setRelayURL(relayURLField.stringValue)
            bridge.start()
        }
    }

    @objc private func copyHookConfig() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(hookConfigField.string, forType: .string)
    }

    /// Runs `daemon pair --json --no-serve` and surfaces the code it prints.
    @objc private func pairTapped() {
        guard pairProcess == nil else { return }
        // Same preflight as start() — a missing bun/checkout otherwise dies as
        // an opaque NSCocoaErrorDomain message.
        if let err = AgentlinkBridge.preflightError() {
            errorLabel.stringValue = err
            errorLabel.isHidden = false
            return
        }
        errorLabel.isHidden = true
        bridge.setRelayURL(relayURLField.stringValue)

        let p = AgentlinkBridge.makeDaemonProcess(
            arguments: ["pair", "--json", "--no-serve"],
            relayURL: relayURLField.stringValue)
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe

        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            for line in text.split(separator: "\n") {
                guard let out = AgentlinkDaemonOutput.parse(String(line).trimmingCharacters(in: .whitespaces))
                else { continue }
                DispatchQueue.main.async { self?.handlePairOutput(out) }
            }
        }
        p.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.pairProcess = nil
                self.pairButton.isEnabled = true
                self.stopPairCountdown()
                self.reloadDevices()
                // Auto-refresh: only when the code genuinely timed out (not on
                // relay/daemon errors — those would loop) and the popover is
                // still up and nothing paired.
                if self.pairExpired && !self.pairSucceeded && self.pairPopover?.isShown == true {
                    self.pairExpired = false
                    self.pairTapped()
                }
            }
        }
        do {
            try p.run()
            pairProcess = p
            pairSucceeded = false
            pairExpired = false
            codeLabel.stringValue = NSL("sync.generating", "Generating…")
            codeHint.stringValue = ""
            qrImageView.image = nil
            if pairPopover?.isShown != true {
                let popover = makePairPopover()
                pairPopover = popover
                popover.show(relativeTo: pairButton.bounds, of: pairButton, preferredEdge: .maxY)
            }
        } catch {
            errorLabel.stringValue = error.localizedDescription
            errorLabel.isHidden = false
        }
    }

    private func handlePairOutput(_ out: AgentlinkDaemonOutput) {
        switch out.type {
        case "pair_code":
            guard let code = out.code else { return }
            codeLabel.stringValue = code
            startPairCountdown(out.ttlSeconds ?? 300)
            qrImageView.image = RemoteSyncPaneViewController.makeQR(
                from: "argus://pair?code=\(code)&relay=\(relayURLField.stringValue)")
        case "pair_done":
            pairSucceeded = true
            stopPairCountdown()
            codeLabel.stringValue = NSL("sync.paired", "Paired")
            codeHint.stringValue = out.deviceName ?? ""
            qrImageView.image = nil
            reloadDevices()
            // Linger just long enough to read the "Paired" confirmation, then
            // tuck the popover away — the pane stays clean once paired.
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
                self?.pairPopover?.performClose(nil)
            }
        case "error":
            errorLabel.stringValue = out.message ?? "pairing failed"
            errorLabel.isHidden = false
        default:
            break
        }
    }

    // MARK: - Pairing-code countdown

    private func startPairCountdown(_ seconds: Int) {
        pairCountdown?.invalidate()
        pairRemaining = seconds
        updateCountdownHint()
        let t = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            self.pairRemaining -= 1
            if self.pairRemaining <= 0 {
                self.stopPairCountdown()
                self.pairExpired = true
                // terminationHandler notices pairExpired and mints a new code.
                self.pairProcess?.terminate()
            } else {
                self.updateCountdownHint()
            }
        }
        RunLoop.main.add(t, forMode: .common)
        pairCountdown = t
    }

    private func stopPairCountdown() {
        pairCountdown?.invalidate()
        pairCountdown = nil
    }

    private func updateCountdownHint() {
        let clock = String(format: "%d:%02d", pairRemaining / 60, pairRemaining % 60)
        codeHint.stringValue = NSLf("sync.codeHint.countdown",
                                    "Enter this code in Argus on your phone · expires in %@", clock)
    }

    /// CoreImage QR generator — no third-party dependency.
    private static func makeQR(from string: String) -> NSImage? {
        guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        filter.setValue(string.data(using: .utf8), forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 8, y: 8))
        let rep = NSCIImageRep(ciImage: scaled)
        let image = NSImage(size: rep.size)
        image.addRepresentation(rep)
        return image
    }
}
