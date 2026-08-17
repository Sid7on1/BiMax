import AppKit
import CoreGraphics
import CryptoKit
import Foundation
import ImageIO
import ScreenCaptureKit
// `CuRect` and `CaptureWireFormat` are wire types, not local ones — they are declared in
// WireProtocol.swift and travel in snapshots and receipts. Without this import the reconstruction
// reads as "cannot find type" for symbols that were never actually missing.
import BimaxCuProtocol
import UniformTypeIdentifiers

/// RECONSTRUCTED 2026-08-18 — the capture pipeline types the evicted files took with them.
///
/// Every type below is contract-pinned by its surviving call sites (ScreenCaptureKitStreamDriver,
/// CaptureService, SOMCaptureComposer, ServiceCore); where a field exists only because a call
/// site reads it, the call site is the spec. Nothing here invents capability: the encoder encodes
/// what ScreenCaptureKit produced, the pool owns at most one stream (bounded by construction),
/// and the handle store is the in-process side of the protocol's separate binary image channel
/// (tokens + sha256 + byteCount — bytes never ride the JSON envelope).

// MARK: - Encoding

public enum CaptureImageFormat: String, Equatable, Sendable {
    case png
    case jpeg

    public init(_ wire: CaptureWireFormat) {
        self = wire == .png ? .png : .jpeg
    }
}

public struct CaptureEncodingRequest: Equatable, Sendable {
    public var format: CaptureImageFormat
    public var maxDimension: Int?
    public var jpegQuality: Double
    public var scaleFactor: Double
    /// Source pixels, top-left origin, cropped BEFORE scaling.
    public var sourcePixelRect: CuRect?

    public init(
        format: CaptureImageFormat,
        maxDimension: Int? = nil,
        jpegQuality: Double = 0.9,
        scaleFactor: Double = 1,
        sourcePixelRect: CuRect? = nil
    ) {
        self.format = format
        self.maxDimension = maxDimension
        self.jpegQuality = jpegQuality
        self.scaleFactor = scaleFactor
        self.sourcePixelRect = sourcePixelRect
    }
}

public enum CaptureImageEncoderError: Error, Equatable, Sendable {
    case emptyImage
    case renderFailed
    case encodeFailed
    case emptyRegion
}

/// The transform actually applied: crop in source pixels, then the produced output size.
public struct CaptureImageTransform: Equatable, Sendable {
    public var sourcePixelRect: CuRect
    public var outputWidth: Int
    public var outputHeight: Int

    public init(sourcePixelRect: CuRect, outputWidth: Int, outputHeight: Int) {
        self.sourcePixelRect = sourcePixelRect
        self.outputWidth = outputWidth
        self.outputHeight = outputHeight
    }
}

/// An encoded still image plus the geometry of its making. Bytes live here, never in envelopes.
public struct EncodedCaptureImage: Equatable, Sendable {
    public var data: Data
    public var format: CaptureImageFormat
    public var pixelWidth: Int
    public var pixelHeight: Int
    public var transform: CaptureImageTransform

    public init(
        data: Data,
        format: CaptureImageFormat,
        pixelWidth: Int,
        pixelHeight: Int,
        transform: CaptureImageTransform
    ) {
        self.data = data
        self.format = format
        self.pixelWidth = pixelWidth
        self.pixelHeight = pixelHeight
        self.transform = transform
    }

    /// The encoded bytes. `SOMCaptureComposer` re-decodes a still to draw marks over it and reads
    /// this name; `ServiceCore`'s binary read path uses the same word for the same thing. Kept as an
    /// alias rather than renaming `data`, so both vocabularies resolve to one stored property.
    public var bytes: Data { data }
}

public struct CaptureImageEncoder: Sendable {
    public init() {}

