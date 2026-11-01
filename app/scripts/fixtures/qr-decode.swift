import Foundation
import CoreImage
let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let image = CIImage(contentsOf: url), let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh]) else { exit(1) }
let texts = detector.features(in: image).compactMap { ($0 as? CIQRCodeFeature)?.messageString }
print(texts.first ?? "")
if texts.count != 1 { exit(2) }
