import AppKit

// Render the system emoji rather than substituting an illustration.
let destination = URL(fileURLWithPath:CommandLine.arguments[1])
let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
let iconset = temporary.appendingPathComponent("Dashboard.iconset")
try FileManager.default.createDirectory(at:iconset,withIntermediateDirectories:true)
try FileManager.default.createDirectory(at:destination.deletingLastPathComponent(),withIntermediateDirectories:true)
defer { try? FileManager.default.removeItem(at:temporary) }
let bitmap = NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:1024,pixelsHigh:1024,bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:0,bitsPerPixel:0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep:bitmap)
NSGraphicsContext.current!.cgContext.clear(CGRect(x:0,y:0,width:1024,height:1024))
let emoji = "\u{1F346}" as NSString
let attributes: [NSAttributedString.Key:Any] = [.font:NSFont(name:"Apple Color Emoji",size:820)!]
let size = emoji.size(withAttributes:attributes)
emoji.draw(at:NSPoint(x:(1024-size.width)/2,y:(1024-size.height)/2),withAttributes:attributes)
NSGraphicsContext.restoreGraphicsState()
let original = temporary.appendingPathComponent("original.png")
try bitmap.representation(using:.png,properties:[:])!.write(to:original)
func run(_ executable: String,_ arguments: [String]) throws {
    let process = Process(); process.executableURL = URL(fileURLWithPath:executable); process.arguments = arguments
    process.standardOutput = FileHandle.nullDevice
    try process.run(); process.waitUntilExit()
    guard process.terminationStatus == 0 else { throw NSError(domain:"Icon generation",code:Int(process.terminationStatus)) }
}
for size in [16,32,128,256,512] {
    for scale in [1,2] {
        let pixels = size*scale
        let name = "icon_\(size)x\(size)\(scale == 2 ? "@2x" : "").png"
        try run("/usr/bin/sips",["-z",String(pixels),String(pixels),original.path,"--out",iconset.appendingPathComponent(name).path])
    }
}
try run("/usr/bin/iconutil",["-c","icns",iconset.path,"-o",destination.path])
print("Generated \(destination.path)")
