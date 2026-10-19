import AppKit
import ApplicationServices
import ScreenCaptureKit
import Network
import CoreImage
import CoreMedia

final class FrameOutput: NSObject, SCStreamOutput, SCStreamDelegate {
    let context = CIContext(options: [.cacheIntermediates: false])
    let onFrame: (Data, Int, Int) -> Void
    let onFailure: (String) -> Void
    init(onFrame: @escaping (Data, Int, Int) -> Void, onFailure: @escaping (String) -> Void) {
        self.onFrame = onFrame; self.onFailure = onFailure
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid, let pixelBuffer = sampleBuffer.imageBuffer else { return }
        let image = CIImage(cvPixelBuffer: pixelBuffer)
        guard let cg = context.createCGImage(image, from: image.extent),
              let data = NSBitmapImageRep(cgImage: cg).representation(using: .jpeg, properties: [.compressionFactor: 0.82]) else { return }
        onFrame(data, cg.width, cg.height)
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) { onFailure(String(describing: error)) }
}

private let targetBundle = "com.openai.codex"
private let servicePort: UInt16 = 18942

struct ViewFailure: Error { let message: String }
struct HTTPRequest {
    let method: String
    let path: String
    let headers: [String: String]
    let body: Data
}

@MainActor
final class AppView: NSObject, NSApplicationDelegate {
    private var listener: NWListener?
    private var statusItem: NSStatusItem?
    private var setupWindow: NSWindow?
    private var setupLabel: NSTextField?
    private var windows: [SCWindow] = []
    private var selected: SCWindow?
    private var jpeg: Data?
    private var lastError = ""
    private var frameCount = 0
    private var captureWidth = 0
    private var captureHeight = 0
    private var subscribers: [UUID: NWConnection] = [:]
    private var busySubscribers = Set<UUID>()
    private let csrf = UUID().uuidString + UUID().uuidString
    private var lastRefresh = Date.distantPast
    private var activeCapture = false
    private var captureStage = "starting"
    private var captureAttempts = 0
    private var captureStream: SCStream?
    private var streamOutput: FrameOutput?
    private var streamWindowID: CGWindowID?
    private var streamWindowSize = CGSize.zero
    private var lastFrameDemand = Date.distantPast
    private var menuTimer: Timer?
    private var pointer = CGPoint.zero

