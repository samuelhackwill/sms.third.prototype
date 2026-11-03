import Foundation

final class ServerDiscovery: NSObject, NetServiceBrowserDelegate, NetServiceDelegate {
    private let browser = NetServiceBrowser()
    private var services: [NetService] = []
    private var refresh: Timer?
    var onEndpoint: ((URL) -> Void)?
    func start() {
        browser.delegate = self
        browser.searchForServices(ofType:"_phonewall._tcp.",inDomain:"local.")
        refresh?.invalidate()
        refresh = Timer.scheduledTimer(withTimeInterval:15,repeats:true) { [weak self] _ in
            self?.services.forEach { $0.stop(); $0.resolve(withTimeout:5) }
        }
    }
    func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
        services.append(service); service.delegate = self; service.resolve(withTimeout:5)
    }
    func netServiceBrowser(_ browser: NetServiceBrowser, didRemove service: NetService, moreComing: Bool) {
        service.stop()
        services.removeAll { $0 == service }
    }
    func netService(_ sender: NetService, didNotResolve errorDict: [String : NSNumber]) {
        DispatchQueue.main.asyncAfter(deadline:.now()+3) { [weak self, weak sender] in
            guard let self = self, let service = sender, self.services.contains(service) else { return }
            service.resolve(withTimeout:5)
        }
    }
    func netServiceBrowser(_ browser: NetServiceBrowser, didNotSearch errorDict: [String : NSNumber]) {
        browser.stop()
        DispatchQueue.main.asyncAfter(deadline:.now()+5) { [weak self] in self?.start() }
    }
    func netServiceDidResolveAddress(_ sender: NetService) {
        guard let host = sender.hostName, sender.port > 0 else { return }
        let record = sender.txtRecordData().map{NetService.dictionary(fromTXTRecord:$0)} ?? [:]
        guard (record["v"].flatMap({String(data:$0,encoding:.utf8)}) ?? "1") == "1" else { return }
        let path = record["path"].flatMap{String(data:$0,encoding:.utf8)} ?? "/phone-wall/ws"
        guard path == "/phone-wall/ws" else { return }
        var components = URLComponents(); components.scheme = "ws"; components.host = host; components.port = sender.port; components.path = path
        if let url = components.url { onEndpoint?(url) }
    }
    deinit { refresh?.invalidate(); browser.stop(); services.forEach { $0.stop() } }
}