    public func encode(_ cgImage: CGImage, request: CaptureEncodingRequest) throws -> EncodedCaptureImage {
        var image = cgImage

        // Crop first (source pixels), then scale — the transform records exactly that order.
        if let region = request.sourcePixelRect {
            let rect = CGRect(
                x: region.x, y: region.y,
                width: region.width, height: region.height
            ).integral
            guard rect.width >= 1, rect.height >= 1,
                  rect.minX >= 0, rect.minY >= 0,
                  rect.maxX <= CGFloat(image.width), rect.maxY <= CGFloat(image.height) else {
                throw CaptureImageEncoderError.emptyRegion
            }
            guard let cropped = image.cropping(to: rect) else { throw CaptureImageEncoderError.renderFailed }
            image = cropped
        }

        let scale = max(request.scaleFactor, 0.01)
        var width = CGFloat(image.width) * scale
        var height = CGFloat(image.height) * scale
        if let maxDimension = request.maxDimension, maxDimension > 0,
           max(width, height) > CGFloat(maxDimension) {
            let shrink = CGFloat(maxDimension) / max(width, height)
            width *= shrink
            height *= shrink
        }
        width = max(width, 1)
        height = max(height, 1)

        let outWidth = Int(width.rounded())
        let outHeight = Int(height.rounded())
        if outWidth != image.width || outHeight != image.height {
            guard let resized = image.resized(to: CGSize(width: outWidth, height: outHeight)) else {
                throw CaptureImageEncoderError.renderFailed
            }
            image = resized
        }

        let uti: UTType = request.format == .png ? .png : .jpeg
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            output as CFMutableData, uti.identifier as CFString, 1, nil
        ) else { throw CaptureImageEncoderError.encodeFailed }
        let options: [CFString: Any] = request.format == .png
            ? [:]
            : [kCGImageDestinationLossyCompressionQuality: request.jpegQuality]
        CGImageDestinationAddImage(destination, image, options as CFDictionary)
        guard CGImageDestinationFinalize(destination), output.length > 0 else {
            throw CaptureImageEncoderError.encodeFailed
        }

        return EncodedCaptureImage(
            data: output as Data,
            format: request.format,
            pixelWidth: outWidth,
            pixelHeight: outHeight,
            transform: CaptureImageTransform(
                sourcePixelRect: request.sourcePixelRect ?? CuRect(
                    x: 0, y: 0, width: Double(cgImage.width), height: Double(cgImage.height)
                ),
                outputWidth: outWidth,
                outputHeight: outHeight
            )
        )
    }
}

extension CGImage {
    /// Lanczos-resized copy through CoreGraphics (the frameworks the package already links).
    fileprivate func resized(to size: CGSize) -> CGImage? {
        let width = max(Int(size.width.rounded()), 1)
        let height = max(Int(size.height.rounded()), 1)
        guard let context = CGContext(
            data: nil, width: width, height: height,
            bitsPerComponent: 8, bytesPerRow: 0,
            space: colorSpace ?? CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        context.interpolationQuality = .high
        context.draw(self, in: CGRect(x: 0, y: 0, width: width, height: height))
        return context.makeImage()
    }
}

// MARK: - Stream pool

public enum CaptureStreamTarget: Equatable, Sendable {
    case window(pid: Int32, windowId: UInt32)
    case display(displayId: UInt32)
}

/// Stream configuration a caller may ask for. Bounds, not guarantees: the driver clamps these
/// against the real source size, so asking for more than the surface has cannot inflate the capture.
public struct CaptureStreamOptions: Equatable, Sendable {
    public var maxWidth: Int
    public var maxHeight: Int
    /// Whether the pointer is composited into the frame. Off by default: a captured cursor is a
    /// distracting artefact in evidence, and the agent's own pointer position is already recorded.
    public var showsCursor: Bool

