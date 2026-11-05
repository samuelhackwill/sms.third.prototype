import UIKit

final class StableWallController: UIViewController {
    private let connection = ConnectionManager(), state = StateStore(), diagnostics = Diagnostics(), media = MediaManager()
    private let host = UIView(), legacy = WallView(), blackout = UIView(), setup = UIStackView(), label = UILabel(), address = UITextField(), debugOverlay = UILabel()
    private lazy var library = ArtworkLibrary(media:media)
    private lazy var runtime = ArtworkRuntime(host:host,library:library)
    private lazy var kissing = KissingWallView(media:media)
    private let liveAlert = LiveMessageAlert()
    private let discovery = ServerDiscovery()
    private var displayLink: CADisplayLink?
    private let boot = ProcessInfo.processInfo.systemUptime
    private var identifying = false
    private let pairingScreen = UIButton(type:.custom)
    private var pairingSessionId: String?
    private var pairingAssigned = false
    private var beforePairingBrightness: CGFloat?
    private var pairingExpiry: DispatchWorkItem?
    private var frameWindowStart: CFTimeInterval = 0
    private var frameCount = 0
    private var displayLinkFps = -1.0
    private var lastDebugError: String?
    private func showDebugError(_ code: String) {
        lastDebugError = String(code.prefix(100))
        refreshDebugOverlay()
    }
    private func refreshDebugOverlay() {
        let enabled = state.state["debugEnabled"] as? Bool ?? false
        debugOverlay.isHidden = !enabled
        guard enabled else { return }
        let info = Bundle.main.infoDictionary ?? [:]
        let version = info["CFBundleShortVersionString"] as? String ?? "?"
        let build = info["CFBundleVersion"] as? String ?? "?"
        let connected = connection.isConnected
        debugOverlay.textColor = connected && lastDebugError == nil ? .green : .systemRed
        debugOverlay.text = "PhoneWall \(version) (\(build)) · \(connected ? "CONNECTED" : "OFFLINE")\n\(connection.endpoint?.host ?? "no controller")\(lastDebugError.map { "\nLast error: " + $0 } ?? "")"
        view.bringSubviewToFront(debugOverlay)
    }
    private func setPaired(_ paired: Bool) {
        setup.isHidden = paired
        if paired { view.endEditing(true) }
    }
    override var prefersStatusBarHidden: Bool { true }
    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .black
        for child in [legacy,host,kissing,blackout] { child.frame = view.bounds; child.autoresizingMask = [.flexibleWidth,.flexibleHeight]; view.addSubview(child) }
        blackout.backgroundColor = .black; blackout.isHidden = true
        label.text = "PHONE WALL\nDiscovering the local controller…"; label.textColor = .white; label.numberOfLines = 0
        let savedAddress = UserDefaults.standard.string(forKey:"serverURL")
        address.text = savedAddress == nil || savedAddress == "ws://mac-mini.local:3000/phone-wall/ws" ? "ws://sms-ingestor.local:3100/phone-wall/ws" : savedAddress
        address.borderStyle = .roundedRect; address.autocapitalizationType = .none; address.autocorrectionType = .no
        let button = UIButton(type:.system); button.setTitle("Connect",for:.normal); button.addTarget(self,action:#selector(configure),for:.touchUpInside)
        setup.axis = .vertical; setup.spacing = 16; [label,address,button].forEach{setup.addArrangedSubview($0)}; setup.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(setup)
        NSLayoutConstraint.activate([setup.centerYAnchor.constraint(equalTo:view.centerYAnchor),setup.leadingAnchor.constraint(equalTo:view.leadingAnchor,constant:24),setup.trailingAnchor.constraint(equalTo:view.trailingAnchor,constant:-24)])
        pairingScreen.frame = view.bounds; pairingScreen.autoresizingMask = [.flexibleWidth,.flexibleHeight]
        pairingScreen.titleLabel?.numberOfLines = 0; pairingScreen.titleLabel?.textAlignment = .center
        pairingScreen.titleLabel?.font = .boldSystemFont(ofSize:30); pairingScreen.setTitleColor(.white,for:.normal)
        pairingScreen.isHidden = true; pairingScreen.addTarget(self,action:#selector(pairingTapped),for:.touchUpInside); view.addSubview(pairingScreen)
        debugOverlay.numberOfLines = 0; debugOverlay.font = .monospacedSystemFont(ofSize:15,weight:.bold)
        debugOverlay.backgroundColor = UIColor.black.withAlphaComponent(0.85); debugOverlay.isHidden = true
        debugOverlay.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(debugOverlay)
        NSLayoutConstraint.activate([debugOverlay.topAnchor.constraint(equalTo:view.safeAreaLayoutGuide.topAnchor,constant:8),debugOverlay.leadingAnchor.constraint(equalTo:view.leadingAnchor,constant:8),debugOverlay.trailingAnchor.constraint(equalTo:view.trailingAnchor,constant:-8)])
        setup.isHidden = !state.state.isEmpty
        runtime.clockOffset = { [weak self] in guard let self = self else { return 0 }; return self.connection.hasClockSample ? self.connection.offset : self.runtime.restoredOffset }
        liveAlert.canPlay = { [weak self] in
            guard let self = self else { return false }
            return self.connection.isConnected && self.state.state["mode"] as? String == "exhibition" && !self.kissing.enabled && !self.identifying && self.pairingSessionId == nil
        }
        runtime.report = { [weak self] payload in
            guard let self = self else { return }
            if payload["status"] as? String == "error" { self.showDebugError(payload["code"] as? String ?? "artwork-error") }
            self.connection.send("artwork.status",payload)
        }
        runtime.onTickerMessage = { [weak self] type,payload in self?.connection.send(type,payload) }
        kissing.report = { [weak self] payload in
            guard let self = self else { return }
            if ["error","prefetch-error"].contains(payload["status"] as? String ?? "") { self.showDebugError(payload["code"] as? String ?? "kissing-error") }
            self.connection.send("kissing.status",payload)
        }
        runtime.onDiagnostic = { [weak self] code in self?.diagnostics.record(code); self?.showDebugError(code); self?.connection.send("client.error",["code":code]) }
        runtime.onActivated = { [weak self] in guard let self = self else { return }; self.setup.isHidden = true; self.legacy.isHidden = !self.identifying; self.view.bringSubviewToFront(self.pairingScreen); self.refreshDebugOverlay() }
        let initialMode = state.state["mode"] as? String ?? "exhibition"
        runtime.setMode(initialMode); blackout.isHidden = initialMode == "exhibition"
        kissing.setMode(initialMode)
        if let saved = state.state["kissing"] as? [String:Any] { kissing.receive(saved) }
        if kissing.enabled { runtime.setMode("night") }
        if initialMode == "night" { UIScreen.main.brightness = CGFloat(state.state["nightBrightness"] as? Double ?? 0) }
        runtime.restore()
        connection.onMessage = { [weak self] type,payload,revision in self?.receive(type,payload,revision) }
        connection.onDisconnect = { [weak self] in
            guard let self = self else { return }
            self.diagnostics.record("connection-lost-retaining-artwork")
            self.showDebugError("connection-lost")
            self.liveAlert.disconnect()
            self.runtime.receiveTicker(["enabled":false,"runs":[]])
            if self.pairingSessionId != nil { self.pairingScreen.isEnabled = false; self.pairingScreen.setTitle("OFFLINE\nWaiting for controller…",for:.normal) }
        }
        connection.onStatus = { [weak self] status in
            self?.label.text = status
            if status.hasPrefix("Controller unavailable") { self?.showDebugError("controller-unavailable") }
            else { self?.refreshDebugOverlay() }
        }
        connection.heartbeat = { [weak self] in
            guard let self = self else { return [:] }
            let batteryState = UIDevice.current.batteryState
            let charging: Any = batteryState == .unknown ? NSNull() : [UIDevice.BatteryState.charging,.full].contains(batteryState)
            let freeDisk = ((try? FileManager.default.attributesOfFileSystem(forPath:NSHomeDirectory()))?[.systemFreeSize] as? NSNumber)?.int64Value ?? 0
            return ["battery":UIDevice.current.batteryLevel,"charging":charging,"thermalState":ProcessInfo.processInfo.thermalState.rawValue,"foreground":UIApplication.shared.applicationState == .active,"lastRevision":self.state.revision,"currentSceneId":self.kissing.enabled ? "kissing-wall" : self.runtime.activeReleaseId ?? "legacy","uptime":ProcessInfo.processInfo.systemUptime-self.boot,"mediaState":self.kissing.enabled ? self.kissing.status : self.runtime.status,"displayLinkFps":self.displayLinkFps,"targetFps":60,"freeDisk":freeDisk]
        }
        for name in [UIDevice.batteryStateDidChangeNotification,UIDevice.batteryLevelDidChangeNotification] { NotificationCenter.default.addObserver(self,selector:#selector(powerChanged),name:name,object:nil) }
        displayLink = CADisplayLink(target:self,selector:#selector(tick(_:))); displayLink?.preferredFramesPerSecond = 60; displayLink?.add(to:.main,forMode:.common)
        configure()
        #if targetEnvironment(simulator)
        if ProcessInfo.processInfo.arguments.contains("-phoneWallDisableDiscovery") { return }
        #endif
        discovery.onEndpoint = { [weak self] endpoint in self?.connection.discovered(endpoint) }; discovery.start()
        refreshDebugOverlay()
    }
    @objc private func powerChanged() { connection.publishHeartbeat() }
    @objc private func configure() {
        guard let text = address.text, let url = URL(string:text), ["ws","wss"].contains(url.scheme ?? ""), url.host != nil else { label.text = "Enter a valid controller address."; return }
        UserDefaults.standard.set(text,forKey:"serverURL"); connection.fallbackEndpoint = url; connection.endpoint = connection.discoveredEndpoint ?? url; connection.connect(force:true); view.endEditing(true)
    }
    @objc private func pairingTapped() {
        guard let id = pairingSessionId, !pairingAssigned, connection.isConnected else { return }
        pairingScreen.setTitle("Assigning…",for:.normal)
        connection.send("pairing.tap",["sessionId":id])
    }
    private func showPairing(_ payload: [String:Any]) {
        guard payload["active"] as? Bool == true, let id = payload["sessionId"] as? String else {
            pairingExpiry?.cancel()
            pairingSessionId = nil; pairingAssigned = false; pairingScreen.isHidden = true
            if let brightness = beforePairingBrightness { UIScreen.main.brightness = brightness; beforePairingBrightness = nil }
            if let paired = payload["paired"] as? Bool { setPaired(paired) }
            kissing.setMode(state.state["mode"] as? String ?? "exhibition")
            return
        }
        if beforePairingBrightness == nil { beforePairingBrightness = UIScreen.main.brightness }
        UIScreen.main.brightness = max(0.4,UIScreen.main.brightness)
        pairingSessionId = id; pairingScreen.isHidden = false; view.bringSubviewToFront(pairingScreen)
        kissing.setMode("night")
        pairingExpiry?.cancel()
        let expiry = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            self.showPairing(["active":false,"paired":!self.state.state.isEmpty])
        }
        pairingExpiry = expiry
        let remaining = (payload["remainingMs"] as? Double ?? 600000)/1000
        DispatchQueue.main.asyncAfter(deadline:.now()+max(1,min(660,remaining)),execute:expiry)
        let slot = payload["slotIndex"] as? Int, columns = payload["columns"] as? Int ?? 5
        pairingAssigned = slot != nil; pairingScreen.isEnabled = !pairingAssigned
        if payload["paired"] as? Bool == true || pairingAssigned { setPaired(true) }
        pairingScreen.backgroundColor = pairingAssigned ? UIColor(red:0.05,green:0.4,blue:0.15,alpha:1) : UIColor(red:0.8,green:0.05,blue:0.05,alpha:1)
        if let slot = slot { pairingScreen.setTitle("ASSIGNED\nRow \(slot/columns+1) · Column \(slot%columns+1)\nSlot \(slot)\n\nWait for the operator",for:.normal) }
        else { pairingScreen.setTitle("PAIRING\nTap to assign this screen\n\n\(payload["count"] ?? 0) assigned\n\(payload["error"] ?? "")",for:.normal) }
    }
    private func receive(_ type: String,_ payload: [String:Any],_ revision: Int) {
        runtime.deviceId = connection.deviceId; runtime.endpoint = connection.endpoint; runtime.token = connection.token
        kissing.endpoint = connection.endpoint; kissing.token = connection.token
        if type == "server.welcome" {
            label.text = "Connected to \(connection.endpoint?.host ?? "controller")\nPairing code: \(payload["pairingCode"] ?? "?")"
            address.text = connection.endpoint?.absoluteString ?? address.text
            if let paired = payload["paired"] as? Bool { setPaired(paired) }
            refreshDebugOverlay()
        }
        if type == "server.error" { let code=payload["code"] as? String ?? "server-error"; diagnostics.record(code); showDebugError(code) }
        if type == "pairing.state" { showPairing(payload); return }
        if type == "ticker.snapshot" {
            liveAlert.receive(payload,clockOffsetMs:connection.hasClockSample ? connection.offset : runtime.restoredOffset)
            runtime.receiveTicker(payload); return
        }
        if type == "command", let name = payload["name"] as? String, let id = payload["commandId"] as? String {
            var completed = UserDefaults.standard.stringArray(forKey:"completedCommands") ?? []
            if completed.contains(id) { connection.send("client.ack",["commandId":id,"result":"duplicate"]); return }
            if ["reload-state","reloadState"].contains(name) { connection.send("state.request",[:]) }
            else if name == "clearCache" {
                completed.append(id); UserDefaults.standard.set(Array(completed.suffix(100)),forKey:"completedCommands")
                Task { [weak self] in
                    guard let self = self else { return }
                    do {
                        try await self.runtime.clearCache()
                        self.legacy.isHidden = false
                        self.lastDebugError = nil; self.refreshDebugOverlay()
                        self.connection.send("state.request",[:])
                        self.connection.send("client.ack",["commandId":id,"result":"cache-cleared"])
                    } catch {
                        self.showDebugError("cache-clear-failed")
                        self.connection.send("state.request",[:])
                        self.connection.send("client.error",["commandId":id,"code":"cache-clear-failed"])
                    }
                }
                return
            }
            else if name == "purge-expired-media" { Task { await media.purge(excluding:nil,all:false) } }
            else if name == "query-diagnostics" { connection.send("client.ack",["commandId":id,"result":"diagnostics","diagnostics":["codes":diagnostics.entries]]) }
            else { connection.send("client.error",["commandId":id,"code":"unsupported-command"]); return }
            completed.append(id); UserDefaults.standard.set(Array(completed.suffix(100)),forKey:"completedCommands"); connection.send("client.ack",["commandId":id,"result":"applied"])
        }
        guard type == "state.snapshot", state.apply(payload,revision:revision) else { return }
        refreshDebugOverlay()
        setPaired(true)
        let mode = payload["mode"] as? String ?? "blackout"
        let previewUntil = payload["previewUntil"] as? Double ?? 0
        identifying = (payload["scene"] as? [String:Any])?["id"] as? String == "identify" && previewUntil>Date().timeIntervalSince1970*1000+connection.offset
        if let config = payload["kissing"] as? [String:Any] { kissing.receive(config) }
        kissing.setMode(identifying || pairingSessionId != nil ? "night" : mode)
        runtime.setMode(identifying || kissing.enabled ? "night" : mode); blackout.isHidden = mode == "exhibition"
        kissing.isHidden = !kissing.enabled || identifying
        host.isHidden = identifying; legacy.isHidden = !identifying && runtime.activeReleaseId != nil
        UIScreen.main.brightness = CGFloat(mode == "night" ? payload["nightBrightness"] as? Double ?? 0 : payload["brightness"] as? Double ?? 0.6)
        if pairingSessionId != nil { beforePairingBrightness = UIScreen.main.brightness; UIScreen.main.brightness = max(0.4,UIScreen.main.brightness) }
        if let artwork = payload["artwork"] as? [String:Any] { runtime.receive(artwork) }
        if identifying || runtime.activeReleaseId == nil { legacy.state = payload; legacy.deviceId = connection.deviceId; legacy.serverMs = { [weak self] in Date().timeIntervalSince1970*1000+(self?.connection.offset ?? 0) } }
        connection.send("client.ack",["result":"configuration-received","revision":revision])
    }
    @objc private func tick(_ link: CADisplayLink) {
        if frameWindowStart == 0 { frameWindowStart = link.timestamp }
        frameCount += 1
        let interval = link.timestamp-frameWindowStart
        if interval >= 2 { displayLinkFps = Double(frameCount-1)/interval; frameWindowStart = link.timestamp; frameCount = 1 }
        let lead = max(0,min(0.1,link.targetTimestamp-CACurrentMediaTime()))*1000
        runtime.tick(presentationLeadMs:lead)
        kissing.tick()
        if identifying || runtime.activeReleaseId == nil { legacy.setNeedsDisplay() }
    }
}