    func applicationDidFinishLaunching(_ notification: Notification) {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "Argus ▣"
        let menu = NSMenu()
        let setup = NSMenuItem(title: "窗口转发与授权…", action: #selector(showSetup), keyEquivalent: "")
        setup.target = self
        menu.addItem(setup)
        let quit = NSMenuItem(title: "退出窗口转发", action: #selector(quitApp), keyEquivalent: "")
        quit.target = self
        menu.addItem(quit)
        item.menu = menu
        statusItem = item
        do { try startServer() } catch { lastError = "本机服务启动失败：\(error)"; showSetup() }
        if !CGPreflightScreenCaptureAccess() || !AXIsProcessTrusted() { showSetup() }
        Task { await captureLoop() }
    }

    @objc private func quitApp() { NSApplication.shared.terminate(nil) }

    @objc private func showSetup() {
        if let window = setupWindow { updateSetupLabel(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); return }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 510, height: 330), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Argus App View · Mac 窗口转发"
        window.isReleasedWhenClosed = false
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 17
        stack.translatesAutoresizingMaskIntoConstraints = false
        let heading = NSTextField(labelWithString: "把现有 ChatGPT / Codex 窗口带到另一台电脑")
        heading.font = .boldSystemFont(ofSize: 17)
        stack.addArrangedSubview(heading)
        let info = NSTextField(wrappingLabelWithString: "首次使用需在这台 Mac 的系统设置中允许两项权限。授权后，回到 Windows 网页即可查看和操作现有窗口。")
        stack.addArrangedSubview(info)
        let status = NSTextField(wrappingLabelWithString: "")
        setupLabel = status
        stack.addArrangedSubview(status)
        for (title, action) in [("1. 允许屏幕录制", #selector(requestScreen)), ("2. 允许辅助功能", #selector(requestAccessibility)), ("刷新授权状态", #selector(refreshSetup))] {
            let button = NSButton(title: title, target: self, action: action)
            button.bezelStyle = .rounded
            stack.addArrangedSubview(button)
        }
        window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 26), stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -26), stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 26)])
        setupWindow = window
        updateSetupLabel()
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func updateSetupLabel() {
        setupLabel?.stringValue = "屏幕录制：\(CGPreflightScreenCaptureAccess() ? "已允许" : "待授权")    辅助功能：\(AXIsProcessTrusted() ? "已允许" : "待授权")\n组件仅连接当前用户的 ChatGPT / Codex App。"
    }

    @objc private func refreshSetup() { updateSetupLabel() }
    @objc private func requestScreen() {
        if !CGRequestScreenCaptureAccess(), let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") { NSWorkspace.shared.open(url) }
        updateSetupLabel()
    }
    @objc private func requestAccessibility() {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") { NSWorkspace.shared.open(url) }
        updateSetupLabel()
    }

    private func refreshWindows() async throws {
        guard CGPreflightScreenCaptureAccess() else { throw ViewFailure(message: "请先在 Mac 允许屏幕录制") }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        windows = content.windows.filter { $0.owningApplication?.bundleIdentifier == targetBundle && $0.frame.width >= 220 && $0.frame.height >= 140 && $0.windowLayer == 0 }
        if let current = selected, let updated = windows.first(where: { $0.windowID == current.windowID }) { selected = updated }
        else { selected = windows.sorted { $0.frame.width * $0.frame.height > $1.frame.width * $1.frame.height }.first }
        lastRefresh = Date()
    }

    private func captureLoop() async {
        activeCapture = true
        captureStage = "idle"
        while !Task.isCancelled {
            if (!subscribers.isEmpty || Date().timeIntervalSince(lastFrameDemand) < 4) && CGPreflightScreenCaptureAccess() {
                do {
                    if Date().timeIntervalSince(lastRefresh) > 2 || selected == nil { try await refreshWindows() }
                    if let window = selected {
                        if captureStream == nil || streamWindowID != window.windowID || streamWindowSize != window.frame.size {
                            if let previous = captureStream { try? await previous.stopCapture() }
                            captureAttempts += 1
                            captureStage = "starting-stream"
                            let filter = SCContentFilter(desktopIndependentWindow: window)
                            let config = SCStreamConfiguration()
                            let scale = min(1.5, 1920.0 / max(1, window.frame.width))
                            config.width = max(1, Int(window.frame.width * scale))
                            config.height = max(1, Int(window.frame.height * scale))
                            config.showsCursor = false
                            config.ignoreShadowsSingleWindow = true
                            config.includeChildWindows = true
                            config.minimumFrameInterval = CMTime(value: 1, timescale: 4)
                            config.queueDepth = 3
                            let output = FrameOutput(onFrame: { [weak self] data, width, height in
                                Task { @MainActor in
                                    guard let self = self else { return }
                                    self.jpeg = data
                                    self.captureWidth = width; self.captureHeight = height
                                    self.frameCount += 1; self.lastError = ""; self.captureStage = "streaming"
                                    self.pushFrame(data)
                                }
                            }, onFailure: { [weak self] message in
                                Task { @MainActor in self?.lastError = message; self?.captureStage = "error"; self?.captureStream = nil }
                            })
                            let stream = SCStream(filter: filter, configuration: config, delegate: output)
                            try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "codes.limen.argus-app-view.frames"))
                            streamOutput = output; captureStream = stream
                            streamWindowID = window.windowID; streamWindowSize = window.frame.size
                            try await stream.startCapture()
                            if frameCount == 0 { captureStage = "waiting-frame" }
                        }
                    } else { lastError = "Mac 上未找到可见的 ChatGPT / Codex 主窗口" }
                } catch { lastError = (error as? ViewFailure)?.message ?? String(describing: error); captureStage = "error" }
            } else if let stream = captureStream {
                try? await stream.stopCapture()
                captureStream = nil; streamOutput = nil; streamWindowID = nil
                captureStage = "idle"
            }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
    }

    private func pushFrame(_ data: Data) {
        for (id, connection) in subscribers where !busySubscribers.contains(id) {
            busySubscribers.insert(id)
            var part = Data("--argusframe\r\nContent-Type: image/jpeg\r\nContent-Length: \(data.count)\r\n\r\n".utf8)
            part.append(data); part.append(Data("\r\n".utf8))
            connection.send(content: part, completion: .contentProcessed { [weak self] error in
                Task { @MainActor in
                    self?.busySubscribers.remove(id)
                    if error != nil { self?.subscribers.removeValue(forKey: id); connection.cancel() }
                }
            })
        }
    }

    private func startServer() throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: NWEndpoint.Host("127.0.0.1"), port: NWEndpoint.Port(rawValue: servicePort)!)
        parameters.allowLocalEndpointReuse = true
        let listener = try NWListener(using: parameters)
        listener.newConnectionHandler = { [weak self] connection in
            connection.start(queue: .main)
            Task { @MainActor in self?.receive(connection, buffer: Data()) }
        }
        listener.stateUpdateHandler = { [weak self] state in
            if case .failed(let error) = state { Task { @MainActor in self?.lastError = "服务连接失败：\(error)" } }
        }
        listener.start(queue: .main)
        self.listener = listener
    }

    private func receive(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, complete, error in
            Task { @MainActor in
                guard let self = self else { connection.cancel(); return }
                var bytes = buffer
                if let data = data { bytes.append(data) }
                guard bytes.count <= 65536 else { self.reply(connection, status: 413, text: "request too large"); return }
                if let split = bytes.range(of: Data("\r\n\r\n".utf8)), let header = String(data: bytes[..<split.lowerBound], encoding: .utf8) {
                    let lines = header.components(separatedBy: "\r\n")
                    let first = (lines.first ?? "").split(separator: " ")
                    guard first.count == 3, first[2].hasPrefix("HTTP/1.") else { self.reply(connection, status: 400, text: "bad request"); return }
                    var headers: [String: String] = [:]
                    for line in lines.dropFirst() {
                        guard let colon = line.firstIndex(of: ":") else { continue }
                        headers[String(line[..<colon]).lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
                    }
                    guard headers["transfer-encoding"] == nil else { self.reply(connection, status: 400, text: "unsupported encoding"); return }
                    let bodySize = Int(headers["content-length"] ?? "0") ?? -1
                    guard bodySize >= 0 && bodySize <= 16384 else { self.reply(connection, status: 413, text: "request too large"); return }
                    if bytes.count - split.upperBound >= bodySize {
                        let request = HTTPRequest(method: String(first[0]), path: String(first[1]).components(separatedBy: "?")[0], headers: headers, body: Data(bytes[split.upperBound..<(split.upperBound + bodySize)]))
                        await self.handle(connection, request)
                        return
                    }
                }
                if complete || error != nil { connection.cancel() } else { self.receive(connection, buffer: bytes) }
            }
        }
    }

    private func handle(_ connection: NWConnection, _ request: HTTPRequest) async {
        let host = request.headers["host"] ?? ""
        guard let hostURL = URL(string: "http://" + host), ["localhost", "127.0.0.1"].contains(hostURL.host ?? "") else { reply(connection, status: 403, text: "loopback host required"); return }
        if request.method == "POST" {
            guard request.headers["origin"] == "http://" + host, request.headers["x-argus-token"] == csrf, request.headers["content-type"]?.hasPrefix("application/json") == true else { reply(connection, status: 403, text: "request verification failed"); return }
            guard let payload = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any] else { reply(connection, status: 400, text: "invalid JSON"); return }
            do {
                switch request.path {
                case "/api/select":
                    try await refreshWindows()
                    guard let id = payload["windowId"] as? UInt32, let window = windows.first(where: { $0.windowID == id }) else { throw ViewFailure(message: "请重新选择 ChatGPT 窗口") }
                    selected = window; jpeg = nil
                case "/api/input": try await input(payload)
                case "/api/permission":
                    if payload["kind"] as? String == "screen" { requestScreen() }
                    else if payload["kind"] as? String == "accessibility" { requestAccessibility() }
                    else { throw ViewFailure(message: "未知权限") }
                case "/api/focus": try activateTarget()
                default: reply(connection, status: 404, text: "not found"); return
                }
                replyJSON(connection, ["ok": true])
            } catch { replyJSON(connection, ["ok": false, "error": (error as? ViewFailure)?.message ?? String(describing: error)], status: 409) }
            return
        }
        guard request.method == "GET" else { reply(connection, status: 405, text: "method not allowed"); return }
        switch request.path {
        case "/api/session": replyJSON(connection, ["token": csrf])
        case "/api/status":
            replyJSON(connection, ["service": "argus-app-view", "version": "0.1.0", "screenRecording": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted(), "appRunning": !NSRunningApplication.runningApplications(withBundleIdentifier: targetBundle).isEmpty, "selectedWindowId": selected?.windowID as Any? ?? NSNull(), "frameWidth": captureWidth, "frameHeight": captureHeight, "frameCount": frameCount, "error": lastError, "captureLoopActive": activeCapture, "captureStage": captureStage, "captureAttempts": captureAttempts, "viewers": subscribers.count])
        case "/api/windows":
            do { try await refreshWindows(); replyJSON(connection, ["windows": windows.map { ["id": $0.windowID, "title": $0.title ?? "ChatGPT", "width": $0.frame.width, "height": $0.frame.height] }]) }
            catch { replyJSON(connection, ["windows": [], "error": (error as? ViewFailure)?.message ?? String(describing: error)]) }
        case "/stream":
            guard CGPreflightScreenCaptureAccess() else { reply(connection, status: 409, text: "screen recording permission required"); return }
            let id = UUID()
            connection.send(content: responseHead(status: 200, type: "multipart/x-mixed-replace; boundary=argusframe", length: nil), completion: .contentProcessed { [weak self] error in
                Task { @MainActor in
                    guard error == nil, let self = self else { connection.cancel(); return }
                    self.subscribers[id] = connection
                    connection.stateUpdateHandler = { [weak self] state in
                        if case .cancelled = state { Task { @MainActor in self?.subscribers.removeValue(forKey: id); self?.busySubscribers.remove(id) } }
                        if case .failed = state { Task { @MainActor in self?.subscribers.removeValue(forKey: id); self?.busySubscribers.remove(id) } }
                    }
                }
            })
        case "/frame.jpg":
            lastFrameDemand = Date()
            if let jpeg = jpeg { reply(connection, status: 200, type: "image/jpeg", data: jpeg) } else { reply(connection, status: 409, text: "frame unavailable") }
        case "/", "/app.js", "/style.css":
            let name = request.path == "/" ? "index.html" : String(request.path.dropFirst())
            let web = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/ArgusAppView/web")
            let base = FileManager.default.fileExists(atPath: web.appendingPathComponent(name).path) ? web : Bundle.main.resourceURL!
            guard let data = try? Data(contentsOf: base.appendingPathComponent(name)) else { reply(connection, status: 404, text: "resource missing"); return }
            let type = name.hasSuffix(".js") ? "text/javascript; charset=utf-8" : name.hasSuffix(".css") ? "text/css; charset=utf-8" : "text/html; charset=utf-8"
            reply(connection, status: 200, type: type, data: data)
        default: reply(connection, status: 404, text: "not found")
        }
    }

    private func activateTarget() throws {
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: targetBundle).first else { throw ViewFailure(message: "请先在 Mac 打开 ChatGPT / Codex") }
        app.activate(options: [])
    }

    private func input(_ payload: [String: Any]) async throws {
        guard AXIsProcessTrusted() else { throw ViewFailure(message: "请先在 Mac 允许辅助功能") }
        guard CGPreflightScreenCaptureAccess() else { throw ViewFailure(message: "请先在 Mac 允许屏幕录制") }
        if Date().timeIntervalSince(lastRefresh) > 1 { try await refreshWindows() }
        guard let window = selected, let app = window.owningApplication, app.bundleIdentifier == targetBundle,
              let running = NSRunningApplication(processIdentifier: app.processID), running.bundleIdentifier == targetBundle else { throw ViewFailure(message: "ChatGPT 窗口已关闭，请重新选择") }
        guard let kind = payload["kind"] as? String else { throw ViewFailure(message: "缺少输入类型") }
        try activateTarget()
        let source = CGEventSource(stateID: .hidSystemState)
        func post(_ event: CGEvent?) { event?.postToPid(app.processID) }
        var flags: CGEventFlags = []
        if payload["command"] as? Bool == true { flags.insert(.maskCommand) }
        if payload["control"] as? Bool == true { flags.insert(.maskControl) }
        if payload["shift"] as? Bool == true { flags.insert(.maskShift) }
        if payload["alt"] as? Bool == true { flags.insert(.maskAlternate) }
        if kind == "mouse" || kind == "scroll" {
            guard let x = payload["x"] as? Double, let y = payload["y"] as? Double, x.isFinite, y.isFinite, (0...1).contains(x), (0...1).contains(y) else { throw ViewFailure(message: "鼠标坐标无效") }
            pointer = CGPoint(x: window.frame.minX + x * window.frame.width, y: window.frame.minY + y * window.frame.height)
        }
        switch kind {
        case "mouse":
            let right = payload["button"] as? Int == 2
            let button: CGMouseButton = right ? .right : .left
            let phase = payload["phase"] as? String ?? ""
            let type: CGEventType
            switch phase { case "down": type = right ? .rightMouseDown : .leftMouseDown
            case "up": type = right ? .rightMouseUp : .leftMouseUp
            case "drag": type = right ? .rightMouseDragged : .leftMouseDragged
            default: throw ViewFailure(message: "鼠标动作无效") }
            let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: pointer, mouseButton: button)
            event?.flags = flags
            if let count = payload["clickCount"] as? Int { event?.setIntegerValueField(.mouseEventClickState, value: Int64(min(3, max(1, count)))) }
            post(event)
        case "scroll":
            let dx = min(1200, max(-1200, payload["dx"] as? Double ?? 0))
            let dy = min(1200, max(-1200, payload["dy"] as? Double ?? 0))
            let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: Int32(-dy), wheel2: Int32(-dx), wheel3: 0)
            event?.location = pointer; event?.flags = flags; post(event)
        case "key":
            guard let key = payload["keyCode"] as? Int, (0...126).contains(key) else { throw ViewFailure(message: "按键无效") }
            for down in [true, false] { let event = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(key), keyDown: down); event?.flags = flags; post(event) }
        case "text":
            guard let text = payload["text"] as? String, text.utf16.count <= 4000 else { throw ViewFailure(message: "一次最多输入 4000 字符") }
            let units = Array(text.utf16)
            for begin in stride(from: 0, to: units.count, by: 16) {
                let chunk = Array(units[begin..<min(begin + 16, units.count)])
                for down in [true, false] { let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down); event?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk); post(event) }
            }
        default: throw ViewFailure(message: "不支持的输入类型")
        }
    }

    private func responseHead(status: Int, type: String, length: Int?) -> Data {
        let phrase = [200: "OK", 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 409: "Conflict", 413: "Payload Too Large"][status] ?? "Error"
        var text = "HTTP/1.1 \(status) \(phrase)\r\nContent-Type: \(type)\r\nCache-Control: no-store\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nCross-Origin-Resource-Policy: same-origin\r\nContent-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'\r\n"
        if let length = length { text += "Content-Length: \(length)\r\n" }
        return Data((text + "\r\n").utf8)
    }
    private func reply(_ connection: NWConnection, status: Int, type: String = "text/plain; charset=utf-8", data: Data) {
        var response = responseHead(status: status, type: type, length: data.count); response.append(data)
        connection.send(content: response, completion: .contentProcessed { _ in connection.cancel() })
    }
    private func reply(_ connection: NWConnection, status: Int, text: String) { reply(connection, status: status, data: Data(text.utf8)) }
    private func replyJSON(_ connection: NWConnection, _ value: [String: Any], status: Int = 200) {
        let data = (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data("{}".utf8)
        reply(connection, status: status, type: "application/json; charset=utf-8", data: data)
    }
}

@main
struct Main {
    @MainActor static func main() {
        let application = NSApplication.shared
        let delegate = AppView()
        application.delegate = delegate
        application.setActivationPolicy(.accessory)
        withExtendedLifetime(delegate) { application.run() }
    }
}
