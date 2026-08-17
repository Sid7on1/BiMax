// Extracted from native/BimaxLivePip.swift's proven ScreenCaptureKit lifecycle.

@preconcurrency import CoreMedia
@preconcurrency import CoreVideo
import CoreImage
import Foundation
@preconcurrency import ScreenCaptureKit

@available(macOS 12.3, *)
private final class PooledCaptureOutput: NSObject, SCStreamOutput, @unchecked Sendable {
    private let lock = NSLock()
    private var value = CaptureStreamStats()
    private var latestCompleteBuffer: CMSampleBuffer?

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of outputType: SCStreamOutputType
    ) {
        guard outputType == .screen, sampleBuffer.isValid,
              CMSampleBufferDataIsReady(sampleBuffer) else { return }
        lock.withLock { value.receivedFrames &+= 1 }
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(
            sampleBuffer,
            createIfNecessary: false
        ) as? [[SCStreamFrameInfo: Any]],
           let raw = attachments.first?[.status] as? Int,
           let status = SCFrameStatus(rawValue: raw), status != .complete {
            lock.withLock {
                value.lastFrameStatusRaw = raw
                if status == .idle { value.idleFrames &+= 1 }
            }
            return
        }

        let dimensions = sampleBuffer.imageBuffer.map {
            (CVPixelBufferGetWidth($0), CVPixelBufferGetHeight($0))
        }
        let now = CMClockGetTime(CMClockGetHostTimeClock())
        let latency = now.seconds - sampleBuffer.presentationTimeStamp.seconds
        lock.withLock {
            value.completeFrames &+= 1
            value.width = dimensions?.0
            value.height = dimensions?.1
            value.latestLatencyMs = latency.isFinite && latency >= 0 && latency < 5
                ? latency * 1_000 : nil
            value.lastFrameStatusRaw = SCFrameStatus.complete.rawValue
            latestCompleteBuffer = sampleBuffer
        }
    }

    func stats() -> CaptureStreamStats { lock.withLock { value } }
    func stopped(reason: String) { lock.withLock { value.stoppedReason = reason } }

    func image(request: CaptureEncodingRequest) throws -> EncodedCaptureImage? {
        guard let pixelBuffer = lock.withLock({ latestCompleteBuffer?.imageBuffer }) else { return nil }
        let context = CIContext()
        let image = CIImage(cvPixelBuffer: pixelBuffer)
        guard let cgImage = context.createCGImage(image, from: image.extent) else {
            throw CaptureImageEncoderError.renderFailed
        }
        return try CaptureImageEncoder().encode(cgImage, request: request)
    }
}

@available(macOS 12.3, *)
private final class PooledCapture: NSObject, SCStreamDelegate, @unchecked Sendable {
    private(set) var stream: SCStream!
    let output: PooledCaptureOutput

    init(filter: SCContentFilter, configuration: SCStreamConfiguration, queue: DispatchQueue) throws {
        output = PooledCaptureOutput()
        super.init()
        stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: queue)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        output.stopped(reason: error.localizedDescription)
    }
}

/// Production ScreenCaptureKit driver used by `CaptureStreamPool`.
///
/// It retains only stream/output objects and frame metadata. Image handles are added separately so
/// stream availability cannot be mistaken for verified image delivery.
@available(macOS 12.3, *)
@MainActor public final class ScreenCaptureKitStreamDriver: CaptureStreamDriving, @unchecked Sendable {
    private let captureQueue = DispatchQueue(label: "ai.bimax.capture-pool", qos: .userInitiated)
    private var captures: [String: PooledCapture] = [:]

    public init() {}