    public init(maxWidth: Int = 4_096, maxHeight: Int = 4_096, showsCursor: Bool = false) {
        self.maxWidth = maxWidth
        self.maxHeight = maxHeight
        self.showsCursor = showsCursor
    }
}

/// The capture surface `ScreenCaptureKitStreamDriver` implements.
///
/// `@MainActor` because ScreenCaptureKit's stream objects are main-actor bound, and the pool that
/// owns a driver is an actor that must hop to reach it.
///
/// `stillImage` is deliberately NOT a requirement here: it is macOS 14+, the driver's floor is 12.3,
/// and both call sites hold the concrete driver inside an `#available` check. Putting it in the
/// protocol would force every conformer to carry an availability it may not have.
@available(macOS 12.3, *)
@MainActor public protocol CaptureStreamDriving: AnyObject {
    /// Starts a stream and returns the handle every later call is addressed to.
    func start(target: CaptureStreamTarget, options: CaptureStreamOptions) async throws -> String
    func stop(handle: String) async
    /// Nil when the handle is unknown — distinct from a live stream that has produced no frames,
    /// which reports zeroed counters instead.
    func stats(handle: String) async -> CaptureStreamStats?
    /// Nil when no complete frame has arrived yet. Never a stale or synthesised frame.
    func image(handle: String, request: CaptureEncodingRequest) async throws -> EncodedCaptureImage?
}

public struct CaptureStreamStats: Equatable, Sendable {
    /// Every valid sample buffer the stream handed us, complete or not. Kept separate from
    /// `completeFrames` because the difference is the diagnosis: frames arriving but never
    /// completing is a stalled compositor, whereas no frames at all is a dead stream, and a single
    /// counter cannot tell those apart.
    public var receivedFrames: UInt64
    public var completeFrames: UInt64
    /// Frames SCFrameStatus reported as `.idle` — the surface had nothing new to show. Normal for a
    /// static window, so this is what stops "no complete frames" being read as a failure.
    public var idleFrames: UInt64
    public var width: Int?
    public var height: Int?
    public var latestLatencyMs: Double?
    public var lastFrameStatusRaw: Int
    /// Set once when the stream stops, naming why. Nil while running.
    public var stoppedReason: String?

    public init(
        receivedFrames: UInt64 = 0,
        completeFrames: UInt64 = 0,
        idleFrames: UInt64 = 0,
        width: Int? = nil,
        height: Int? = nil,
        latestLatencyMs: Double? = nil,
        lastFrameStatusRaw: Int = 0,
        stoppedReason: String? = nil
    ) {
        self.receivedFrames = receivedFrames
        self.completeFrames = completeFrames
        self.idleFrames = idleFrames
        self.width = width
        self.height = height
        self.latestLatencyMs = latestLatencyMs
        self.lastFrameStatusRaw = lastFrameStatusRaw
        self.stoppedReason = stoppedReason
    }
}

public struct CaptureStreamLease: Equatable, Sendable {
    public let handle: String
    public let target: CaptureStreamTarget
}

/// A bounded single-stream pool. `maxStreams` exists in the initializer's contract; the pool
/// enforces it by never holding more than `min(maxStreams, 1)` — one ScreenCaptureKit stream is
/// the entire budget a still-image capture needs, and a bounded pool that silently over-commits
/// would be worse than an honest single-stream one.
public actor CaptureStreamPool {
    private let maxStreams: Int
    private let driver: ScreenCaptureKitStreamDriver?
    private var active: (lease: CaptureStreamLease, output: PoolFrameOutput)?

    public init(maxStreams: Int, driver: ScreenCaptureKitStreamDriver? = nil) {
        self.maxStreams = max(1, maxStreams)
        self.driver = driver
    }

    @available(macOS 12.3, *)
    public func acquire(target: CaptureStreamTarget) async throws -> CaptureStreamLease {
        await teardown()
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        let filter: SCContentFilter
        switch target {
        case .window(let pid, let windowId):
            guard let window = content.windows.first(where: {
                $0.windowID == windowId && $0.owningApplication?.processID == pid
            }) else { throw ScreenCaptureKitStreamError.targetUnavailable }
            filter = SCContentFilter(desktopIndependentWindow: window)
        case .display(let displayId):
            guard let display = content.displays.first(where: { $0.displayID == displayId }) else {
                throw ScreenCaptureKitStreamError.targetUnavailable
            }
            filter = SCContentFilter(display: display, excludingWindows: [])
        }

        let configuration = SCStreamConfiguration()
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 5)
        configuration.queueDepth = 2
        let output = PoolFrameOutput()
        let stream = SCStream(filter: filter, configuration: configuration, delegate: output)
        do {
            try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: nil)
        } catch {
            throw ScreenCaptureKitStreamError.startFailed
        }
        output.attach(stream: stream)
        do {
            try await stream.startCapture()
        } catch {
            throw ScreenCaptureKitStreamError.startFailed
        }
        let lease = CaptureStreamLease(handle: UUID().uuidString, target: target)
        active = (lease, output)
        return lease
    }

    public func stats(for lease: CaptureStreamLease) -> CaptureStreamStats? {
        guard active?.lease == lease else { return nil }
        return active?.output.stats()
    }

    public func image(for lease: CaptureStreamLease, request: CaptureEncodingRequest) throws -> EncodedCaptureImage? {
        guard let current = active, current.lease == lease else { return nil }
        return try current.output.image(request: request)
    }

    public func release(_ lease: CaptureStreamLease) async {
        guard active?.lease == lease else { return }
        await teardown()
    }

    public func reset() async {
        await teardown()
    }

    private func teardown() async {
        guard let current = active else { return }
        active = nil
        try? await current.output.stop()
    }
}

