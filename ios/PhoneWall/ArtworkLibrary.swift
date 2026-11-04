import Foundation

actor ArtworkLibrary {
    let media: MediaManager
    private let root: URL
    private var records: [ActivatedArtwork] = []
    init(media: MediaManager) {
        self.media = media
        root = FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appendingPathComponent("PhoneWallArtwork",isDirectory:true)
        try? FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        if let data = try? Data(contentsOf:root.appendingPathComponent("last-good.json")), let saved = try? JSONDecoder().decode([ActivatedArtwork].self,from:data) { records = saved }
    }
    func history() -> [ActivatedArtwork] { records }
    func clearCache() async throws {
        if FileManager.default.fileExists(atPath:root.path) { try FileManager.default.removeItem(at:root) }
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        records.removeAll()
        await media.pin([])
        await media.purge(excluding:nil,all:true)
    }
    func rejectFailed(_ deploymentId: String) async {
        records.removeAll{$0.deployment.deploymentId == deploymentId}
        if let data = try? JSONEncoder().encode(records) { try? data.write(to:root.appendingPathComponent("last-good.json"),options:[.atomic,.completeFileProtectionUntilFirstUserAuthentication]) }
        await protectLastGood()
    }
    func prepare(_ manifest: ArtworkManifest, endpoint: URL?, token: String, deviceId: String) async throws -> [String:URL] {
        try manifest.validate(deviceId:deviceId)
        pruneBundles(keeping:Set(records.map{$0.deployment.releaseId}+[manifest.id]))
        let protected = Set((records.flatMap{$0.deployment.release.assets.map(\.hash)}) + manifest.assets.map(\.hash))
        await media.pin(protected)
        var result: [String:URL] = [:]
        for asset in manifest.assets {
            try Task.checkCancellation()
            if let cached = await media.verified(asset.hash) { result[asset.hash] = cached; continue }
            guard let endpoint = endpoint, var url = URLComponents(url:endpoint,resolvingAgainstBaseURL:false) else { throw ArtworkFailure.missingAsset }
            url.scheme = endpoint.scheme == "wss" ? "https" : "http"; url.path = "/phone-wall/media/\(asset.hash)"; url.query = nil
            guard let source = url.url else { throw ArtworkFailure.invalidManifest }
            result[asset.hash] = try await media.local(url:source,hash:asset.hash,token:token)
        }
        return result
    }
    func commit(_ value: ActivatedArtwork) async throws {
        let previous = records.first
        var next = [value]
        if let previous = previous, previous.deployment.deploymentId != value.deployment.deploymentId { next.append(previous) }
        else if records.count > 1 { next.append(records[1]) }
        let data = try JSONEncoder().encode(next)
        try data.write(to:root.appendingPathComponent("last-good.json"),options:[.atomic,.completeFileProtectionUntilFirstUserAuthentication])
        records = next
        pruneBundles(keeping:Set(records.map{$0.deployment.releaseId}))
        await media.pin(Set(records.flatMap{$0.deployment.release.assets.map(\.hash)}))
    }
    func protectLastGood() async { pruneBundles(keeping:Set(records.map{$0.deployment.releaseId})); await media.pin(Set(records.flatMap{$0.deployment.release.assets.map(\.hash)})) }
    private func pruneBundles(keeping ids: Set<String>) {
        guard let directories = try? FileManager.default.contentsOfDirectory(at:root,includingPropertiesForKeys:[.isDirectoryKey]) else { return }
        for file in directories where file.lastPathComponent.count == 64 && !ids.contains(file.lastPathComponent) { try? FileManager.default.removeItem(at:file) }
    }
    func bundle(_ manifest: ArtworkManifest, element: ArtworkElement, files: [String:URL]) throws -> URL {
        guard let script = element.asset, let source = files[script], let pixi = manifest.pixiHash, let pixiSource = files[pixi] else { throw ArtworkFailure.missingAsset }
        let directory = root.appendingPathComponent(manifest.id,isDirectory:true)
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
        func link(_ from: URL, _ name: String) throws {
            let target = directory.appendingPathComponent(name)
            let temporary = directory.appendingPathComponent("incoming-\(UUID().uuidString)")
            defer { try? FileManager.default.removeItem(at:temporary) }
            do { try FileManager.default.linkItem(at:from,to:temporary) } catch { try FileManager.default.copyItem(at:from,to:temporary) }
            if FileManager.default.fileExists(atPath:target.path) { _ = try FileManager.default.replaceItemAt(target,withItemAt:temporary) }
            else { try FileManager.default.moveItem(at:temporary,to:target) }
        }
        try link(source,"art.js"); try link(pixiSource,"pixi.js")
        for r in manifest.definition.resources ?? [] { guard let file = files[r.hash], !["art.js","pixi.js","index.html"].contains(r.name), !r.name.contains("/") else { throw ArtworkFailure.invalidManifest }; try link(file,r.name) }
        let html = "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'><meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self'; connect-src 'none'\"><style>html,body{margin:0;min-height:100%;background:transparent;overflow:hidden}</style></head><body><script src='pixi.js'></script><script src='art.js'></script></body></html>"
        let index = directory.appendingPathComponent("index.html")
        try Data(html.utf8).write(to:index,options:.atomic)
        return index
    }
}
