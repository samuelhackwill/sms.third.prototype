import Foundation

final class ServerDiscovery: NSObject, NetServiceBrowserDelegate, NetServiceDelegate {
    private let browser = NetServiceBrowser()
    private var services: [NetService] = []
    var onEndpoint: ((URL) -> Void)?
    func start() {
        browser.delegate = self
        browser.searchForServices(ofType:"_phonewall._tcp.",inDomain:"local.")
    }
    func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
        services.append(service); service.delegate = self; service.resolve(withTimeout:5)
    }
    func netServiceBrowser(_ browser: NetServiceBrowser, didRemove service: NetService, moreComing: Bool) {
        services.removeAll { $0 == service }
    }
    func netServiceDidResolveAddress(_ sender: NetService) {
        guard let host = sender.hostName, sender.port > 0 else { return }
        var components = URLComponents(); components.scheme = "ws"; components.host = host; components.port = sender.port; components.path = "/phone-wall/ws"
        if let url = components.url { onEndpoint?(url) }
    }
    deinit { browser.stop(); services.forEach { $0.stop() } }
}
