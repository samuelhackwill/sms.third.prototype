import UIKit
import AVFoundation

struct KissingConfiguration: Codable {
    struct Clip: Codable {
        let hash: String
        let bytes: Int
        let startSec: Double?
        let endSec: Double?
    }
    let v: Int
    let enabled: Bool
    let drain: Bool?
    let trim: Bool
    let trimStartOffsetSec: Double
    let trimEndOffsetSec: Double
    let revealDurationMs: Double
    let fadeOutDurationMs: Double
    let clips: [Clip]
    func validate() -> Bool {
        v == 1 && clips.count <= 24 && [trimStartOffsetSec,trimEndOffsetSec].allSatisfy { $0.isFinite && $0 >= 0 && $0 <= 30 } &&
        [revealDurationMs,fadeOutDurationMs].allSatisfy { $0.isFinite && $0 >= 0 && $0 <= 5000 } && clips.allSatisfy {
            $0.hash.count == 64 && $0.hash.allSatisfy { $0.isHexDigit } && $0.bytes > 0 && $0.bytes <= 100*1024*1024 &&
            ($0.startSec == nil || ($0.startSec!.isFinite && $0.startSec! >= 0)) &&
            ($0.endSec == nil || ($0.endSec!.isFinite && $0.endSec! > ($0.startSec ?? 0)))
        }
    }
}

