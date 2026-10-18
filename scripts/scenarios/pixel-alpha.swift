// Prints the median alpha (0-255) of a PNG. On a Chat capture most pixels are
// panel, so the median is the panel's, whatever text the window holds.
// Usage: pixel-alpha <png>
import CoreGraphics
import Foundation
import ImageIO

let url = URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL
guard let source = CGImageSourceCreateWithURL(url, nil),
  let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
else {
  FileHandle.standardError.write("pixel-alpha: cannot read \(CommandLine.arguments[1])\n".data(using: .utf8)!)
  exit(3)
}
let (w, h) = (image.width, image.height)
var pixels = [UInt8](repeating: 0, count: w * h * 4)
let context = CGContext(
  data: &pixels, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
  space: CGColorSpaceCreateDeviceRGB(),
  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
context.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
var counts = [Int](repeating: 0, count: 256)
for i in 0..<(w * h) {
  counts[Int(pixels[i * 4 + 3])] += 1
}
var seen = 0
for (alpha, count) in counts.enumerated() {
  seen += count
  if seen * 2 >= w * h {
    print(alpha)
    break
  }
}