/// Frame sink for the pool's single stream: keeps only the latest complete frame, encodes on
/// demand — the same contract the driver's pooled output implements for named captures.
private final class PoolFrameOutput: NSObject, SCStreamDelegate, SCStreamOutput, @unchecked Sendable {
    private let lock = NSLock()
    private var latestBuffer: CVPixelBuffer?
    private var statsValue = CaptureStreamStats()
    private var stream: SCStream?
    private var stopped = false

    func attach(stream: SCStream) {
        lock.lock()
        self.stream = stream
        lock.unlock()
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        lock.lock()
        stopped = true
        lock.unlock()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid, let buffer = sampleBuffer.imageBuffer else { return }
        // Frame status is an attachment on the sample buffer, not a property of it. Reading it is
        // what separates a real frame from an idle or blank one; without it every delivered buffer
        // counted as a complete frame and the pool reported success on a stream showing nothing.
        let statusRaw = (CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
            as? [[SCStreamFrameInfo: Any]])?.first?[.status] as? Int
        let status = statusRaw.flatMap(SCFrameStatus.init(rawValue:))
        guard status == nil || status == .complete else {
            lock.withLock {
                statsValue.receivedFrames &+= 1
                if status == .idle { statsValue.idleFrames &+= 1 }
                if let statusRaw { statsValue.lastFrameStatusRaw = statusRaw }
            }
            return
        }
        let dimensions: (Int, Int)? = {
            let width = CVPixelBufferGetWidth(buffer)
            let height = CVPixelBufferGetHeight(buffer)
            return width > 0 && height > 0 ? (width, height) : nil
        }()
        let now = CMClockGetTime(CMClockGetHostTimeClock())
        let latency = now.seconds - sampleBuffer.presentationTimeStamp.seconds
        lock.withLock {
            latestBuffer = buffer
            statsValue.receivedFrames &+= 1
            statsValue.completeFrames &+= 1
            statsValue.width = dimensions?.0
            statsValue.height = dimensions?.1
            statsValue.latestLatencyMs = latency.isFinite && latency >= 0 && latency < 5
                ? latency * 1_000 : nil
            statsValue.lastFrameStatusRaw = statusRaw ?? SCFrameStatus.complete.rawValue
        }
    }

    func stats() -> CaptureStreamStats {
        lock.lock()
        defer { lock.unlock() }
        return statsValue
    }

    func image(request: CaptureEncodingRequest) throws -> EncodedCaptureImage? {
        lock.lock()
        let buffer = latestBuffer
        lock.unlock()
        guard let pixelBuffer = buffer else { return nil }
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        let context = CIContext()
        guard let cgImage = context.createCGImage(ciImage, from: ciImage.extent) else {
            throw CaptureImageEncoderError.renderFailed
        }
        return try CaptureImageEncoder().encode(cgImage, request: request)
    }

    func stop() async {
        let stream = lock.withLock { () -> SCStream? in
            let held = self.stream
            self.stream = nil
            return held
        }
        try? await stream?.stopCapture()
    }
}

// MARK: - Image handle store (the binary image channel's in-process side)

public enum ImageHandleStoreError: Error, Equatable, Sendable {
    case invalidHandle
    case sessionMismatch
    case storeLimitExceeded
    /// Empty bytes or a non-positive dimension. `ServiceCore` maps this to `invalid_image`, so the
    /// check that produces it has to exist here — a store that accepted a zero-sized image would
    /// hand out a handle that every later read fails on, naming the reader instead of the writer.
    case invalidImage
    case imageTooLarge
    /// The recorded transform disagrees with the image it describes. The transform is what a caller
    /// maps coordinates through, so a mismatch silently returns points in the wrong space.
    case invalidTransform
}

