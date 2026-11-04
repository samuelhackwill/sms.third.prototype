import UIKit

@MainActor final class ArtworkRuntime {
    private struct Prepared { let deployment: ArtworkDeployment; let view: DeclarativeSceneView }
    let library: ArtworkLibrary
    private weak var host: UIView?
    private var task: Task<Void,Never>?
    private var candidate: Prepared?
    private var active: Prepared?
    private var preparingId: String?
    private var restoreGeneration = 0
    private var blocked = Set(UserDefaults.standard.stringArray(forKey:"failedDeployments") ?? [])
    private var mode = "exhibition"
    private var fadeOld: DeclarativeSceneView?
    private var fadeStart = 0.0
    var deviceId = ""
    var endpoint: URL?
    var token = ""
    var clockOffset: () -> Double = { 0 }
    var report: (([String:Any])->Void)?
    var onActivated: (() -> Void)?
    var onDiagnostic: ((String)->Void)?
    var onTickerMessage: ((String,[String:Any])->Void)?
    private var tickerState: [String:Any] = ["enabled":false,"runs":[]]
    private(set) var activeReleaseId: String?
    private(set) var status = "idle"
    private(set) var restoredOffset = 0.0
    init(host: UIView, library: ArtworkLibrary) { self.host = host; self.library = library }
    func clearCache() async throws {
        restoreGeneration += 1
        cancelCandidate()
        fadeOld?.stop(); fadeOld = nil
        active?.view.stop(); active = nil
        activeReleaseId = nil; status = "idle"
        blocked.removeAll(); UserDefaults.standard.removeObject(forKey:"failedDeployments")
        try await library.clearCache()
    }
    func restore() {
        let generation = restoreGeneration
        task = Task { [weak self] in
            guard let self = self else { return }
            for record in await self.library.history() {
                guard self.restoreGeneration == generation else { return }
                if self.blocked.contains(record.deployment.deploymentId) { continue }
                self.deviceId = record.deviceId; self.restoredOffset = record.offsetMs
                do {
                    let prepared = try await self.prepare(record.deployment)
                    guard !Task.isCancelled, self.restoreGeneration == generation else { prepared.view.stop(); return }
                    self.candidate = prepared; self.activate(prepared,persist:false,sendStatus:false); return
                } catch { if Task.isCancelled { return } }
            }
        }
    }
    func receive(_ value: [String:Any]) {
        guard let bytes = try? JSONSerialization.data(withJSONObject:value), let snapshot = try? JSONDecoder().decode(ArtworkSnapshot.self,from:bytes) else { return }
        if snapshot.pending == nil, (candidate != nil || preparingId != nil), candidate?.deployment.deploymentId != snapshot.active?.deploymentId, preparingId != snapshot.active?.deploymentId { cancelCandidate(); Task { await library.protectLastGood() } }
        let desired = snapshot.pending ?? snapshot.active
        guard let desired = desired else { if preparingId != nil || candidate != nil { cancelCandidate() }; return }
        if blocked.contains(desired.deploymentId) { return }
        if active?.deployment.deploymentId == desired.deploymentId { return }
        if candidate?.deployment.deploymentId == desired.deploymentId, let candidate = candidate {
            self.candidate = Prepared(deployment:desired,view:candidate.view); if desired.phase == "preparing" { send(desired,"ready") }; return
        }
        if preparingId == desired.deploymentId { pendingDescriptor = desired; return }
        restoreGeneration += 1; cancelCandidate(); preparingId = desired.deploymentId; pendingDescriptor = desired; status = "preparing"
        task = Task { [weak self] in
            guard let self = self else { return }
            do {
                let ready = try await self.prepare(desired)
                guard !Task.isCancelled, self.preparingId == desired.deploymentId else { ready.view.stop(); return }
                let descriptor = self.pendingDescriptor ?? desired
                self.candidate = Prepared(deployment:descriptor,view:ready.view); self.preparingId = nil; self.status = "ready"
                self.send(descriptor,"ready")
            } catch {
                if !Task.isCancelled { self.preparingId = nil; self.status = "error"; self.send(desired,"error",code:artworkFailureCode(error)); await self.library.protectLastGood() }
            }
        }
    }
    private var pendingDescriptor: ArtworkDeployment?
    private func cancelCandidate() {
        task?.cancel(); task = nil; preparingId = nil; pendingDescriptor = nil
        candidate?.view.stop(); candidate = nil
    }
    private func prepare(_ deployment: ArtworkDeployment) async throws -> Prepared {
        let files = try await library.prepare(deployment.release,endpoint:endpoint,token:token,deviceId:deviceId)
        try Task.checkCancellation()
        let view = try DeclarativeSceneView(manifest:deployment.release,deviceId:deviceId)
        view.frame = host?.bounds ?? .zero; view.autoresizingMask = [.flexibleWidth,.flexibleHeight]; view.alpha = 0; host?.addSubview(view)
        view.onFailure = { [weak self,weak view] code in
            guard let self = self else { return }
            if self.active?.view === view { self.recoverFailedActive(deployment,code:code) }
            else if self.candidate?.view === view { self.blocked.insert(deployment.deploymentId); self.cancelCandidate(); self.status = "error"; self.send(deployment,"error",code:code); Task { await self.library.protectLastGood() } }
        }
        view.onDiagnostic = { [weak self] code in self?.onDiagnostic?(code) }
        view.onTickerMessage = { [weak self] type,payload in self?.onTickerMessage?(type,payload) }
        do { try await view.prepare(files:files,library:library,offset:clockOffset()); view.receiveTicker(tickerState); return Prepared(deployment:deployment,view:view) }
        catch { view.stop(); throw error }
    }
    func tick(presentationLeadMs: Double = 0) {
        let now = Date().timeIntervalSince1970*1000+clockOffset()+presentationLeadMs
        if let next = candidate, let start = next.deployment.startAtServerMs, now>=start { activate(next,persist:true,sendStatus:true) }
        guard mode == "exhibition", let active = active, let start = active.deployment.startAtServerMs else { return }
        active.view.render(serverMs:now,startAt:start,offset:clockOffset())
        if let old = fadeOld {
            let duration = active.deployment.release.definition.transition.durationMs
            let t = duration>0 ? min(1,max(0,(now-fadeStart)/duration)) : 1
            active.view.alpha = t; old.alpha = 1-t
            if t>=1 { old.stop(); fadeOld = nil }
        }
    }
    private func activate(_ next: Prepared,persist: Bool,sendStatus: Bool) {
        guard let start = next.deployment.startAtServerMs else { return }
        fadeOld?.stop(); fadeOld = nil
        let old = active
        active = next; candidate = nil; activeReleaseId = next.deployment.releaseId; status = "displayed"
        next.view.setMode(mode)
        next.view.receiveTicker(tickerState)
        let now = Date().timeIntervalSince1970*1000+clockOffset()
        next.view.activate(serverMs:now,startAt:start,offset:clockOffset())
        if next.deployment.release.definition.transition.type == "fade", old != nil, mode == "exhibition" {
            fadeOld = old?.view; fadeStart = start; next.view.alpha = 0
        } else { old?.view.stop(); next.view.alpha = 1 }
        onActivated?()
        if persist {
            Task {
                do {
                    try await library.commit(ActivatedArtwork(deployment:next.deployment,deviceId:deviceId,offsetMs:clockOffset()))
                    if sendStatus { send(next.deployment,"displayed") }
                } catch { recoverFailedActive(next.deployment,code:"last-good-persist-failed") }
            }
        } else if sendStatus { send(next.deployment,"displayed") }
    }
    private func recoverFailedActive(_ deployment: ArtworkDeployment,code: String) {
        guard !blocked.contains(deployment.deploymentId) else { return }
        blocked.insert(deployment.deploymentId); UserDefaults.standard.set(Array(blocked.suffix(20)),forKey:"failedDeployments")
        send(deployment,"error",code:code); status = "fallback"
        task = Task {
            await library.rejectFailed(deployment.deploymentId)
            for record in await library.history() where !blocked.contains(record.deployment.deploymentId) {
                do { let fallback = try await prepare(record.deployment); activate(fallback,persist:false,sendStatus:false); status = "fallback"; return } catch { continue }
            }
        }
    }
    private func send(_ d: ArtworkDeployment,_ status: String,code: String = "") { report?(["deploymentId":d.deploymentId,"releaseId":d.releaseId,"status":status,"code":code]) }
    func setMode(_ mode: String) {
        guard self.mode != mode else { return }; self.mode = mode; active?.view.setMode(mode)
        if mode == "exhibition", let active = active, let start = active.deployment.startAtServerMs { active.view.activate(serverMs:Date().timeIntervalSince1970*1000+clockOffset(),startAt:start,offset:clockOffset()) }
    }
    func receiveTicker(_ payload: [String:Any]) {
        tickerState = payload; active?.view.receiveTicker(payload); candidate?.view.receiveTicker(payload)
    }
}
