import UIKit

final class StableWallController: UIViewController {
    private let connection = ConnectionManager(), state = StateStore(), diagnostics = Diagnostics(), media = MediaManager()
    private let host = UIView(), legacy = WallView(), blackout = UIView(), setup = UIStackView(), label = UILabel(), address = UITextField()
    private lazy var library = ArtworkLibrary(media:media)
    private lazy var runtime = ArtworkRuntime(host:host,library:library)
    private let discovery = ServerDiscovery()
    private var displayLink: CADisplayLink?
    private let boot = ProcessInfo.processInfo.systemUptime
    private var identifying = false
    private let pairingScreen = UIButton(type:.custom)
    private var pairingSessionId: String?
    private var pairingAssigned = false
    private var beforePairingBrightness: CGFloat?
    private var pairingExpiry: DispatchWorkItem?
    private func setPaired(_ paired: Bool) {
        setup.isHidden = paired
        if paired { view.endEditing(true) }
    }
    override var prefersStatusBarHidden: Bool { true }
    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .black
        for child in [legacy,host,blackout] { child.frame = view.bounds; child.autoresizingMask = [.flexibleWidth,.flexibleHeight]; view.addSubview(child) }
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
        setup.isHidden = !state.state.isEmpty
        runtime.clockOffset = { [weak self] in guard let self = self else { return 0 }; return self.connection.hasClockSample ? self.connection.offset : self.runtime.restoredOffset }
        runtime.report = { [weak self] payload in self?.connection.send("artwork.status",payload) }
        runtime.onDiagnostic = { [weak self] code in self?.diagnostics.record(code); self?.connection.send("client.error",["code":code]) }
        runtime.onActivated = { [weak self] in guard let self = self else { return }; self.setup.isHidden = true; self.legacy.isHidden = !self.identifying; self.view.bringSubviewToFront(self.pairingScreen) }
        let initialMode = state.state["mode"] as? String ?? "exhibition"
        runtime.setMode(initialMode); blackout.isHidden = initialMode == "exhibition"
        if initialMode == "night" { UIScreen.main.brightness = CGFloat(state.state["nightBrightness"] as? Double ?? 0) }
        runtime.restore()
        connection.onMessage = { [weak self] type,payload,revision in self?.receive(type,payload,revision) }
        connection.onDisconnect = { [weak self] in
            guard let self = self else { return }
            self.diagnostics.record("connection-lost-retaining-artwork")
            if self.pairingSessionId != nil { self.pairingScreen.isEnabled = false; self.pairingScreen.setTitle("OFFLINE\nWaiting for controller…",for:.normal) }
        }
        connection.onStatus = { [weak self] status in self?.label.text = status }
        connection.heartbeat = { [weak self] in
            guard let self = self else { return [:] }
            return ["battery":UIDevice.current.batteryLevel,"charging":[UIDevice.BatteryState.charging,.full].contains(UIDevice.current.batteryState),"thermalState":ProcessInfo.processInfo.thermalState.rawValue,"foreground":UIApplication.shared.applicationState == .active,"lastRevision":self.state.revision,"currentSceneId":self.runtime.activeReleaseId ?? "legacy","uptime":ProcessInfo.processInfo.systemUptime-self.boot,"mediaState":self.runtime.status]
        }
        displayLink = CADisplayLink(target:self,selector:#selector(tick)); displayLink?.preferredFramesPerSecond = 30; displayLink?.add(to:.main,forMode:.common)
        configure()
        discovery.onEndpoint = { [weak self] endpoint in guard let self = self else { return }; self.connection.discoveredEndpoint = endpoint; if !self.connection.isConnected { self.connection.endpoint = endpoint; self.connection.connect() } }; discovery.start()
    }
    @objc private func configure() {
        guard let text = address.text, let url = URL(string:text), ["ws","wss"].contains(url.scheme ?? ""), url.host != nil else { label.text = "Enter a valid controller address."; return }
        UserDefaults.standard.set(text,forKey:"serverURL"); connection.fallbackEndpoint = url; connection.endpoint = connection.discoveredEndpoint ?? url; connection.connect(); view.endEditing(true)
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
            return
        }
        if beforePairingBrightness == nil { beforePairingBrightness = UIScreen.main.brightness }
        UIScreen.main.brightness = max(0.4,UIScreen.main.brightness)
        pairingSessionId = id; pairingScreen.isHidden = false; view.bringSubviewToFront(pairingScreen)
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
        if type == "server.welcome" {
            label.text = "Connected to \(connection.endpoint?.host ?? "controller")\nPairing code: \(payload["pairingCode"] ?? "?")"
            address.text = connection.endpoint?.absoluteString ?? address.text
            if let paired = payload["paired"] as? Bool { setPaired(paired) }
        }
        if type == "server.error" { diagnostics.record(payload["code"] as? String ?? "server-error") }
        if type == "pairing.state" { showPairing(payload); return }
        if type == "command", let name = payload["name"] as? String, let id = payload["commandId"] as? String {
            var completed = UserDefaults.standard.stringArray(forKey:"completedCommands") ?? []
            if completed.contains(id) { connection.send("client.ack",["commandId":id,"result":"duplicate"]); return }
            if ["reload-state","reloadState"].contains(name) { connection.send("state.request",[:]) }
            else if ["clearCache","purge-expired-media"].contains(name) { Task { await media.purge(excluding:nil,all:name == "clearCache") } }
            else if name == "query-diagnostics" { connection.send("client.ack",["commandId":id,"result":"diagnostics","diagnostics":["codes":diagnostics.entries]]) }
            else { connection.send("client.error",["commandId":id,"code":"unsupported-command"]); return }
            completed.append(id); UserDefaults.standard.set(Array(completed.suffix(100)),forKey:"completedCommands"); connection.send("client.ack",["commandId":id,"result":"applied"])
        }
        guard type == "state.snapshot", state.apply(payload,revision:revision) else { return }
        setPaired(true)
        let mode = payload["mode"] as? String ?? "blackout"
        let previewUntil = payload["previewUntil"] as? Double ?? 0
        identifying = (payload["scene"] as? [String:Any])?["id"] as? String == "identify" && previewUntil>Date().timeIntervalSince1970*1000+connection.offset
        runtime.setMode(identifying ? "night" : mode); blackout.isHidden = mode == "exhibition"
        host.isHidden = identifying; legacy.isHidden = !identifying && runtime.activeReleaseId != nil
        UIScreen.main.brightness = CGFloat(mode == "night" ? payload["nightBrightness"] as? Double ?? 0 : payload["brightness"] as? Double ?? 0.6)
        if pairingSessionId != nil { beforePairingBrightness = UIScreen.main.brightness; UIScreen.main.brightness = max(0.4,UIScreen.main.brightness) }
        if let artwork = payload["artwork"] as? [String:Any] { runtime.receive(artwork) }
        if identifying || runtime.activeReleaseId == nil { legacy.state = payload; legacy.deviceId = connection.deviceId; legacy.serverMs = { [weak self] in Date().timeIntervalSince1970*1000+(self?.connection.offset ?? 0) } }
        connection.send("client.ack",["result":"configuration-received","revision":revision])
    }
    @objc private func tick() { runtime.tick(); if identifying || runtime.activeReleaseId == nil { legacy.setNeedsDisplay() } }
}