/// Internal handle: identity and integrity metadata only — the envelope-facing mirror is
/// `ImageHandleRef` in the protocol library.
public struct CaptureImageHandle: Equatable, Sendable {
    public var token: String
    public var sessionId: String
    public var format: CaptureImageFormat
    public var pixelWidth: Int
    public var pixelHeight: Int
    public var byteCount: Int
    public var sha256: String
    public var createdAtMs: Int64

    public init(
        token: String,
        sessionId: String,
        format: CaptureImageFormat,
        pixelWidth: Int,
        pixelHeight: Int,
        byteCount: Int,
        sha256: String,
        createdAtMs: Int64
    ) {
        self.token = token
        self.sessionId = sessionId
        self.format = format
        self.pixelWidth = pixelWidth
        self.pixelHeight = pixelHeight
        self.byteCount = byteCount
        self.sha256 = sha256
        self.createdAtMs = createdAtMs
    }
}

public struct StoredCaptureImage: Equatable, Sendable {
    public var handle: CaptureImageHandle
    public var transform: CaptureImageTransform
    public var bytes: Data

    public init(handle: CaptureImageHandle, transform: CaptureImageTransform, bytes: Data) {
        self.handle = handle
        self.transform = transform
        self.bytes = bytes
    }
}

/// Retains captured bytes under unguessable tokens, scoped to a session, integrity-stamped.
/// Bounded: a session that retains without releasing cannot grow the store past `capacity`
/// (default 32 images — a vision loop's working set, not a cache).
public final class ImageHandleStore: @unchecked Sendable {
    private let lock = NSLock()
    private var images: [String: StoredCaptureImage] = [:]
    private let capacity: Int

    public init(capacity: Int = 32) {
        self.capacity = max(1, capacity)
    }

    /// Bytes above this are refused rather than retained. A single still that large is a symptom
    /// (an unclamped display capture, a runaway scale factor), and holding it would evict the
    /// handles a live operation is mid-way through using.
    public static let maxImageBytes = 64 * 1024 * 1024

    public func retain(sessionId: String, image: EncodedCaptureImage) throws -> CaptureImageHandle {
        // Validate before taking the lock: a rejected image never becomes a handle, so it must not
        // be able to occupy capacity or race a concurrent retain.
        guard !image.data.isEmpty, image.pixelWidth > 0, image.pixelHeight > 0 else {
            throw ImageHandleStoreError.invalidImage
        }
        guard image.data.count <= Self.maxImageBytes else {
            throw ImageHandleStoreError.imageTooLarge
        }
        guard image.transform.outputWidth == image.pixelWidth,
              image.transform.outputHeight == image.pixelHeight else {
            throw ImageHandleStoreError.invalidTransform
        }
        lock.lock()
        defer { lock.unlock() }
        if images.count >= capacity {
            throw ImageHandleStoreError.storeLimitExceeded
        }
        let token = UUID().uuidString
        let handle = CaptureImageHandle(
            token: token,
            sessionId: sessionId,
            format: image.format,
            pixelWidth: image.pixelWidth,
            pixelHeight: image.pixelHeight,
            byteCount: image.data.count,
            sha256: Self.sha256Hex(image.data),
            createdAtMs: Int64(Date().timeIntervalSince1970 * 1000)
        )
        images[token] = StoredCaptureImage(handle: handle, transform: image.transform, bytes: image.data)
        return handle
    }

    public func resolve(sessionId: String, handle: CaptureImageHandle) throws -> StoredCaptureImage {
        lock.lock()
        defer { lock.unlock() }
        guard let stored = images[handle.token] else { throw ImageHandleStoreError.invalidHandle }
        guard stored.handle.sessionId == sessionId, handle.sessionId == sessionId else {
            throw ImageHandleStoreError.sessionMismatch
        }
        guard stored.handle == handle || stored.handle.token == handle.token else {
            throw ImageHandleStoreError.invalidHandle
        }
        return stored
    }

    public func release(sessionId: String, handle: CaptureImageHandle) throws {
        lock.lock()
        defer { lock.unlock() }
        guard let stored = images[handle.token] else { throw ImageHandleStoreError.invalidHandle }
        guard stored.handle.sessionId == sessionId else { throw ImageHandleStoreError.sessionMismatch }
        images.removeValue(forKey: handle.token)
    }

    public func reset(sessionId: String) {
        lock.lock()
        defer { lock.unlock() }
        images = images.filter { $0.value.handle.sessionId != sessionId }
    }

    private static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
