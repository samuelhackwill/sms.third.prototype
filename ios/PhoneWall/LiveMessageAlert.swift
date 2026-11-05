import AVFoundation
import AudioToolbox

@MainActor final class LiveMessageAlert {
    var canPlay: () -> Bool = { true }
    private var player: AVAudioPlayer?
    private var enabled = false
    private var currentRuns = Set<String>()
    private var seen = Set<String>()
    private var seenOrder: [String] = []
    private var pending: [String: DispatchWorkItem] = [:]

    func receive(_ snapshot: [String:Any], clockOffsetMs: Double) {
        enabled = snapshot["alertEnabled"] as? Bool ?? false
        let runs = snapshot["runs"] as? [[String:Any]] ?? []
        currentRuns = Set(runs.compactMap { $0["id"] as? String })
        for id in pending.keys.filter({ !enabled || !currentRuns.contains($0) }) {
            pending.removeValue(forKey:id)?.cancel()
        }
        let nowServerMs = Date().timeIntervalSince1970 * 1000 + clockOffsetMs
        for run in runs where run["source"] as? String == "router" && run["phase"] as? String == "playing" {
            guard let id = run["id"] as? String, let start = run["startAtServerMs"] as? Double, !seen.contains(id) else { continue }
            seen.insert(id); seenOrder.append(id)
            if seenOrder.count > 200 { seen.remove(seenOrder.removeFirst()) }
            guard enabled else { continue }
            let delayMs = start - nowServerMs
            guard delayMs > -2000, delayMs < 10000 else { continue }
            let work = DispatchWorkItem { [weak self] in self?.play(id:id) }
            pending[id] = work
            DispatchQueue.main.asyncAfter(deadline:.now() + max(0, delayMs / 1000), execute:work)
        }
    }

    func disconnect() {
        enabled = false; currentRuns.removeAll()
        for work in pending.values { work.cancel() }
        pending.removeAll()
    }

    private func play(id: String) {
        pending.removeValue(forKey:id)
        guard enabled, currentRuns.contains(id), canPlay() else { return }
        if player == nil, let sound = Bundle.main.url(forResource:"live-sms-ding",withExtension:"wav") {
            player = try? AVAudioPlayer(contentsOf:sound)
            player?.prepareToPlay()
        }
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback,mode:.default,options:[.mixWithOthers])
            try AVAudioSession.sharedInstance().setActive(true)
        } catch { }
        player?.currentTime = 0
        player?.play()
        AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
    }
}
