import UIKit
import WebKit

private final class SceneWebMessages: NSObject, WKScriptMessageHandler {
    weak var owner: SceneWebSurface?
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) { owner?.receive(message) }
}
final class SceneWebSurface: UIView, WKNavigationDelegate {
    private let file: URL
    private var context: [String:Any]
    private var web: WKWebView?
    private let fallback = UIImageView()
    private var health: Timer?
    private var heartbeat = Date()
    private var retries: [Date] = []
    private var playing = false
    private var started = false
    private var terminal = false
    private var sentPlaying: Bool?
    private var sentStart = -1.0
    private var sentOffset = -Double.greatestFiniteMagnitude
    private var capturedAt = Date.distantPast
    var onReady: (() -> Void)?
    var onFailure: ((String) -> Void)?
    var onDiagnostic: ((String) -> Void)?
    init(file: URL, context: [String:Any]) {
        self.file = file; self.context = context
        super.init(frame:.zero)
        clipsToBounds = true; backgroundColor = .clear
        fallback.frame = bounds; fallback.autoresizingMask = [.flexibleWidth,.flexibleHeight]; fallback.contentMode = .scaleToFill; addSubview(fallback)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unsupported") }
    func load() { build() }
    private func build() {
        guard !terminal else { return }
        web?.stopLoading(); web?.removeFromSuperview()
        let config = WKWebViewConfiguration(), messages = SceneWebMessages(); messages.owner = self
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(messages,name:"phoneWallHealth")
        var payload = context; payload["playing"] = playing
        let data = (try? JSONSerialization.data(withJSONObject:payload)) ?? Data("{}".utf8)
        let script = """
        (() => {
          window.PHONE_WALL=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('\(data.base64EncodedString())'),c=>c.charCodeAt(0))));
          const post=(event)=>window.webkit.messageHandlers.phoneWallHealth.postMessage({event});
          let failed=false,last=0,callbacks=[];
          window.addEventListener('error',()=>{failed=true;post('error')});
          window.addEventListener('unhandledrejection',()=>{failed=true;post('error')});
          window.addEventListener('load',()=>{if(!failed && !window.PHONE_WALL.parameters?.manualReady)post('ready')});
          window.PhoneWall={onFrame:fn=>callbacks.push(fn),asset:name=>name,ready:()=>{if(!failed)post('ready')}};
          function frame(){
            const now=Date.now();if(now-last>1000){post('heartbeat');last=now;}
            const state=window.PHONE_WALL;
            if(state.playing && now+state.clockOffsetMs>=state.startAtServerMs){for(const fn of callbacks)fn((now+state.clockOffsetMs-state.startAtServerMs)/1000,state);}
            requestAnimationFrame(frame);
          } requestAnimationFrame(frame);
        })();
        """
        config.userContentController.addUserScript(WKUserScript(source:script,injectionTime:.atDocumentStart,forMainFrameOnly:true))
        let view = WKWebView(frame:bounds,configuration:config); view.autoresizingMask = [.flexibleWidth,.flexibleHeight]; view.isOpaque = false; view.backgroundColor = .clear; view.scrollView.isScrollEnabled = false; view.navigationDelegate = self
        web = view; addSubview(view); heartbeat = Date()
        sentPlaying = nil
        view.loadFileURL(file,allowingReadAccessTo:file.deletingLastPathComponent())
    }
    func receive(_ message: WKScriptMessage) {
        guard message.webView === web, let value = message.body as? [String:Any], let event = value["event"] as? String else { return }
        if event == "ready" { heartbeat = Date(); onReady?(); update(offset:context["clockOffsetMs"] as? Double ?? 0,start:context["startAtServerMs"] as? Double ?? 0,playing:playing) }
        if event == "heartbeat" { heartbeat = Date() }
        if event == "error" { recover("web-javascript-error") }
    }
    func update(offset: Double, start: Double, playing: Bool) {
        context["clockOffsetMs"] = offset; context["startAtServerMs"] = start
        if playing && !self.playing { heartbeat = Date() }
        self.playing = playing
        if sentPlaying != playing || sentStart != start || abs(sentOffset-offset)>1 {
            sentPlaying = playing; sentStart = start; sentOffset = offset
            web?.evaluateJavaScript("Object.assign(window.PHONE_WALL,{clockOffsetMs:\(offset),startAtServerMs:\(start),playing:\(playing ? "true" : "false")})",completionHandler:nil)
        }
        if playing && !started {
            started = true; heartbeat = Date()
            health = Timer.scheduledTimer(withTimeInterval:2,repeats:true) { [weak self] _ in
                guard let self = self, self.playing else { return }
                if Date().timeIntervalSince(self.heartbeat)>8 { self.recover("web-heartbeat-timeout") }
                else if Date().timeIntervalSince(self.capturedAt)>5 {
                    self.capturedAt = Date(); let current = self.web
                    current?.takeSnapshot(with:nil) { [weak self,weak current] image,_ in if let self = self, self.web === current, let image = image { self.fallback.image = image } }
                }
            }
        }
    }
    private func recover(_ code: String) {
        guard !terminal else { return }
        retries = retries.filter{Date().timeIntervalSince($0)<60}
        if retries.count >= 3 { terminal = true; health?.invalidate(); web?.removeFromSuperview(); onFailure?(code+"-recovery-exhausted"); return }
        retries.append(Date()); onDiagnostic?(code+"-retry-\(retries.count)"); heartbeat = Date(); build()
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { recover("web-process-terminated") }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { recover("web-file-load-failed") }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy)->Void) {
        let allowed = navigationAction.request.url.map{$0.isFileURL && $0.path.hasPrefix(file.deletingLastPathComponent().path+"/")} ?? false
        decisionHandler(allowed ? .allow : .cancel)
    }
    func stop() { playing = false; health?.invalidate(); health = nil; web?.stopLoading(); web?.removeFromSuperview(); web = nil }
    deinit { health?.invalidate() }
}
