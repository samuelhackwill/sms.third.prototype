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
    override var prefersStatusBarHidden: Bool { true }
    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .black
        for child in [legacy,host,blackout] { child.frame = view.bounds; child.autoresizingMask = [.flexibleWidth,.flexibleHeight]; view.addSubview(child) }
        blackout.backgroundColor = .black; blackout.isHidden = true
        label.text = "PHONE WALL\nDiscovering the local controller…"; label.textColor = .white; label.numberOfLines = 0
        address.text = UserDefaults.standard.string(forKey:"serverURL") ?? "ws://mac-mini.local:3000/phone-wall/ws"; address.borderStyle = .roundedRect; address.autocapitalizationType = .none; address.autocorrectionType = .no
        let button = UIButton(type:.system); button.setTitle("Connect",for:.normal); button.addTarget(self,action:#selector(configure),for:.touchUpInside)
        setup.axis = .vertical; setup.spacing = 16; [label,address,button].forEach{setup.addArrangedSubview($0)}; setup.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(setup)
        NSLayoutConstraint.activate([setup.centerYAnchor.constraint(equalTo:view.centerYAnchor),setup.leadingAnchor.constraint(equalTo:view.leadingAnchor,constant:24),setup.trailingAnchor.constraint(equalTo:view.trailingAnchor,constant:-24)])
        setup.isHidden = !state.state.isEmpty
        runtime.clockOffset = { [weak self] in guard let self = self else { return 0 }; return self.connection.hasClockSample ? self.connection.offset : self.runtime.restoredOffset }
        runtime.report = { [weak self] payload in self?.connection.send("artwork.status",payload) }
        runtime.onDiagnostic = { [weak self] code in self?.diagnostics.record(code); self?.connection.send("client.error",["code":code]) }
        runtime.onActivated = { [weak self] in guard let self = self else { return }; self.setup.isHidden = true; self.legacy.isHidden = !self.identifying }
        let initialMode = state.state["mode"] as? String ?? "exhibition"
        runtime.setMode(initialMode); blackout.isHidden = initialMode == "exhibition"
        if initialMode == "night" { UIScreen.main.brightness = CGFloat(state.state["nightBrightness"] as? Double ?? 0) }
        runtime.restore()
        connection.onMessage = { [weak self] type,payload,revision in self?.receive(type,payload,revision) }
        connection.onDisconnect = { [weak self] in self?.diagnostics.record("connection-lost-retaining-artwork") }
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
    private func receive(_ type: String,_ payload: [String:Any],_ revision: Int) {
        runtime.deviceId = connection.deviceId; runtime.endpoint = connection.endpoint; runtime.token = connection.token
        if type == "server.welcome" { label.text = "Pairing code: \(payload["pairingCode"] ?? "?")" }
        if type == "server.error" { diagnostics.record(payload["code"] as? String ?? "server-error") }
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
        setup.isHidden = true
        let mode = payload["mode"] as? String ?? "blackout"
        let previewUntil = payload["previewUntil"] as? Double ?? 0
        identifying = (payload["scene"] as? [String:Any])?["id"] as? String == "identify" && previewUntil>Date().timeIntervalSince1970*1000+connection.offset
        runtime.setMode(identifying ? "night" : mode); blackout.isHidden = mode == "exhibition"
        host.isHidden = identifying; legacy.isHidden = !identifying && runtime.activeReleaseId != nil
        UIScreen.main.brightness = CGFloat(mode == "night" ? payload["nightBrightness"] as? Double ?? 0 : payload["brightness"] as? Double ?? 0.6)
        if let artwork = payload["artwork"] as? [String:Any] { runtime.receive(artwork) }
        if identifying || runtime.activeReleaseId == nil { legacy.state = payload; legacy.deviceId = connection.deviceId; legacy.serverMs = { [weak self] in Date().timeIntervalSince1970*1000+(self?.connection.offset ?? 0) } }
        connection.send("client.ack",["result":"configuration-received","revision":revision])
    }
    @objc private func tick() { runtime.tick(); if identifying || runtime.activeReleaseId == nil { legacy.setNeedsDisplay() } }
}
