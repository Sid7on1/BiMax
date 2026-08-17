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
        format: CaptureImageFormat = .png,
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

    /// Rejects a malformed request before any pixels are touched. Each of these would otherwise
    /// produce a plausible-looking image rather than an error, which is the worse outcome: the
    /// caller acts on it.
    public func validate() throws {
        if let maxDimension, maxDimension <= 0 { throw CaptureImageEncoderError.invalidLimit }
        guard (0...1).contains(jpegQuality) else { throw CaptureImageEncoderError.invalidQuality }
        guard scaleFactor > 0 else { throw CaptureImageEncoderError.invalidLimit }
        if let rect = sourcePixelRect, rect.width <= 0 || rect.height <= 0 {
            throw CaptureImageEncoderError.invalidCrop
        }
    }
}

public enum CaptureImageEncoderError: Error, Equatable, Sendable {
    case emptyImage
    case renderFailed
    case encodeFailed
    case emptyRegion
    /// A non-positive `maxDimension`. Zero is not "no limit" — that is what `nil` means — so
    /// accepting it would silently produce a 1px image instead of refusing a malformed request.
    case invalidLimit
    /// JPEG quality outside 0...1.
    case invalidQuality
    /// A crop that is empty or reaches outside the source image.
    case invalidCrop
}

/// The transform actually applied: crop in source pixels, then the produced output size.
///
/// This is the only thing that lets a caller turn a coordinate it read off an image back into a
/// screen coordinate, so it validates on construction. A degenerate rect or a zero output would
/// divide by zero at map time — far from the mistake — and a transform that cannot map is worse
/// than no transform, because callers trust it.
public struct CaptureImageTransform: Equatable, Sendable {
    public var sourcePixelRect: CuRect
    public var outputWidth: Int
    public var outputHeight: Int

    public init(sourcePixelRect: CuRect, outputWidth: Int, outputHeight: Int) throws {
        guard sourcePixelRect.x.isFinite, sourcePixelRect.y.isFinite,
              sourcePixelRect.width.isFinite, sourcePixelRect.height.isFinite,
              sourcePixelRect.width > 0, sourcePixelRect.height > 0,
              outputWidth > 0, outputHeight > 0 else {
            throw ImageHandleStoreError.invalidTransform
        }
        self.sourcePixelRect = sourcePixelRect
        self.outputWidth = outputWidth
        self.outputHeight = outputHeight
    }

    /// Output pixel -> source pixel. Returns a zero-size rect AT the mapped point, and nil when the
    /// coordinate is outside the image: a point that was never in the frame has no source, and
    /// clamping it would invent a location the caller would then click.
    public func sourcePixel(x: Int, y: Int) -> CuRect? {
        guard x >= 0, y >= 0, x < outputWidth, y < outputHeight else { return nil }
        return CuRect(
            x: sourcePixelRect.x + Double(x) * sourcePixelRect.width / Double(outputWidth),
            y: sourcePixelRect.y + Double(y) * sourcePixelRect.height / Double(outputHeight),
            width: 0, height: 0
        )
    }

    /// Source pixel -> output pixel, the exact inverse of `sourcePixel`.
    public func outputPixel(sourceX: Double, sourceY: Double) -> CuRect? {
        let x = (sourceX - sourcePixelRect.x) * Double(outputWidth) / sourcePixelRect.width
        let y = (sourceY - sourcePixelRect.y) * Double(outputHeight) / sourcePixelRect.height
        guard x >= 0, y >= 0, x < Double(outputWidth), y < Double(outputHeight) else { return nil }
        return CuRect(x: x.rounded(.down), y: y.rounded(.down), width: 0, height: 0)
    }
}

/// An encoded still image plus the geometry of its making. Bytes live here, never in envelopes.
public struct EncodedCaptureImage: Equatable, Sendable {
    public var bytes: Data
    public var format: CaptureImageFormat
    public var pixelWidth: Int
    public var pixelHeight: Int
    public var transform: CaptureImageTransform

    public init(
        bytes: Data,
        format: CaptureImageFormat,
        pixelWidth: Int,
        pixelHeight: Int,
        transform: CaptureImageTransform
    ) {
        self.bytes = bytes
        self.format = format
        self.pixelWidth = pixelWidth
        self.pixelHeight = pixelHeight
        self.transform = transform
    }

    /// Some call sites say `data` for the same encoded bytes. One stored property, two names.
    public var data: Data { bytes }
}

public struct CaptureImageEncoder: Sendable {
    public init() {}

