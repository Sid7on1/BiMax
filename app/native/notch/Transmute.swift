// God's Land stage 7: one-tap conversions (docs/product-reset/gods-land/03_PLAN.md, 00 §4). The app decides which a
// card has and where the result goes (app/src/main/transmute.ts); this does the local ones with the Mac's own
// frameworks — no model, nothing sent — and reports the result, which lands on the shelf as a new card.
//
// Protocol additions:
//   in   {"t":"transmute-run","id","action","source","out","label"}
//   out  {"t":"transmute","id","action"}   {"t":"made","source","path?","note","copied?","error?"}

import AppKit
import ImageIO
import PDFKit
import UniformTypeIdentifiers
import Vision

struct TransmuteAction: Equatable, Hashable {
    let id: String
    let label: String
    let kind: String

    init?(json row: [String: Any]) {
        guard let id = row["id"] as? String, let label = row["label"] as? String else { return nil }
        self.id = id
        self.label = label
        self.kind = row["kind"] as? String ?? "local"
    }
}

struct Made {
    var path: String?
    var note: String
    var copied: Bool = false
}

enum TransmuteError: Error, CustomStringConvertible {
    case unreadable, unsupported(String), failed(String)
    var description: String {
        switch self {
        case .unreadable: return "could not read the file"
        case let .unsupported(what): return what
        case let .failed(what): return what
        }
    }
}

enum Transmute {
    static let maxSide = 2560
    static let base64Limit = 5 * 1024 * 1024

