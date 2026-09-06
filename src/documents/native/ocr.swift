// On-device OCR via Apple's Vision framework.
//
// Why Vision and not a bundled model: an air-gapped deployment cannot download weights on first
// run, and vendoring a Tesseract traineddata set adds ~15 MB per language to the installer. Vision
// ships with macOS, runs entirely on the device with no network access of any kind, and its
// handwriting recognition is materially better than Tesseract's — which matters when the input is a
// handwritten inspection note. Tesseract remains the backend on Linux (see ocr.ts).
//
// Reads image paths as arguments, writes one JSON object per input to stdout.

import Foundation
import Vision
import AppKit

struct PageResult: Encodable {
    let path: String
    let text: String
    /// Mean Vision confidence across recognized lines, 0...1. Absent when nothing was recognized.
    let confidence: Double?
    let lines: Int
    let error: String?
}

func recognize(path: String) -> PageResult {
    guard let image = NSImage(contentsOfFile: path),
          let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        return PageResult(path: path, text: "", confidence: nil, lines: 0, error: "could not read image")
    }

    let request = VNRecognizeTextRequest()
    // `accurate` over `fast`: an inspection report is read once and acted on, so a second of extra
    // compute is worth more than a misread tag number.
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    // Vision's language models are on-device; this must never be allowed to fetch.
    if #available(macOS 13.0, *) { request.automaticallyDetectsLanguage = true }

    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    do {
        try handler.perform([request])
    } catch {
        return PageResult(path: path, text: "", confidence: nil, lines: 0, error: "\(error)")
    }

    guard let observations = request.results else {
        return PageResult(path: path, text: "", confidence: nil, lines: 0, error: nil)
    }

    var lines: [String] = []
    var confidenceSum: Double = 0
    for observation in observations {
        guard let candidate = observation.topCandidates(1).first else { continue }
        lines.append(candidate.string)
        confidenceSum += Double(candidate.confidence)
    }
    return PageResult(
        path: path,
        text: lines.joined(separator: "\n"),
        confidence: lines.isEmpty ? nil : confidenceSum / Double(lines.count),
        lines: lines.count,
        error: nil
    )
}

let inputs = Array(CommandLine.arguments.dropFirst())
if inputs.isEmpty {
    FileHandle.standardError.write("usage: bimax-ocr <image> [image...]\n".data(using: .utf8)!)
    exit(2)
}

let encoder = JSONEncoder()
var failed = false
for path in inputs {
    let result = recognize(path: path)
    if result.error != nil { failed = true }
    if let data = try? encoder.encode(result), let line = String(data: data, encoding: .utf8) {
        print(line)
    }
}
exit(failed ? 1 : 0)
