import Foundation
import CryptoKit

enum MediaFailure: Error { case invalidManifest, tooLarge, checksum }
private final class DownloadBudget: NSObject, URLSessionDownloadDelegate {
    let limit: Int64
    init(limit: Int64) { self.limit = limit }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {}
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        if totalBytesWritten > limit || totalBytesExpectedToWrite > limit { downloadTask.cancel() }
    }
}
actor MediaManager {
    private let root: URL
    private let quota: Int64 = 512 * 1024 * 1024
    private var pinned: Set<String> = []
    private var kissingPins: Set<String> = []
    init() {
        root = FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appendingPathComponent("PhoneWallMedia",isDirectory:true)
        try? FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
    }
    func pin(_ hashes: Set<String>) { pinned = hashes }
    func pinKissing(_ hashes: Set<String>) { kissingPins = hashes }
    func videoFile(_ file: URL) throws -> URL {
        guard file.deletingLastPathComponent() == root, file.lastPathComponent.count == 64 else { throw MediaFailure.invalidManifest }
        // AVFoundation needs the container extension; retain one checksummed blob, not a second copy.
        let links = root.appendingPathComponent("VideoLinks",isDirectory:true)
        try FileManager.default.createDirectory(at:links,withIntermediateDirectories:true)
        let alias = links.appendingPathComponent(file.lastPathComponent+".mp4")
        let target = "../"+file.lastPathComponent
        if (try? FileManager.default.destinationOfSymbolicLink(atPath:alias.path)) != target {
            try? FileManager.default.removeItem(at:alias)
            try FileManager.default.createSymbolicLink(atPath:alias.path,withDestinationPath:target)
        }
        return alias
    }
    private func removeVideoAlias(_ hash: String) {
        try? FileManager.default.removeItem(at:root.appendingPathComponent("VideoLinks/\(hash).mp4"))
    }
    func verified(_ hash: String) -> URL? {
        guard hash.count == 64, hash.allSatisfy({$0.isHexDigit}) else { return nil }
        let file = root.appendingPathComponent(hash)
        return (try? digest(file)) == hash ? file : nil
    }
    func local(url: URL, hash: String, token: String, timeout: TimeInterval = 60) async throws -> URL {
        guard hash.count == 64, hash.allSatisfy({ $0.isHexDigit }), ["http","https"].contains(url.scheme ?? "") else { throw MediaFailure.invalidManifest }
        let destination = root.appendingPathComponent(hash.lowercased())
        if (try? digest(destination)) == hash.lowercased() { return destination }
        var request = URLRequest(url:url)
        request.timeoutInterval = timeout
        request.setValue("Bearer \(token)",forHTTPHeaderField:"Authorization")
        let session = URLSession(configuration:.ephemeral,delegate:DownloadBudget(limit:200*1024*1024),delegateQueue:nil)
        defer { session.invalidateAndCancel() }
        let (temporary, response) = try await session.download(for:request)
        defer { try? FileManager.default.removeItem(at:temporary) }
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw MediaFailure.invalidManifest }
        let size = try temporary.resourceValues(forKeys:[.fileSizeKey]).fileSize ?? Int.max
        guard size < quota else { throw MediaFailure.tooLarge }
        guard try digest(temporary) == hash.lowercased() else { throw MediaFailure.checksum }
        try Task.checkCancellation()
        let staging = root.appendingPathComponent("incoming-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at:staging) }
        try FileManager.default.copyItem(at:temporary,to:staging)
        if FileManager.default.fileExists(atPath:destination.path) { _ = try FileManager.default.replaceItemAt(destination,withItemAt:staging) }
        else { try FileManager.default.moveItem(at:staging,to:destination) }
        do { try prune(keeping:destination) }
        catch {
            try? FileManager.default.removeItem(at:destination); removeVideoAlias(destination.lastPathComponent)
            throw error
        }
        return destination
    }
    private func digest(_ url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom:url)
        defer { try? handle.close() }
        var hash = SHA256(), bytes = 0
        while let chunk = try handle.read(upToCount:1024*1024), !chunk.isEmpty {
            bytes += chunk.count
            guard bytes <= quota else { throw MediaFailure.tooLarge }
            hash.update(data:chunk)
        }
        return hash.finalize().map { String(format:"%02x",$0) }.joined()
    }
    func purge(excluding hash: String?, all: Bool = false) {
        guard let files = try? FileManager.default.contentsOfDirectory(at:root,includingPropertiesForKeys:[.contentModificationDateKey]) else { return }
        for file in files where file.lastPathComponent != "VideoLinks" && file.lastPathComponent != hash && !pinned.contains(file.lastPathComponent) && !kissingPins.contains(file.lastPathComponent) {
            let modified = (try? file.resourceValues(forKeys:[.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            if all || Date().timeIntervalSince(modified) > 7*86400 { try? FileManager.default.removeItem(at:file); removeVideoAlias(file.lastPathComponent) }
        }
    }
    private func prune(keeping: URL) throws {
        let files = try FileManager.default.contentsOfDirectory(at:root,includingPropertiesForKeys:[.contentModificationDateKey,.fileSizeKey]).filter{$0.lastPathComponent != "VideoLinks"}.sorted { ((try? $0.resourceValues(forKeys:[.contentModificationDateKey]).contentModificationDate) ?? .distantPast) < ((try? $1.resourceValues(forKeys:[.contentModificationDateKey]).contentModificationDate) ?? .distantPast) }
        var bytes = files.reduce(Int64(0)) { $0 + Int64((try? $1.resourceValues(forKeys:[.fileSizeKey]).fileSize) ?? 0) }
        for file in files where bytes > quota && file != keeping && !pinned.contains(file.lastPathComponent) && !kissingPins.contains(file.lastPathComponent) { let size = (try? file.resourceValues(forKeys:[.fileSizeKey]).fileSize) ?? 0; try FileManager.default.removeItem(at:file); removeVideoAlias(file.lastPathComponent); bytes -= Int64(size) }
        if bytes > quota { throw MediaFailure.tooLarge }
    }
}