    public func start(target: CaptureStreamTarget, options: CaptureStreamOptions) async throws -> String {
        let content = try await SCShareableContent.excludingDesktopWindows(
            false,
            onScreenWindowsOnly: false
        )
        let filter: SCContentFilter
        let sourceSize: CGSize
        switch target {
        case .window(let pid, let windowId):
            guard let window = content.windows.first(where: {
                $0.windowID == windowId && $0.owningApplication?.processID == pid
            }) else {
                throw ScreenCaptureKitStreamError.targetUnavailable
            }
            filter = SCContentFilter(desktopIndependentWindow: window)
            sourceSize = window.frame.size
        case .display(let displayId):
            guard let display = content.displays.first(where: { $0.displayID == displayId }) else {
                throw ScreenCaptureKitStreamError.targetUnavailable
            }
            filter = SCContentFilter(display: display, excludingWindows: [])
            sourceSize = CGSize(width: display.width, height: display.height)
        }

        let configuration = SCStreamConfiguration()
        let scale: CGFloat = 2
        configuration.width = max(1, min(options.maxWidth, Int(sourceSize.width * scale)))
        configuration.height = max(1, min(options.maxHeight, Int(sourceSize.height * scale)))
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 60)
        configuration.queueDepth = 3
        configuration.showsCursor = options.showsCursor
        configuration.pixelFormat = kCVPixelFormatType_32BGRA

        let capture = try PooledCapture(
            filter: filter,
            configuration: configuration,
            queue: captureQueue
        )
        try await capture.stream.startCapture()
        let handle = UUID().uuidString
        captures[handle] = capture
        return handle
    }

    public func stop(handle: String) async {
        guard let capture = captures.removeValue(forKey: handle) else { return }
        try? await capture.stream.stopCapture()
    }

    public func stats(handle: String) async -> CaptureStreamStats? {
        captures[handle]?.output.stats()
    }

    public func image(
        handle: String,
        request: CaptureEncodingRequest
    ) async throws -> EncodedCaptureImage? {
        try captures[handle]?.output.image(request: request)
    }

    /// One-shot fallback for macOS 14+. Some compositor states suspend a continuous window stream
    /// before it emits a complete frame, while SCScreenshotManager can still produce the exact
    /// desktop-independent window image. This is a distinct Apple-supported capture mechanism, not
    /// a cached frame or a relaxation of the image postcondition.
    @available(macOS 14.0, *)
    public func stillImage(
        target: CaptureStreamTarget,
        request: CaptureEncodingRequest
    ) async throws -> EncodedCaptureImage {
        let content = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: false
        )
        let filter: SCContentFilter
        let sourceSize: CGSize
        switch target {
        case .window(let pid, let windowId):
            guard let window = content.windows.first(where: {
                $0.windowID == windowId && $0.owningApplication?.processID == pid
            }) else { throw ScreenCaptureKitStreamError.targetUnavailable }
            filter = SCContentFilter(desktopIndependentWindow: window)
            sourceSize = window.frame.size
        case .display(let displayId):
            guard let display = content.displays.first(where: { $0.displayID == displayId }) else {
                throw ScreenCaptureKitStreamError.targetUnavailable
            }
            filter = SCContentFilter(display: display, excludingWindows: [])
            sourceSize = CGSize(width: display.width, height: display.height)
        }
        let configuration = SCStreamConfiguration()
        configuration.width = max(1, min(4_096, Int(sourceSize.width * 2)))
        configuration.height = max(1, min(4_096, Int(sourceSize.height * 2)))
        configuration.showsCursor = false
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        let image = try await SCScreenshotManager.captureImage(
            contentFilter: filter, configuration: configuration
        )
        return try CaptureImageEncoder().encode(image, request: request)
    }
}

public enum ScreenCaptureKitStreamError: Error, Equatable, Sendable {
    /// The window or display named by the request is not in the shareable content list — it closed,
    /// moved to another process, or was never capturable.
    case targetUnavailable
    /// The target existed but the stream could not be attached or started. Distinct from
    /// `targetUnavailable` because the remedy differs: this one is usually a permission or
    /// compositor state, not a stale target, so retrying with a different window will not help.
    case startFailed
}