    /// Runs `action` on `source`, writing to `out` when it makes a file. Runs off the main thread.
    static func run(_ action: String, source: URL, out: URL, copy: (String) -> Void) throws -> Made {
        switch action {
        case "compress": return try image(source, to: out, type: .jpeg, quality: 0.7, fit: maxSide, verb: "Compressed")
        case "avif": return try image(source, to: out, type: UTType("public.avif") ?? .jpeg, quality: 0.8, fit: nil, verb: "AVIF")
        case "heic": return try image(source, to: out, type: .heic, quality: 0.8, fit: nil, verb: "HEIC")
        case "png": return try image(source, to: out, type: .png, quality: nil, fit: nil, verb: "PNG")
        case "jpeg": return try image(source, to: out, type: .jpeg, quality: 0.85, fit: nil, verb: "JPEG")
        case "remove-background": return try removeBackground(source, to: out)
        case "ocr":
            let text = try recognizeText(source)
            guard !text.isEmpty else { throw TransmuteError.failed("no text found") }
            copy(text)
            return Made(note: "Copied \(text.split(separator: "\n").count) lines of text", copied: true)
        case "base64":
            let data = try Data(contentsOf: source)
            guard data.count <= base64Limit else { throw TransmuteError.unsupported("too large for Base64 (over 5 MB)") }
            let mime = UTType(filenameExtension: source.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            copy("data:\(mime);base64,\(data.base64EncodedString())")
            return Made(note: "Copied as Base64 (\(ByteCountFormatter.string(fromByteCount: Int64(data.count), countStyle: .file)))", copied: true)
        case "pdf-page1": return try pdfPage1(source, to: out)
        case "pdf-flatten": return try pdfFlatten(source, to: out)
        case "pdf-compress": return try pdfCompress(source, to: out)
        default: throw TransmuteError.unsupported("not something the notch can do")
        }
    }

    // MARK: Images

    static func cgImage(_ source: URL, fit: Int?) throws -> CGImage {
        guard let src = CGImageSourceCreateWithURL(source as CFURL, nil) else { throw TransmuteError.unreadable }
        let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any] ?? [:]
        let width = props[kCGImagePropertyPixelWidth] as? Int ?? 0, height = props[kCGImagePropertyPixelHeight] as? Int ?? 0
        let longest = max(width, height)
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true, // keep the photo's orientation
            kCGImageSourceThumbnailMaxPixelSize: min(longest, fit ?? longest),
        ]
        guard longest > 0, let image = CGImageSourceCreateThumbnailAtIndex(src, 0, options as CFDictionary) else { throw TransmuteError.unreadable }
        return image
    }

    /// JPEG has no transparency: transparent pixels would turn black, so the image is laid on white first.
    static func flattenOnWhite(_ image: CGImage) -> CGImage {
        guard image.alphaInfo != .none, image.alphaInfo != .noneSkipFirst, image.alphaInfo != .noneSkipLast,
              let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return image }
        context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: image.width, height: image.height))
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        return context.makeImage() ?? image
    }

    static func write(_ image: CGImage, to out: URL, type: UTType, quality: Double?) throws {
        guard let destination = CGImageDestinationCreateWithURL(out as CFURL, type.identifier as CFString, 1, nil) else {
            throw TransmuteError.unsupported("this Mac cannot write \(type.preferredFilenameExtension ?? type.identifier)")
        }
        var options: [CFString: Any] = [:]
        if let quality { options[kCGImageDestinationLossyCompressionQuality] = quality }
        CGImageDestinationAddImage(destination, type == .jpeg ? flattenOnWhite(image) : image, options as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw TransmuteError.failed("could not write the image") }
    }

    static func image(_ source: URL, to out: URL, type: UTType, quality: Double?, fit: Int?, verb: String) throws -> Made {
        let image = try cgImage(source, fit: fit)
        try write(image, to: out, type: type, quality: quality)
        let before = (try? source.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        let after = (try? out.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        if verb == "Compressed" {
            // Not worth a new card when it did not get smaller.
            guard before > 0, after < before else { try? FileManager.default.removeItem(at: out); throw TransmuteError.failed("already as small as it gets") }
            return Made(path: out.path, note: "Compressed −\(Int((1 - Double(after) / Double(before)) * 100))%")
        }
        return Made(path: out.path, note: "\(verb) · \(ByteCountFormatter.string(fromByteCount: Int64(after), countStyle: .file))")
    }

    static func removeBackground(_ source: URL, to out: URL) throws -> Made {
        guard #available(macOS 14.0, *) else { throw TransmuteError.unsupported("needs macOS 14") }
        let image = try cgImage(source, fit: nil)
        let request = VNGenerateForegroundInstanceMaskRequest()
        let handler = VNImageRequestHandler(cgImage: image)
        try handler.perform([request])
        guard let result = request.results?.first, !result.allInstances.isEmpty else { throw TransmuteError.failed("no subject found to keep") }
        let buffer = try result.generateMaskedImage(ofInstances: result.allInstances, from: handler, croppedToInstancesExtent: false)
        let ci = CIImage(cvPixelBuffer: buffer)
        guard let masked = CIContext().createCGImage(ci, from: ci.extent) else { throw TransmuteError.failed("could not cut out the subject") }
        try write(masked, to: out, type: .png, quality: nil)
        return Made(path: out.path, note: "Background removed")
    }

    static func recognizeText(_ source: URL) throws -> String {
        let image = try cgImage(source, fit: nil)
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        try VNImageRequestHandler(cgImage: image).perform([request])
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    }

    // MARK: PDFs

    static func pdf(_ source: URL) throws -> PDFDocument {
        guard let document = PDFDocument(url: source), document.pageCount > 0 else { throw TransmuteError.unreadable }
        if document.isLocked { throw TransmuteError.unsupported("the PDF is locked") }
        return document
    }

    static func pdfPage1(_ source: URL, to out: URL) throws -> Made {
        let document = try pdf(source)
        let single = PDFDocument()
        guard let page = document.page(at: 0) else { throw TransmuteError.unreadable }
        single.insert(page, at: 0)
        guard single.write(to: out) else { throw TransmuteError.failed("could not write the PDF") }
        return Made(path: out.path, note: "Page 1 of \(document.pageCount)")
    }

    /// Redraws every page, annotations and form fields included, into a new PDF: nothing is editable any more.
    static func pdfFlatten(_ source: URL, to out: URL) throws -> Made {
        let document = try pdf(source)
        guard let consumer = CGDataConsumer(url: out as CFURL), let context = CGContext(consumer: consumer, mediaBox: nil, nil) else {
            throw TransmuteError.failed("could not write the PDF")
        }
        for index in 0..<document.pageCount {
            guard let page = document.page(at: index) else { continue }
            var box = page.bounds(for: .mediaBox)
            context.beginPage(mediaBox: &box)
            page.draw(with: .mediaBox, to: context)
            context.endPage()
        }
        context.closePDF()
        return Made(path: out.path, note: "Flattened · \(document.pageCount) pages")
    }

    static func pdfCompress(_ source: URL, to out: URL) throws -> Made {
        let document = try pdf(source)
        var options: [PDFDocumentWriteOption: Any] = [:]
        if #available(macOS 13.4, *) {
            options[.saveImagesAsJPEGOption] = true
            options[.optimizeImagesForScreenOption] = true
        }
        guard document.write(to: out, withOptions: options) else { throw TransmuteError.failed("could not write the PDF") }
        let before = (try? source.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        let after = (try? out.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard before > 0, after < before else { try? FileManager.default.removeItem(at: out); throw TransmuteError.failed("already as small as it gets") }
        return Made(path: out.path, note: "Compressed −\(Int((1 - Double(after) / Double(before)) * 100))% · \(ByteCountFormatter.string(fromByteCount: Int64(after), countStyle: .file))")
    }
}
