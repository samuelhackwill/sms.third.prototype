import Foundation
import UIKit

enum ArtworkJSON: Codable {
    case string(String),number(Double),bool(Bool),array([ArtworkJSON]),object([String:ArtworkJSON]),null
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let value = try? c.decode(Bool.self) { self = .bool(value) }
        else if let value = try? c.decode(Double.self) { self = .number(value) }
        else if let value = try? c.decode(String.self) { self = .string(value) }
        else if let value = try? c.decode([ArtworkJSON].self) { self = .array(value) }
        else { self = .object(try c.decode([String:ArtworkJSON].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self { case .null:try c.encodeNil();case .string(let v):try c.encode(v);case .number(let v):try c.encode(v);case .bool(let v):try c.encode(v);case .array(let v):try c.encode(v);case .object(let v):try c.encode(v) }
    }
}

struct ArtworkFrame: Codable { let x: Double; let y: Double; let width: Double; let height: Double }
struct ArtworkAnimation: Codable {
    let property: String; let from: Double; let to: Double; let durationMs: Double; let delayMs: Double?; let easing: String; let `repeat`: Bool
    func value(at elapsed: Double) -> Double {
        let time = max(0,elapsed - (delayMs ?? 0))
        var t = self.repeat ? time.truncatingRemainder(dividingBy:durationMs)/durationMs : min(1,time/durationMs)
        if easing == "easeInOut" { t = t*t*(3-2*t) }
        return from+(to-from)*t
    }
}
struct ArtworkElement: Codable {
    let id: String; let type: String; let frame: ArtworkFrame
    let text: String?; let color: String?; let opacity: Double?; let rotation: Double?; let fontSize: Double?; let speed: Double?; let asset: String?; let animation: ArtworkAnimation?
}
struct ArtworkDefinition: Codable {
    struct Canvas: Codable { let width: Double; let height: Double }
    struct Transition: Codable { let type: String; let durationMs: Double }
    struct Resource: Codable { let name: String; let hash: String }
    let sceneSchemaVersion: Int; let artworkId: String; let artworkVersion: String
    let canvas: Canvas; let background: String; let transition: Transition; let elements: [ArtworkElement]; let resources: [Resource]?
    let parameters: [String:ArtworkJSON]?
}
struct ArtworkManifest: Codable {
    struct Asset: Codable { let hash: String; let mime: String; let bytes: Int }
    struct Runtime: Codable { let minimumVersion: String; let sceneSchemaVersion: Int }
    struct Layout: Codable {
        struct Slot: Codable { let deviceId: String; let slotIndex: Int; let geometry: ArtworkFrame }
        let rows: Int; let columns: Int; let slots: [Slot]; let gap: Double
    }
    let id: String; let definition: ArtworkDefinition; let layout: Layout; let assets: [Asset]; let runtime: Runtime; let pixiHash: String?
    func validate(deviceId: String) throws {
        guard id.count == 64, id.allSatisfy({$0.isHexDigit}), definition.sceneSchemaVersion == 1, runtime.sceneSchemaVersion == 1,
              runtime.minimumVersion.compare("2.0",options:.numeric) != .orderedDescending,
              definition.canvas.width > 0, definition.canvas.width<=100000, definition.canvas.height > 0, definition.canvas.height<=100000, definition.elements.count <= 32,
              layout.slots.contains(where:{$0.deviceId == deviceId}), assets.count<=66, assets.allSatisfy({$0.bytes>=0 && $0.bytes<=200*1024*1024}), assets.reduce(0,{$0+$1.bytes}) <= 200*1024*1024,
              ["cut","fade"].contains(definition.transition.type), definition.transition.durationMs>=0, definition.transition.durationMs<=5000 else { throw ArtworkFailure.invalidManifest }
        let hashes = Set(assets.map(\.hash))
        for asset in assets { guard asset.hash.count == 64, asset.hash.allSatisfy({$0.isHexDigit}), asset.bytes >= 0 else { throw ArtworkFailure.invalidManifest } }
        for e in definition.elements {
            guard ["text","rect","ticker","image","video","web"].contains(e.type), e.frame.width > 0, e.frame.height > 0, [e.frame.x,e.frame.y,e.frame.width,e.frame.height].allSatisfy({$0.isFinite && abs($0)<=100000}), (e.fontSize ?? 48)>=8, (e.fontSize ?? 48)<=300 else { throw ArtworkFailure.invalidManifest }
            if let hash = e.asset, !hashes.contains(hash) { throw ArtworkFailure.invalidManifest }
            if let a = e.animation, a.durationMs < 16 { throw ArtworkFailure.invalidManifest }
        }
        if definition.elements.contains(where:{$0.type == "web"}), pixiHash == nil { throw ArtworkFailure.invalidManifest }
    }
}
struct ArtworkDeployment: Codable {
    let deploymentId: String; let releaseId: String; let phase: String; let startAtServerMs: Double?; let deadlineMs: Double; let release: ArtworkManifest
}
struct ArtworkSnapshot: Decodable { let active: ArtworkDeployment?; let pending: ArtworkDeployment? }
struct ActivatedArtwork: Codable { let deployment: ArtworkDeployment; let deviceId: String; let offsetMs: Double }
enum ArtworkFailure: Error { case invalidManifest, missingAsset, rendererFailed, timeout, storageBudget }
func artworkFailureCode(_ error: Error) -> String {
    if let failure = error as? ArtworkFailure {
        switch failure { case .invalidManifest:return "incompatible-artwork-manifest";case .missingAsset:return "artwork-asset-missing";case .rendererFailed:return "artwork-renderer-failed";case .timeout:return "artwork-renderer-timeout";case .storageBudget:return "artwork-render-budget-exceeded" }
    }
    if let failure = error as? MediaFailure {
        switch failure { case .checksum:return "artwork-checksum-failed";case .tooLarge:return "artwork-cache-budget-exceeded";case .invalidManifest:return "artwork-media-invalid" }
    }
    return "artwork-asset-or-storage-unavailable"
}

extension UIColor {
    static func artwork(_ value: String?) -> UIColor {
        let number = UInt32((value ?? "#ffffff").replacingOccurrences(of:"#",with:""),radix:16) ?? 0xffffff
        return UIColor(red:CGFloat((number >> 16)&255)/255,green:CGFloat((number >> 8)&255)/255,blue:CGFloat(number&255)/255,alpha:1)
    }
}