    public func encode(_ cgImage: CGImage, request: CaptureEncodingRequest) throws -> EncodedCaptureImage {
        try request.validate()
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
                throw CaptureImageEncoderError.invalidCrop
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
            bytes: output as Data,
            format: request.format,
            pixelWidth: outWidth,
            pixelHeight: outHeight,
            transform: try CaptureImageTransform(
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

public enum CaptureStreamTarget: Hashable, Sendable {
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

    public init(maxWidth: Int = 2_560, maxHeight: Int = 2_560, showsCursor: Bool = false) {
        self.maxWidth = maxWidth
        self.maxHeight = maxHeight
        self.showsCursor = showsCursor
    }
}

/// The capture surface `ScreenCaptureKitStreamDriver` implements.
///
/// `stillImage` is deliberately NOT a requirement here: it is macOS 14+, the driver's floor is 12.3,
/// and both call sites hold the concrete driver inside an `#available` check. Putting it in the
/// protocol would force every conformer to carry an availability it may not have.
/// Not `@MainActor`: the pool is an actor and the suite's own driver double is a plain class, so
/// isolating the protocol would make every conformer main-actor-bound for no benefit. The one
/// production driver that IS main-actor-bound isolates itself.
@available(macOS 12.3, *)
public protocol CaptureStreamDriving: AnyObject, Sendable {
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
    /// The LEASE's identity, not the stream's — several leases share one stream handle, so
    /// conflating the two is what makes a shared stream look like a leak.
    public let id: UUID
    public let target: CaptureStreamTarget

    public init(id: UUID = UUID(), target: CaptureStreamTarget) {
        self.id = id
        self.target = target
    }
}

/// A bounded pool of capture streams, shared by lease.
///
/// Two leases on the SAME target share one stream — a second ScreenCaptureKit stream on a window
/// already being captured costs a real frame budget and buys nothing. `maxStreams` bounds distinct
/// streams, not leases, and a stream is torn down only when its last lease is released.
public actor CaptureStreamPool {
    private struct Stream {
        var handle: String
        var leases: Int
        var lastUsed: UInt64
    }

    private let maxStreams: Int
    private let driver: (any CaptureStreamDriving)?
    /// Keyed by target: this is what makes a warm stream reusable.
    private var streams: [CaptureStreamTarget: Stream] = [:]
    private var leaseTargets: [UUID: CaptureStreamTarget] = [:]
    private var usageClock: UInt64 = 0

    public init(maxStreams: Int, driver: (any CaptureStreamDriving)? = nil) throws {
        guard maxStreams >= 1 else { throw CaptureStreamPoolError.invalidCapacity }
        self.maxStreams = maxStreams
        self.driver = driver
    }

    public func acquire(target: CaptureStreamTarget) async throws -> CaptureStreamLease {
        guard let driver else { throw CaptureStreamPoolError.driverUnavailable }
        if var existing = streams[target] {
            existing.leases += 1
            usageClock &+= 1
            existing.lastUsed = usageClock
            streams[target] = existing
            let lease = CaptureStreamLease(target: target)
            leaseTargets[lease.id] = target
            return lease
        }
        if streams.count >= maxStreams {
            guard let eviction = streams
                .filter({ $0.value.leases == 0 })
                .min(by: { $0.value.lastUsed < $1.value.lastUsed }) else {
                throw CaptureStreamPoolError.capacityExhausted
            }
            streams.removeValue(forKey: eviction.key)
            await driver.stop(handle: eviction.value.handle)
        }
        let handle = try await driver.start(target: target, options: CaptureStreamOptions())
        usageClock &+= 1
        streams[target] = Stream(handle: handle, leases: 1, lastUsed: usageClock)
        let lease = CaptureStreamLease(target: target)
        leaseTargets[lease.id] = target
        return lease
    }

    /// Throws on a lease this pool never issued. Silently ignoring one would let a caller "release"
    /// a stream it does not hold and believe it had freed something.
    public func release(_ lease: CaptureStreamLease) async throws {
        guard let target = leaseTargets.removeValue(forKey: lease.id),
              var stream = streams[target] else {
            throw CaptureStreamPoolError.invalidLease
        }
        stream.leases -= 1
        // Zero-holder streams stay warm only inside the bounded pool. They are the first candidates
        // for LRU eviction and reset always stops them, so reuse does not grow without limit.
        usageClock &+= 1
        stream.lastUsed = usageClock
        streams[target] = stream
    }

    public func stats(for lease: CaptureStreamLease) async -> CaptureStreamStats? {
        guard let target = leaseTargets[lease.id],
              let stream = streams[target] else { return nil }
        return await driver?.stats(handle: stream.handle)
    }

    public func image(
        for lease: CaptureStreamLease,
        request: CaptureEncodingRequest
    ) async throws -> EncodedCaptureImage? {
        guard let target = leaseTargets[lease.id],
              let stream = streams[target] else { return nil }
        return try await driver?.image(handle: stream.handle, request: request)
    }

    public func snapshot() -> CaptureStreamPoolSnapshot {
        CaptureStreamPoolSnapshot(
            activeStreams: streams.count,
            activeLeases: leaseTargets.count,
            idleStreams: streams.values.filter { $0.leases == 0 }.count
        )
    }

    public func reset() async {
        // Deterministic least-recently-used order makes shutdown receipts and tests stable.
        let handles = streams.values.sorted { $0.lastUsed < $1.lastUsed }.map(\.handle)
        streams.removeAll()
        leaseTargets.removeAll()
        for handle in handles { await driver?.stop(handle: handle) }
    }
}

public enum CaptureStreamPoolError: Error, Equatable, Sendable {
    case invalidLease
    case invalidCapacity
    case capacityExhausted
    case driverUnavailable
}

/// Lease and stream counts, so sharing and leaks are both observable.
public struct CaptureStreamPoolSnapshot: Equatable, Sendable {
    public var activeStreams: Int
    public var activeLeases: Int
    public var idleStreams: Int

    public init(activeStreams: Int, activeLeases: Int, idleStreams: Int) {
        self.activeStreams = activeStreams
        self.activeLeases = activeLeases
        self.idleStreams = idleStreams
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
    private var insertionOrder: [String] = []
    private let capacity: Int
    private let maxBytesPerSession: Int

    private let now: @Sendable () -> Int64

    public init(
        maxHandlesPerSession: Int = 32,
        maxBytesPerSession: Int = 256 * 1024 * 1024,
        now: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1_000) }
    ) {
        self.now = now
        self.capacity = max(1, maxHandlesPerSession)
        // Handle count alone does not bound memory — a few full-display PNGs outweigh many small
        // crops — so the byte budget is enforced separately.
        self.maxBytesPerSession = max(1, maxBytesPerSession)
    }

    /// Bytes above this are refused rather than retained. A single still that large is a symptom
    /// (an unclamped display capture, a runaway scale factor), and holding it would evict the
    /// handles a live operation is mid-way through using.
    public static let maxImageBytes = 64 * 1024 * 1024

    /// How many handles a session currently holds. Used to prove bytes were retained BEHIND a
    /// handle rather than inlined into the envelope.
    public func retainedCount(sessionId: String) -> Int {
        lock.withLock { images.values.filter { $0.handle.sessionId == sessionId }.count }
    }

    /// Total retained bytes for a session — the budget that actually bounds memory.
    public func retainedBytes(sessionId: String) -> Int {
        lock.withLock {
            images.values.filter { $0.handle.sessionId == sessionId }
                .reduce(0) { $0 + $1.handle.byteCount }
        }
    }

    /// Retains already-encoded bytes. The granular form exists because a caller that produced the
    /// bytes itself should not have to rebuild an `EncodedCaptureImage` just to store them.
    public func retain(
        sessionId: String,
        bytes: Data,
        format: CaptureImageFormat,
        pixelWidth: Int,
        pixelHeight: Int,
        transform: CaptureImageTransform
    ) throws -> CaptureImageHandle {
        try retain(sessionId: sessionId, image: EncodedCaptureImage(
            bytes: bytes, format: format,
            pixelWidth: pixelWidth, pixelHeight: pixelHeight, transform: transform
        ))
    }

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
        guard image.data.count <= maxBytesPerSession else {
            throw ImageHandleStoreError.storeLimitExceeded
        }
        lock.lock()
        defer { lock.unlock() }
        func sessionUsage() -> (count: Int, bytes: Int) {
            let retained = images.values.filter { $0.handle.sessionId == sessionId }
            return (retained.count, retained.reduce(0) { $0 + $1.handle.byteCount })
        }
        var usage = sessionUsage()
        while usage.count >= capacity || usage.bytes + image.data.count > maxBytesPerSession {
            guard let oldest = insertionOrder.first(where: {
                images[$0]?.handle.sessionId == sessionId
            }) else {
                throw ImageHandleStoreError.storeLimitExceeded
            }
            images.removeValue(forKey: oldest)
            insertionOrder.removeAll { $0 == oldest }
            usage = sessionUsage()
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
            createdAtMs: now()
        )
        images[token] = StoredCaptureImage(handle: handle, transform: image.transform, bytes: image.data)
        insertionOrder.append(token)
        return handle
    }

    public func resolve(sessionId: String, handle: CaptureImageHandle) throws -> StoredCaptureImage {
        lock.lock()
        defer { lock.unlock() }
        guard let stored = images[handle.token] else { throw ImageHandleStoreError.invalidHandle }
        guard stored.handle.sessionId == sessionId, handle.sessionId == sessionId else {
            // Do not reveal whether a token exists in another session.
            throw ImageHandleStoreError.invalidHandle
        }
        guard stored.handle == handle else {
            throw ImageHandleStoreError.invalidHandle
        }
        return stored
    }

    public func release(sessionId: String, handle: CaptureImageHandle) throws {
        lock.lock()
        defer { lock.unlock() }
        guard let stored = images[handle.token] else { throw ImageHandleStoreError.invalidHandle }
        guard stored.handle.sessionId == sessionId, stored.handle == handle else {
            throw ImageHandleStoreError.invalidHandle
        }
        images.removeValue(forKey: handle.token)
        insertionOrder.removeAll { $0 == handle.token }
    }

    public func reset(sessionId: String) {
        lock.lock()
        defer { lock.unlock() }
        let removed = Set(images.values.filter { $0.handle.sessionId == sessionId }.map(\.handle.token))
        images = images.filter { $0.value.handle.sessionId != sessionId }
        insertionOrder.removeAll { removed.contains($0) }
    }

    private static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
