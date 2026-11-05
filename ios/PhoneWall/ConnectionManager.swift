import Foundation
import UIKit
import Network

final class ConnectionManager {
    private(set) var deviceId = ""
    private(set) var token = ""
    private let bootSession = UUID().uuidString
    private var socket: URLSessionWebSocketTask?
    private var timer: Timer?
    private var retry: DispatchWorkItem?
    private var handshakeTimeout: DispatchWorkItem?
    private(set) var isConnected = false
    private let monitor = NWPathMonitor()
    private var attempt = 0
    private var generation = 0
    private var samples: [(rtt: Double, offset: Double)] = []
    private var lastResponse = Date()
    private var connectedAt: Date?
    private var features: [String:Int] = [:]
    private(set) var offset: Double = 0
    var hasClockSample: Bool { !samples.isEmpty }
    var onMessage: ((String, [String: Any], Int) -> Void)?
    var onDisconnect: (() -> Void)?
    var onStatus: ((String) -> Void)?
    var heartbeat: (() -> [String: Any])?
    var endpoint: URL?
    var fallbackEndpoint: URL?
    var discoveredEndpoint: URL?
    init() {
        monitor.pathUpdateHandler = { [weak self] path in
            DispatchQueue.main.async { if path.status == .satisfied, self?.socket == nil { self?.connect() } }
        }
        monitor.start(queue: DispatchQueue(label: "wall.network"))
    }
    func connect(force: Bool = false) {
        if socket != nil && !force { return }
        guard let endpoint = endpoint else { return }
        if deviceId.isEmpty || token.isEmpty {
            do { deviceId = try DeviceIdentity.value("deviceId"); token = try DeviceIdentity.value("token") }
            catch {
                onMessage?("server.error",["code":"identity-unavailable-unlock-device"],0)
                retry?.cancel()
                let work = DispatchWorkItem { [weak self] in self?.connect() }; retry = work
                DispatchQueue.main.asyncAfter(deadline:.now()+5,execute:work)
                return
            }
        }
        retry?.cancel(); handshakeTimeout?.cancel(); timer?.invalidate(); socket?.cancel(with: .goingAway, reason: nil)
        isConnected = false
        connectedAt = nil; features = [:]
        onStatus?("Connecting to \(endpoint.host ?? "controller")…")
        generation += 1
        let current = generation
        lastResponse = Date()
        let ws = URLSession.shared.webSocketTask(with: endpoint)
        ws.maximumMessageSize = 262144
        socket = ws; ws.resume()
        let timeout = DispatchWorkItem { [weak self] in self?.failed(current) }
        handshakeTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline:.now()+10,execute:timeout)
        let screen = UIScreen.main
        send("client.hello", ["deviceId": deviceId, "token": token, "bootSessionId": bootSession, "appVersion": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "2.0", "runtimeVersion":"2.0", "capabilities": ["sceneSchemaVersions":[1],"liveTicker":1,"liveAlert":1,"kissingWall":1,"kissingDrain":1,"audioVolume":1,"debugOverlay":1,"model": UIDevice.current.model, "osVersion": UIDevice.current.systemVersion, "width": screen.bounds.width, "height": screen.bounds.height, "pixelWidth": screen.nativeBounds.width, "pixelHeight": screen.nativeBounds.height, "scale": screen.scale, "codecs": ["h264"]]])
        receive(ws, generation: current)
        let heartbeatTimer = Timer(timeInterval:12,repeats:true) { [weak self] _ in
            guard let self = self else { return }
            if Date().timeIntervalSince(self.lastResponse) > 45 { self.failed(current); return }
            self.publishHeartbeat()
            self.send("time.request", ["sent": Date().timeIntervalSince1970 * 1000])
        }
        timer = heartbeatTimer; RunLoop.main.add(heartbeatTimer,forMode:.common)
    }
    func discovered(_ url: URL) {
        discoveredEndpoint = url
        guard socket == nil else { return }
        endpoint = url; connect()
    }
    func publishHeartbeat() { if isConnected { send("client.heartbeat",heartbeat?() ?? [:]) } }
    func send(_ type: String, _ payload: [String: Any], id: String = UUID().uuidString) {
        if type.hasPrefix("ticker."), features["liveTicker"] != 1 { return }
        if type.hasPrefix("kissing."), features["kissingWall"] != 1 { return }
        let object: [String: Any] = ["v": 1, "type": type, "messageId": id, "payload": payload]
        guard let data = try? JSONSerialization.data(withJSONObject: object), let text = String(data: data, encoding: .utf8) else { return }
        let current = generation
        socket?.send(.string(text)) { [weak self] error in if error != nil { DispatchQueue.main.async { self?.failed(current) } } }
    }
    private func receive(_ ws: URLSessionWebSocketTask, generation current: Int) {
        ws.receive { [weak self] result in
            DispatchQueue.main.async {
                guard let self = self, self.generation == current, self.socket != nil else { return }
                switch result {
                case .failure: self.failed(current)
                case .success(let message):
                    let data: Data
                    switch message { case .data(let d): data = d; case .string(let s): data = Data(s.utf8); @unknown default: self.failed(current); return }
                    guard data.count <= 262144, let m = try? JSONSerialization.jsonObject(with: data) as? [String: Any], m["v"] as? Int == 1, let type = m["type"] as? String, let p = m["payload"] as? [String: Any] else { self.failed(current); return }
                    self.lastResponse = Date()
                    if type == "server.welcome" {
                        self.isConnected = true
                        self.handshakeTimeout?.cancel()
                        self.connectedAt = Date()
                        self.features = p["features"] as? [String:Int] ?? [:]
                        self.samples = []
                        self.publishHeartbeat()
                        self.send("state.request",[:])
                        for n in 0..<5 { DispatchQueue.main.asyncAfter(deadline:.now()+Double(n)*0.2) { [weak self] in guard let self = self, self.generation == current else { return }; self.send("time.request",["sent":Date().timeIntervalSince1970 * 1000]) } }
                    }
                    if type == "time.response", let sent = p["sent"] as? Double, let server = m["serverTimeMs"] as? Double {
                        let now = Date().timeIntervalSince1970 * 1000
                        self.samples.append((now - sent, server - (now + sent) / 2))
                        self.samples = Array(self.samples.suffix(20))
                        self.offset = self.samples.min(by: { $0.rtt < $1.rtt })?.offset ?? 0
                    }
                    self.onMessage?(type, p, m["revision"] as? Int ?? 0)
                    self.receive(ws, generation: current)
                }
            }
        }
    }
    private func failed(_ current: Int) {
        guard generation == current, socket != nil else { return }
        socket?.cancel(with: .goingAway, reason: nil); socket = nil; timer?.invalidate(); handshakeTimeout?.cancel(); isConnected = false
        onStatus?("Controller unavailable. Retrying automatically…")
        onDisconnect?()
        if let connectedAt = connectedAt, Date().timeIntervalSince(connectedAt)>=30 { attempt = 0 }
        connectedAt = nil; features = [:]
        let delay = min(30, 0.5 * pow(2, Double(min(attempt, 8)))) * Double.random(in: 0.5...1)
        attempt += 1
        endpoint = attempt % 2 == 0 ? (fallbackEndpoint ?? discoveredEndpoint ?? endpoint) : (discoveredEndpoint ?? fallbackEndpoint ?? endpoint)
        let work = DispatchWorkItem { [weak self] in self?.connect() }; retry = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }
}