@MainActor final class KissingWallView: UIView {
    private let media: MediaManager
    private let player = AVPlayer()
    private lazy var videoLayer = AVPlayerLayer(player:player)
    private var configuration: KissingConfiguration?
    private var task: Task<Void,Never>?
    private var prefetch: Task<Void,Never>?
    private var prefetched: (KissingConfiguration.Clip,URL)?
    private var downloadingHash: String?
    private var recent: [KissingConfiguration.Clip] = []
    private var failures = Set<String>()
    private var mode = "exhibition"
    private var lastHash: String?
    private var playbackWindow: (start:Double,end:Double,fadeIn:Double,fadeOut:Double)?
    private(set) var enabled = false
    private(set) var status = "stopped"
    var endpoint: URL?
    var token = ""
    var report: (([String:Any])->Void)?
    init(media: MediaManager) {
        self.media = media
        super.init(frame:.zero)
        backgroundColor = .black; isHidden = true; clipsToBounds = true
        if let data = UserDefaults.standard.data(forKey:"kissingLastGoodClips"), let clips = try? JSONDecoder().decode([KissingConfiguration.Clip].self,from:data) { recent = Array(clips.prefix(2)) }
        player.isMuted = false; player.volume = 1
        videoLayer.videoGravity = .resizeAspectFill
        layer.addSublayer(videoLayer)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unsupported") }
    override func layoutSubviews() { super.layoutSubviews(); videoLayer.frame = bounds }
    func receive(_ payload: [String:Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject:payload),
              let next = try? JSONDecoder().decode(KissingConfiguration.self,from:data), next.validate() else {
            report?(["status":"error","code":"invalid-kissing-configuration"]); return
        }
        configuration = next
        if next.enabled == enabled { return }
        enabled = next.enabled; isHidden = !enabled
        task?.cancel(); prefetch?.cancel(); prefetch = nil; prefetched = nil; downloadingHash = nil
        player.pause(); player.replaceCurrentItem(with:nil)
        playbackWindow = nil
        if enabled {
            failures.removeAll(); setMode(mode)
            task = Task { [weak self] in await self?.run() }
        } else {
            status = "stopped"; report?(["status":status]); task = nil
            Task { await media.pinKissing([]) }
            try? AVAudioSession.sharedInstance().setActive(false,options:.notifyOthersOnDeactivation)
        }
    }
    func setMode(_ mode: String) {
        self.mode = mode
        if mode != "exhibition" || !enabled { player.pause(); return }
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback,mode:.moviePlayback)
            try AVAudioSession.sharedInstance().setActive(true)
        } catch { report?(["status":"error","code":"kissing-audio-session-failed"]) }
        if player.currentItem != nil { player.play() }
    }
    private func loadNext() async -> (KissingConfiguration.Clip,URL)? {
        defer { if !Task.isCancelled { downloadingHash = nil } }
        guard let config = configuration else { return nil }
        let pool = config.clips.isEmpty ? recent : config.clips
        let candidates = pool.filter { !failures.contains($0.hash) && $0.hash != lastHash }.shuffled()
        let choices = candidates.isEmpty ? pool.filter { !failures.contains($0.hash) }.shuffled() : candidates
        for clip in choices {
            if Task.isCancelled { return nil }
            do {
                downloadingHash = clip.hash
                await protectClips()
                if let file = await media.verified(clip.hash) { return (clip,file) }
                guard let endpoint = endpoint, var url = URLComponents(url:endpoint,resolvingAgainstBaseURL:false) else { continue }
                url.scheme = endpoint.scheme == "wss" ? "https" : "http"; url.path = "/phone-wall/media/\(clip.hash)"; url.query = nil; url.fragment = nil
                guard let source = url.url else { continue }
                return (clip,try await media.local(url:source,hash:clip.hash,token:token,timeout:10))
            } catch {
                if Task.isCancelled { return nil }
                // One failed transfer must not prevent offline playback of other verified files.
                report?(["status":"prefetch-error","code":"kissing-download-failed","hash":clip.hash])
                if let cached = await cachedNext() { return cached }
            }
        }
        return await cachedNext()
    }
    private func cachedNext() async -> (KissingConfiguration.Clip,URL)? {
        let pool = ((configuration?.clips ?? [])+recent).filter { !failures.contains($0.hash) }.shuffled()
        for clip in pool.filter({$0.hash != lastHash})+pool.filter({$0.hash == lastHash}) {
            if Task.isCancelled { return nil }
            if let file = await media.verified(clip.hash) { return (clip,file) }
        }
        return nil
    }
    private func protectClips() async {
        await media.pinKissing(Set(recent.map(\.hash)+[prefetched?.0.hash,downloadingHash].compactMap{$0}))
    }
    func tick() {
        guard enabled, mode == "exhibition", let window = playbackWindow else { return }
        let position = player.currentTime().seconds
        guard position.isFinite else { return }
        let opacity = min(window.fadeIn>0 ? max(0,(position-window.start)/window.fadeIn) : 1,window.fadeOut>0 ? max(0,(window.end-position)/window.fadeOut) : 1)
        CATransaction.begin(); CATransaction.setDisableActions(true); videoLayer.opacity = Float(opacity); CATransaction.commit()
    }
    private func run() async {
        while !Task.isCancelled && enabled {
            if configuration?.drain == true {
                if status != "drained" { status = "drained"; report?(["status":status]) }
                try? await Task.sleep(nanoseconds:200_000_000)
                continue
            }
            guard mode == "exhibition" else { try? await Task.sleep(nanoseconds:200_000_000); continue }
            let loaded: (KissingConfiguration.Clip,URL)?
            if let ready = prefetched { loaded = ready; prefetched = nil }
            else if let download = prefetch {
                // Never wait on an unavailable controller if a local clip can keep the wall moving.
                if let cached = await cachedNext() { loaded = cached }
                else { await download.value; loaded = prefetched; prefetched = nil }
            } else { loaded = await loadNext() }
            if Task.isCancelled { return }
            guard let (clip,file) = loaded, let config = configuration else {
                status = "waiting-for-clips"; report?(["status":status])
                try? await Task.sleep(nanoseconds:5_000_000_000); failures.removeAll(); continue
            }
            lastHash = clip.hash; recent = Array(([clip]+recent.filter{$0.hash != clip.hash}).prefix(2))
            await protectClips()
            if Task.isCancelled { return }
            if configuration?.drain == true { continue }
            let asset: AVURLAsset
            let duration: Double
            do {
                let playable = try await media.videoFile(file)
                asset = AVURLAsset(url:playable,options:[AVURLAssetPreferPreciseDurationAndTimingKey:true])
                duration = try await asset.load(.duration).seconds
            }
            catch {
                if Task.isCancelled { return }
                let detail=error as NSError
                failures.insert(clip.hash); report?(["status":"error","code":"kissing-asset-load-\(detail.domain)-\(detail.code)","hash":clip.hash]); continue
            }
            if Task.isCancelled { return }
            let item = AVPlayerItem(asset:asset)
            playbackWindow = nil; player.replaceCurrentItem(with:item); videoLayer.opacity = 0
            status = "loading"; report?(["status":status,"hash":clip.hash])
            let deadline = Date().addingTimeInterval(20)
            while item.status == .unknown && Date()<deadline && !Task.isCancelled { try? await Task.sleep(nanoseconds:50_000_000) }
            if Task.isCancelled { return }
            guard item.status == .readyToPlay, duration.isFinite, duration>0, duration<=3600 else {
                let code = item.status == .readyToPlay ? "kissing-duration-invalid" : "kissing-player-load-\((item.error as NSError?)?.code ?? 0)"
                failures.insert(clip.hash); report?(["status":"error","code":code,"hash":clip.hash]); continue
            }
            let start = config.trim ? max(0,(clip.startSec ?? 0)-config.trimStartOffsetSec) : 0
            let end = config.trim ? min(duration,(clip.endSec ?? duration)+config.trimEndOffsetSec) : duration
            guard end>start else { failures.insert(clip.hash); report?(["status":"error","code":"kissing-trim-invalid","hash":clip.hash]); continue }
            await player.seek(to:CMTime(seconds:start,preferredTimescale:600),toleranceBefore:.zero,toleranceAfter:.zero)
            if Task.isCancelled { return }
            if configuration?.drain == true { player.replaceCurrentItem(with:nil); continue }
            playbackWindow = (start,end,config.revealDurationMs/1000,config.fadeOutDurationMs/1000)
            if mode == "exhibition" { player.play() }
            status = "playing"; report?(["status":status,"hash":clip.hash,"audio":true])
            if let data = try? JSONEncoder().encode(recent) { UserDefaults.standard.set(data,forKey:"kissingLastGoodClips") }
            if prefetch == nil && prefetched == nil {
                prefetch = Task { [weak self] in
                    guard let self = self else { return }
                    let loaded = await self.loadNext()
                    guard !Task.isCancelled else { return }
                    self.prefetched = loaded; self.prefetch = nil
                }
            }
            var previous = start, stalledAt = Date()
            while !Task.isCancelled {
                let position = player.currentTime().seconds
                if mode != "exhibition" { stalledAt = Date() }
                else {
                    if position>=end-0.03 { break }
                    if position>previous+0.01 { previous = position; stalledAt = Date() }
                    if item.status == .failed || Date().timeIntervalSince(stalledAt)>30 {
                        failures.insert(clip.hash); report?(["status":"error","code":"kissing-playback-stalled","hash":clip.hash]); break
                    }
                }
                try? await Task.sleep(nanoseconds:50_000_000)
            }
            if Task.isCancelled { return }
            player.pause(); playbackWindow = nil; videoLayer.opacity = 0; report?(["status":"ended","hash":clip.hash])
            try? await Task.sleep(nanoseconds:150_000_000)
        }
    }
}
