import UIKit
import AVFoundation
import ImageIO

final class DeclarativeSceneView: UIView {
    private let manifest: ArtworkManifest
    private let slot: ArtworkManifest.Layout.Slot
    private var views: [String:UIView] = [:]
    private var players: [AVQueuePlayer] = []
    private var loopers: [AVPlayerLooper] = []
    private var videos: [(UIView,AVPlayerLayer)] = []
    private var webs: [SceneWebSurface] = []
    private var readyWebs = Set<String>()
    private var failed = false
    private var observers: [NSKeyValueObservation] = []
    private var started = false
    private var mode = "exhibition"
    private var textWidths: [String:Double] = [:]
    private var viewportSize = CGSize(width:-1,height:-1)
    var onFailure: ((String)->Void)?
    var onDiagnostic: ((String)->Void)?
    init(manifest: ArtworkManifest, deviceId: String) throws {
        self.manifest = manifest
        guard let slot = manifest.layout.slots.first(where:{$0.deviceId == deviceId}) else { throw ArtworkFailure.invalidManifest }
        self.slot = slot
        super.init(frame:.zero)
        backgroundColor = .artwork(manifest.definition.background); clipsToBounds = true
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unsupported") }
    func prepare(files: [String:URL], library: ArtworkLibrary, offset: Double) async throws {
        var decodedPixels = 0
        for e in manifest.definition.elements {
            try Task.checkCancellation()
            let geometry = slot.geometry
            let staysInRow = e.animation?.property != "y" && e.animation?.property != "rotation" && (e.rotation ?? 0) == 0
            if ["text","ticker"].contains(e.type), staysInRow,
               e.frame.y+e.frame.height <= geometry.y || e.frame.y >= geometry.y+geometry.height { continue }
            let view: UIView
            let intersects = CGRect(x:e.frame.x,y:e.frame.y,width:e.frame.width,height:e.frame.height).intersects(CGRect(x:slot.geometry.x,y:slot.geometry.y,width:slot.geometry.width,height:slot.geometry.height))
            if !intersects && e.animation == nil && ["image","video","web"].contains(e.type) { let placeholder = UIView(); views[e.id] = placeholder; addSubview(placeholder); continue }
            switch e.type {
            case "text","ticker":
                let label = UILabel(); label.text = (e.text ?? "").replacingOccurrences(of:"{deviceId}",with:slot.deviceId).replacingOccurrences(of:"{row}",with:String(slot.slotIndex/max(1,manifest.layout.columns)+1)).replacingOccurrences(of:"{column}",with:String(slot.slotIndex%max(1,manifest.layout.columns)+1))
                label.font = .monospacedSystemFont(ofSize:e.fontSize ?? 48,weight:.regular)
                label.textColor = .artwork(e.color)
                label.numberOfLines = e.type == "ticker" || manifest.definition.artworkId == "operator-test-text" ? 1 : 0
                label.lineBreakMode = label.numberOfLines == 1 ? .byClipping : .byWordWrapping
                textWidths[e.id] = ceil((label.text! as NSString).size(withAttributes:[.font:label.font!]).width)
                view = label
            case "rect": view = UIView(); view.backgroundColor = .artwork(e.color)
            case "image":
                guard let asset = e.asset, let file = files[asset], let source = CGImageSourceCreateWithURL(file as CFURL,nil), let image = CGImageSourceCreateThumbnailAtIndex(source,0,[kCGImageSourceCreateThumbnailFromImageAlways:true,kCGImageSourceCreateThumbnailWithTransform:true,kCGImageSourceThumbnailMaxPixelSize:2048] as CFDictionary) else { throw ArtworkFailure.missingAsset }
                decodedPixels += image.width*image.height
                guard decodedPixels <= 12*1024*1024 else { throw ArtworkFailure.storageBudget }
                let imageView = UIImageView(image:UIImage(cgImage:image)); imageView.contentMode = .scaleAspectFit; view = imageView
            case "video":
                guard let asset = e.asset, let file = files[asset] else { throw ArtworkFailure.missingAsset }
                let player = AVQueuePlayer(); player.isMuted = true
                observers.append(player.observe(\.status,options:[.new]) { [weak self] player,_ in if player.status == .failed { DispatchQueue.main.async { self?.failed = true; self?.onFailure?("video-renderer-failed") } } })
                let looper = AVPlayerLooper(player:player,templateItem:AVPlayerItem(url:file)); loopers.append(looper); players.append(player)
                view = UIView(); let layer = AVPlayerLayer(player:player); layer.videoGravity = .resizeAspect; view.layer.addSublayer(layer); videos.append((view,layer))
            case "web":
                let file = try await library.bundle(manifest,element:e,files:files)
                var context = (try? JSONSerialization.jsonObject(with:JSONEncoder().encode(manifest.definition))) as? [String:Any] ?? [:]
                context["definition"] = context; context["clockOffsetMs"] = offset; context["startAtServerMs"] = 0; context["deviceId"] = slot.deviceId
                context["scene"] = context["parameters"] ?? [:]
                context["geometry"] = ["x":slot.geometry.x,"y":slot.geometry.y,"width":slot.geometry.width,"height":slot.geometry.height]
                let viewport = CGRect(x:e.frame.x,y:e.frame.y,width:e.frame.width,height:e.frame.height).intersection(CGRect(x:slot.geometry.x,y:slot.geometry.y,width:slot.geometry.width,height:slot.geometry.height))
                context["viewport"] = ["x":viewport.minX,"y":viewport.minY,"width":viewport.width,"height":viewport.height]
                let surface = SceneWebSurface(file:file,context:context)
                surface.onReady = { [weak self] in self?.readyWebs.insert(e.id) }
                surface.onFailure = { [weak self] code in self?.failed = true; self?.onFailure?(code) }
                surface.onDiagnostic = { [weak self] code in self?.onDiagnostic?(code) }
                webs.append(surface); view = surface
            default: throw ArtworkFailure.invalidManifest
            }
            view.layer.anchorPoint = .zero
            views[e.id] = view; addSubview(view)
        }
        render(serverMs:0,startAt:0,offset:offset)
        webs.forEach{$0.load()}
        let deadline = Date().addingTimeInterval(20)
        while Date()<deadline {
            try Task.checkCancellation()
            if failed || players.contains(where:{$0.status == .failed || $0.currentItem?.status == .failed}) { throw ArtworkFailure.rendererFailed }
            if readyWebs.count == webs.count && players.allSatisfy({$0.currentItem?.status == .readyToPlay}) { return }
            try await Task.sleep(nanoseconds:50_000_000)
        }
        throw ArtworkFailure.timeout
    }
    func render(serverMs: Double, startAt: Double, offset: Double) {
        guard bounds.width > 0, bounds.height > 0 else { return }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }
        let elapsed = max(0,serverMs-startAt),g = slot.geometry,sx = bounds.width/g.width,sy = bounds.height/g.height
        let resized = bounds.size != viewportSize
        if resized { viewportSize = bounds.size }
        for e in manifest.definition.elements {
            guard let view = views[e.id] else { continue }
            var x = e.frame.x,y = e.frame.y,opacity = e.opacity ?? 1,rotation = e.rotation ?? 0,width = e.frame.width
            if e.type == "ticker" {
                width = textWidths[e.id] ?? e.frame.width
                x = e.frame.x+e.frame.width-(elapsed/1000*(e.speed ?? 100)).truncatingRemainder(dividingBy:e.frame.width+width)
            }
            if let a = e.animation {
                let value = a.value(at:elapsed)
                switch a.property { case "x":x = value;case "y":y = value;case "opacity":opacity = value;case "rotation":rotation = value;default:break }
            }
            var position = CGPoint(x:(x-g.x)*sx,y:(y-g.y)*sy)
            if e.type == "web" {
                let intersection = CGRect(x:x,y:y,width:width,height:e.frame.height).intersection(CGRect(x:g.x,y:g.y,width:g.width,height:g.height))
                let frame = intersection.isNull ? CGRect.zero : CGRect(x:(intersection.minX-g.x)*sx,y:(intersection.minY-g.y)*sy,width:intersection.width*sx,height:intersection.height*sy)
                if view.bounds.size != frame.size { view.bounds = CGRect(origin:.zero,size:frame.size) }
                position = frame.origin
            } else if resized {
                // Fonts and text backing stores change only when the viewport changes.
                view.bounds = CGRect(x:0,y:0,width:width*sx,height:e.frame.height*sy)
                if let label = view as? UILabel { label.font = .monospacedSystemFont(ofSize:(e.fontSize ?? 48)*sy,weight:.regular) }
            }
            if view.layer.position != position { view.layer.position = position }
            if view.layer.opacity != Float(opacity) { view.layer.opacity = Float(opacity) }
            let transform = CGAffineTransform(rotationAngle:rotation * .pi/180)
            if view.layer.affineTransform() != transform { view.layer.setAffineTransform(transform) }
        }
        if resized { for (view,layer) in videos { layer.frame = view.bounds } }
        for web in webs { web.update(offset:offset,start:startAt,playing:started && mode == "exhibition") }
    }
    func activate(serverMs: Double,startAt: Double,offset: Double) {
        started = true
        for player in players {
            let duration = player.currentItem?.duration.seconds ?? 0
            if duration.isFinite && duration>0 { player.seek(to:CMTime(seconds:(max(0,serverMs-startAt)/1000).truncatingRemainder(dividingBy:duration),preferredTimescale:600),toleranceBefore:.zero,toleranceAfter:.zero) }
            if mode == "exhibition" { player.play() }
        }
        render(serverMs:serverMs,startAt:startAt,offset:offset)
    }
    func setMode(_ mode: String) { self.mode = mode; players.forEach{mode == "exhibition" && started ? $0.play() : $0.pause()} }
    func stop() { players.forEach{$0.pause()}; webs.forEach{$0.stop()}; removeFromSuperview() }
}
