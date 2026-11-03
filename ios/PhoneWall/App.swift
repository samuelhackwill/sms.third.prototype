import UIKit

@main final class AppCoordinator: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        application.isIdleTimerDisabled = true
        UIDevice.current.isBatteryMonitoringEnabled = true
        return true
    }
    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name:"Wall",sessionRole:connectingSceneSession.role)
        configuration.delegateClass = WallScene.self
        return configuration
    }
}
final class WallScene: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene:scene)
        window.rootViewController = StableWallController()
        window.makeKeyAndVisible()
        self.window = window
    }
}

enum DeviceIdentity {
    enum Failure: Error { case unavailable }
    static func value(_ key: String) throws -> String {
        let root = FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0]
        let file = root.appendingPathComponent("phone-wall-identity.json")
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        var values: [String:String] = [:]
        if FileManager.default.fileExists(atPath:file.path) {
            let data = try Data(contentsOf:file)
            guard let stored = try JSONSerialization.jsonObject(with:data) as? [String:String] else { throw Failure.unavailable }
            values = stored
        }
        if let value = values[key] { return value }
        let value = UUID().uuidString + (key == "token" ? UUID().uuidString : "")
        values[key] = value
        let data = try JSONSerialization.data(withJSONObject:values)
        try data.write(to:file,options:[.atomic,.completeFileProtectionUntilFirstUserAuthentication])
        try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:file.path)
        var url = file; var attributes = URLResourceValues(); attributes.isExcludedFromBackup = true; try url.setResourceValues(attributes)
        return value
    }
}

final class Diagnostics {
    private(set) var entries: [String] = []
    func record(_ code: String) { entries.append(String(code.prefix(200))); entries = Array(entries.suffix(50)) }
}

final class StateStore {
    private(set) var revision = -1
    private(set) var state: [String: Any] = [:]
    init() {
        if let data = UserDefaults.standard.data(forKey:"lastSnapshot"), let saved = try? JSONSerialization.jsonObject(with:data) as? [String:Any], let revision = saved["revision"] as? Int, let payload = saved["payload"] as? [String:Any] { _ = apply(payload,revision:revision) }
    }
    func apply(_ payload: [String: Any], revision next: Int) -> Bool {
        let newInstallation = (payload["installationId"] as? String) != (state["installationId"] as? String)
        guard (next >= revision || newInstallation), next >= 0, let mode = payload["mode"] as? String, ["exhibition", "night", "blackout"].contains(mode), payload["scene"] is [String: Any], payload["device"] is [String: Any] else { return false }
        state = payload; revision = next
        if let data = try? JSONSerialization.data(withJSONObject:["revision":next,"payload":payload]) { UserDefaults.standard.set(data,forKey:"lastSnapshot") }
        return true
    }
}


protocol ScreenRenderer { func render(state: [String: Any], serverMs: Double, deviceId: String, in rect: CGRect, context: CGContext) }
final class NativeRenderer: ScreenRenderer {
    func render(state: [String: Any], serverMs: Double, deviceId: String, in rect: CGRect, context: CGContext) {
        guard state["mode"] as? String == "exhibition", let scene = state["scene"] as? [String: Any] else { return }
        let kind = scene["kind"] as? String ?? "test"
        let device = state["device"] as? [String: Any] ?? [:]
        let geometry = device["geometry"] as? [String: Any] ?? [:]
        let w = geometry["width"] as? Double ?? Double(rect.width), h = geometry["height"] as? Double ?? Double(rect.height)
        let x = geometry["x"] as? Double ?? 0, y = geometry["y"] as? Double ?? 0
        let fontSize = scene["fontSize"] as? Double ?? 48
        let hex = (scene["color"] as? String ?? "#ffffff").replacingOccurrences(of:"#",with:"")
        let rgb = UInt32(hex,radix:16) ?? 0xffffff
        let color = UIColor(red:CGFloat((rgb >> 16) & 255)/255,green:CGFloat((rgb >> 8) & 255)/255,blue:CGFloat(rgb & 255)/255,alpha:1)
        context.saveGState(); defer { context.restoreGState() }
        context.scaleBy(x: rect.width / max(1,w), y: rect.height / max(1,h))
        if kind == "solid" { context.setFillColor(color.cgColor); context.fill(CGRect(x:0,y:0,width:w,height:h)); return }
        var text = scene["text"] as? String ?? "PHONE WALL"
        var textX = 20.0
        if kind == "test" {
            let slot = device["slotIndex"] as? Int ?? 0
            let columns = (state["layout"] as? [String:Any])?["columns"] as? Int ?? 5
            text = "PHONE WALL\n\(deviceId.prefix(8))\nSlot \(slot) / R\(slot / max(1,columns)+1) C\(slot % max(1,columns)+1)\n\(Int(serverMs))"
            context.setStrokeColor(UIColor.darkGray.cgColor); context.setLineWidth(1)
            for n in 0...10 { context.move(to:CGPoint(x:Double(n)*w/10,y:0)); context.addLine(to:CGPoint(x:Double(n)*w/10,y:h)); context.move(to:CGPoint(x:0,y:Double(n)*h/10)); context.addLine(to:CGPoint(x:w,y:Double(n)*h/10)) }; context.strokePath()
            let barX = (serverMs / 10).truncatingRemainder(dividingBy: 5000) - x
            context.setFillColor(UIColor.cyan.cgColor); context.fill(CGRect(x:barX,y:0,width:10,height:h))
        } else if kind == "ticker" {
            let start = scene["startAtServerMs"] as? Double ?? serverMs
            let speed = scene["speed"] as? Double ?? 100
            let width = (text as NSString).size(withAttributes:[.font:UIFont.monospacedSystemFont(ofSize:fontSize,weight:.regular)]).width
            let wallWidth = state["logicalWidth"] as? Double ?? w
            textX = wallWidth - (max(0, serverMs - start) / 1000 * speed).truncatingRemainder(dividingBy:wallWidth + width) - x
        }
        (text as NSString).draw(in:CGRect(x:textX,y:kind == "ticker" ? fontSize-y : 30,width:max(w,10000),height:h), withAttributes:[.font:UIFont.monospacedSystemFont(ofSize:kind == "test" ? 24 : fontSize,weight:.regular), .foregroundColor:color])
    }
}

final class WallView: UIView {
    var state: [String: Any] = [:]
    var serverMs: () -> Double = { Date().timeIntervalSince1970 * 1000 }
    var deviceId = ""
    let renderer = NativeRenderer()
    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        UIColor.black.setFill(); context.fill(rect)
        renderer.render(state:state,serverMs:serverMs(),deviceId:deviceId,in:bounds,context:context)
    }
}

