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

    // A cross-check against dropped lines. MEASURED 2026-09-28 on macOS 27: an `accurate` read of a
    // clean 150 dpi report returned 4 of its 8 lines — no title, no vessel tag, no 8.2 mm reading —
    // with confidence 1.0, on several runs in a row; the same binary on the same image later read
    // all 8. Nothing in the result marks the short read. So the page is also read with the `fast`
    // recognizer, a different model (~50 ms): when it finds MORE lines, `accurate` is asked once
    // more, and the read with the most lines wins, preferring `accurate` text on a tie (the fast
    // model misreads characters — "Augusl" for "August" — but it does not invent whole lines).
    func pass(_ level: VNRequestTextRecognitionLevel) throws -> (lines: [String], confidence: Double) {
        let request = VNRecognizeTextRequest()
        // `accurate` over `fast`: an inspection report is read once and acted on, so a second of extra
        // compute is worth more than a misread tag number.
        request.recognitionLevel = level
        request.usesLanguageCorrection = true
        // Vision's language models are on-device; this must never be allowed to fetch.
        if #available(macOS 13.0, *) { request.automaticallyDetectsLanguage = true }
        try VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([request])
        var found: [String] = []
        var confidence: Double = 0
        for observation in request.results ?? [] {
            guard let candidate = observation.topCandidates(1).first else { continue }
            found.append(candidate.string)
            confidence += Double(candidate.confidence)
        }
        return (found, confidence)
    }

    var best: (lines: [String], confidence: Double)
    do {
        best = try pass(.accurate)
    } catch {
        return PageResult(path: path, text: "", confidence: nil, lines: 0, error: "\(error)")
    }
    if let quick = try? pass(.fast), quick.lines.count > best.lines.count {
        if let again = try? pass(.accurate), again.lines.count > best.lines.count { best = again }
        if quick.lines.count > best.lines.count { best = quick }
    }
    let lines = best.lines
    let confidenceSum = best.confidence
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
