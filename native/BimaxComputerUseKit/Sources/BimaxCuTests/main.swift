import ApplicationServices
import CoreText
import Darwin
import Foundation
import ImageIO
import BimaxCuProtocol
import BimaxComputerUseKit

private enum TestFailure: Error, CustomStringConvertible {
    case failed(String)
    var description: String {
        switch self { case .failed(let message): return message }
    }
}

private func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    guard condition() else { throw TestFailure.failed(message) }
}

private final class AsyncResultBox<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Result<Value, Error>?

    func set(_ result: Result<Value, Error>) { lock.withLock { value = result } }
    func get() -> Result<Value, Error>? { lock.withLock { value } }
}

private func waitForAsync<Value: Sendable>(
    _ operation: @escaping @Sendable () async throws -> Value
) throws -> Value {
    let semaphore = DispatchSemaphore(value: 0)
    let box = AsyncResultBox<Value>()
    Task.detached {
        do { box.set(.success(try await operation())) }
        catch { box.set(.failure(error)) }
        semaphore.signal()
    }
    semaphore.wait()
    guard let result = box.get() else { throw TestFailure.failed("async test produced no result") }
    return try result.get()
}

private struct FixedPermissions: PermissionStateProviding {
    func current() -> PermissionState {
        PermissionState(
            accessibility: .granted,
            screenRecording: .denied,
            screenCapturable: false,
            inputMonitoring: .notRequired,
            serviceSigned: true,
            signingIdentifier: "ai.bimax.cu.service"
        )
    }
}

private struct FixedWorkspace: WorkspaceInventoryProviding {
    let bundleId: String

    init(bundleId: String = "com.apple.TextEdit") {
        self.bundleId = bundleId
    }

    func snapshot(_ request: WorkspaceSnapshotRequest) throws -> WorkspaceSnapshot {
        let app = AppInfo(
            app: AppRef(bundleId: bundleId, pid: 42, launchId: "42:1000", displayName: "Test App"),
            activationPolicy: "regular",
            active: true,
            hidden: false,
            finishedLaunching: true
        )
        let window = WindowInfo(
            window: WindowRef(pid: 42, windowId: 7, generation: 3, title: "Draft"),
            ownerName: "TextEdit",
            bounds: CuRect(x: 10, y: 20, width: 640, height: 480),
            layer: 0,
            alpha: 1,
            onScreen: true
        )
        let display = DisplayInfo(
            displayId: 1,
            bounds: CuRect(x: 0, y: 0, width: 1512, height: 982),
            pixelWidth: 3024,
            pixelHeight: 1964,
            scale: 2,
            main: true
        )
        return WorkspaceSnapshot(
            capturedAtMs: 1_000,
            frontmostPid: 42,
            apps: [app],
            windows: request.pid == nil || request.pid == 42 ? [window] : [],
            displays: [display]
        )
    }
}

private final class FixedCaptureService: CaptureServicing, @unchecked Sendable {
    private let lock = NSLock()
    private var captureRequests: [CaptureImageRequest] = []
    private var resetSessions: [String] = []
    var failure: CaptureServiceError?
    let bytes = Data([0, 255, 1, 254, 2, 253])

    func capture(sessionId: String, request: CaptureImageRequest) throws -> EncodedCaptureImage {
        if let failure { throw failure }
        lock.withLock { captureRequests.append(request) }
        let source = request.region ?? CuRect(x: 0, y: 0, width: 4, height: 2)
        return EncodedCaptureImage(
            bytes: bytes,
            format: request.format == .png ? .png : .jpeg,
            pixelWidth: Int(source.width),
            pixelHeight: Int(source.height),
            transform: try CaptureImageTransform(
                sourcePixelRect: source,
                outputWidth: Int(source.width),
                outputHeight: Int(source.height)
            )
        )
    }

    func reset(sessionId: String) { lock.withLock { resetSessions.append(sessionId) } }
    var requestCount: Int { lock.withLock { captureRequests.count } }
    var resets: [String] { lock.withLock { resetSessions } }
}

private final class FixedSOMCaptureService: CaptureServicing, @unchecked Sendable {
    private let lock = NSLock()
    private var captureRequests: [CaptureImageRequest] = []

    func capture(sessionId: String, request: CaptureImageRequest) throws -> EncodedCaptureImage {
        lock.withLock { captureRequests.append(request) }
        guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(
                data: nil, width: 320, height: 240,
                bitsPerComponent: 8, bytesPerRow: 1_280, space: colorSpace,
                bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue)
                    .union(.byteOrder32Big).rawValue
              ) else {
            throw TestFailure.failed("could not construct fixed SOM source")
        }
        context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 320, height: 240))
        guard let source = context.makeImage() else {
            throw TestFailure.failed("could not finish fixed SOM source")
        }
        return try CaptureImageEncoder().encode(source, request: .init(
            format: request.format == .png ? .png : .jpeg,
            maxDimension: request.maxDimension,
            jpegQuality: request.jpegQuality,
            scaleFactor: request.zoomFactor,
            sourcePixelRect: request.region
        ))
    }

    func reset(sessionId: String) {}
    var requestCount: Int { lock.withLock { captureRequests.count } }
    var latestRequest: CaptureImageRequest? { lock.withLock { captureRequests.last } }
}

private final class FixedAnalysisCaptureService: CaptureServicing, @unchecked Sendable {
    func capture(sessionId: String, request: CaptureImageRequest) throws -> EncodedCaptureImage {
        guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(
                data: nil, width: 640, height: 320,
                bitsPerComponent: 8, bytesPerRow: 2_560, space: colorSpace,
                bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue)
                    .union(.byteOrder32Big).rawValue
              ) else {
            throw TestFailure.failed("could not construct fixed analysis source")
        }
        context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 640, height: 320))
        context.setFillColor(CGColor(red: 0, green: 0, blue: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 240, height: 160))
        context.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
        context.fill(CGRect(x: 0, y: 160, width: 240, height: 160))
        let line = CTLineCreateWithAttributedString(NSAttributedString(
            string: "HELLO",
            attributes: [
                NSAttributedString.Key(kCTFontAttributeName as String):
                    CTFontCreateWithName("Helvetica-Bold" as CFString, 72, nil),
                NSAttributedString.Key(kCTForegroundColorAttributeName as String):
                    CGColor(red: 0, green: 0, blue: 0, alpha: 1),
            ]
        ))
        context.textPosition = CGPoint(x: 300, y: 120)
        CTLineDraw(line, context)
        guard let source = context.makeImage() else {
            throw TestFailure.failed("could not finish fixed analysis source")
        }
        return try CaptureImageEncoder().encode(source, request: .init(
            format: request.format == .png ? .png : .jpeg,
            maxDimension: request.maxDimension,
            jpegQuality: request.jpegQuality,
            scaleFactor: request.zoomFactor,
            sourcePixelRect: request.region
        ))
    }

    func reset(sessionId: String) {}
}

private struct AllowTestClient: XPCClientIdentityValidating {
    let kernelCodeSigningRequirement: String? = nil
    func validate(processIdentifier: pid_t, effectiveUserIdentifier: uid_t) -> XPCClientTrustDecision {
        .init(accepted: true, reason: "test")
    }
}

private struct SelectiveTestClient: XPCClientIdentityValidating {
    let acceptedPids: Set<pid_t>
    let kernelCodeSigningRequirement: String? = "test"
    func validate(processIdentifier: pid_t, effectiveUserIdentifier: uid_t) -> XPCClientTrustDecision {
        .init(accepted: acceptedPids.contains(processIdentifier), reason: "test")
    }
}

private final class FixedAccessibility: AXObserving, @unchecked Sendable {
    private let lock = NSLock()
    private var revisions: [String: UInt64] = [:]
    private let emitPartial: Bool

    init(emitPartial: Bool = false) {
        self.emitPartial = emitPartial
    }

    func observe(sessionId: String, request: AXObserveRequest) throws -> AXSnapshot {
        let next = lock.withLock { revisions[sessionId, default: 0] += 1; return revisions[sessionId]! }
        let snapshotId = "\(sessionId)-snapshot-\(next)"
        let token = "\(sessionId)-token-\(next)"
        let stablePathHash = "save-path"
        return AXSnapshot(
            snapshotId: snapshotId,
            sessionId: sessionId,
            pid: request.pid,
            windowId: request.windowId,
            windowGeneration: request.windowGeneration,
            revision: next,
            capturedAtMs: 1_000,
            profile: request.profile,
            scope: request.scope,
            nodes: [AXNode(
                token: token,
                parentToken: nil,
                role: "AXButton",
                subrole: nil,
                label: next == 1 ? "Save" : "Save As",
                value: nil,
                identifier: "save",
                bounds: CuRect(x: 10, y: 20, width: 80, height: 24),
                enabled: true,
                focused: false,
                actions: ["AXPress"],
                childCount: 0,
                stablePathHash: stablePathHash,
                elementRef: ElementRef(
                    token: token,
                    snapshotId: snapshotId,
                    pid: request.pid,
                    windowId: request.windowId,
                    windowGeneration: request.windowGeneration,
                    axRevision: next,
                    stablePathHash: stablePathHash
                )
            )],
            visitedCount: 4,
            truncated: false,
            partial: emitPartial,
            issues: emitPartial ? [.init(code: .axTimeout, stage: "early_attributes")] : [],
            clippedNodeCount: request.scope == .window ? 2 : 0
        )
    }
    func reset(sessionId: String) { lock.withLock { _ = revisions.removeValue(forKey: sessionId) } }
}

private final class TransactionAccessibility: AXObserving, @unchecked Sendable {
    func observe(sessionId: String, request: AXObserveRequest) throws -> AXSnapshot {
        let snapshotId = "\(sessionId)-transaction-snapshot"
        func node(_ token: String, _ role: String, _ value: String?, selected: Bool = false, order: Int) -> AXNode {
            let hash = "transaction-\(token)"
            return AXNode(
                token: token, parentToken: nil, role: role, subrole: nil, label: token,
                value: value, identifier: token, bounds: nil, enabled: true, focused: false,
                actions: [], childCount: 0, stablePathHash: hash,
                elementRef: ElementRef(
                    token: token, snapshotId: snapshotId, pid: request.pid,
                    windowId: request.windowId, windowGeneration: request.windowGeneration,
                    axRevision: 1, stablePathHash: hash
                ),
                order: order, selected: selected,
                settableAttributes: role == "AXRow" ? ["AXSelected"] : ["AXValue"]
            )
        }
        return AXSnapshot(
            snapshotId: snapshotId, sessionId: sessionId, pid: request.pid,
            windowId: request.windowId, windowGeneration: request.windowGeneration,
            revision: 1, capturedAtMs: 1_000, profile: request.profile, scope: request.scope,
            nodes: [
                node("field-one", "AXTextField", "before-one", order: 0),
                node("field-two", "AXTextField", "before-two", order: 1),
                node("row-one", "AXRow", nil, order: 2),
                node("row-two", "AXRow", nil, order: 3),
            ],
            visitedCount: 4, truncated: false
        )
    }

    func reset(sessionId: String) {}
}

private final class ManualEventTracker: AXEventTracking, @unchecked Sendable {
    private let lock = NSLock()
    private var revisions: [String: UInt64] = [:]
    private var watched = Set<String>()
    var changeOnNextCheckpoint = false

    func begin(sessionId: String, pid: pid_t) -> AXEventCheckpoint {
        lock.withLock {
            let key = "\(sessionId):\(pid)"
            watched.insert(key)
            return .init(tracking: true, revision: revisions[key, default: 0])
        }
    }

    func checkpoint(sessionId: String, pid: pid_t) -> AXEventCheckpoint {
        lock.withLock {
            let key = "\(sessionId):\(pid)"
            if changeOnNextCheckpoint {
                revisions[key, default: 0] += 1
                changeOnNextCheckpoint = false
            }
            return .init(tracking: watched.contains(key), revision: revisions[key, default: 0], lastNotification: revisions[key, default: 0] > 0 ? "AXValueChanged" : nil)
        }
    }

    func reset(sessionId: String) {
        lock.withLock {
            let prefix = "\(sessionId):"
            watched = watched.filter { !$0.hasPrefix(prefix) }
            revisions = revisions.filter { !$0.key.hasPrefix(prefix) }
        }
    }

    func mark(sessionId: String, pid: pid_t) {
        lock.withLock { revisions["\(sessionId):\(pid)", default: 0] += 1 }
    }

    func isWatching(sessionId: String, pid: pid_t) -> Bool {
        lock.withLock { watched.contains("\(sessionId):\(pid)") }
    }
}

private final class FixedSemanticActions: AXSemanticActionExecuting, @unchecked Sendable {
    private let lock = NSLock()
    private var performed = 0
    private var attempts = 0
    private var observedRequests: [SemanticActionRequest] = []
    var beforeValidation: (() -> Void)?
    var failure: AXSemanticActionError?
    var failureOnAttempt: Int?

    func execute(
        request: SemanticActionRequest,
        expected: AXNode,
        validateBeforeMutation: () throws -> Void
    ) throws -> AXActionExecution {
        let attempt = lock.withLock {
            attempts += 1
            observedRequests.append(request)
            return attempts
        }
        beforeValidation?()
        try validateBeforeMutation()
        if let failure, failureOnAttempt == nil || failureOnAttempt == attempt { throw failure }
        lock.withLock { performed += 1 }
        switch request.action {
        case .setValue:
            return AXActionExecution(primitive: "AXSetAttribute:AXValue")
        case .selectTextRange, .selectText, .setCaret:
            return AXActionExecution(
                primitive: "AXSetAttribute:AXSelectedTextRange",
                textSelection: TextSelectionReceipt(
                    location: 14, length: 5, characterCount: 19,
                    requested: TextRangeSelection(location: 14, length: 5), honored: true
                )
            )
        case .scrollPage:
            guard case .scroll(let scroll)? = request.payload else {
                throw AXSemanticActionError.invalidPayload
            }
            return AXActionExecution(
                primitive: AXScrollPattern.action(for: scroll.direction),
                scroll: ScrollReceipt(
                    direction: scroll.direction,
                    verticalPercentBefore: 10,
                    verticalPercentAfter: 40,
                    changed: true
                )
            )
        default:
            return AXActionExecution(primitive: "AXPress")
        }
    }

    var performedCount: Int { lock.withLock { performed } }
    var attemptCount: Int { lock.withLock { attempts } }
    var requests: [SemanticActionRequest] { lock.withLock { observedRequests } }
}

/// A focus controller that can be told to lie the way real ones do.
///
/// `acceptedButIgnored` is the important mode: activation returning true while focus never moves is
/// the same failure shape as an AX write returning success and doing nothing, and the lease must
/// report it rather than assume it worked.
private final class FakeFocusController: FocusControlling, @unchecked Sendable {
    private let lock = NSLock()
    private var frontmost: Int32?
    private var refused: Set<Int32> = []
    private var acceptedButIgnored: Set<Int32> = []
    private var activationLog: [Int32] = []
    /// Runs after each accepted activation, so a test can simulate the human clicking elsewhere
    /// while the lease is held.
    var afterActivation: (@Sendable (Int32) -> Void)?

    init(frontmost: Int32?) { self.frontmost = frontmost }

    func observeFrontmost() -> FocusObservation {
        lock.withLock { FocusObservation(pid: frontmost, bundleId: frontmost.map { "bundle.\($0)" }) }
    }

    func requestActivation(pid: Int32) -> Bool {
        let accepted: Bool = lock.withLock {
            activationLog.append(pid)
            if refused.contains(pid) { return false }
            if !acceptedButIgnored.contains(pid) { frontmost = pid }
            return true
        }
        if accepted { afterActivation?(pid) }
        return accepted
    }

    func refuse(_ pid: Int32) { lock.withLock { _ = refused.insert(pid) } }
    func acceptButIgnore(_ pid: Int32) { lock.withLock { _ = acceptedButIgnored.insert(pid) } }
    func set(frontmost pid: Int32?) { lock.withLock { frontmost = pid } }
    var activations: [Int32] { lock.withLock { activationLog } }
    var currentFrontmost: Int32? { lock.withLock { frontmost } }
}

private final class FakeActivationBroker: FocusActivationBrokerRequesting, @unchecked Sendable {
    private let lock = NSLock()
    private var calls: [(Int32, String)] = []
    var accepted: Bool

    init(accepted: Bool) { self.accepted = accepted }

    func requestActivation(pid: Int32, bundleId: String) -> Bool {
        lock.withLock { calls.append((pid, bundleId)) }
        return accepted
    }

    var requests: [(Int32, String)] { lock.withLock { calls } }
}

private final class FakeCaptureStreamDriver: CaptureStreamDriving, @unchecked Sendable {
    private let lock = NSLock()
    private var nextHandle = 0
    private var startedTargets: [CaptureStreamTarget] = []
    private var stoppedHandles: [String] = []
    private var handleStats: [String: CaptureStreamStats] = [:]

    func start(target: CaptureStreamTarget, options: CaptureStreamOptions) async throws -> String {
        lock.withLock {
            nextHandle += 1
            let handle = "capture-\(nextHandle)"
            startedTargets.append(target)
            handleStats[handle] = CaptureStreamStats(
                completeFrames: 1, width: options.maxWidth, height: options.maxHeight
            )
            return handle
        }
    }

    func stop(handle: String) async {
        lock.withLock {
            stoppedHandles.append(handle)
            handleStats.removeValue(forKey: handle)
        }
    }

    func stats(handle: String) async -> CaptureStreamStats? {
        lock.withLock { handleStats[handle] }
    }

    func image(
        handle: String,
        request: CaptureEncodingRequest
    ) async throws -> EncodedCaptureImage? {
        guard lock.withLock({ handleStats[handle] != nil }) else { return nil }
        let transform = try CaptureImageTransform(
            sourcePixelRect: request.sourcePixelRect ?? CuRect(x: 0, y: 0, width: 10, height: 5),
            outputWidth: 10,
            outputHeight: 5
        )
        return EncodedCaptureImage(
            bytes: Data([137, 80, 78, 71]), format: request.format,
            pixelWidth: 10, pixelHeight: 5, transform: transform
        )
    }

    var starts: [CaptureStreamTarget] { lock.withLock { startedTargets } }
    var stops: [String] { lock.withLock { stoppedHandles } }
    var retainedHandleCount: Int { lock.withLock { handleStats.count } }
}

private final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Int64 = 1_000_000

    var now: @Sendable () -> Int64 { { [self] in lock.withLock { value } } }
    func advance(_ ms: Int64) { lock.withLock { value += ms } }
}

private func makeLeaseManager(
    _ focus: FakeFocusController,
    clock: TestClock = TestClock()
) -> FocusLeaseManager {
    FocusLeaseManager(focus: focus, clock: clock.now, sleep: { _ in })
}

private struct UnavailableEventTracker: AXEventTracking {
    func begin(sessionId: String, pid: pid_t) -> AXEventCheckpoint { .init(tracking: false, revision: 0) }
    func checkpoint(sessionId: String, pid: pid_t) -> AXEventCheckpoint { .init(tracking: false, revision: 0) }
    func reset(sessionId: String) {}
}

private func request(_ id: String, session: String = "bootstrap", body: RequestBody) -> RequestEnvelope {
    RequestEnvelope(requestId: id, sessionId: session, deadlineMs: 2_000, body: body)
}

private func testWireRoundTrips() throws {
    let envelope = RequestEnvelope(
        requestId: "req-1",
        sessionId: "bootstrap",
        deadlineMs: 2_000,
        body: .handshake(HandshakeRequest(
            clientVersion: "1.0.0",
            supportedProtocols: [BimaxCuProtocolVersion.v1],
            requestedFeatures: ["workspace.apps"]
        ))
    )
    let data = try JSONEncoder().encode(envelope)
    let decodedEnvelope = try JSONDecoder().decode(RequestEnvelope.self, from: data)
    try expect(decodedEnvelope == envelope, "handshake envelope did not round-trip")
    try expect(String(decoding: data, as: UTF8.self).contains("bimax.cu.v1"), "wire payload omitted protocol id")

    for body in [
        RequestBody.sessionCreate(requestedId: "task-a"),
        .sessionStatus,
        .sessionReset(reason: "interrupted"),
        .sessionClose,
        .workspaceSnapshot(.init(pid: 42, includeOffscreenWindows: true)),
        .axObserve(.init(pid: 42, windowId: 7, windowGeneration: 3, profile: "balanced", maxElements: 250)),
    ] {
        let encoded = try JSONEncoder().encode(body)
        let decodedBody = try JSONDecoder().decode(RequestBody.self, from: encoded)
        try expect(decodedBody == body, "session operation did not round-trip: \(body)")
    }
    let node = snapshotNode(snapshotId: "wire", revision: 1, hash: "save", token: "wire-save", label: "Save", order: 0)
    let operations: [AXDiffOperation] = [.insert(node), .update(node), .remove(stablePathHash: "save", token: "wire-save")]
    let encodedOperations = try JSONEncoder().encode(operations)
    let decodedOperations = try JSONDecoder().decode([AXDiffOperation].self, from: encodedOperations)
    try expect(decodedOperations == operations, "AX diff operations did not round-trip")
    let actionRequest = SemanticActionRequest(
        element: node.elementRef!,
        action: .invoke,
        expectedEventRevision: 3
    )
    let encodedAction = try JSONEncoder().encode(RequestBody.semanticAction(actionRequest))
    let decodedAction = try JSONDecoder().decode(RequestBody.self, from: encodedAction)
    try expect(decodedAction == .semanticAction(actionRequest), "semantic action did not round-trip")

    let legacyCapabilities = Data(#"{"profiles":["flash"],"axDiff":true,"som":false,"regionCapture":false,"zoom":false,"streams":false}"#.utf8)
    let decodedLegacyCapabilities = try JSONDecoder().decode(ObserveCapabilities.self, from: legacyCapabilities)
    try expect(!decodedLegacyCapabilities.eventRevisions, "missing additive observer capability did not default to false")
    try expect(decodedLegacyCapabilities.scopes.isEmpty, "missing additive observation scopes did not default safely")

    let legacyObserve = Data(#"{"pid":42,"profile":"flash","maxElements":100}"#.utf8)
    let decodedLegacyObserve = try JSONDecoder().decode(AXObserveRequest.self, from: legacyObserve)
    try expect(decodedLegacyObserve.scope == .application && decodedLegacyObserve.maxDurationMs == 750,
               "legacy observation request did not receive safe scope/duration defaults")

    let currentSnapshot = AXSnapshot(
        snapshotId: "legacy", sessionId: "wire", pid: 42, windowId: nil,
        windowGeneration: nil, revision: 1, capturedAtMs: 1, profile: "flash",
        nodes: [node], visitedCount: 1, truncated: false,
        eventTracking: true, eventRevision: 7, changedDuringCapture: true
    )
    let encodedSnapshot = try JSONEncoder().encode(currentSnapshot)
    var legacySnapshot = try JSONSerialization.jsonObject(with: encodedSnapshot) as! [String: Any]
    legacySnapshot.removeValue(forKey: "eventTracking")
    legacySnapshot.removeValue(forKey: "eventRevision")
    legacySnapshot.removeValue(forKey: "changedDuringCapture")
    legacySnapshot.removeValue(forKey: "scope")
    legacySnapshot.removeValue(forKey: "partial")
    legacySnapshot.removeValue(forKey: "issues")
    legacySnapshot.removeValue(forKey: "clippedNodeCount")
    let decodedLegacySnapshot = try JSONDecoder().decode(
        AXSnapshot.self,
        from: try JSONSerialization.data(withJSONObject: legacySnapshot)
    )
    try expect(!decodedLegacySnapshot.eventTracking && decodedLegacySnapshot.eventRevision == 0 && !decodedLegacySnapshot.changedDuringCapture,
               "missing additive observer snapshot fields did not decode safely")
    try expect(decodedLegacySnapshot.scope == .application && !decodedLegacySnapshot.partial
               && decodedLegacySnapshot.issues.isEmpty && decodedLegacySnapshot.clippedNodeCount == 0,
               "missing additive scope/partial fields did not decode safely")
}

private func testHandshake() throws {
    let core = BimaxCuServiceCore(serviceVersion: "test", permissions: FixedPermissions())
    let response = core.handle(request("h1", body: .handshake(.init(
        clientVersion: "client", supportedProtocols: [BimaxCuProtocolVersion.v1]
    ))))
    guard case .handshake(let handshake) = response.body else {
        throw TestFailure.failed("expected handshake response: \(response)")
    }
    try expect(handshake.selectedProtocol == BimaxCuProtocolVersion.v1, "wrong negotiated protocol")
    try expect(handshake.permissions.accessibility == .granted, "permission provider was ignored")
    try expect(handshake.capabilities.delivery.physicalInput,
               "the foreground-lease physical keyboard path was not advertised")
    try expect(!handshake.capabilities.delivery.targetedEvents,
               "an end-state-unverified process-targeted keyboard path was advertised")
    try expect(handshake.capabilities.delivery.semanticTransactions,
               "implemented semantic transactions were not advertised")
    try expect(handshake.capabilities.observe.profiles == ["flash", "balanced"], "implemented AX profiles were not advertised")
    try expect(handshake.capabilities.observe.axDiff, "implemented retained AX diffs were not advertised")
    try expect(handshake.capabilities.observe.eventRevisions, "implemented AX event revisions were not advertised")
    try expect(handshake.capabilities.observe.scopes == AXObservationScope.allCases.map(\.rawValue), "observation scope catalog was incomplete")
    try expect(handshake.capabilities.delivery.policies == SemanticDeliveryPolicy.allCases.map(\.rawValue),
               "the delivery policy catalog was incomplete")
    try expect(handshake.capabilities.delivery.semanticActions == SemanticActionKind.allCases.map(\.rawValue), "semantic action catalog was incomplete")
    for advertised in ["select_text_range", "select_text", "set_caret", "scroll_page", "show_menu"] {
        try expect(handshake.capabilities.delivery.semanticActions.contains(advertised),
                   "implemented text/scroll action \(advertised) was not advertised")
    }
    let verified = handshake.capabilities.delivery.verifiedSemanticActions
    try expect(Set(verified).isSubset(of: Set(handshake.capabilities.delivery.semanticActions)),
               "the verified catalog claimed an action the service does not accept")
    // Both are advertised-but-inert on macOS; claiming them verified would be an overclaim.
    try expect(!verified.contains("scroll_page") && !verified.contains("scroll_to_visible"),
               "an unverifiable action was reported as verified")
    for proven in ["invoke", "show_menu", "set_value", "toggle", "select", "expand", "collapse",
                   "select_text_range", "select_text", "set_caret", "set_selected",
                   "increment", "decrement", "scroll_to_fraction", "type_text"] {
        try expect(verified.contains(proven), "conformance-proven action \(proven) was not reported verified")
    }
    let legacyDelivery = try JSONDecoder().decode(
        DeliveryCapabilities.self,
        from: Data(#"{"policies":["background_native"],"semanticActions":["invoke"]}"#.utf8)
    )
    try expect(legacyDelivery.verifiedSemanticActions.isEmpty,
               "a service predating conformance reported actions as verified")
    try expect(legacyDelivery.verifiedDeliveryPolicies.isEmpty,
               "a service predating focus conformance reported policies as verified")
    try expect(!legacyDelivery.semanticTransactions,
               "a service predating transactions invented transaction support")

    // Advertising the four policies is not a claim that their focus behavior has been watched.
    let verifiedPolicies = handshake.capabilities.delivery.verifiedDeliveryPolicies
    try expect(Set(verifiedPolicies).isSubset(of: Set(handshake.capabilities.delivery.policies)),
               "the verified policy list claimed a policy the service does not accept")
    // The lease capability is derived from the verified list, so the two can never disagree.
    let claimsForegroundVerified = verifiedPolicies.contains {
        SemanticDeliveryPolicy(rawValue: $0)?.requiresApproval == true
    }
    try expect(handshake.capabilities.delivery.focusLease == claimsForegroundVerified,
               "the focus-lease capability drifted from the policies actually verified")
    try expect(handshake.capabilities.delivery.physicalInput,
               "the measured foreground physical path disappeared from the handshake")
    try expect(handshake.capabilities.workspace.apps, "implemented application inventory was not advertised")
    try expect(handshake.capabilities.workspace.windows, "implemented window inventory was not advertised")
    try expect(handshake.capabilities.workspace.displays, "implemented display inventory was not advertised")
    try expect(handshake.capabilities.overlay?.cursor == false,
               "the handshake overclaimed the unimplemented cursor renderer")
    let legacyCapabilities = try JSONDecoder().decode(
        CapabilitySet.self,
        from: JSONEncoder().encode(CapabilitySet())
    )
    try expect(legacyCapabilities.overlay == nil,
               "an absent overlay capability became supported during decoding")
}

private func testWorkspaceRequiresSession() throws {
    let core = BimaxCuServiceCore(permissions: FixedPermissions(), workspace: FixedWorkspace())
    let response = core.handle(request("w0", session: "missing", body: .workspaceSnapshot(.init())))
    try expect(response.error?.code == "session_not_found", "workspace inventory accepted an unknown session")
}

private func testWorkspaceSnapshot() throws {
    let core = BimaxCuServiceCore(permissions: FixedPermissions(), workspace: FixedWorkspace())
    let created = core.handle(request("create", body: .sessionCreate(requestedId: "workspace-test")))
    guard case .session(let session) = created.body else { throw TestFailure.failed("workspace session was not created") }
    let response = core.handle(request(
        "workspace",
        session: session.sessionId,
        body: .workspaceSnapshot(.init(pid: 42, includeOffscreenWindows: false))
    ))
    guard case .workspace(let snapshot) = response.body else {
        throw TestFailure.failed("expected typed workspace response: \(response)")
    }
    try expect(snapshot.frontmostPid == 42, "frontmost pid was lost")
    try expect(snapshot.apps.first?.app.launchId == "42:1000", "launch identity was lost")
    try expect(snapshot.windows.first?.window.generation == 3, "window generation was lost")
    try expect(snapshot.displays.first?.scale == 2, "display point/pixel scale was lost")
}

private func testAXObservationIsSessionBound() throws {
    let accessibility = FixedAccessibility()
    let events = ManualEventTracker()
    let core = BimaxCuServiceCore(permissions: FixedPermissions(), workspace: FixedWorkspace(), accessibility: accessibility, axEvents: events)
    let missing = core.handle(request("ax-missing", session: "missing", body: .axObserve(.init(pid: 42))))
    try expect(missing.error?.code == "session_not_found", "AX observation accepted an unknown session")

    let created = core.handle(request("create-ax", body: .sessionCreate(requestedId: "ax-test")))
    guard case .session(let session) = created.body else { throw TestFailure.failed("AX session was not created") }
    let observed = core.handle(request("observe-ax", session: session.sessionId, body: .axObserve(.init(pid: 42, windowId: 7, windowGeneration: 3))))
    guard case .axSnapshot(let snapshot) = observed.body else { throw TestFailure.failed("typed AX snapshot was missing") }
    try expect(snapshot.sessionId == session.sessionId && snapshot.pid == 42 && snapshot.windowId == 7 && snapshot.windowGeneration == 3, "AX snapshot lost target identity")
    try expect(snapshot.nodes.first?.actions == ["AXPress"], "AX action metadata was lost")
    try expect(snapshot.eventTracking && snapshot.eventRevision == 0 && !snapshot.changedDuringCapture, "stable observer checkpoint was not attached")
    events.mark(sessionId: session.sessionId, pid: 42)
    let diffed = core.handle(request(
        "observe-ax-diff",
        session: session.sessionId,
        body: .axObserve(.init(pid: 42, windowId: 7, windowGeneration: 3, sinceSnapshotId: snapshot.snapshotId))
    ))
    guard case .axSnapshot(let diff) = diffed.body else { throw TestFailure.failed("typed AX diff was missing") }
    try expect(diff.baseSnapshotId == snapshot.snapshotId && diff.nodes.isEmpty, "AX diff did not bind its retained base")
    try expect(diff.diff?.count == 1 && diff.fullNodeCount == 1, "AX semantic update was not compacted")
    try expect(diff.eventRevision == 1 && !diff.changedDuringCapture, "pre-capture AX event incorrectly invalidated a stable diff")

    let invalid = core.handle(request("observe-limit", session: session.sessionId, body: .axObserve(.init(pid: 42, maxElements: 0))))
    try expect(invalid.error?.code == "invalid_ax_limit", "invalid AX budget was accepted")
    let invalidDuration = core.handle(request("observe-duration", session: session.sessionId, body: .axObserve(.init(pid: 42, maxDurationMs: 50))))
    try expect(invalidDuration.error?.code == "invalid_ax_duration", "invalid AX duration was accepted")
    let stale = core.handle(request("observe-stale", session: session.sessionId, body: .axObserve(.init(pid: 42, windowId: 7, windowGeneration: 2))))
    try expect(stale.error?.code == "stale_window_ref", "stale window generation was accepted")
    _ = core.handle(request("reset-ax", session: session.sessionId, body: .sessionReset(reason: "test invalidation")))
    try expect(!events.isWatching(sessionId: session.sessionId, pid: 42), "session reset leaked its AX observer")
    let expired = core.handle(request(
        "observe-expired",
        session: session.sessionId,
        body: .axObserve(.init(pid: 42, windowId: 7, windowGeneration: 3, sinceSnapshotId: snapshot.snapshotId))
    ))
    try expect(expired.error?.code == "stale_snapshot_ref", "session reset retained an old AX diff base")
}

private func testAXCaptureRaceFailsClosed() throws {
    let events = ManualEventTracker()
    events.changeOnNextCheckpoint = true
    let store = AXSnapshotStore()
    let core = BimaxCuServiceCore(
        permissions: FixedPermissions(),
        workspace: FixedWorkspace(),
        accessibility: FixedAccessibility(),
        axSnapshots: store,
        axEvents: events
    )
    let created = core.handle(request("race-create", body: .sessionCreate(requestedId: "race")))
    guard case .session(let session) = created.body else { throw TestFailure.failed("race session was not created") }
    let raced = core.handle(request("race-observe", session: session.sessionId, body: .axObserve(.init(pid: 42, windowId: 7, windowGeneration: 3))))
    guard case .axSnapshot(let snapshot) = raced.body else { throw TestFailure.failed("race snapshot was missing") }
    try expect(snapshot.eventTracking && snapshot.eventRevision == 1 && snapshot.changedDuringCapture, "capture race was not surfaced")
    try expect(snapshot.baseSnapshotId == nil && snapshot.diff == nil && !snapshot.nodes.isEmpty, "unstable capture was emitted as a diff")
    try expect(store.retainedCount(sessionId: session.sessionId) == 0, "unstable capture refs were retained")

    let staleBase = core.handle(request(
        "race-stale-base",
        session: session.sessionId,
        body: .axObserve(.init(pid: 42, windowId: 7, windowGeneration: 3, sinceSnapshotId: snapshot.snapshotId))
    ))
    try expect(staleBase.error?.code == "stale_snapshot_ref", "unstable snapshot became a valid diff base")
    _ = core.handle(request("race-close", session: session.sessionId, body: .sessionClose))
    try expect(!events.isWatching(sessionId: session.sessionId, pid: 42), "session close leaked its AX observer")
}

private func testSemanticActionLiveRevalidation() throws {
    let events = ManualEventTracker()
    let actions = FixedSemanticActions()
    let store = AXSnapshotStore()
    let core = BimaxCuServiceCore(
        permissions: FixedPermissions(), workspace: FixedWorkspace(),
        accessibility: FixedAccessibility(), axSnapshots: store, axEvents: events,
        semanticActions: actions
    )
    let created = core.handle(request("action-create", body: .sessionCreate(requestedId: "action")))
    guard case .session(let session) = created.body else { throw TestFailure.failed("action session was not created") }
    let observed = core.handle(request(
        "action-observe", session: session.sessionId,
        body: .axObserve(.init(pid: 42, windowId: 7, windowGeneration: 3))
    ))
    guard case .axSnapshot(let snapshot) = observed.body,
          let ref = snapshot.nodes.first?.elementRef else { throw TestFailure.failed("action authority was not observed") }
    let action = SemanticActionRequest(
        element: ref, action: .invoke, expectedEventRevision: snapshot.eventRevision
    )
    let response = core.handle(request("action-run", session: session.sessionId, body: .semanticAction(action)))
    guard case .semanticActionReceipt(let receipt) = response.body else {
        throw TestFailure.failed("semantic action receipt was missing: \(response)")
    }
    try expect(receipt.primitive == "AXPress" && receipt.outcome == .performed, "semantic primitive receipt was incorrect")
    try expect(receipt.deliveryPolicy == .backgroundNative, "action escaped background-native policy")
    try expect(receipt.frontmostPidBefore == 42 && receipt.frontmostPidAfter == 42, "foreground evidence was not recorded")
    try expect(actions.performedCount == 1, "semantic executor did not run exactly once")
    try expect(store.retainedCount(sessionId: session.sessionId) == 0, "successful action retained stale target authorities")

    let replay = core.handle(request("action-replay", session: session.sessionId, body: .semanticAction(action)))
    try expect(replay.error?.code == "stale_element_ref", "a consumed action authority was reusable")
    try expect(actions.performedCount == 1, "stale action authority reached the executor")
}

private func testSemanticActionRacesFailClosed() throws {
    let staleEvents = ManualEventTracker()
    let staleActions = FixedSemanticActions()
    let staleCore = BimaxCuServiceCore(
        permissions: FixedPermissions(), workspace: FixedWorkspace(),
        accessibility: FixedAccessibility(), axEvents: staleEvents,
        semanticActions: staleActions
    )
    guard case .session(let staleSession) = staleCore.handle(request(
        "stale-action-create", body: .sessionCreate(requestedId: "stale-action")
    )).body else { throw TestFailure.failed("stale action session was not created") }
    guard case .axSnapshot(let staleSnapshot) = staleCore.handle(request(
        "stale-action-observe", session: staleSession.sessionId,
        body: .axObserve(.init(pid: 42, windowId: 7, windowGeneration: 3))
    )).body, let staleRef = staleSnapshot.nodes.first?.elementRef else {
        throw TestFailure.failed("stale action authority was not observed")
    }
    staleEvents.mark(sessionId: staleSession.sessionId, pid: 42)
    let staleResponse = staleCore.handle(request(
        "stale-action-run", session: staleSession.sessionId,
        body: .semanticAction(.init(element: staleRef, action: .invoke, expectedEventRevision: staleSnapshot.eventRevision))
    ))
    try expect(staleResponse.error?.code == "stale_element_ref", "post-snapshot event did not reject the action")
    try expect(staleActions.performedCount == 0, "stale action reached mutation")

    let raceEvents = ManualEventTracker()
    let raceActions = FixedSemanticActions()
    let raceStore = AXSnapshotStore()
    let raceCore = BimaxCuServiceCore(
        permissions: FixedPermissions(), workspace: FixedWorkspace(),
        accessibility: FixedAccessibility(), axSnapshots: raceStore, axEvents: raceEvents,
        semanticActions: raceActions
    )
    guard case .session(let raceSession) = raceCore.handle(request(
        "preflight-race-create", body: .sessionCreate(requestedId: "preflight-race")
    )).body else { throw TestFailure.failed("preflight race session was not created") }
    guard case .axSnapshot(let raceSnapshot) = raceCore.handle(request(
        "preflight-race-observe", session: raceSession.sessionId,
        body: .axObserve(.init(pid: 42, windowId: 7, windowGeneration: 3))
    )).body, let raceRef = raceSnapshot.nodes.first?.elementRef else {
        throw TestFailure.failed("preflight race authority was not observed")
    }
    raceActions.beforeValidation = { raceEvents.mark(sessionId: raceSession.sessionId, pid: 42) }
    let raceResponse = raceCore.handle(request(
        "preflight-race-run", session: raceSession.sessionId,
        body: .semanticAction(.init(element: raceRef, action: .invoke, expectedEventRevision: raceSnapshot.eventRevision))
    ))
    try expect(raceResponse.error?.code == "action_preflight_race", "live revalidation race did not fail closed")
    try expect(raceActions.performedCount == 0, "raced action reached mutation")
    try expect(raceStore.retainedCount(sessionId: raceSession.sessionId) == 1, "rejected action consumed its authority")
}

private func testSemanticActionAuthorityPolicy() throws {
    let appEvents = ManualEventTracker()
    let appActions = FixedSemanticActions()
    let appCore = BimaxCuServiceCore(
        permissions: FixedPermissions(), workspace: FixedWorkspace(),
        accessibility: FixedAccessibility(), axEvents: appEvents,
        semanticActions: appActions
    )
    guard case .session(let appSession) = appCore.handle(request(
        "app-action-create", body: .sessionCreate(requestedId: "app-action")
    )).body else { throw TestFailure.failed("app action session was not created") }
    guard case .axSnapshot(let appSnapshot) = appCore.handle(request(
        "app-action-observe", session: appSession.sessionId, body: .axObserve(.init(pid: 42))
    )).body, let appRef = appSnapshot.nodes.first?.elementRef else {
        throw TestFailure.failed("app-wide action authority was not observed")
    }
    let appResponse = appCore.handle(request(
        "app-action-run", session: appSession.sessionId,
        body: .semanticAction(.init(element: appRef, action: .invoke, expectedEventRevision: appSnapshot.eventRevision))
    ))
    try expect(appResponse.error?.code == "action_requires_exact_window", "PID-only action authority was accepted")
    try expect(appActions.performedCount == 0, "PID-only action reached mutation")

    let unavailableActions = FixedSemanticActions()
    let unavailableCore = BimaxCuServiceCore(
        permissions: FixedPermissions(), workspace: FixedWorkspace(),
        accessibility: FixedAccessibility(), axEvents: UnavailableEventTracker(),
        semanticActions: unavailableActions
    )
    guard case .session(let unavailableSession) = unavailableCore.handle(request(
        "untracked-action-create", body: .sessionCreate(requestedId: "untracked-action")
    )).body else { throw TestFailure.failed("untracked action session was not created") }
    guard case .axSnapshot(let unavailableSnapshot) = unavailableCore.handle(request(
        "untracked-action-observe", session: unavailableSession.sessionId,
        body: .axObserve(.init(pid: 42, windowId: 7, windowGeneration: 3))
    )).body, let unavailableRef = unavailableSnapshot.nodes.first?.elementRef else {
        throw TestFailure.failed("untracked action authority was not observed")
    }
    let unavailableResponse = unavailableCore.handle(request(
        "untracked-action-run", session: unavailableSession.sessionId,
        body: .semanticAction(.init(element: unavailableRef, action: .invoke, expectedEventRevision: 0))
    ))
    try expect(unavailableResponse.error?.code == "event_tracking_unavailable", "untracked action authority was accepted")
    try expect(unavailableActions.performedCount == 0, "untracked action reached mutation")
}

private func testObservationScopeAndPartialPolicy() throws {
    let systemEvents = ManualEventTracker()
    let systemStore = AXSnapshotStore()
    let systemCore = BimaxCuServiceCore(
        permissions: FixedPermissions(), workspace: FixedWorkspace(bundleId: "com.apple.dock"),
        accessibility: FixedAccessibility(), axSnapshots: systemStore, axEvents: systemEvents
    )
    guard case .session(let systemSession) = systemCore.handle(request(
        "system-create", body: .sessionCreate(requestedId: "system-ui")
    )).body else { throw TestFailure.failed("system UI session was not created") }
    let systemResponse = systemCore.handle(request(
        "system-observe", session: systemSession.sessionId,
        body: .axObserve(.init(pid: 42, scope: .systemUI))
    ))
    guard case .axSnapshot(let systemSnapshot) = systemResponse.body else {
        throw TestFailure.failed("allowlisted system UI snapshot was rejected: \(systemResponse)")
    }
    try expect(systemSnapshot.scope == .systemUI && !systemSnapshot.partial, "system UI scope was not preserved")
    try expect(systemStore.retainedCount(sessionId: systemSession.sessionId) == 1, "stable system UI evidence was not retained")
    var truncated = systemSnapshot
    truncated.truncated = true
    do {
        _ = try AXSnapshotStore().retain(full: truncated, since: nil)
        throw TestFailure.failed("snapshot store accepted truncated evidence directly")
    } catch let error as AXSnapshotStoreError {
        try expect(error == .nonAuthoritativeSnapshot, "truncated evidence returned the wrong store error")
    }
    let bypass = systemCore.handle(request(
        "system-bypass", session: systemSession.sessionId,
        body: .axObserve(.init(pid: 42, scope: .application))
    ))
    try expect(bypass.error?.code == "system_ui_scope_required", "system UI allowlist was bypassed through application scope")

    let deniedCore = BimaxCuServiceCore(
        permissions: FixedPermissions(), workspace: FixedWorkspace(),
        accessibility: FixedAccessibility(), axEvents: ManualEventTracker()
    )
    guard case .session(let deniedSession) = deniedCore.handle(request(
        "system-denied-create", body: .sessionCreate(requestedId: "system-denied")
    )).body else { throw TestFailure.failed("denied system UI session was not created") }
    let denied = deniedCore.handle(request(
        "system-denied-observe", session: deniedSession.sessionId,
        body: .axObserve(.init(pid: 42, scope: .systemUI))
    ))
    try expect(denied.error?.code == "system_ui_scope_denied", "non-system process entered system UI scope")
    let malformedWindow = deniedCore.handle(request(
        "window-scope-missing-ref", session: deniedSession.sessionId,
        body: .axObserve(.init(pid: 42, scope: .window))
    ))
    try expect(malformedWindow.error?.code == "invalid_observation_scope", "window scope accepted a missing window ref")

    let partialStore = AXSnapshotStore()
    let partialCore = BimaxCuServiceCore(
        permissions: FixedPermissions(), workspace: FixedWorkspace(),
        accessibility: FixedAccessibility(emitPartial: true), axSnapshots: partialStore,
        axEvents: ManualEventTracker(), semanticActions: FixedSemanticActions()
    )
    guard case .session(let partialSession) = partialCore.handle(request(
        "partial-create", body: .sessionCreate(requestedId: "partial")
    )).body else { throw TestFailure.failed("partial session was not created") }
    let partialResponse = partialCore.handle(request(
        "partial-observe", session: partialSession.sessionId,
        body: .axObserve(.init(pid: 42, windowId: 7, windowGeneration: 3, scope: .window))
    ))
    guard case .axSnapshot(let partial) = partialResponse.body, let ref = partial.nodes.first?.elementRef else {
        throw TestFailure.failed("partial snapshot was not returned as evidence")
    }
    try expect(partial.partial && partial.issues == [.init(code: .axTimeout, stage: "early_attributes")], "partial diagnostics were lost")
    try expect(partial.clippedNodeCount == 2, "clipping diagnostics were lost")
    try expect(partialStore.retainedCount(sessionId: partialSession.sessionId) == 0, "partial snapshot became durable authority")
    do {
        _ = try AXSnapshotStore().retain(full: partial, since: nil)
        throw TestFailure.failed("snapshot store accepted partial evidence directly")
    } catch let error as AXSnapshotStoreError {
        try expect(error == .nonAuthoritativeSnapshot, "partial evidence returned the wrong store error")
    }
    let partialAction = partialCore.handle(request(
        "partial-action", session: partialSession.sessionId,
        body: .semanticAction(.init(element: ref, action: .invoke, expectedEventRevision: partial.eventRevision))
    ))
    try expect(partialAction.error?.code == "stale_element_ref", "partial snapshot authorized an action")
}

private func textNode(role: String = "AXTextArea", subrole: String? = nil, enabled: Bool = true) -> AXNode {
    var node = snapshotNode(snapshotId: "text", revision: 1, hash: "body", token: "text-body", label: "Body", order: 0)
    node.role = role
    node.subrole = subrole
    node.enabled = enabled
    return node
}

private func expectShapeError(
    _ request: SemanticActionRequest,
    _ expected: AXNode,
    _ error: AXSemanticActionError,
    _ message: String
) throws {
    do {
        try AXSemanticActionEngine.validateRequestShape(request, expected: expected)
        throw TestFailure.failed(message)
    } catch let thrown as AXSemanticActionError {
        try expect(thrown == error, "\(message): got \(thrown), wanted \(error)")
    }
}

private func testTextScrollWireRoundTrips() throws {
    let node = textNode()
    guard let ref = node.elementRef else { throw TestFailure.failed("text ref was missing") }
    let payloads: [SemanticActionPayload] = [
        .textRange(TextRangeSelection(location: 14, length: 5)),
        .textMatch(TextMatchSelection(text: "alpha", prefix: "beta ", suffix: nil, placement: .after)),
        .caret(CaretPlacement(anchor: .index, index: 7)),
        .scroll(ScrollPageSelection(direction: .down)),
    ]
    for payload in payloads {
        let request = SemanticActionRequest(
            element: ref, action: .selectText, payload: payload, expectedEventRevision: 2
        )
        let encoded = try JSONEncoder().encode(RequestBody.semanticAction(request))
        let decoded = try JSONDecoder().decode(RequestBody.self, from: encoded)
        try expect(decoded == .semanticAction(request), "text/scroll payload did not round-trip: \(payload)")
    }
    try expect(SemanticActionKind.allCases.map(\.rawValue).contains(where: { $0 == "select_text_range" })
               && SemanticActionKind.allCases.map(\.rawValue).contains(where: { $0 == "scroll_page" }),
               "text/scroll action catalog was incomplete")

    let receipt = SemanticActionReceipt(
        actionId: "a1", element: ref, action: .scrollPage, primitive: "AXScrollDownByPage",
        outcome: .performed, deliveryPolicy: .backgroundNative, startedAtMs: 1, completedAtMs: 2,
        eventRevisionBefore: 1, eventRevisionAfter: 1, frontmostPidBefore: 42, frontmostPidAfter: 42,
        textSelection: TextSelectionReceipt(
            location: 0, length: 0, characterCount: 19,
            requested: TextRangeSelection(location: 3, length: 5), honored: false
        ),
        scroll: ScrollReceipt(direction: .down, verticalPercentBefore: 0, verticalPercentAfter: 25, changed: true)
    )
    let encodedReceipt = try JSONEncoder().encode(receipt)
    let decodedReceipt = try JSONDecoder().decode(SemanticActionReceipt.self, from: encodedReceipt)
    try expect(decodedReceipt == receipt, "text/scroll receipt did not round-trip")

    // A pre-slice-6 client and a pre-slice-6 service must both keep decoding.
    var legacyRequest = try JSONSerialization.jsonObject(
        with: try JSONEncoder().encode(SemanticActionRequest(element: ref, action: .invoke, expectedEventRevision: 1))
    ) as! [String: Any]
    legacyRequest.removeValue(forKey: "payload")
    let decodedLegacyRequest = try JSONDecoder().decode(
        SemanticActionRequest.self,
        from: try JSONSerialization.data(withJSONObject: legacyRequest)
    )
    try expect(decodedLegacyRequest.payload == nil, "missing additive action payload did not default to none")

    var legacyReceipt = try JSONSerialization.jsonObject(with: encodedReceipt) as! [String: Any]
    legacyReceipt.removeValue(forKey: "textSelection")
    legacyReceipt.removeValue(forKey: "scroll")
    let decodedLegacyReceipt = try JSONDecoder().decode(
        SemanticActionReceipt.self,
        from: try JSONSerialization.data(withJSONObject: legacyReceipt)
    )
    try expect(decodedLegacyReceipt.textSelection == nil && decodedLegacyReceipt.scroll == nil,
               "missing additive receipt evidence did not decode to unsupported")

    let legacySelection = try JSONDecoder().decode(
        TextSelectionReceipt.self,
        from: Data(#"{"location":3,"length":5}"#.utf8)
    )
    try expect(legacySelection.requested == nil && legacySelection.honored == nil,
               "a pre-honored selection receipt invented an applied-vs-requested verdict")

    let unknownPayload = Data(#"{"kind":"text_markers","match":{"text":"x"}}"#.utf8)
    do {
        _ = try JSONDecoder().decode(SemanticActionPayload.self, from: unknownPayload)
        throw TestFailure.failed("unknown payload kind decoded as a known action")
    } catch is DecodingError {}
    let unknownAction = Data(#"{"element":{"token":"t","snapshotId":"s","pid":1,"axRevision":1,"stablePathHash":"h"},"action":"select_text_markers","expectedEventRevision":1,"deliveryPolicy":"background_native"}"#.utf8)
    do {
        _ = try JSONDecoder().decode(SemanticActionRequest.self, from: unknownAction)
        throw TestFailure.failed("unknown action kind decoded as a known action")
    } catch is DecodingError {}

    let defaultedPlacement = try JSONDecoder().decode(
        TextMatchSelection.self,
        from: Data(#"{"text":"alpha"}"#.utf8)
    )
    try expect(defaultedPlacement.placement == .select && defaultedPlacement.prefix == nil,
               "omitted match placement did not default to select")
}

private func testTextMatchResolution() throws {
    // UTF-16 offsets: the emoji occupies two code units, so "alpha" starts at 3 and 14.
    let text = "🙂 alpha beta alpha"
    let prefixed = try AXTextPattern.resolveMatch(
        in: text, match: TextMatchSelection(text: "alpha", prefix: "beta ")
    )
    try expect(prefixed == TextRangeSelection(location: 14, length: 5), "prefix disambiguation resolved the wrong range")
    let suffixed = try AXTextPattern.resolveMatch(
        in: text, match: TextMatchSelection(text: "alpha", suffix: " beta")
    )
    try expect(suffixed == TextRangeSelection(location: 3, length: 5), "suffix disambiguation resolved the wrong range")
    let before = try AXTextPattern.resolveMatch(
        in: text, match: TextMatchSelection(text: "alpha", prefix: "beta ", placement: .before)
    )
    try expect(before == TextRangeSelection(location: 14, length: 0), "caret-before placement was wrong")
    let after = try AXTextPattern.resolveMatch(
        in: text, match: TextMatchSelection(text: "alpha", prefix: "beta ", placement: .after)
    )
    try expect(after == TextRangeSelection(location: 19, length: 0), "caret-after placement was wrong")

    for (match, expected, message) in [
        (TextMatchSelection(text: "alpha"), AXSemanticActionError.ambiguousTextMatch, "repeated text was not refused"),
        (TextMatchSelection(text: "gamma"), .textNotFound, "absent text was not refused"),
        (TextMatchSelection(text: "alpha", prefix: "omega "), .textNotFound, "unsatisfiable prefix was not refused"),
        (TextMatchSelection(text: ""), .invalidPayload, "empty needle was accepted"),
        (TextMatchSelection(text: "alpha", prefix: ""), .invalidPayload, "empty prefix was accepted"),
        (TextMatchSelection(text: "al\0pha"), .invalidPayload, "NUL-bearing needle was accepted"),
        (TextMatchSelection(text: String(repeating: "x", count: AXTextLimits.maxNeedleCharacters + 1)),
         .textTooLarge, "oversized needle was accepted"),
    ] {
        do {
            _ = try AXTextPattern.resolveMatch(in: text, match: match)
            throw TestFailure.failed(message)
        } catch let error as AXSemanticActionError {
            try expect(error == expected, "\(message): got \(error)")
        }
    }
    do {
        _ = try AXTextPattern.resolveMatch(
            in: String(repeating: "a", count: AXTextLimits.maxSearchableCharacters + 1),
            match: TextMatchSelection(text: "zz")
        )
        throw TestFailure.failed("oversized document was searched")
    } catch let error as AXSemanticActionError {
        try expect(error == .textTooLarge, "oversized document returned the wrong error")
    }
}

private func testTextRangeAndCaretBounds() throws {
    let whole = try AXTextPattern.validatedRange(location: 0, length: 19, characterCount: 19)
    try expect(whole == TextRangeSelection(location: 0, length: 19), "whole-document range was rejected")
    let atEnd = try AXTextPattern.validatedRange(location: 19, length: 0, characterCount: 19)
    try expect(atEnd == TextRangeSelection(location: 19, length: 0), "end caret range was rejected")
    for (location, length) in [(0, 20), (20, 0), (-1, 2), (0, -1), (Int.max, 1)] {
        do {
            _ = try AXTextPattern.validatedRange(location: location, length: length, characterCount: 19)
            throw TestFailure.failed("out-of-range selection \(location)+\(length) was accepted")
        } catch let error as AXSemanticActionError {
            try expect(error == .textRangeOutOfBounds, "out-of-range selection returned the wrong error")
        }
    }
    let atStart = try AXTextPattern.caretRange(placement: .init(anchor: .start), characterCount: 19)
    try expect(atStart == TextRangeSelection(location: 0, length: 0), "start caret was wrong")
    let atDocumentEnd = try AXTextPattern.caretRange(placement: .init(anchor: .end), characterCount: 19)
    try expect(atDocumentEnd == TextRangeSelection(location: 19, length: 0), "end caret was wrong")
    let atIndex = try AXTextPattern.caretRange(placement: .init(anchor: .index, index: 7), characterCount: 19)
    try expect(atIndex == TextRangeSelection(location: 7, length: 0), "indexed caret was wrong")
    do {
        _ = try AXTextPattern.caretRange(placement: .init(anchor: .index), characterCount: 19)
        throw TestFailure.failed("indexed caret without an index was accepted")
    } catch let error as AXSemanticActionError {
        try expect(error == .invalidPayload, "missing caret index returned the wrong error")
    }
    do {
        _ = try AXTextPattern.caretRange(placement: .init(anchor: .start, index: 3), characterCount: 19)
        throw TestFailure.failed("anchored caret with a conflicting index was accepted")
    } catch let error as AXSemanticActionError {
        try expect(error == .invalidPayload, "conflicting caret anchor returned the wrong error")
    }
}

private func testTextScrollRequestShapePolicy() throws {
    let node = textNode()
    guard let ref = node.elementRef else { throw TestFailure.failed("text ref was missing") }
    try AXSemanticActionEngine.validateRequestShape(
        .init(element: ref, action: .selectTextRange,
              payload: .textRange(.init(location: 0, length: 5)), expectedEventRevision: 1),
        expected: node
    )
    try AXSemanticActionEngine.validateRequestShape(
        .init(element: ref, action: .scrollPage, payload: .scroll(.init(direction: .down)), expectedEventRevision: 1),
        expected: node
    )

    try expectShapeError(
        .init(element: ref, action: .selectText,
              payload: .textRange(.init(location: 0, length: 1)), expectedEventRevision: 1),
        node, .invalidPayload, "mismatched action/payload pair was accepted"
    )
    try expectShapeError(
        .init(element: ref, action: .selectTextRange, expectedEventRevision: 1),
        node, .invalidPayload, "text selection without a payload was accepted"
    )
    try expectShapeError(
        .init(element: ref, action: .invoke,
              payload: .scroll(.init(direction: .up)), expectedEventRevision: 1),
        node, .invalidPayload, "a non-text action carried a text/scroll payload"
    )
    try expectShapeError(
        .init(element: ref, action: .selectText, value: .string("x"),
              payload: .textMatch(.init(text: "alpha")), expectedEventRevision: 1),
        node, .invalidPayload, "text selection carried a value payload"
    )
    try expectShapeError(
        .init(element: ref, action: .selectTextRange,
              payload: .textRange(.init(location: -1, length: 2)), expectedEventRevision: 1),
        node, .textRangeOutOfBounds, "negative selection origin was accepted"
    )
    try expectShapeError(
        .init(element: ref, action: .selectTextRange,
              payload: .textRange(.init(location: 0, length: 4)), expectedEventRevision: 1),
        textNode(role: "AXButton"), .actionUnsupported, "a non-text role accepted a text selection"
    )
    for secure in [textNode(role: "AXSecureTextField"), textNode(role: "AXTextField", subrole: "AXSecureTextField")] {
        try expectShapeError(
            .init(element: ref, action: .setCaret,
                  payload: .caret(.init(anchor: .end)), expectedEventRevision: 1),
            secure, .sensitiveElement, "a secure field accepted caret placement"
        )
        try expectShapeError(
            .init(element: ref, action: .scrollPage,
                  payload: .scroll(.init(direction: .down)), expectedEventRevision: 1),
            secure, .sensitiveElement, "a secure field accepted page scrolling"
        )
    }
    try expectShapeError(
        .init(element: ref, action: .selectTextRange,
              payload: .textRange(.init(location: 0, length: 1)), expectedEventRevision: 1),
        textNode(enabled: false), .liveIdentityMismatch, "a disabled element accepted a selection"
    )
}

/// The AXValue boxing is the one place where a silent bug selects the wrong text rather than
/// failing, so it is exercised against real CoreFoundation values rather than only through a live
/// application.
private func testSelectionRangeEncoding() throws {
    for selection in [
        TextRangeSelection(location: 0, length: 0),
        TextRangeSelection(location: 14, length: 5),
        TextRangeSelection(location: 262_143, length: 1),
    ] {
        guard let encoded = AXTextPattern.encodeRange(selection) else {
            throw TestFailure.failed("selection range \(selection) did not encode")
        }
        try expect(AXTextPattern.decodeRange(encoded) == selection,
                   "selection range \(selection) did not survive AXValue boxing")
    }
    try expect(AXTextPattern.decodeRange(nil) == nil, "a missing attribute decoded as a range")
    try expect(AXTextPattern.decodeRange("AXSelectedTextRange" as CFString) == nil,
               "a non-AXValue attribute decoded as a range")
    var point = CGPoint(x: 3, y: 4)
    guard let wrongType = AXValueCreate(.cgPoint, &point) else {
        throw TestFailure.failed("test AXValue was not created")
    }
    try expect(AXTextPattern.decodeRange(wrongType) == nil,
               "a non-range AXValue was coerced into a selection")
}

private func testScrollPercentParsing() throws {
    try expect(AXScrollPattern.percentValue(NSNumber(value: 0.25)) == 25, "scrollbar value was not scaled")
    try expect(AXScrollPattern.percentValue(NSNumber(value: 0.0)) == 0, "a top scrollbar was reported as unknown")
    try expect(AXScrollPattern.percentValue(NSNumber(value: Double.nan)) == nil, "a NaN scrollbar became a position")
    try expect(AXScrollPattern.percentValue(NSNumber(value: Double.infinity)) == nil, "an infinite scrollbar became a position")
    try expect(AXScrollPattern.percentValue(nil) == nil, "a missing scrollbar became a position")
    try expect(AXScrollPattern.percentValue("0.5") == nil, "a string scrollbar value became a position")
}

private func testScrollPatternMapping() throws {
    let expected: [ScrollPageDirection: String] = [
        .up: "AXScrollUpByPage", .down: "AXScrollDownByPage",
        .left: "AXScrollLeftByPage", .right: "AXScrollRightByPage",
    ]
    for direction in ScrollPageDirection.allCases {
        try expect(AXScrollPattern.action(for: direction) == expected[direction],
                   "scroll direction \(direction) mapped to the wrong AX action")
    }
    try expect(AXSemanticActionEngine.scrollChanged(horizontal: (nil, nil), vertical: (nil, nil)) == nil,
               "unreadable scrollbars were reported as a known outcome")
    try expect(AXSemanticActionEngine.scrollChanged(horizontal: (nil, nil), vertical: (10, 10)) == false,
               "an unmoved scrollbar was reported as changed")
    try expect(AXSemanticActionEngine.scrollChanged(horizontal: (nil, 4), vertical: (10, 40)) == true,
               "a moved scrollbar was not reported")
}

private func testTextScrollActionPipeline() throws {
    let events = ManualEventTracker()
    let actions = FixedSemanticActions()
    let store = AXSnapshotStore()
    let core = BimaxCuServiceCore(
        permissions: FixedPermissions(), workspace: FixedWorkspace(),
        accessibility: FixedAccessibility(), axSnapshots: store, axEvents: events,
        semanticActions: actions
    )
    guard case .session(let session) = core.handle(request(
        "text-create", body: .sessionCreate(requestedId: "text-scroll")
    )).body else { throw TestFailure.failed("text session was not created") }
    guard case .axSnapshot(let snapshot) = core.handle(request(
        "text-observe", session: session.sessionId,
        body: .axObserve(.init(pid: 42, windowId: 7, windowGeneration: 3))
    )).body, let ref = snapshot.nodes.first?.elementRef else {
        throw TestFailure.failed("text action authority was not observed")
    }
    let select = SemanticActionRequest(
        element: ref, action: .selectText,
        payload: .textMatch(.init(text: "alpha", prefix: "beta ")),
        expectedEventRevision: snapshot.eventRevision
    )
    guard case .semanticActionReceipt(let receipt) = core.handle(request(
        "text-select", session: session.sessionId, body: .semanticAction(select)
    )).body else { throw TestFailure.failed("text selection receipt was missing") }
    try expect(receipt.primitive == "AXSetAttribute:AXSelectedTextRange", "selection primitive was wrong")
    try expect(receipt.textSelection?.location == 14 && receipt.textSelection?.length == 5
               && receipt.textSelection?.characterCount == 19 && receipt.textSelection?.honored == true,
               "selection offsets were not recorded")
    try expect(receipt.scroll == nil, "a text action fabricated scroll evidence")
    try expect(actions.requests.first?.payload == select.payload, "the text payload did not reach the executor")
    let encodedReceipt = String(decoding: try JSONEncoder().encode(receipt), as: UTF8.self)
    try expect(!encodedReceipt.contains("alpha") && !encodedReceipt.contains("beta"),
               "the receipt leaked selected or surrounding text")
    try expect(store.retainedCount(sessionId: session.sessionId) == 0,
               "a successful selection retained stale target authorities")
    let replay = core.handle(request("text-replay", session: session.sessionId, body: .semanticAction(select)))
    try expect(replay.error?.code == "stale_element_ref", "a consumed selection authority was reusable")
    try expect(actions.attemptCount == 1, "a consumed authority reached the executor again")

    // Scrolling reuses the same authorization pipeline and the same one-shot authority rule.
    let scrollEvents = ManualEventTracker()
    let scrollActions = FixedSemanticActions()
    let scrollStore = AXSnapshotStore()
    let scrollCore = BimaxCuServiceCore(
        permissions: FixedPermissions(), workspace: FixedWorkspace(),
        accessibility: FixedAccessibility(), axSnapshots: scrollStore, axEvents: scrollEvents,
        semanticActions: scrollActions
    )
    guard case .session(let scrollSession) = scrollCore.handle(request(
        "scroll-create", body: .sessionCreate(requestedId: "scroll")
    )).body else { throw TestFailure.failed("scroll session was not created") }
    guard case .axSnapshot(let scrollSnapshot) = scrollCore.handle(request(
        "scroll-observe", session: scrollSession.sessionId,
        body: .axObserve(.init(pid: 42, windowId: 7, windowGeneration: 3))
    )).body, let scrollRef = scrollSnapshot.nodes.first?.elementRef else {
        throw TestFailure.failed("scroll action authority was not observed")
    }
    guard case .semanticActionReceipt(let scrollReceipt) = scrollCore.handle(request(
        "scroll-run", session: scrollSession.sessionId,
        body: .semanticAction(.init(
            element: scrollRef, action: .scrollPage, payload: .scroll(.init(direction: .down)),
            expectedEventRevision: scrollSnapshot.eventRevision
        ))
    )).body else { throw TestFailure.failed("scroll receipt was missing") }
    try expect(scrollReceipt.primitive == "AXScrollDownByPage", "scroll primitive was wrong")
    try expect(scrollReceipt.scroll?.changed == true && scrollReceipt.textSelection == nil,
               "scroll evidence was wrong")
    try expect(scrollStore.retainedCount(sessionId: scrollSession.sessionId) == 0,
               "a successful scroll retained geometry-stale authorities")

    // A failing mutation is reported once. The service never re-attempts it.
    let failingEvents = ManualEventTracker()
    let failingActions = FixedSemanticActions()
    failingActions.failure = .selectionNotSettable
    let failingCore = BimaxCuServiceCore(
        permissions: FixedPermissions(), workspace: FixedWorkspace(),
        accessibility: FixedAccessibility(), axEvents: failingEvents, semanticActions: failingActions
    )
    guard case .session(let failingSession) = failingCore.handle(request(
        "fail-create", body: .sessionCreate(requestedId: "fail")
    )).body else { throw TestFailure.failed("failing session was not created") }
    guard case .axSnapshot(let failingSnapshot) = failingCore.handle(request(
        "fail-observe", session: failingSession.sessionId,
        body: .axObserve(.init(pid: 42, windowId: 7, windowGeneration: 3))
    )).body, let failingRef = failingSnapshot.nodes.first?.elementRef else {
        throw TestFailure.failed("failing authority was not observed")
    }
    let failed = failingCore.handle(request(
        "fail-run", session: failingSession.sessionId,
        body: .semanticAction(.init(
            element: failingRef, action: .setCaret, payload: .caret(.init(anchor: .end)),
            expectedEventRevision: failingSnapshot.eventRevision
        ))
    ))
    try expect(failed.error?.code == "ax_selection_not_settable", "a non-settable selection was mistyped")
    try expect(failingActions.attemptCount == 1, "a failed mutation was retried")
}

/// Stands in for an application whose Accessibility server has stopped answering. The engine's own
/// per-call timeout and capture budget bound a real hang; this double makes the *service-level*
/// property testable: one stuck target must not stall unrelated sessions.
private final class HangingAccessibility: AXObserving, @unchecked Sendable {
    private let inner = FixedAccessibility()
    private let hangPid: Int32
    private let hangSeconds: Double
    private let entered = DispatchSemaphore(value: 0)

    init(hangPid: Int32, hangSeconds: Double) {
        self.hangPid = hangPid
        self.hangSeconds = hangSeconds
    }

    func observe(sessionId: String, request: AXObserveRequest) throws -> AXSnapshot {
        if request.pid == hangPid {
            entered.signal()
            Thread.sleep(forTimeInterval: hangSeconds)
        }
        return try inner.observe(sessionId: sessionId, request: request)
    }

    func reset(sessionId: String) { inner.reset(sessionId: sessionId) }
    func waitUntilHanging(timeout: Double) -> Bool {
        entered.wait(timeout: .now() + timeout) == .success
    }
}

private func testHungApplicationDoesNotBlockOtherSessions() throws {
    let hanging = HangingAccessibility(hangPid: 99, hangSeconds: 2.0)
    let core = BimaxCuServiceCore(
        permissions: FixedPermissions(), workspace: FixedWorkspace(),
        accessibility: hanging, axEvents: ManualEventTracker()
    )
    guard case .session(let stuck) = core.handle(request(
        "hang-create-a", body: .sessionCreate(requestedId: "hung-target")
    )).body, case .session(let healthy) = core.handle(request(
        "hang-create-b", body: .sessionCreate(requestedId: "healthy-target")
    )).body else { throw TestFailure.failed("hang test sessions were not created") }

    let finished = DispatchSemaphore(value: 0)
    Thread.detachNewThread {
        _ = core.handle(request(
            "hang-observe", session: stuck.sessionId,
            body: .axObserve(.init(pid: 99, scope: .application, maxDurationMs: 5_000))
        ))
        finished.signal()
    }
    try expect(hanging.waitUntilHanging(timeout: 2.0), "the hung observation never started")

    let startedNanos = DispatchTime.now().uptimeNanoseconds
    let response = core.handle(request(
        "healthy-observe", session: healthy.sessionId,
        body: .axObserve(.init(pid: 42, windowId: 7, windowGeneration: 3))
    ))
    let elapsedMs = Double(DispatchTime.now().uptimeNanoseconds - startedNanos) / 1_000_000
    guard case .axSnapshot = response.body else {
        throw TestFailure.failed("a healthy session was refused while another target hung: \(response)")
    }
    try expect(elapsedMs < 500, "a hung application delayed an unrelated session by \(Int(elapsedMs)) ms")
    try expect(finished.wait(timeout: .now() + 5) == .success, "the hung observation never returned")
}

private func testObservationQueryFiltering() throws {
    try expect(AccessibilityEngine.matchesQuery("save", role: "AXButton", label: "Save As", value: nil, identifier: nil),
               "a case-insensitive label match was missed")
    try expect(AccessibilityEngine.matchesQuery("BUTTON", role: "AXButton", label: nil, value: nil, identifier: nil),
               "a role match was missed")
    try expect(AccessibilityEngine.matchesQuery("resume", role: "AXButton", label: "Résumé", value: nil, identifier: nil),
               "a diacritic-insensitive match was missed")
    try expect(AccessibilityEngine.matchesQuery("id-7", role: "AXButton", label: nil, value: nil, identifier: "field-id-7"),
               "an identifier match was missed")
    try expect(!AccessibilityEngine.matchesQuery("cancel", role: "AXButton", label: "Save", value: nil, identifier: "save"),
               "a non-matching node was emitted")
    try expect(AccessibilityEngine.matchesQuery("   ", role: "AXButton", label: nil, value: nil, identifier: nil),
               "a blank query filtered everything out")

    let core = BimaxCuServiceCore(
        permissions: FixedPermissions(), workspace: FixedWorkspace(),
        accessibility: FixedAccessibility(), axEvents: ManualEventTracker()
    )
    guard case .session(let session) = core.handle(request(
        "query-create", body: .sessionCreate(requestedId: "query")
    )).body else { throw TestFailure.failed("query session was not created") }
    let blank = core.handle(request(
        "query-blank", session: session.sessionId,
        body: .axObserve(.init(pid: 42, windowId: 7, windowGeneration: 3, query: "   "))
    ))
    try expect(blank.error?.code == "invalid_observation_query", "a blank query was accepted")
    let oversized = core.handle(request(
        "query-oversized", session: session.sessionId,
        body: .axObserve(.init(pid: 42, windowId: 7, windowGeneration: 3, query: String(repeating: "x", count: 257)))
    ))
    try expect(oversized.error?.code == "invalid_observation_query", "an oversized query was accepted")
}

/// A filtered view is a lens over the graph, not the graph. Diffing one against an unfiltered base
/// would report every non-matching node as removed.
private func testQueryFilteredSnapshotsAreNotDiffedAgainstFullState() throws {
    let store = AXSnapshotStore()
    var full = retainedSnapshot(session: "q", id: "q1", revision: 1, specs: [("save", "Save"), ("cancel", "Cancel")])
    full.query = nil
    var filtered = retainedSnapshot(session: "q", id: "q2", revision: 2, specs: [("save", "Save")])
    filtered.query = "save"
    _ = try store.retain(full: full, since: nil)
    do {
        _ = try store.retain(full: filtered, since: full.snapshotId)
        throw TestFailure.failed("a filtered snapshot diffed against unfiltered state")
    } catch let error as AXSnapshotStoreError {
        try expect(error == .baseSnapshotTargetMismatch, "query mismatch returned the wrong error")
    }
    var filteredAgain = retainedSnapshot(session: "q", id: "q3", revision: 3, specs: [("save", "Saved")])
    filteredAgain.query = "save"
    _ = try store.retain(full: filtered, since: nil)
    let diff = try store.retain(full: filteredAgain, since: filtered.snapshotId)
    try expect(diff.baseSnapshotId == filtered.snapshotId, "matching queries did not diff against each other")
}

/// Launch Services stand-in. Nothing here starts a real process, so the launch *policy* is
/// testable offline; whether macOS honors a non-activating open is the conformance run's job.
private final class FakeLaunchServices: LaunchServicesProviding, @unchecked Sendable {
    struct Bundle {
        var url: URL
        var bundleId: String?
        var displayName: String?
    }

    private let lock = NSLock()
    private var byBundleId: [String: Bundle] = [:]
    private var byName: [String: Bundle] = [:]
    private var running: [String: [AppRef]] = [:]
    private(set) var opened: [URL] = []
    var frontmost: Int32? = 501
    /// What the fake foreground becomes after an open. The live check is whether the real one moves.
    var frontmostAfterOpen: Int32?
    var openError: AppWorkspaceError?
    var launchedPid: Int32 = 4_242
    var readyPids: Set<Int32> = []

    init(bundleId: String = "ai.bimax.cu.fixture", name: String = "BimaxCuFixture") {
        let bundle = Bundle(
            url: URL(fileURLWithPath: "/Applications/BimaxCuFixture.app"),
            bundleId: bundleId,
            displayName: name
        )
        byBundleId[bundleId] = bundle
        byName[name] = bundle
    }

    func setRunning(bundleId: String, refs: [AppRef]) { lock.withLock { running[bundleId] = refs } }

    func urlForBundleId(_ bundleId: String) -> URL? { lock.withLock { byBundleId[bundleId]?.url } }
    func urlForName(_ name: String) -> URL? { lock.withLock { byName[name]?.url } }

    func bundleMetadata(at url: URL) -> (bundleId: String?, displayName: String?) {
        lock.withLock {
            guard let bundle = byBundleId.values.first(where: { $0.url == url }) else { return (nil, nil) }
            return (bundle.bundleId, bundle.displayName)
        }
    }

    func runningInstances(bundleId: String) -> [AppRef] { lock.withLock { running[bundleId] ?? [] } }
    func frontmostPid() -> Int32? { lock.withLock { frontmost } }

    func openWithoutActivation(_ url: URL, timeoutMs: Int) throws -> AppRef {
        if let openError { throw openError }
        return try lock.withLock {
            opened.append(url)
            if let frontmostAfterOpen { frontmost = frontmostAfterOpen }
            guard let bundle = byBundleId.values.first(where: { $0.url == url }) else {
                throw AppWorkspaceError.launchFailed("unknown bundle")
            }
            let ref = AppRef(
                bundleId: bundle.bundleId, pid: launchedPid,
                launchId: "\(launchedPid):1000", displayName: bundle.displayName
            )
            running[bundle.bundleId ?? "", default: []].append(ref)
            return ref
        }
    }

    func finishedLaunching(pid: Int32) -> Bool { lock.withLock { readyPids.contains(pid) } }
}

private func testAppWorkspaceResolveAndLaunchPolicy() throws {
    // Resolution reports the exact bundle that would launch, so an approval can name it.
    let services = FakeLaunchServices()
    let workspace = AppWorkspace(services: services, sleeper: { _ in })
    let resolved = try workspace.resolve(.init(lookup: .bundleId("ai.bimax.cu.fixture")))
    try expect(resolved.resolved && resolved.bundlePath == "/Applications/BimaxCuFixture.app",
               "bundle-id resolution did not return the resolved bundle path")
    try expect(resolved.displayName == "BimaxCuFixture" && resolved.running.isEmpty,
               "resolution returned the wrong metadata")
    try expect(services.opened.isEmpty, "resolution started an application")

    let byName = try workspace.resolve(.init(lookup: .name("BimaxCuFixture")))
    try expect(byName.bundleId == "ai.bimax.cu.fixture", "name resolution did not report the bundle id")

    let missing = try workspace.resolve(.init(lookup: .bundleId("com.example.absent")))
    try expect(!missing.resolved && missing.bundlePath == nil,
               "an unresolved lookup claimed a bundle")

    // A launch reports its own measured foreground, and the fake keeps it still.
    services.readyPids = [4_242]
    let receipt = try workspace.launch(.init(lookup: .bundleId("ai.bimax.cu.fixture"), readinessTimeoutMs: 0))
    try expect(receipt.outcome == .launched && receipt.app?.pid == 4_242, "launch did not report the started app")
    try expect(!receipt.requestedActivation && !receipt.frontmostChanged,
               "a background launch reported an activation")
    try expect(receipt.finishedLaunching, "readiness was not read back from the process")
    try expect(services.opened.count == 1, "launch opened the bundle more than once")

    // Second call: the bundle is running, so opening it again would raise it.
    let second = try workspace.launch(.init(lookup: .bundleId("ai.bimax.cu.fixture"), readinessTimeoutMs: 0))
    try expect(second.outcome == .alreadyRunning && services.opened.count == 1,
               "a running application was opened again")
    try expect(second.app?.pid == 4_242, "the already-running receipt lost the existing instance")
}

private func testAppWorkspaceRefusesPathsAndReportsForegroundTheft() throws {
    let services = FakeLaunchServices()
    let workspace = AppWorkspace(services: services, sleeper: { _ in })

    // The protocol has no path case; a path-shaped *name* must not reach Launch Services either.
    for lookup: AppLookup in [
        .name("/Applications/Calculator.app"), .name("../Calculator"), .name(".hidden"),
        .name("Calc\u{0}ulator"), .bundleId("com.example.app/../evil"), .bundleId("com.example app"),
        .name(String(repeating: "a", count: 257)), .name(""),
    ] {
        do {
            _ = try workspace.resolve(.init(lookup: lookup))
            throw TestFailure.failed("resolve accepted the lookup \(lookup.value)")
        } catch let error as AppWorkspaceError {
            guard case .invalidLookup = error else {
                throw TestFailure.failed("resolve returned the wrong refusal for \(lookup.value)")
            }
        }
        do {
            _ = try workspace.launch(.init(lookup: lookup, readinessTimeoutMs: 0))
            throw TestFailure.failed("launch accepted the lookup \(lookup.value)")
        } catch let error as AppWorkspaceError {
            guard case .invalidLookup = error else {
                throw TestFailure.failed("launch returned the wrong refusal for \(lookup.value)")
            }
        }
    }
    try expect(services.opened.isEmpty, "a refused lookup still opened something")

    do {
        _ = try workspace.launch(.init(lookup: .bundleId("ai.bimax.cu.fixture"), readinessTimeoutMs: 10_001))
        throw TestFailure.failed("launch accepted an unbounded readiness timeout")
    } catch let error as AppWorkspaceError {
        guard case .invalidLookup = error else { throw TestFailure.failed("wrong timeout refusal") }
    }

    do {
        _ = try workspace.launch(.init(lookup: .name("Absent"), readinessTimeoutMs: 0))
        throw TestFailure.failed("launch accepted an unresolvable application")
    } catch let error as AppWorkspaceError {
        try expect(error == .notFound, "an unresolvable launch returned the wrong error")
    }

    // If the foreground does move, the receipt says so rather than reporting a clean background
    // launch. This is the whole reason the receipt measures instead of trusting `activates = false`.
    let thief = FakeLaunchServices()
    thief.frontmostAfterOpen = 9_999
    let thiefWorkspace = AppWorkspace(services: thief, sleeper: { _ in })
    let receipt = try thiefWorkspace.launch(.init(lookup: .bundleId("ai.bimax.cu.fixture"), readinessTimeoutMs: 0))
    try expect(receipt.frontmostChanged && receipt.frontmostPidAfter == 9_999,
               "a launch that moved the foreground reported a background launch")
    try expect(!receipt.finishedLaunching, "readiness was invented for a process that never reported it")

    // The derived flag survives the wire, and a forged `frontmostChanged` cannot override it.
    let encoder = JSONEncoder()
    let decoder = JSONDecoder()
    let roundTripped = try decoder.decode(AppLaunchReceipt.self, from: encoder.encode(receipt))
    try expect(roundTripped.frontmostChanged, "the derived foreground flag did not survive the wire")
    var forged = try JSONSerialization.jsonObject(with: encoder.encode(receipt)) as! [String: Any]
    forged["frontmostChanged"] = false
    let forgedReceipt = try decoder.decode(
        AppLaunchReceipt.self, from: JSONSerialization.data(withJSONObject: forged)
    )
    try expect(forgedReceipt.frontmostChanged,
               "a forged frontmostChanged overrode the receipt's own measurements")
}

private func testAppWorkspaceServiceOperations() throws {
    let services = FakeLaunchServices()
    let core = BimaxCuServiceCore(
        permissions: FixedPermissions(),
        workspace: FixedWorkspace(),
        appWorkspace: AppWorkspace(services: services, sleeper: { _ in })
    )
    let created = core.handle(RequestEnvelope(
        requestId: "r0", sessionId: "bootstrap", deadlineMs: 1_000,
        body: .sessionCreate(requestedId: "app-workspace")
    ))
    guard case .session(let session)? = created.body else {
        throw TestFailure.failed("could not create a session")
    }

    // Both operations are session-bound even though resolution is read-only.
    let unknownSession = core.handle(RequestEnvelope(
        requestId: "r1", sessionId: "not-a-session", deadlineMs: 1_000,
        body: .appResolve(.init(lookup: .bundleId("ai.bimax.cu.fixture")))
    ))
    try expect(unknownSession.error?.code == "session_not_found",
               "resolution ran outside a live session")

    let resolveResponse = core.handle(RequestEnvelope(
        requestId: "r2", sessionId: session.sessionId, deadlineMs: 1_000,
        body: .appResolve(.init(lookup: .bundleId("ai.bimax.cu.fixture")))
    ))
    guard case .appResolved(let resolved)? = resolveResponse.body else {
        throw TestFailure.failed("resolve produced no typed response")
    }
    try expect(resolved.bundleId == "ai.bimax.cu.fixture", "the service lost the resolved bundle id")

    let launchResponse = core.handle(RequestEnvelope(
        requestId: "r3", sessionId: session.sessionId, deadlineMs: 1_000,
        body: .appLaunch(.init(lookup: .bundleId("ai.bimax.cu.fixture"), readinessTimeoutMs: 0))
    ))
    guard case .appLaunchReceipt(let receipt)? = launchResponse.body else {
        throw TestFailure.failed("launch produced no typed receipt")
    }
    try expect(receipt.outcome == .launched, "the service did not report a launch")

    let refused = core.handle(RequestEnvelope(
        requestId: "r4", sessionId: session.sessionId, deadlineMs: 1_000,
        body: .appLaunch(.init(lookup: .name("/Applications/Calculator.app"), readinessTimeoutMs: 0))
    ))
    try expect(refused.error?.code == "invalid_app_lookup", "the service accepted a path lookup")

    let absent = core.handle(RequestEnvelope(
        requestId: "r5", sessionId: session.sessionId, deadlineMs: 1_000,
        body: .appLaunch(.init(lookup: .bundleId("com.example.absent"), readinessTimeoutMs: 0))
    ))
    try expect(absent.error?.code == "app_not_found", "an unresolvable launch returned the wrong code")
    try expect(absent.error?.message.contains("com.example.absent") != true,
               "a workspace error echoed the caller's lookup back")

    // Wire round-trip for both operations, including the additive capability fields.
    let encoder = JSONEncoder()
    let decoder = JSONDecoder()
    let requests: [RequestBody] = [
        .appResolve(.init(lookup: .name("BimaxCuFixture"))),
        .appLaunch(.init(lookup: .bundleId("ai.bimax.cu.fixture"), readinessTimeoutMs: 2_500)),
    ]
    for request in requests {
        let decoded = try decoder.decode(RequestBody.self, from: encoder.encode(request))
        try expect(decoded == request, "a workspace request did not round-trip")
    }
    let responses: [ResponseBody] = [.appResolved(resolved), .appLaunchReceipt(receipt)]
    for response in responses {
        let decoded = try decoder.decode(ResponseBody.self, from: encoder.encode(response))
        try expect(decoded == response, "a workspace response did not round-trip")
    }

    // A service predating this slice omits the new capability fields; absent must read as nothing
    // proven, never as everything supported.
    let legacy = try decoder.decode(
        WorkspaceCapabilities.self,
        from: Data(#"{"apps":true,"windows":true,"displays":true}"#.utf8)
    )
    try expect(legacy.operations.isEmpty && legacy.verifiedOperations.isEmpty,
               "a legacy handshake implied workspace operations")

    let handshake = core.handshakeResponse()
    try expect(handshake.capabilities.workspace.operations == WorkspaceOperationKind.allCases.map(\.rawValue),
               "the handshake did not advertise the workspace operations")
    try expect(Set(handshake.capabilities.workspace.verifiedOperations)
        .isSubset(of: Set(handshake.capabilities.workspace.operations)),
               "the handshake verified a workspace operation it does not accept")
}

/// Filesystem/Launch Services stand-in. No real file is touched, so the refusal policy is
/// testable without a scratch directory; the conformance run exercises the real filesystem.
private final class FakeFileServices: FileServicesProviding, @unchecked Sendable {
    private let lock = NSLock()
    var existing: Set<String> = ["/workspace/report.txt"]
    var directories: Set<String> = []
    var packages: Set<String> = []
    private(set) var opened: [(path: String, bundle: URL?)] = []
    private(set) var revealed: [String] = []
    private(set) var trashed: [String] = []
    private(set) var duplicated: [String] = []
    private(set) var openedURLs: [URL] = []
    var frontmost: Int32? = 501
    var frontmostAfterReveal: Int32?
    var trashFailure: FileWorkspaceError?

    func attributes(_ path: String) -> FileAttributesRecord? {
        lock.withLock {
            guard existing.contains(path) || directories.contains(path) else { return nil }
            return FileAttributesRecord(
                isDirectory: directories.contains(path), isSymbolicLink: false,
                byteSize: 128, modifiedAtMs: 1_700_000_000_000
            )
        }
    }

    func contentType(_ path: String) -> (identifier: String?, description: String?) {
        path.hasSuffix(".txt") ? ("public.plain-text", "Plain Text Document") : (nil, nil)
    }

    func isPackage(_ path: String) -> Bool { lock.withLock { packages.contains(path) } }
    func defaultApplicationPath(for path: String) -> String? { "/Applications/TextEdit.app" }
    func frontmostPid() -> Int32? { lock.withLock { frontmost } }

    func open(path: String, withApplicationAt bundle: URL?, timeoutMs: Int) throws -> AppRef? {
        lock.withLock {
            opened.append((path, bundle))
            return AppRef(bundleId: "com.apple.TextEdit", pid: 77, launchId: "77:1", displayName: "TextEdit")
        }
    }

    func reveal(path: String) -> Bool {
        lock.withLock {
            revealed.append(path)
            if let frontmostAfterReveal { frontmost = frontmostAfterReveal }
            return true
        }
    }

    func trash(path: String) throws -> String? {
        if let trashFailure { throw trashFailure }
        return lock.withLock {
            trashed.append(path)
            return "/Users/test/.Trash/\((path as NSString).lastPathComponent)"
        }
    }

    func duplicate(path: String) throws -> String? {
        lock.withLock {
            duplicated.append(path)
            return "/workspace/report copy.txt"
        }
    }

    func openURL(_ url: URL, withApplicationAt bundle: URL?, timeoutMs: Int) throws -> AppRef? {
        lock.withLock {
            openedURLs.append(url)
            return AppRef(bundleId: "com.apple.Safari", pid: 88, launchId: "88:1", displayName: "Safari")
        }
    }
}

private func testFileWorkspacePolicy() throws {
    let services = FakeFileServices()
    let workspace = FileWorkspace(services: services, homePath: "/Users/test")
    let resolveApp: (AppLookup) throws -> URL = { _ in URL(fileURLWithPath: "/Applications/TextEdit.app") }

    let info = try workspace.inspect(.init(path: "/workspace/report.txt"))
    try expect(info.exists && info.contentType == "public.plain-text" && info.byteSize == 128,
               "inspect did not describe the file")
    try expect(info.defaultApplicationPath == "/Applications/TextEdit.app",
               "inspect lost the default handler")
    let missing = try workspace.inspect(.init(path: "/workspace/absent.txt"))
    try expect(!missing.exists && missing.contentType == nil,
               "a missing file was described as existing")

    // Only absolute, already-normalized paths. Normalizing here would validate one path and act
    // on another.
    for path in ["report.txt", "~/report.txt", "/workspace/../etc/passwd", "", "/workspace/\u{0}x"] {
        do {
            _ = try workspace.inspect(.init(path: path))
            throw TestFailure.failed("inspect accepted the path \(path)")
        } catch let error as FileWorkspaceError {
            guard case .invalidPath = error else { throw TestFailure.failed("wrong refusal for \(path)") }
        }
    }

    let opened = try workspace.perform(
        .init(operation: .open, path: "/workspace/report.txt", application: .bundleId("com.apple.TextEdit")),
        resolving: resolveApp
    )
    try expect(opened.performed && !opened.requestedActivation && !opened.frontmostChanged,
               "open reported an activation it did not request")
    try expect(opened.applicationBundlePath == "/Applications/TextEdit.app" && opened.app?.pid == 77,
               "open lost the resolved handler")

    // Revealing is foreground-changing by construction, so it declares it rather than hiding it.
    services.frontmostAfterReveal = 9_001
    let revealed = try workspace.perform(.init(operation: .reveal, path: "/workspace/report.txt"), resolving: resolveApp)
    try expect(revealed.requestedActivation && revealed.frontmostChanged,
               "reveal did not report the foreground change it causes")

    let trashed = try workspace.perform(.init(operation: .trash, path: "/workspace/report.txt"), resolving: resolveApp)
    try expect(trashed.performed && trashed.resultingPath == "/Users/test/.Trash/report.txt",
               "trash did not report where the item landed")

    let duplicated = try workspace.perform(.init(operation: .duplicate, path: "/workspace/report.txt"), resolving: resolveApp)
    try expect(duplicated.resultingPath == "/workspace/report copy.txt", "duplicate did not report the new path")

    // An application may only be named for open_file.
    do {
        _ = try workspace.perform(
            .init(operation: .trash, path: "/workspace/report.txt", application: .bundleId("com.apple.TextEdit")),
            resolving: resolveApp
        )
        throw TestFailure.failed("trash accepted an application")
    } catch let error as FileWorkspaceError {
        guard case .invalidPath = error else { throw TestFailure.failed("wrong application refusal") }
    }

    do {
        _ = try workspace.perform(.init(operation: .open, path: "/workspace/absent.txt"), resolving: resolveApp)
        throw TestFailure.failed("open accepted a missing file")
    } catch let error as FileWorkspaceError {
        try expect(error == .notFound, "a missing file returned the wrong error")
    }
}

private func testFileWorkspaceRefusesDangerousDeletionAndSchemes() throws {
    let services = FakeFileServices()
    services.existing = ["/", "/Users/test", "/Users", "/System/Library/CoreServices",
                         "/Applications/Mail.app", "/workspace/report.txt"]
    services.directories = services.existing
    let workspace = FileWorkspace(services: services, homePath: "/Users/test")
    let resolveApp: (AppLookup) throws -> URL = { _ in URL(fileURLWithPath: "/Applications/TextEdit.app") }

    // Workspace scoping lives in the coordinator; this is the floor beneath it.
    for path in ["/", "/Users/test", "/Users", "/System/Library/CoreServices", "/Applications/Mail.app"] {
        do {
            _ = try workspace.perform(.init(operation: .trash, path: path), resolving: resolveApp)
            throw TestFailure.failed("trash accepted \(path)")
        } catch let error as FileWorkspaceError {
            guard case .refused = error else { throw TestFailure.failed("wrong deletion refusal for \(path)") }
        }
    }
    try expect(services.trashed.isEmpty, "a refused deletion still reached the filesystem")

    // A custom scheme is a request to run whichever local application claims it.
    for url in ["file:///etc/passwd", "javascript:alert(1)", "x-bimax://run", "mailto:a@example.com",
                "https://", "not a url", "http://"] {
        do {
            _ = try workspace.openURL(.init(url: url), resolving: resolveApp)
            throw TestFailure.failed("openURL accepted \(url)")
        } catch let error as FileWorkspaceError {
            switch error {
            case .refused, .invalidPath: break
            default: throw TestFailure.failed("wrong URL refusal for \(url)")
            }
        }
    }
    try expect(services.openedURLs.isEmpty, "a refused URL still reached Launch Services")

    let receipt = try workspace.openURL(.init(url: "https://example.com/docs?q=1"), resolving: resolveApp)
    try expect(receipt.opened && receipt.scheme == "https" && receipt.host == "example.com",
               "an accepted URL was not described")
    try expect(!receipt.requestedActivation && !receipt.frontmostChanged,
               "opening a URL reported an activation it did not request")

    // The derived foreground flag survives the wire and cannot be forged in either receipt.
    let encoder = JSONEncoder()
    let decoder = JSONDecoder()
    var forgedURL = try JSONSerialization.jsonObject(with: encoder.encode(receipt)) as! [String: Any]
    forgedURL["frontmostChanged"] = true
    let decodedURL = try decoder.decode(OpenURLReceipt.self, from: JSONSerialization.data(withJSONObject: forgedURL))
    try expect(!decodedURL.frontmostChanged, "a forged URL receipt overrode its own measurements")

    let fileReceipt = try workspace.perform(.init(operation: .open, path: "/workspace/report.txt"), resolving: resolveApp)
    var forgedFile = try JSONSerialization.jsonObject(with: encoder.encode(fileReceipt)) as! [String: Any]
    forgedFile["frontmostChanged"] = true
    let decodedFile = try decoder.decode(FileOperationReceipt.self, from: JSONSerialization.data(withJSONObject: forgedFile))
    try expect(!decodedFile.frontmostChanged, "a forged file receipt overrode its own measurements")
}

private func testFileWorkspaceServiceOperations() throws {
    let services = FakeFileServices()
    let core = BimaxCuServiceCore(
        permissions: FixedPermissions(),
        workspace: FixedWorkspace(),
        appWorkspace: AppWorkspace(services: FakeLaunchServices(), sleeper: { _ in }),
        fileWorkspace: FileWorkspace(services: services, homePath: "/Users/test")
    )
    let created = core.handle(RequestEnvelope(
        requestId: "f0", sessionId: "bootstrap", deadlineMs: 1_000,
        body: .sessionCreate(requestedId: "file-workspace")
    ))
    guard case .session(let session)? = created.body else {
        throw TestFailure.failed("could not create a session")
    }

    for body in [
        RequestBody.fileInspect(.init(path: "/workspace/report.txt")),
        .fileOperation(.init(operation: .open, path: "/workspace/report.txt")),
        .urlOpen(.init(url: "https://example.com")),
    ] {
        let response = core.handle(RequestEnvelope(
            requestId: "f-session", sessionId: "not-a-session", deadlineMs: 1_000, body: body
        ))
        try expect(response.error?.code == "session_not_found", "a file operation ran outside a live session")
    }

    let info = core.handle(RequestEnvelope(
        requestId: "f1", sessionId: session.sessionId, deadlineMs: 1_000,
        body: .fileInspect(.init(path: "/workspace/report.txt"))
    ))
    guard case .fileInfo(let receipt)? = info.body else { throw TestFailure.failed("inspect produced no typed response") }
    try expect(receipt.exists, "the service lost the inspect result")

    let refused = core.handle(RequestEnvelope(
        requestId: "f2", sessionId: session.sessionId, deadlineMs: 1_000,
        body: .fileOperation(.init(operation: .trash, path: "/Users/test"))
    ))
    try expect(refused.error?.code == "file_operation_refused", "the service accepted a home-directory deletion")

    let scheme = core.handle(RequestEnvelope(
        requestId: "f3", sessionId: session.sessionId, deadlineMs: 1_000,
        body: .urlOpen(.init(url: "file:///etc/passwd"))
    ))
    try expect(scheme.error?.code == "file_operation_refused", "the service accepted a file:// URL")

    // An application named for open_file passes through the same resolution a launch uses, so an
    // unresolvable handler fails there rather than reaching Launch Services with a raw string.
    let unknownApp = core.handle(RequestEnvelope(
        requestId: "f4", sessionId: session.sessionId, deadlineMs: 1_000,
        body: .fileOperation(.init(operation: .open, path: "/workspace/report.txt", application: .bundleId("com.example.absent")))
    ))
    try expect(unknownApp.error?.code == "app_not_found", "an unresolvable handler was not refused")

    let encoder = JSONEncoder()
    let decoder = JSONDecoder()
    let requests: [RequestBody] = [
        .fileInspect(.init(path: "/workspace/report.txt")),
        .fileOperation(.init(operation: .duplicate, path: "/workspace/report.txt")),
        .urlOpen(.init(url: "https://example.com", application: .name("Safari"))),
    ]
    for request in requests {
        let decoded = try decoder.decode(RequestBody.self, from: encoder.encode(request))
        try expect(decoded == request, "a file request did not round-trip")
    }
    guard case .fileInfo(let infoReceipt)? = info.body else { throw TestFailure.failed("missing info receipt") }
    let decodedInfo = try decoder.decode(ResponseBody.self, from: encoder.encode(ResponseBody.fileInfo(infoReceipt)))
    try expect(decodedInfo == .fileInfo(infoReceipt), "a file info response did not round-trip")
}

/// A window that accepts writes, ignores them, or clamps them — the three behaviors real toolkits
/// exhibit, and the reason a receipt reads the window back instead of trusting the write.
private final class FakeWindowAccess: WindowElementAccessing, @unchecked Sendable {
    private let lock = NSLock()
    var frame = CuRect(x: 100, y: 100, width: 800, height: 600)
    var minimized = false
    var fullScreen = false
    var exists = true
    /// Applied to every requested size, so a clamping application is reproducible offline.
    var maxSize: CuRect?
    var ignoreWrites = false
    var missingCloseButton = false
    var minimizeSettable = true
    var missingMinimizeButton = false
    var missingFullScreen = false
    private(set) var writes: [String] = []

    func bounds(pid: Int32, windowId: UInt32) throws -> CuRect {
        try lock.withLock {
            guard exists else { throw WindowOperationError.windowNotFound }
            return frame
        }
    }

    func flag(pid: Int32, windowId: UInt32, attribute: String) throws -> Bool {
        try lock.withLock {
            guard exists else { throw WindowOperationError.windowNotFound }
            if attribute == "AXFullScreen" {
                guard !missingFullScreen else { throw WindowOperationError.attributeUnavailable(attribute) }
                return fullScreen
            }
            return minimized
        }
    }

    func setFrame(pid: Int32, windowId: UInt32, frame requested: CuRect, moveOnly: Bool, resizeOnly: Bool) throws {
        lock.withLock {
            writes.append(moveOnly ? "position" : resizeOnly ? "size" : "frame")
            guard !ignoreWrites else { return }
            if !resizeOnly { frame = CuRect(x: requested.x, y: requested.y, width: frame.width, height: frame.height) }
            if !moveOnly {
                let width = maxSize.map { min(requested.width, $0.width) } ?? requested.width
                let height = maxSize.map { min(requested.height, $0.height) } ?? requested.height
                frame = CuRect(x: frame.x, y: frame.y, width: width, height: height)
            }
        }
    }

    func setFlag(pid: Int32, windowId: UInt32, attribute: String, value: Bool) throws {
        try lock.withLock {
            writes.append(attribute)
            if attribute == "AXFullScreen" {
                guard !missingFullScreen else { throw WindowOperationError.attributeUnavailable(attribute) }
                if !ignoreWrites { fullScreen = value }
                return
            }
            guard minimizeSettable else { throw WindowOperationError.attributeUnavailable(attribute) }
            if !ignoreWrites { minimized = value }
        }
    }

    func pressWindowButton(pid: Int32, windowId: UInt32, attribute: String) throws {
        try lock.withLock {
            if attribute == kAXCloseButtonAttribute as String {
                guard !missingCloseButton else {
                    throw WindowOperationError.attributeUnavailable(attribute)
                }
                writes.append("close")
                if !ignoreWrites { exists = false }
                return
            }
            guard !missingMinimizeButton else {
                throw WindowOperationError.attributeUnavailable(attribute)
            }
            writes.append("minimize-button")
            if !ignoreWrites { minimized = true }
        }
    }

    func windowExists(pid: Int32, windowId: UInt32) -> Bool { lock.withLock { exists } }
}

private func testWindowOperationHonesty() throws {
    let window = WindowRef(pid: 42, windowId: 7, generation: 3, title: "Fixture")
    let frontmost: @Sendable () -> Int32? = { 501 }

    // A working toolkit: the receipt reports the applied geometry and honors the request.
    let access = FakeWindowAccess()
    let operations = WindowOperations(access: access, settle: {})
    let moved = try operations.perform(
        .init(operation: .move, window: window, frame: CuRect(x: 10, y: 20, width: 0, height: 0)),
        frontmostPid: frontmost
    )
    try expect(moved.honored && moved.boundsAfter?.x == 10 && moved.boundsAfter?.y == 20,
               "a move was not honored")
    try expect(moved.boundsBefore?.x == 100 && !moved.frontmostChanged,
               "a move lost its before-state or moved the foreground")
    try expect(access.writes == ["position"], "a move also wrote a size")

    // A clamping application: the receipt says what the window became, and honored is false.
    let clamping = FakeWindowAccess()
    clamping.maxSize = CuRect(x: 0, y: 0, width: 400, height: 300)
    let clampedOps = WindowOperations(access: clamping, settle: {})
    let clamped = try clampedOps.perform(
        .init(operation: .resize, window: window, frame: CuRect(x: 0, y: 0, width: 1_200, height: 900)),
        frontmostPid: frontmost
    )
    try expect(!clamped.honored, "a clamped resize claimed to be honored")
    try expect(clamped.boundsAfter?.width == 400 && clamped.boundsAfter?.height == 300,
               "a clamped resize did not report the applied size")

    // The Electron case: the write reports success and changes nothing.
    let lying = FakeWindowAccess()
    lying.ignoreWrites = true
    let lyingOps = WindowOperations(access: lying, settle: {})
    let ignored = try lyingOps.perform(
        .init(operation: .setFrame, window: window, frame: CuRect(x: 5, y: 5, width: 500, height: 400)),
        frontmostPid: frontmost
    )
    try expect(!ignored.honored && ignored.boundsAfter == ignored.boundsBefore,
               "an ignored write was reported as honored")
    try expect(lying.writes.count == 1, "an ignored write was retried")

    // Minimize, unminimize, full screen, close.
    let lifecycle = FakeWindowAccess()
    let lifecycleOps = WindowOperations(access: lifecycle, settle: {})
    let minimized = try lifecycleOps.perform(.init(operation: .minimize, window: window), frontmostPid: frontmost)
    try expect(minimized.honored && minimized.minimizedAfter == true, "minimize was not honored")
    let restored = try lifecycleOps.perform(.init(operation: .unminimize, window: window), frontmostPid: frontmost)
    try expect(restored.honored && restored.minimizedAfter == false, "unminimize was not honored")
    let full = try lifecycleOps.perform(
        .init(operation: .setFullScreen, window: window, fullScreen: true), frontmostPid: frontmost
    )
    try expect(full.honored && full.fullScreenAfter == true, "full screen was not honored")
    let closed = try lifecycleOps.perform(.init(operation: .close, window: window), frontmostPid: frontmost)
    try expect(closed.honored && closed.windowGone, "close did not prove the window is gone")

    // The AppKit case: `AXMinimized` is readable and not settable, but the window has a minimize
    // button. A single-rung minimize would fail on exactly the windows it exists for.
    let unsettable = FakeWindowAccess()
    unsettable.minimizeSettable = false
    let ladderOps = WindowOperations(access: unsettable, settle: {})
    let laddered = try ladderOps.perform(.init(operation: .minimize, window: window), frontmostPid: frontmost)
    try expect(laddered.honored && unsettable.writes.contains("minimize-button"),
               "minimize did not fall through to the window's own button")

    // Unminimize has no second rung: a minimized window's buttons are not pressable.
    let noRestore = FakeWindowAccess()
    noRestore.minimizeSettable = false
    noRestore.minimized = true
    let noRestoreOps = WindowOperations(access: noRestore, settle: {})
    do {
        _ = try noRestoreOps.perform(.init(operation: .unminimize, window: window), frontmostPid: frontmost)
        throw TestFailure.failed("unminimize invented a rung that does not exist")
    } catch let error as WindowOperationError {
        guard case .attributeUnavailable = error else { throw TestFailure.failed("wrong unminimize refusal") }
    }

    // A window that survives a close is not a successful close.
    let stubborn = FakeWindowAccess()
    stubborn.ignoreWrites = true
    let stubbornOps = WindowOperations(access: stubborn, settle: {})
    let survived = try stubbornOps.perform(.init(operation: .close, window: window), frontmostPid: frontmost)
    try expect(!survived.honored && !survived.windowGone, "a surviving window reported a successful close")

    // Unavailable attributes are typed refusals, not silent no-ops.
    let bare = FakeWindowAccess()
    bare.missingCloseButton = true
    bare.missingFullScreen = true
    let bareOps = WindowOperations(access: bare, settle: {})
    for request in [
        WindowOperationRequest(operation: .close, window: window),
        WindowOperationRequest(operation: .setFullScreen, window: window, fullScreen: true),
    ] {
        do {
            _ = try bareOps.perform(request, frontmostPid: frontmost)
            throw TestFailure.failed("\(request.operation.rawValue) accepted a window that cannot do it")
        } catch let error as WindowOperationError {
            guard case .attributeUnavailable = error else {
                throw TestFailure.failed("wrong refusal for \(request.operation.rawValue)")
            }
        }
    }
}

private func testWindowOperationRequestPolicy() throws {
    let window = WindowRef(pid: 42, windowId: 7, generation: 3, title: nil)
    let refused: [WindowOperationRequest] = [
        .init(operation: .move, window: window),
        .init(operation: .setFrame, window: window, frame: CuRect(x: 0, y: 0, width: 0, height: 100)),
        .init(operation: .resize, window: window, frame: CuRect(x: 0, y: 0, width: .infinity, height: 100)),
        .init(operation: .resize, window: window, frame: CuRect(x: 0, y: 0, width: 100_000, height: 100)),
        .init(operation: .minimize, window: window, frame: CuRect(x: 0, y: 0, width: 10, height: 10)),
        .init(operation: .setFullScreen, window: window),
        .init(operation: .close, window: window, fullScreen: true),
        .init(operation: .move, window: WindowRef(pid: 0, windowId: 7, generation: 3, title: nil), frame: CuRect(x: 1, y: 1, width: 1, height: 1)),
    ]
    for request in refused {
        do {
            try WindowOperations.validate(request)
            throw TestFailure.failed("\(request.operation.rawValue) accepted a malformed request")
        } catch let error as WindowOperationError {
            guard case .invalidRequest = error else {
                throw TestFailure.failed("wrong refusal for \(request.operation.rawValue)")
            }
        }
    }

    // A stale window generation is refused before any Accessibility write.
    let access = FakeWindowAccess()
    let core = BimaxCuServiceCore(
        permissions: FixedPermissions(),
        workspace: FixedWorkspace(),
        windowOperations: WindowOperations(access: access, settle: {})
    )
    let created = core.handle(RequestEnvelope(
        requestId: "w0", sessionId: "bootstrap", deadlineMs: 1_000,
        body: .sessionCreate(requestedId: "window-ops")
    ))
    guard case .session(let session)? = created.body else { throw TestFailure.failed("no session") }

    // FixedWorkspace issues pid 42 / window 7 / generation 3.
    let stale = core.handle(RequestEnvelope(
        requestId: "w1", sessionId: session.sessionId, deadlineMs: 1_000,
        body: .windowOperation(.init(
            operation: .minimize, window: WindowRef(pid: 42, windowId: 7, generation: 99, title: nil)
        ))
    ))
    try expect(stale.error?.code == "window_generation_stale", "a stale window generation was accepted")
    try expect(access.writes.isEmpty, "a stale generation still reached Accessibility")

    let missing = core.handle(RequestEnvelope(
        requestId: "w2", sessionId: session.sessionId, deadlineMs: 1_000,
        body: .windowOperation(.init(
            operation: .minimize, window: WindowRef(pid: 42, windowId: 4_242, generation: 3, title: nil)
        ))
    ))
    try expect(missing.error?.code == "window_not_found", "an unknown window was accepted")

    let ok = core.handle(RequestEnvelope(
        requestId: "w3", sessionId: session.sessionId, deadlineMs: 1_000,
        body: .windowOperation(.init(
            operation: .minimize, window: WindowRef(pid: 42, windowId: 7, generation: 3, title: nil)
        ))
    ))
    guard case .windowOperationReceipt(let receipt)? = ok.body else {
        throw TestFailure.failed("a valid window operation produced no receipt")
    }
    try expect(receipt.honored && receipt.minimizedAfter == true, "the service lost the window receipt")

    let encoder = JSONEncoder()
    let decoder = JSONDecoder()
    let request = RequestBody.windowOperation(.init(
        operation: .setFrame, window: WindowRef(pid: 42, windowId: 7, generation: 3, title: "t"),
        frame: CuRect(x: 1, y: 2, width: 3, height: 4)
    ))
    let decodedRequest = try decoder.decode(RequestBody.self, from: encoder.encode(request))
    try expect(decodedRequest == request, "a window request did not round-trip")
    var forged = try JSONSerialization.jsonObject(with: encoder.encode(receipt)) as! [String: Any]
    forged["frontmostChanged"] = true
    let decoded = try decoder.decode(
        WindowOperationReceipt.self, from: JSONSerialization.data(withJSONObject: forged)
    )
    try expect(!decoded.frontmostChanged, "a forged window receipt overrode its own measurements")
}

private func testDisplayUsableBoundsGeometry() throws {
    // Measured on this machine: a 1470x956 display reports visibleFrame (0, 59, 1470, 864) —
    // a 33pt menu bar at the top and a 59pt Dock at the bottom, in AppKit's bottom-left space.
    let primary = WorkspaceInventory.flipToGlobalTopLeft(
        visibleFrame: CGRect(x: 0, y: 59, width: 1_470, height: 864),
        zeroScreenFrame: CGRect(x: 0, y: 0, width: 1_470, height: 956)
    )
    try expect(primary == CuRect(x: 0, y: 33, width: 1_470, height: 864),
               "the primary display's usable area did not convert to top-left global coordinates")

    // A second display above the primary has a negative AppKit origin and must stay above it after
    // conversion, not fold onto it.
    let above = WorkspaceInventory.flipToGlobalTopLeft(
        visibleFrame: CGRect(x: 0, y: 956, width: 1_920, height: 1_080),
        zeroScreenFrame: CGRect(x: 0, y: 0, width: 1_470, height: 956)
    )
    try expect(above == CuRect(x: 0, y: -1_080, width: 1_920, height: 1_080),
               "a display above the primary did not convert")

    // A display below/right keeps its offsets.
    let below = WorkspaceInventory.flipToGlobalTopLeft(
        visibleFrame: CGRect(x: 1_470, y: -1_080, width: 1_920, height: 1_000),
        zeroScreenFrame: CGRect(x: 0, y: 0, width: 1_470, height: 956)
    )
    try expect(below == CuRect(x: 1_470, y: 1_036, width: 1_920, height: 1_000),
               "a display below the primary did not convert")

    // Usable bounds are optional on the wire and must round-trip as absent, never as full bounds.
    let encoder = JSONEncoder()
    let decoder = JSONDecoder()
    let unknown = DisplayInfo(
        displayId: 9, bounds: CuRect(x: 0, y: 0, width: 100, height: 100),
        pixelWidth: 100, pixelHeight: 100, scale: 1, main: false
    )
    let decoded = try decoder.decode(DisplayInfo.self, from: encoder.encode(unknown))
    try expect(decoded.usableBounds == nil, "an unmeasured usable area became a claim")

    let legacy = try decoder.decode(
        WorkspaceSnapshot.self,
        from: Data(#"{"capturedAtMs":1,"apps":[],"windows":[],"displays":[]}"#.utf8)
    )
    try expect(!legacy.displaysHaveSeparateSpaces,
               "a legacy snapshot implied per-display Spaces")
}

private func testControlPatternClassification() throws {
    func patterns(role: String, actions: [String] = [], settable: [String] = [], expandable: Bool = false) -> Set<String> {
        Set(AccessibilityEngine.patterns(role: role, actions: actions, settable: settable, expandable: expandable))
    }
    try expect(patterns(role: "AXButton", actions: ["AXPress"]).contains("invoke"), "invoke was not classified")
    try expect(patterns(role: "AXButton", actions: ["AXShowMenu"]).contains("secondary_action"),
               "secondary AX action was not classified")
    try expect(patterns(role: "AXCheckBox", actions: ["AXPress"]) == ["invoke", "toggle"], "toggle was not classified")
    try expect(patterns(role: "AXSlider", actions: ["AXIncrement", "AXDecrement"]).contains("range_value"),
               "range value was not classified")
    try expect(patterns(role: "AXTextArea", settable: ["AXValue", "AXSelectedTextRange"]) == ["value", "text"],
               "text and value were not classified")
    try expect(!patterns(role: "AXButton", settable: ["AXSelectedTextRange"]).contains("text"),
               "a non-text role claimed the text pattern")
    try expect(patterns(role: "AXScrollArea", actions: ["AXScrollDownByPage"]).contains("scroll"),
               "page scrolling was not classified")
    try expect(patterns(role: "AXRow", actions: ["AXScrollToVisible"]).contains("scroll_to_visible"),
               "scroll-to-visible was not classified")
    try expect(patterns(role: "AXRow", settable: ["AXSelected"]).contains("selection"),
               "explicit selection state was not classified")
    try expect(patterns(role: "AXDisclosureTriangle", expandable: true).contains("expand_collapse"),
               "expand/collapse was not classified")
    try expect(patterns(role: "AXWindow").contains("window"), "the window pattern was not classified")
    try expect(patterns(role: "AXStaticText").isEmpty, "an inert role advertised capabilities")
    try expect(AccessibilityEngine.correctedLabel(
        role: "AXButton", subrole: "AXCloseButton", base: nil, children: []
    ) == "Close", "window-control correction did not supply a bounded semantic label")
    try expect(AccessibilityEngine.correctedLabel(
        role: "AXButton", subrole: "AXCloseButton", base: "Dismiss", children: []
    ) == "Dismiss", "a correction overwrote a measured application label")
    try expect(AccessibilityEngine.preferredLabel(
        title: nil, description: nil, value: nil, titleUIElementText: "Linked Fixture Control",
        identifier: "fixture-linked-button", help: "fixture control"
    ) == "Linked Fixture Control", "a linked accessibility title lost to an implementation identifier")
    try expect(AccessibilityEngine.preferredLabel(
        title: "Direct name", description: nil, value: nil, titleUIElementText: "Linked name",
        identifier: nil, help: nil
    ) == "Direct name", "a linked accessibility title overwrote the target's own title")
    try expect(AccessibilityEngine.preferredLabel(
        title: nil, description: nil, value: nil, titleUIElementText: nil,
        identifier: "fixture-linked-button", help: nil
    ) == "fixture-linked-button", "label enrichment removed the identifier fallback")

    let node = textNode(role: "AXButton")
    guard let ref = node.elementRef else { throw TestFailure.failed("secondary-action ref was missing") }
    try AXSemanticActionEngine.validateRequestShape(
        .init(element: ref, action: .showMenu, expectedEventRevision: 1), expected: node
    )
    do {
        try AXSemanticActionEngine.validateRequestShape(
            .init(element: ref, action: .showMenu, value: .boolean(true), expectedEventRevision: 1),
            expected: node
        )
        throw TestFailure.failed("secondary action accepted a value payload")
    } catch AXSemanticActionError.invalidPayload {
        // Expected: AXShowMenu has no model-controlled payload.
    }
}

private func testSelectionStateAndScrollToVisiblePolicy() throws {
    let row = textNode(role: "AXRow")
    guard let ref = row.elementRef else { throw TestFailure.failed("row ref was missing") }
    try AXSemanticActionEngine.validateRequestShape(
        .init(element: ref, action: .setSelected, value: .boolean(true), expectedEventRevision: 1),
        expected: row
    )
    try AXSemanticActionEngine.validateRequestShape(
        .init(element: ref, action: .scrollToVisible, expectedEventRevision: 1),
        expected: row
    )
    try expectShapeError(
        .init(element: ref, action: .setSelected, value: .string("yes"), expectedEventRevision: 1),
        row, .invalidPayload, "selection state accepted a non-boolean"
    )
    try expectShapeError(
        .init(element: ref, action: .setSelected, expectedEventRevision: 1),
        row, .invalidPayload, "selection state accepted a missing value"
    )
    try expectShapeError(
        .init(element: ref, action: .scrollToVisible, value: .boolean(true), expectedEventRevision: 1),
        row, .invalidPayload, "scroll-to-visible accepted a value"
    )
    try expectShapeError(
        .init(element: ref, action: .setSelected, value: .boolean(true), expectedEventRevision: 1),
        textNode(role: "AXTextField", subrole: "AXSecureTextField"), .sensitiveElement,
        "a secure field accepted selection mutation"
    )
}

/// `AXScroll*ByPage` is advertised by AppKit, SwiftUI, and Electron scroll areas and then returns
/// kAXErrorFailure without moving anything. The scroll-bar `AXValue` path is what actually works,
/// so it is the one the catalog leads with.
private func testScrollToFractionPolicy() throws {
    let area = textNode(role: "AXScrollArea")
    guard let ref = area.elementRef else { throw TestFailure.failed("scroll ref was missing") }
    for fraction in [0.0, 0.5, 1.0] {
        try AXSemanticActionEngine.validateRequestShape(
            .init(element: ref, action: .scrollToFraction,
                  payload: .scrollFraction(.init(axis: .vertical, fraction: fraction)),
                  expectedEventRevision: 1),
            expected: area
        )
    }
    for fraction in [-0.01, 1.01, Double.nan, Double.infinity] {
        try expectShapeError(
            .init(element: ref, action: .scrollToFraction,
                  payload: .scrollFraction(.init(axis: .horizontal, fraction: fraction)),
                  expectedEventRevision: 1),
            area, .invalidPayload, "out-of-range scroll fraction \(fraction) was accepted"
        )
    }
    try expectShapeError(
        .init(element: ref, action: .scrollToFraction,
              payload: .scroll(.init(direction: .down)), expectedEventRevision: 1),
        area, .invalidPayload, "scroll-to-fraction accepted a page payload"
    )
    try expectShapeError(
        .init(element: ref, action: .scrollToFraction, value: .number(0.5),
              payload: .scrollFraction(.init(axis: .vertical, fraction: 0.5)), expectedEventRevision: 1),
        area, .invalidPayload, "scroll-to-fraction accepted a value"
    )
    try expectShapeError(
        .init(element: ref, action: .scrollToFraction,
              payload: .scrollFraction(.init(axis: .vertical, fraction: 0.5)), expectedEventRevision: 1),
        textNode(role: "AXTextField", subrole: "AXSecureTextField"), .sensitiveElement,
        "a secure element accepted scrolling"
    )

    let payload = SemanticActionPayload.scrollFraction(.init(axis: .horizontal, fraction: 0.25))
    let encoded = try JSONEncoder().encode(payload)
    let decoded = try JSONDecoder().decode(SemanticActionPayload.self, from: encoded)
    try expect(decoded == payload, "scroll fraction payload did not round-trip")
    let legacyScroll = try JSONDecoder().decode(
        ScrollReceipt.self, from: Data(#"{"direction":"down"}"#.utf8)
    )
    try expect(legacyScroll.honored == nil && legacyScroll.requestedPercent == nil && legacyScroll.axis == nil,
               "a pre-fraction scroll receipt invented an applied-vs-requested verdict")
}

private func testWindowIntersectionClipping() throws {
    let window = CuRect(x: 10, y: 10, width: 100, height: 80)
    let partial = AccessibilityEngine.intersection(
        CuRect(x: 80, y: 50, width: 80, height: 80),
        window
    )
    try expect(partial == CuRect(x: 80, y: 50, width: 30, height: 40), "partially visible element was not clipped")
    try expect(AccessibilityEngine.intersection(CuRect(x: 200, y: 200, width: 10, height: 10), window) == nil,
               "off-window element survived clipping")
}

private func testProtocolFailClosed() throws {
    let core = BimaxCuServiceCore(permissions: FixedPermissions())
    var incompatible = request("bad", body: .sessionCreate(requestedId: "task-a"))
    incompatible.protocol = "bimax.cu.v2"
    let response = core.handle(incompatible)
    try expect(response.error?.code == "incompatible_protocol", "incompatible protocol was not rejected")
    try expect(core.sessions.count == 0, "incompatible request mutated session state")
}

private func testSessionIsolation() throws {
    let core = BimaxCuServiceCore(permissions: FixedPermissions())
    let alpha = core.handle(request("a", body: .sessionCreate(requestedId: "task-alpha")))
    let beta = core.handle(request("b", body: .sessionCreate(requestedId: "task-beta")))
    guard case .session(let alphaInfo) = alpha.body,
          case .session(let betaInfo) = beta.body else {
        throw TestFailure.failed("sessions were not created")
    }
    let reset = core.handle(request("r", session: alphaInfo.sessionId, body: .sessionReset(reason: "test")))
    guard case .session(let resetInfo) = reset.body else { throw TestFailure.failed("alpha did not reset") }
    try expect(resetInfo.generation != alphaInfo.generation, "reset did not invalidate alpha generation")

    let betaStatus = core.handle(request("s", session: betaInfo.sessionId, body: .sessionStatus))
    guard case .session(let currentBeta) = betaStatus.body else { throw TestFailure.failed("beta disappeared") }
    try expect(currentBeta.generation == betaInfo.generation, "alpha reset contaminated beta")
}

private func testMalformedWireError() throws {
    let core = BimaxCuServiceCore(permissions: FixedPermissions())
    let data = core.handle(data: Data("not-json".utf8))
    let response = try JSONDecoder().decode(ResponseEnvelope.self, from: data)
    try expect(response.error?.code == "malformed_request", "malformed request lacked typed error")
}

private func testDevelopmentIdentityPolicy() throws {
    let validator = CodeSigningXPCClientValidator(
        requirement: "identifier \"ai.bimax.app\" and anchor apple generic",
        allowUnsignedDevelopment: true,
        expectedUserIdentifier: 501
    )
    try expect(
        validator.validate(processIdentifier: 123, effectiveUserIdentifier: 501).accepted,
        "explicit same-user development client was rejected"
    )
    let foreign = validator.validate(processIdentifier: 123, effectiveUserIdentifier: 502)
    try expect(!foreign.accepted && foreign.reason == "uid_mismatch", "foreign uid was accepted")
    try expect(!validator.validate(processIdentifier: 0, effectiveUserIdentifier: 501).accepted, "invalid pid was accepted")

    let ownExecutable = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.path
    let ownRequirement = try CodeSigningXPCClientValidator.designatedRequirement(
        forExecutableAt: ownExecutable
    )
    let strictSelfValidator = CodeSigningXPCClientValidator(
        requirement: ownRequirement,
        expectedUserIdentifier: geteuid()
    )
    try expect(
        strictSelfValidator.validate(
            processIdentifier: getpid(), effectiveUserIdentifier: geteuid()
        ).accepted,
        "the Security.framework validator rejected the exact designated requirement of its peer"
    )
    let wrongRequirement = CodeSigningXPCClientValidator(
        requirement: "identifier \"ai.bimax.not-the-test-client\"",
        expectedUserIdentifier: geteuid()
    )
    try expect(
        !wrongRequirement.validate(
            processIdentifier: getpid(), effectiveUserIdentifier: geteuid()
        ).accepted,
        "the Security.framework validator accepted a peer with a mismatched requirement"
    )
    try expect(
        bimaxParentProcessIdentifier(getpid()) == getppid(),
        "the native ancestry lookup did not return the kernel-reported parent"
    )

    let parents: [pid_t: pid_t] = [40: 30, 30: 20, 20: 1]
    let ancestry = BimaxSignedAncestorAuthorizer(
        validator: SelectiveTestClient(acceptedPids: [30]),
        parentLookup: { parents[$0] }
    )
    try expect(
        ancestry.authorize(parentPID: 40, userIdentifier: 501).accepted,
        "a signed Bimax ancestor was not found through the engine process"
    )
    let refused = BimaxSignedAncestorAuthorizer(
        validator: SelectiveTestClient(acceptedPids: [99]),
        parentLookup: { parents[$0] }
    ).authorize(parentPID: 40, userIdentifier: 501)
    try expect(!refused.accepted && refused.reason == "signed_bimax_ancestor_required",
               "an unrelated process tree was authorized for the XPC bridge")
    let cycle = BimaxSignedAncestorAuthorizer(
        validator: SelectiveTestClient(acceptedPids: []),
        parentLookup: { $0 == 40 ? 30 : 40 }
    ).authorize(parentPID: 40, userIdentifier: 501)
    try expect(!cycle.accepted, "a cyclic process tree bypassed ancestry validation")
}

private func testConnectionLifecycleDiagnostics() throws {
    let lifecycle = XPCConnectionLifecycle()
    lifecycle.didAccept()
    lifecycle.didAccept()
    lifecycle.didReject()
    lifecycle.didInterrupt()
    lifecycle.didInvalidate()
    let state = lifecycle.snapshot()
    try expect(state.active == 1, "active connection count was wrong")
    try expect(state.accepted == 2 && state.rejected == 1, "accept/reject diagnostics were wrong")
    try expect(state.interrupted == 1 && state.invalidated == 1, "lifecycle diagnostics were wrong")
}

private func snapshotNode(
    snapshotId: String,
    revision: UInt64,
    hash: String,
    token: String,
    label: String,
    order: Int
) -> AXNode {
    AXNode(
        token: token,
        parentToken: nil,
        role: "AXButton",
        subrole: nil,
        label: label,
        value: nil,
        identifier: hash,
        bounds: CuRect(x: Double(order * 10), y: 0, width: 8, height: 8),
        enabled: true,
        focused: false,
        actions: ["AXPress"],
        childCount: 0,
        stablePathHash: hash,
        elementRef: ElementRef(
            token: token,
            snapshotId: snapshotId,
            pid: 42,
            windowId: 7,
            windowGeneration: 3,
            axRevision: revision,
            stablePathHash: hash
        ),
        order: order
    )
}

private func retainedSnapshot(session: String, id: String, revision: UInt64, specs: [(String, String)]) -> AXSnapshot {
    let nodes = specs.enumerated().map { index, spec in
        snapshotNode(snapshotId: id, revision: revision, hash: spec.0, token: "\(id)-\(spec.0)", label: spec.1, order: index)
    }
    return AXSnapshot(
        snapshotId: id,
        sessionId: session,
        pid: 42,
        windowId: 7,
        windowGeneration: 3,
        revision: revision,
        capturedAtMs: Int64(revision * 1_000),
        profile: "flash",
        nodes: nodes,
        visitedCount: nodes.count,
        truncated: false
    )
}

private func semanticNodes(_ nodes: [AXNode]) -> [String] {
    nodes.map { "\($0.stablePathHash)|\($0.label ?? "")|\($0.order)" }
}

private func testRetainedSnapshotDiffReplayAndEviction() throws {
    let store = AXSnapshotStore(maxSnapshotsPerSession: 2, maxDiffOperations: 20)
    let first = retainedSnapshot(session: "alpha", id: "s1", revision: 1, specs: [("save", "Save"), ("cancel", "Cancel")])
    let second = retainedSnapshot(session: "alpha", id: "s2", revision: 2, specs: [("save", "Save As"), ("open", "Open")])
    _ = try store.retain(full: first, since: nil)
    let diff = try store.retain(full: second, since: first.snapshotId)
    try expect(diff.nodes.isEmpty && diff.baseSnapshotId == "s1", "store returned a full snapshot instead of a bounded diff")
    guard let operations = diff.diff else { throw TestFailure.failed("diff operations were omitted") }
    let replayed = try AXSnapshotStore.replay(base: first.nodes, operations: operations)
    try expect(semanticNodes(replayed) == semanticNodes(second.nodes), "diff replay did not equal the canonical full snapshot")

    if let ref = first.nodes.first?.elementRef {
        let resolved = try store.resolveElement(sessionId: "alpha", ref: ref)
        try expect(resolved.label == "Save", "retained element ref did not resolve")
    } else { throw TestFailure.failed("test element ref was missing") }

    let third = retainedSnapshot(session: "alpha", id: "s3", revision: 3, specs: [("save", "Save As")])
    _ = try store.retain(full: third, since: second.snapshotId)
    if let expiredRef = first.nodes.first?.elementRef {
        do {
            _ = try store.resolveElement(sessionId: "alpha", ref: expiredRef)
            throw TestFailure.failed("evicted element ref still resolved")
        } catch let error as AXSnapshotStoreError {
            try expect(error == .staleElementRef, "evicted ref returned the wrong error")
        }
    }
    do {
        _ = try store.retain(full: retainedSnapshot(session: "alpha", id: "s4", revision: 4, specs: [("save", "Saved")]), since: first.snapshotId)
        throw TestFailure.failed("evicted base snapshot still produced a diff")
    } catch let error as AXSnapshotStoreError {
        try expect(error == .baseSnapshotNotFound, "evicted base returned the wrong error")
    }
}

private func testSnapshotSessionIsolationAndMalformedDiff() throws {
    let store = AXSnapshotStore(maxSnapshotsPerSession: 3)
    let alpha = retainedSnapshot(session: "alpha", id: "a1", revision: 1, specs: [("save", "Save")])
    let beta = retainedSnapshot(session: "beta", id: "b1", revision: 1, specs: [("save", "Save")])
    _ = try store.retain(full: alpha, since: nil)
    _ = try store.retain(full: beta, since: nil)
    if let betaRef = beta.nodes.first?.elementRef {
        do {
            _ = try store.resolveElement(sessionId: "alpha", ref: betaRef)
            throw TestFailure.failed("cross-session element ref resolved")
        } catch let error as AXSnapshotStoreError {
            try expect(error == .staleElementRef, "cross-session ref returned the wrong error")
        }
    }
    store.reset(sessionId: "alpha")
    try expect(store.retainedCount(sessionId: "alpha") == 0, "alpha snapshot survived reset")
    try expect(store.retainedCount(sessionId: "beta") == 1, "alpha reset contaminated beta")
    do {
        _ = try AXSnapshotStore.replay(base: beta.nodes, operations: [.remove(stablePathHash: "save", token: "forged")])
        throw TestFailure.failed("forged remove operation replayed")
    } catch let error as AXSnapshotStoreError {
        try expect(error == .malformedDiff, "forged remove returned the wrong error")
    }
    do {
        _ = try AXSnapshotStore.replay(base: beta.nodes + beta.nodes, operations: [])
        throw TestFailure.failed("duplicate stable paths replayed")
    } catch let error as AXSnapshotStoreError {
        try expect(error == .malformedDiff, "duplicate paths returned the wrong error")
    }

    let fullFallbackStore = AXSnapshotStore(maxDiffOperations: 0)
    _ = try fullFallbackStore.retain(full: alpha, since: nil)
    let alpha2 = retainedSnapshot(session: "alpha", id: "a2", revision: 2, specs: [("save", "Save As")])
    let fallback = try fullFallbackStore.retain(full: alpha2, since: alpha.snapshotId)
    try expect(fallback.baseSnapshotId == nil && fallback.diff == nil && fallback.nodes.count == 1, "oversized diff did not fall back to a full snapshot")

    let mismatchStore = AXSnapshotStore()
    _ = try mismatchStore.retain(full: alpha, since: nil)
    var wrongTarget = retainedSnapshot(session: "alpha", id: "wrong-window", revision: 2, specs: [("save", "Save")])
    wrongTarget.windowId = 8
    wrongTarget.nodes[0].elementRef?.windowId = 8
    do {
        _ = try mismatchStore.retain(full: wrongTarget, since: alpha.snapshotId)
        throw TestFailure.failed("cross-target base produced a diff")
    } catch let error as AXSnapshotStoreError {
        try expect(error == .baseSnapshotTargetMismatch, "cross-target base returned the wrong error")
    }
    try expect(mismatchStore.retainedCount(sessionId: "alpha") == 1, "rejected target mismatch mutated retention")
}

private struct FixedHumanActivity: HumanInputActivityReporting {
    var seconds: Double?
    func secondsSinceLastInput() -> Double? { seconds }
}

private func testPhysicalInputArbiter() throws {
    func arbiter(
        mechanisms: Set<PhysicalInputMechanism> = Set(PhysicalInputMechanism.allCases),
        idleSeconds: Double? = 30,
        frontmost: Int32? = 42,
        focusedWindow: Bool? = true
    ) -> PhysicalInputArbiter {
        PhysicalInputArbiter(
            implementedMechanisms: mechanisms,
            humanActivity: FixedHumanActivity(seconds: idleSeconds),
            frontmost: { frontmost },
            clock: { 1_000 },
            focusedWindowProbe: { _ in focusedWindow }
        )
    }
    func decide(
        _ value: PhysicalInputArbiter,
        _ mechanism: PhysicalInputMechanism = .targetedProcess,
        policy: SemanticDeliveryPolicy = .foregroundOnce,
        lease: Bool = true
    ) -> PhysicalInputDecision {
        value.decide(
            mechanism: mechanism, policy: policy, targetPid: 42, targetWindowId: 7,
            holdsFocusLease: lease
        )
    }

    // What ships: the global stream only, behind recipient/focus/quiet-period gates. The targeted
    // form is not advertised after a live macOS run acknowledged the post without changing state.
    let shipped = PhysicalInputArbiter()
    try expect(!shipped.implemented(.targetedProcess), "the shipped build re-advertised unverified targeted input")
    try expect(shipped.implemented(.globalStream), "the shipped build omitted foreground physical input")
    try expect(decide(shipped, .targetedProcess).refusals.contains(.notImplemented),
               "the shipped arbiter did not refuse targeted-process posting")

    // A background policy never posts input, whatever the mechanism.
    for policy in SemanticDeliveryPolicy.allCases where policy.isBackground {
        for mechanism in PhysicalInputMechanism.allCases {
            let decision = decide(arbiter(), mechanism, policy: policy)
            try expect(decision.refusals.contains(.policyForbids) && !decision.allowed,
                       "\(policy.rawValue) was allowed to post \(mechanism.rawValue) input")
        }
    }

    // The gates that exist because the global stream infers its recipient apply only to it.
    // Requiring them of a targeted post would guard a race it does not have, and would make Bimax
    // steal a foreground it does not need.
    let background = arbiter(idleSeconds: 0, frontmost: 999)
    try expect(decide(background, .targetedProcess, lease: false).allowed,
               "targeted input was refused for conditions only the global stream is subject to")
    let globalDecision = decide(background, .globalStream, lease: false)
    try expect(globalDecision.refusals.contains(.focusLeaseRequired)
        && globalDecision.refusals.contains(.recipientNotFrontmost)
        && globalDecision.refusals.contains(.humanActive),
        "global-stream posting skipped the gates that make its recipient provable")

    // The recipient observation is recorded either way, so a targeted allow is still auditable.
    try expect(decide(background, .targetedProcess, lease: false).proof.frontmostPid == 999,
               "a targeted decision did not record what it observed")

    // Typed text lands in whatever the process has focused, so this gate applies to both.
    for mechanism in PhysicalInputMechanism.allCases {
        try expect(decide(arbiter(focusedWindow: false), mechanism).refusals.contains(.recipientHasNoFocusedWindow),
                   "\(mechanism.rawValue) input was allowed at an application with no focused window")
        try expect(!decide(arbiter(focusedWindow: nil), mechanism).refusals.contains(.recipientHasNoFocusedWindow),
                   "an unreadable focused window was invented into a refusal")
    }

    // The human wins on the shared input device. An unreadable idle time counts as active.
    try expect(decide(arbiter(idleSeconds: 0.2), .globalStream).refusals.contains(.humanActive),
               "global-stream input was allowed while the human was typing")
    try expect(decide(arbiter(idleSeconds: nil), .globalStream).refusals.contains(.humanActive),
               "an unreadable idle time was treated as an idle machine")
    try expect(decide(arbiter(idleSeconds: nil), .globalStream).secondsSinceHumanInput == nil,
               "an unreadable idle time was reported as a number")

    // Every condition is reported, not just the first, so one round-trip names all the work.
    let allBad = decide(
        arbiter(mechanisms: [], idleSeconds: 0, frontmost: 999, focusedWindow: false),
        .globalStream, policy: .backgroundOnly, lease: false
    )
    try expect(Set(allBad.refusals) == Set(PhysicalInputRefusal.allCases),
               "the arbiter short-circuited instead of reporting every refusal: \(allBad.refusals)")
}

private func testDeliveryLadder() throws {
    func rung(
        _ path: DeliveryPath,
        _ primitive: String,
        _ attempt: @escaping () throws -> AXActionExecution?
    ) -> AXDeliveryLadder.Rung {
        AXDeliveryLadder.Rung(path: path, primitive: primitive, attempt: attempt)
    }
    let delivered = AXActionExecution(primitive: "AXPress")

    // The first rung that delivers wins, and the walk is recorded up to and including it.
    let first = try AXDeliveryLadder.walk([
        rung(.axAttribute, "AXSetAttribute:AXSelected") { AXActionExecution(primitive: "AXSetAttribute:AXSelected") },
        rung(.axAction, "AXPress") { throw TestFailure.failed("a later rung ran after delivery") },
    ])
    try expect(first.deliveryPath == .axAttribute, "the delivering rung was misreported")
    try expect(first.attemptedPaths.count == 1 && first.attemptedPaths[0].outcome == .performed,
               "the delivering rung was not recorded")

    // An unavailable rung is skipped and recorded — this is the evidence that would have caught
    // press-only `expand` against a combo box before it shipped.
    let fellThrough = try AXDeliveryLadder.walk([
        rung(.axAttribute, "AXSetAttribute:AXExpanded") { nil },
        rung(.axAction, "AXPress") { delivered },
    ])
    try expect(fellThrough.deliveryPath == .axAction, "the ladder did not fall through to the next rung")
    try expect(fellThrough.attemptedPaths.map(\.outcome) == [.unavailable, .performed],
               "an unavailable rung was not recorded as attempted")

    // A refused rung does not stop the ladder: one toolkit's refusal must not mask a rung that works.
    let afterRefusal = try AXDeliveryLadder.walk([
        rung(.axAttribute, "AXSetAttribute:AXSelected") { throw AXSemanticActionError.executionFailed(AXError.failure) },
        rung(.axAction, "AXPress") { delivered },
    ])
    try expect(afterRefusal.deliveryPath == .axAction, "the ladder stopped at a refused rung")
    try expect(afterRefusal.attemptedPaths.map(\.outcome) == [.refused, .performed], "a refusal was not recorded")
    try expect(afterRefusal.attemptedPaths[0].axError == AXError.failure.rawValue,
               "a refusal lost the native error code")

    // Every rung unavailable means the element genuinely does not offer the action.
    do {
        _ = try AXDeliveryLadder.walk([
            rung(.axAttribute, "AXSetAttribute:AXExpanded") { nil },
            rung(.axAction, "AXPress") { nil },
        ])
        throw TestFailure.failed("an entirely unavailable ladder reported success")
    } catch let error as AXSemanticActionError {
        try expect(error == .actionUnsupported, "an unavailable ladder reported the wrong cause")
    }

    // Offered and refused everywhere reports the application's refusal, not "unsupported".
    do {
        _ = try AXDeliveryLadder.walk([
            rung(.axAttribute, "AXSetAttribute:AXSelected") { throw AXSemanticActionError.executionFailed(AXError.failure) },
            rung(.axAction, "AXPress") { throw AXSemanticActionError.executionFailed(AXError.cannotComplete) },
        ])
        throw TestFailure.failed("a fully refused ladder reported success")
    } catch let error as AXSemanticActionError {
        try expect(error == .executionFailed(AXError.cannotComplete),
                   "a fully refused ladder did not report the last refusal")
    }

    // An already-satisfied rung is a delivery, not a skip.
    let satisfied = try AXDeliveryLadder.walk([
        rung(.axAttribute, "AXSetAttribute:AXExpanded") {
            AXActionExecution(primitive: "AXExpanded:true", outcome: .alreadySatisfied)
        },
    ])
    try expect(satisfied.outcome == .alreadySatisfied
        && satisfied.attemptedPaths.map(\.outcome) == [.alreadySatisfied],
        "an already-satisfied rung was not recorded as delivering")

    let empty = try? AXDeliveryLadder.walk([])
    try expect(empty == nil, "an empty ladder reported success")
}

private func testDeliveryPolicyWireRoundTrips() throws {
    let encoder = JSONEncoder()
    let decoder = JSONDecoder()
    let ref = ElementRef(
        token: "token", snapshotId: "snap", pid: 42, windowId: 7, windowGeneration: 3,
        axRevision: 4, stablePathHash: "hash"
    )

    for policy in SemanticDeliveryPolicy.allCases {
        let approval = policy.requiresApproval
            ? ForegroundApproval(
                approvalId: "a-1", policy: policy, targetPid: 42, targetWindowId: 7,
                grantedAtMs: 1_000, expiresAtMs: 2_000
            )
            : nil
        let action = SemanticActionRequest(
            element: ref, action: .invoke, expectedEventRevision: 4, deliveryPolicy: policy,
            approval: approval,
            focusLease: policy.requiresApproval ? FocusLeaseOptions(restorePolicy: .always, ttlMs: 3_000) : nil
        )
        let decoded = try decoder.decode(RequestBody.self, from: encoder.encode(RequestBody.semanticAction(action)))
        try expect(decoded == .semanticAction(action), "\(policy.rawValue) action did not round-trip")
    }

    let leaseReceipt = FocusLeaseReceipt(
        leaseId: "lease-1", targetPid: 42, targetWindowId: 7, previousFrontmostPid: 100,
        previousFrontmostBundleId: "com.example.previous", restorePolicy: .ifUnchanged,
        acquiredAtMs: 1_000, releasedAtMs: 1_400, expiresAtMs: 6_000,
        targetBecameFrontmost: true, frontmostPidAfterAcquire: 42, frontmostPidAtRelease: 100,
        restoreOutcome: .restored, expired: false
    )
    let receipt = SemanticActionReceipt(
        actionId: "action-1", element: ref, action: .invoke, primitive: "AXPress",
        outcome: .performed, deliveryPolicy: .foregroundOnce, startedAtMs: 1, completedAtMs: 2,
        eventRevisionBefore: 4, eventRevisionAfter: 5, frontmostPidBefore: 100, frontmostPidAfter: 100,
        focusLease: leaseReceipt
    )
    let decodedReceipt = try decoder.decode(ResponseBody.self, from: encoder.encode(ResponseBody.semanticActionReceipt(receipt)))
    try expect(decodedReceipt == .semanticActionReceipt(receipt), "a lease receipt did not round-trip")

    let proposal = EscalationProposal(
        proposalId: "proposal-1", element: ref, action: .selectTextRange,
        requestedPolicy: .backgroundPreferred, blockedBy: "ax_selection_not_settable",
        message: "background delivery was refused", recommendedPolicy: .foregroundOnce,
        recommendedRung: 6
    )
    let decodedProposal = try decoder.decode(ResponseBody.self, from: encoder.encode(ResponseBody.escalationProposal(proposal)))
    try expect(decodedProposal == .escalationProposal(proposal), "an escalation proposal did not round-trip")

    // A request from a client predating this slice carries no approval and no lease options, and
    // must still decode as the background policy it was written against.
    let legacy = try decoder.decode(SemanticActionRequest.self, from: Data(#"""
    {"element":{"token":"token","snapshotId":"snap","pid":42,"windowId":7,"windowGeneration":3,
     "axRevision":4,"stablePathHash":"hash"},"action":"invoke",
     "expectedEventRevision":4,"deliveryPolicy":"background_native"}
    """#.utf8))
    try expect(legacy.deliveryPolicy == .backgroundNative && legacy.approval == nil && legacy.focusLease == nil,
               "a pre-slice request did not decode as an unapproved background action")

    // A receipt from a service predating this slice reports no lease, which reads as "no focus
    // change was taken" rather than "focus changes are not reported".
    let legacyReceipt = try decoder.decode(SemanticActionReceipt.self, from: Data(#"""
    {"actionId":"a","element":{"token":"token","snapshotId":"snap","pid":42,"windowId":7,
     "windowGeneration":3,"axRevision":4,"stablePathHash":"hash"},"action":"invoke",
     "primitive":"AXPress","outcome":"performed","deliveryPolicy":"background_native",
     "startedAtMs":1,"completedAtMs":2,"eventRevisionBefore":4,"eventRevisionAfter":5}
    """#.utf8))
    try expect(legacyReceipt.focusLease == nil, "a pre-slice receipt invented a focus lease")

    for policy in SemanticDeliveryPolicy.allCases {
        try expect(policy.isBackground != policy.requiresApproval,
                   "\(policy.rawValue) is both background and approval-bound")
        try expect(!policy.isBackground || policy.restorePolicy == .ifUnchanged,
                   "a background policy declared a restore behavior")
    }
    try expect(SemanticDeliveryPolicy.foregroundPersistent.restorePolicy == .never
        && SemanticDeliveryPolicy.foregroundOnce.restorePolicy == .ifUnchanged,
        "foreground policies mapped to the wrong restore behavior")
}

private func testFocusLeaseRestoreSemantics() throws {
    // A background policy must be structurally incapable of taking a lease, not merely discouraged.
    for policy in SemanticDeliveryPolicy.allCases where policy.isBackground {
        let manager = makeLeaseManager(FakeFocusController(frontmost: 100))
        do {
            _ = try manager.acquire(
                sessionId: "s", policy: policy, targetPid: 42, targetWindowId: 7,
                options: FocusLeaseOptions()
            )
            throw TestFailure.failed("\(policy.rawValue) acquired a focus lease")
        } catch let error as FocusLeaseError {
            try expect(error == .policyForbidsLease(policy), "\(policy.rawValue) failed with the wrong lease error")
        }
    }

    // A lease over the current foreground app must not generate another activation. Besides being
    // unnecessary, that transition can reset the OS input-idle clock and make the subsequent
    // physical-input safety decision refuse activity Bimax generated itself.
    let currentFocus = FakeFocusController(frontmost: 42)
    let currentManager = makeLeaseManager(currentFocus)
    let currentLease = try currentManager.acquire(
        sessionId: "current", policy: .foregroundOnce, targetPid: 42, targetWindowId: 7,
        options: FocusLeaseOptions()
    )
    try expect(currentFocus.activations.isEmpty && !currentLease.targetBecameFrontmost,
               "an already-frontmost target was activated again")
    let currentReceipt = try currentManager.release(leaseId: currentLease.leaseId)
    try expect(currentReceipt.restoreOutcome == .nothingToRestore,
               "an already-frontmost lease invented a displaced application")

    // foreground_once: take the front, then hand it back.
    let onceFocus = FakeFocusController(frontmost: 100)
    let onceManager = makeLeaseManager(onceFocus)
    let onceLease = try onceManager.acquire(
        sessionId: "once", policy: .foregroundOnce, targetPid: 42, targetWindowId: 7,
        options: FocusLeaseOptions()
    )
    try expect(onceLease.targetBecameFrontmost && onceLease.previousFrontmostPid == 100,
               "foreground_once lease did not record the focus it displaced")
    try expect(onceLease.restorePolicy == .ifUnchanged, "foreground_once defaulted to the wrong restore policy")
    try expect(onceManager.heldLease(sessionId: "once")?.leaseId == onceLease.leaseId, "held lease was not tracked")
    let onceReceipt = try onceManager.release(leaseId: onceLease.leaseId)
    try expect(onceReceipt.restoreOutcome == .restored, "foreground_once did not restore: \(onceReceipt.restoreOutcome)")
    try expect(onceFocus.currentFrontmost == 100, "foreground_once left the target in front")
    try expect(!onceReceipt.expired, "a lease inside its deadline was reported expired")
    try expect(onceManager.heldLease(sessionId: "once") == nil, "released lease stayed held")

    // One lease per session: a second acquire would lose the first lease's restore target.
    let doubleFocus = FakeFocusController(frontmost: 100)
    let doubleManager = makeLeaseManager(doubleFocus)
    _ = try doubleManager.acquire(
        sessionId: "double", policy: .foregroundOnce, targetPid: 42, targetWindowId: 7,
        options: FocusLeaseOptions()
    )
    do {
        _ = try doubleManager.acquire(
            sessionId: "double", policy: .foregroundOnce, targetPid: 43, targetWindowId: 8,
            options: FocusLeaseOptions()
        )
        throw TestFailure.failed("a session held two focus leases at once")
    } catch let error as FocusLeaseError {
        try expect(error == .leaseAlreadyHeld, "double acquire failed with the wrong error")
    }

    // The human moves focus during the lease. Their choice wins.
    let humanFocus = FakeFocusController(frontmost: 100)
    let humanManager = makeLeaseManager(humanFocus)
    let humanLease = try humanManager.acquire(
        sessionId: "human", policy: .foregroundOnce, targetPid: 42, targetWindowId: 7,
        options: FocusLeaseOptions()
    )
    humanFocus.set(frontmost: 999)
    let humanReceipt = try humanManager.release(leaseId: humanLease.leaseId)
    try expect(humanReceipt.restoreOutcome == .humanOverride, "a human focus change was overridden by restore")
    try expect(humanFocus.currentFrontmost == 999, "restore stole focus back from the human")
    try expect(!humanFocus.activations.contains(100), "restore activated the previous app despite a human override")

    // `always` is the opposite contract and must still be honored when asked for explicitly.
    let alwaysFocus = FakeFocusController(frontmost: 100)
    let alwaysManager = makeLeaseManager(alwaysFocus)
    let alwaysLease = try alwaysManager.acquire(
        sessionId: "always", policy: .foregroundOnce, targetPid: 42, targetWindowId: 7,
        options: FocusLeaseOptions(restorePolicy: .always)
    )
    alwaysFocus.set(frontmost: 999)
    let alwaysReceipt = try alwaysManager.release(leaseId: alwaysLease.leaseId)
    try expect(alwaysReceipt.restoreOutcome == .restored && alwaysFocus.currentFrontmost == 100,
               "an explicit always-restore lease did not restore")

    // Activation accepted, focus never moved. The lease must say so and must not then "restore".
    let ignoredFocus = FakeFocusController(frontmost: 100)
    ignoredFocus.acceptButIgnore(42)
    let ignoredManager = makeLeaseManager(ignoredFocus)
    let ignoredLease = try ignoredManager.acquire(
        sessionId: "ignored", policy: .foregroundOnce, targetPid: 42, targetWindowId: 7,
        options: FocusLeaseOptions(ttlMs: 5_000, activationTimeoutMs: 0)
    )
    try expect(!ignoredLease.targetBecameFrontmost, "an ignored activation was reported as frontmost")
    let ignoredReceipt = try ignoredManager.release(leaseId: ignoredLease.leaseId)
    try expect(ignoredReceipt.restoreOutcome == .nothingToRestore,
               "a lease that never took the front claimed \(ignoredReceipt.restoreOutcome)")
    try expect(ignoredFocus.currentFrontmost == 100, "a failed lease still moved focus")

    // A refused activation is reported, not retried into a claim of success.
    let refusedFocus = FakeFocusController(frontmost: 100)
    refusedFocus.refuse(42)
    let refusedManager = makeLeaseManager(refusedFocus)
    let refusedLease = try refusedManager.acquire(
        sessionId: "refused", policy: .foregroundOnce, targetPid: 42, targetWindowId: 7,
        options: FocusLeaseOptions()
    )
    try expect(!refusedLease.targetBecameFrontmost, "a refused activation was reported as frontmost")

    // foreground_persistent deliberately keeps the target in front.
    let keepFocus = FakeFocusController(frontmost: 100)
    let keepManager = makeLeaseManager(keepFocus)
    let keepLease = try keepManager.acquire(
        sessionId: "keep", policy: .foregroundPersistent, targetPid: 42, targetWindowId: 7,
        options: FocusLeaseOptions()
    )
    try expect(keepLease.restorePolicy == .never, "foreground_persistent took a restoring lease")
    let keepReceipt = try keepManager.release(leaseId: keepLease.leaseId)
    try expect(keepReceipt.restoreOutcome == .retained && keepFocus.currentFrontmost == 42,
               "foreground_persistent did not keep the target in front")

    // An expired lease still restores; expiry is recorded, not used as an excuse to hold focus.
    let expiryClock = TestClock()
    let expiryFocus = FakeFocusController(frontmost: 100)
    let expiryManager = makeLeaseManager(expiryFocus, clock: expiryClock)
    let expiryLease = try expiryManager.acquire(
        sessionId: "expiry", policy: .foregroundOnce, targetPid: 42, targetWindowId: 7,
        options: FocusLeaseOptions(ttlMs: 1_000)
    )
    expiryClock.advance(5_000)
    let expiryReceipt = try expiryManager.release(leaseId: expiryLease.leaseId)
    try expect(expiryReceipt.expired, "an overdue lease was not marked expired")
    try expect(expiryReceipt.restoreOutcome == .restored && expiryFocus.currentFrontmost == 100,
               "an expired lease kept the focus it took")

    // Cancellation path: whatever a session still holds is handed back.
    let cancelFocus = FakeFocusController(frontmost: 100)
    let cancelManager = makeLeaseManager(cancelFocus)
    _ = try cancelManager.acquire(
        sessionId: "cancel", policy: .foregroundOnce, targetPid: 42, targetWindowId: 7,
        options: FocusLeaseOptions()
    )
    let swept = cancelManager.releaseAll(sessionId: "cancel")
    try expect(swept.count == 1 && swept[0].restoreOutcome == .restored, "releaseAll did not restore a held lease")
    try expect(cancelFocus.currentFrontmost == 100, "cancellation left focus on the target")
    try expect(cancelManager.releaseAll(sessionId: "cancel").isEmpty, "releaseAll re-released a lease")

    // A lease that was never held cannot be released into a receipt.
    do {
        _ = try cancelManager.release(leaseId: "no-such-lease")
        throw TestFailure.failed("an unknown lease id produced a receipt")
    } catch let error as FocusLeaseError {
        try expect(error == .leaseNotFound, "unknown lease id failed with the wrong error")
    }

    // Unbounded lease windows are refused: a lease nobody bounds is a focus change nobody watches.
    let boundsManager = makeLeaseManager(FakeFocusController(frontmost: 100))
    for options in [FocusLeaseOptions(ttlMs: 0), FocusLeaseOptions(ttlMs: 120_000),
                    FocusLeaseOptions(ttlMs: 1_000, activationTimeoutMs: 60_000)] {
        do {
            _ = try boundsManager.acquire(
                sessionId: "bounds", policy: .foregroundOnce, targetPid: 42, targetWindowId: 7,
                options: options
            )
            throw TestFailure.failed("an out-of-range lease window was accepted")
        } catch let error as FocusLeaseError {
            try expect(error == .invalidLeaseWindow, "out-of-range lease window failed with the wrong error")
        }
    }
}

private func testDesktopFocusBrokerContract() throws {
    let local = FakeFocusController(frontmost: 100)
    let accepted = FakeActivationBroker(accepted: true)
    let controller = BrokeredFocusController(
        local: local, broker: accepted,
        bundleIdForPid: { $0 == 42 ? "com.example.Target" : nil }
    )
    try expect(controller.observeFrontmost().pid == 100, "brokered focus stopped using local observation")
    try expect(controller.requestActivation(pid: 42), "an accepted desktop activation was refused")
    try expect(accepted.requests.count == 1
        && accepted.requests[0].0 == 42
        && accepted.requests[0].1 == "com.example.Target",
        "the desktop broker was not bound to the exact PID and resolved bundle")
    try expect(local.activations.isEmpty, "brokered focus also attempted an in-process activation")

    let refused = FakeActivationBroker(accepted: false)
    let refusedController = BrokeredFocusController(
        local: local, broker: refused,
        bundleIdForPid: { _ in "com.example.Target" }
    )
    try expect(!refusedController.requestActivation(pid: 42), "a desktop broker refusal was bypassed")
    try expect(local.activations.isEmpty, "a broker refusal fell through to AppKit activation")

    let unresolved = FakeActivationBroker(accepted: true)
    let unresolvedController = BrokeredFocusController(
        local: local, broker: unresolved,
        bundleIdForPid: { _ in nil }
    )
    try expect(!unresolvedController.requestActivation(pid: 42) && unresolved.requests.isEmpty,
               "an unresolved PID reached the desktop broker")

    try expect(HTTPFocusActivationBroker(endpoint: "https://127.0.0.1:1/v1/focus/activate",
                                         token: String(repeating: "a", count: 64)) == nil,
               "the focus broker accepted a non-loopback HTTP contract")
    try expect(HTTPFocusActivationBroker(endpoint: "http://127.0.0.1:4000/v1/focus/activate",
                                         token: "short") == nil,
               "the focus broker accepted a malformed capability token")
    try expect(HTTPFocusActivationBroker(endpoint: "http://127.0.0.1:4000/v1/focus/activate",
                                         token: String(repeating: "a", count: 64)) != nil,
               "the valid loopback broker configuration was refused")
}

private func testDeliveryPolicyAuthorization() throws {
    let focus = FakeFocusController(frontmost: 100)
    let events = ManualEventTracker()
    let actions = FixedSemanticActions()
    let store = AXSnapshotStore()
    let core = BimaxCuServiceCore(
        permissions: FixedPermissions(), workspace: FixedWorkspace(),
        accessibility: FixedAccessibility(), axSnapshots: store, axEvents: events,
        semanticActions: actions, focusLeases: makeLeaseManager(focus)
    )
    guard case .session(let session) = core.handle(request(
        "policy-create", body: .sessionCreate(requestedId: "policy")
    )).body else { throw TestFailure.failed("policy session was not created") }

    func authority() throws -> (ElementRef, UInt64) {
        guard case .axSnapshot(let snapshot) = core.handle(request(
            "policy-observe", session: session.sessionId,
            body: .axObserve(.init(pid: 42, windowId: 7, windowGeneration: 3))
        )).body, let ref = snapshot.nodes.first?.elementRef else {
            throw TestFailure.failed("policy authority was not observed")
        }
        return (ref, snapshot.eventRevision)
    }
    func act(_ id: String, _ build: (ElementRef, UInt64) -> SemanticActionRequest) throws -> ResponseEnvelope {
        let (ref, revision) = try authority()
        return core.handle(request(id, session: session.sessionId, body: .semanticAction(build(ref, revision))))
    }
    func approval(
        policy: SemanticDeliveryPolicy = .foregroundOnce,
        pid: Int32 = 42,
        windowId: UInt32? = 7,
        expiresInMs: Int64 = 30_000
    ) -> ForegroundApproval {
        let now = Int64(Date().timeIntervalSince1970 * 1_000)
        return ForegroundApproval(
            approvalId: "approval-1", policy: policy, targetPid: pid, targetWindowId: windowId,
            grantedAtMs: now, expiresAtMs: now + expiresInMs
        )
    }

    // A background policy carrying foreground authority is refused outright, so an approval can
    // never ride along on a background call and be spent later.
    let strayApproval = try act("stray-approval") { ref, revision in
        .init(element: ref, action: .invoke, expectedEventRevision: revision,
              deliveryPolicy: .backgroundOnly, approval: approval())
    }
    try expect(strayApproval.error?.code == "approval_not_applicable", "a background policy accepted an approval")
    let strayLease = try act("stray-lease") { ref, revision in
        .init(element: ref, action: .invoke, expectedEventRevision: revision,
              deliveryPolicy: .backgroundPreferred, focusLease: FocusLeaseOptions())
    }
    try expect(strayLease.error?.code == "lease_not_applicable", "a background policy accepted lease options")

    // Every foreground policy needs an approval that names this exact policy and target.
    let unapproved = try act("unapproved") { ref, revision in
        .init(element: ref, action: .invoke, expectedEventRevision: revision, deliveryPolicy: .foregroundOnce)
    }
    try expect(unapproved.error?.code == "foreground_approval_required", "an unapproved foreground action was accepted")
    let wrongPolicy = try act("wrong-policy") { ref, revision in
        .init(element: ref, action: .invoke, expectedEventRevision: revision,
              deliveryPolicy: .foregroundPersistent, approval: approval(policy: .foregroundOnce))
    }
    try expect(wrongPolicy.error?.code == "foreground_approval_policy_mismatch",
               "a once-approval authorized a persistent foreground change")
    let wrongPid = try act("wrong-pid") { ref, revision in
        .init(element: ref, action: .invoke, expectedEventRevision: revision,
              deliveryPolicy: .foregroundOnce, approval: approval(pid: 999))
    }
    try expect(wrongPid.error?.code == "foreground_approval_target_mismatch", "an approval was replayed against another process")
    let wrongWindow = try act("wrong-window") { ref, revision in
        .init(element: ref, action: .invoke, expectedEventRevision: revision,
              deliveryPolicy: .foregroundOnce, approval: approval(windowId: 8))
    }
    try expect(wrongWindow.error?.code == "foreground_approval_target_mismatch", "an approval was replayed against another window")
    let expired = try act("expired-approval") { ref, revision in
        .init(element: ref, action: .invoke, expectedEventRevision: revision,
              deliveryPolicy: .foregroundOnce, approval: approval(expiresInMs: -1))
    }
    try expect(expired.error?.code == "foreground_approval_expired", "an expired approval was accepted")
    try expect(actions.performedCount == 0, "a refused delivery policy still reached the executor")
    try expect(focus.activations.isEmpty, "a refused delivery policy still moved focus")

    // Background delivery leaves no lease receipt at all — its absence is the evidence.
    guard case .semanticActionReceipt(let background) = (try act("background-run") { ref, revision in
        .init(element: ref, action: .invoke, expectedEventRevision: revision, deliveryPolicy: .backgroundOnly)
    }).body else { throw TestFailure.failed("background_only action was refused") }
    try expect(background.focusLease == nil, "a background action reported a focus lease")
    try expect(focus.activations.isEmpty, "a background action changed focus")

    // The approved path: take the front, act, hand it back.
    guard case .semanticActionReceipt(let leased) = (try act("foreground-run") { ref, revision in
        .init(element: ref, action: .invoke, expectedEventRevision: revision,
              deliveryPolicy: .foregroundOnce, approval: approval())
    }).body else { throw TestFailure.failed("an approved foreground action was refused") }
    guard let leaseReceipt = leased.focusLease else {
        throw TestFailure.failed("an approved foreground action reported no lease")
    }
    try expect(leaseReceipt.targetPid == 42 && leaseReceipt.previousFrontmostPid == 100,
               "the lease receipt lost the focus it displaced")
    try expect(leaseReceipt.restoreOutcome == .restored, "an approved foreground action did not restore focus")
    try expect(focus.currentFrontmost == 100, "an approved foreground action kept the front")

    // A refused action must still hand focus back.
    actions.failure = .executionFailed(AXError.failure)
    let failedForeground = try act("foreground-failure") { ref, revision in
        .init(element: ref, action: .invoke, expectedEventRevision: revision,
              deliveryPolicy: .foregroundOnce, approval: approval())
    }
    try expect(failedForeground.error?.code == "semantic_action_failed", "a failing foreground action did not report its failure")
    try expect(focus.currentFrontmost == 100, "a failing foreground action stranded focus on the target")

    // background_preferred answers a focus-dependent refusal with a proposal, not an error.
    actions.failure = .selectionNotSettable
    let activationsBeforeProposal = focus.activations.count
    guard case .escalationProposal(let proposal)? = (try act("escalate") { ref, revision in
        .init(element: ref, action: .selectTextRange,
              payload: .textRange(.init(location: 0, length: 4)),
              expectedEventRevision: revision, deliveryPolicy: .backgroundPreferred)
    }).body else { throw TestFailure.failed("background_preferred did not propose an escalation") }
    try expect(proposal.blockedBy == "ax_selection_not_settable", "the proposal lost the refusal that caused it")
    try expect(proposal.recommendedPolicy == .foregroundOnce && proposal.recommendedRung == 6,
               "the proposal recommended the wrong rung")
    try expect(proposal.requiresApproval, "the proposal implied it could escalate itself")
    try expect(!proposal.physicalInputAvailable && proposal.recommendedAction == nil,
               "a keyboard path was offered as if it could select a text range")
    try expect(focus.activations.count == activationsBeforeProposal, "a proposal moved focus instead of asking")

    // The same refusal under background_only stays an error: "fail if unavailable" means fail.
    let strictRefusal = try act("strict") { ref, revision in
        .init(element: ref, action: .selectTextRange,
              payload: .textRange(.init(location: 0, length: 4)),
              expectedEventRevision: revision, deliveryPolicy: .backgroundOnly)
    }
    try expect(strictRefusal.error?.code == "ax_selection_not_settable", "background_only softened a refusal into a proposal")

    // A refused string value write does have an equivalent physical rung, but it must take an
    // approved foreground lease; the end-state-unverified targeted background route stays absent.
    actions.failure = .valueNotSettable
    guard case .escalationProposal(let typingProposal)? = (try act("typing-fallback") { ref, revision in
        .init(element: ref, action: .setValue, value: .string("hello"),
              expectedEventRevision: revision, deliveryPolicy: .backgroundPreferred)
    }).body else { throw TestFailure.failed("a refused text write did not propose targeted typing") }
    try expect(typingProposal.recommendedAction == .typeText
        && typingProposal.recommendedPolicy == .foregroundOnce
        && typingProposal.recommendedRung == 6
        && typingProposal.requiresApproval
        && typingProposal.physicalInputAvailable,
        "the text fallback did not describe the approved foreground physical path")

    // A refusal a foreground retry cannot change must not be dressed up as an escalation.
    actions.failure = .actionUnsupported
    let unsupported = try act("unsupported") { ref, revision in
        .init(element: ref, action: .invoke, expectedEventRevision: revision, deliveryPolicy: .backgroundPreferred)
    }
    try expect(unsupported.error?.code == "semantic_action_unsupported",
               "an unsupported action was offered as an escalation a focus change cannot fix")
}

private func signedTransaction(
    snapshotId: String,
    steps: [SemanticTransactionStep],
    policy: SemanticDeliveryPolicy = .backgroundOnly
) throws -> SemanticTransactionRequest {
    var request = SemanticTransactionRequest(
        basedOnSnapshotId: snapshotId,
        steps: steps,
        deliveryPolicy: policy,
        approvalManifestHash: ""
    )
    request.approvalManifestHash = try request.computedManifestHash()
    return request
}

/// Shared with `computer.native.transaction.compiler.test.ts`. This pins the byte-level
/// JSONEncoder(.sortedKeys) contract so the coordinator cannot silently sign a different payload
/// from the one the service recomputes before mutation.
private func testSemanticTransactionManifestVector() throws {
    let element = ElementRef(
        token: "token/日本",
        snapshotId: "snapshot/vector",
        pid: 42,
        windowId: 7,
        windowGeneration: 3,
        axRevision: 11,
        stablePathHash: "stable/path"
    )
    let request = SemanticTransactionRequest(
        basedOnSnapshotId: "snapshot/vector",
        steps: [
            SemanticTransactionStep(
                stepId: "edit/日本",
                element: element,
                action: .setValue,
                value: .string("after/value"),
                precondition: .init(
                    expectedRole: "AXTextField",
                    expectedValue: "before/value"
                )
            ),
        ],
        deliveryPolicy: .backgroundNative,
        approvalManifestHash: ""
    )
    let hash = try request.computedManifestHash()
    try expect(
        hash == "17c667538c791fe90c92b6958f31458eabb72557d9cc8ce1ebd25a4db8bccf6a",
        "Swift transaction manifest encoding drifted from the TypeScript compiler"
    )
}

private func testSemanticTransactions() throws {
    let events = ManualEventTracker()
    let actions = FixedSemanticActions()
    let store = AXSnapshotStore()
    let core = BimaxCuServiceCore(
        permissions: FixedPermissions(), workspace: FixedWorkspace(),
        accessibility: TransactionAccessibility(), axSnapshots: store,
        axEvents: events, semanticActions: actions
    )
    guard case .session(let session) = core.handle(request(
        "transaction-create", body: .sessionCreate(requestedId: "transaction")
    )).body else { throw TestFailure.failed("transaction session was not created") }

    func observe(_ id: String) throws -> AXSnapshot {
        let response = core.handle(request(
            id, session: session.sessionId,
            body: .axObserve(.init(pid: 42, windowId: 7, windowGeneration: 3))
        ))
        guard case .axSnapshot(let snapshot) = response.body else {
            throw TestFailure.failed("transaction snapshot was not observed: \(response)")
        }
        return snapshot
    }

    let snapshot = try observe("transaction-observe")
    let refs = Dictionary(uniqueKeysWithValues: snapshot.nodes.compactMap { node in
        node.elementRef.map { (node.identifier ?? "", $0) }
    })
    guard let fieldOne = refs["field-one"], let fieldTwo = refs["field-two"] else {
        throw TestFailure.failed("transaction fixture refs were missing")
    }
    let steps = [
        SemanticTransactionStep(
            stepId: "edit-one", element: fieldOne, action: .setValue,
            value: .string("after-one"),
            precondition: .init(expectedRole: "AXTextField", expectedValue: "before-one")
        ),
        SemanticTransactionStep(
            stepId: "edit-two", element: fieldTwo, action: .setValue,
            value: .string("after-two"),
            precondition: .init(expectedRole: "AXTextField", expectedValue: "before-two")
        ),
    ]
    let transaction = try signedTransaction(snapshotId: snapshot.snapshotId, steps: steps)
    let wire = try JSONDecoder().decode(
        RequestBody.self,
        from: JSONEncoder().encode(RequestBody.semanticTransaction(transaction))
    )
    try expect(wire == .semanticTransaction(transaction), "semantic transaction did not round-trip")

    let response = core.handle(request(
        "transaction-run", session: session.sessionId, body: .semanticTransaction(transaction)
    ))
    guard case .semanticTransactionReceipt(let receipt) = response.body else {
        throw TestFailure.failed("valid semantic transaction was refused: \(response)")
    }
    try expect(receipt.outcome == .completed && receipt.steps.map(\.stepId) == ["edit-one", "edit-two"],
               "multi-edit did not complete in declared order")
    try expect(actions.performedCount == 2, "multi-edit did not perform exactly two mutations")
    try expect(store.retainedCount(sessionId: session.sessionId) == 0,
               "completed transaction did not consume its target authority")

    // A bad later step is rejected during whole-manifest preflight. No prefix may run.
    let preflightSnapshot = try observe("transaction-preflight-observe")
    let preflightRefs = Dictionary(uniqueKeysWithValues: preflightSnapshot.nodes.compactMap { node in
        node.elementRef.map { (node.identifier ?? "", $0) }
    })
    guard let preflightOne = preflightRefs["field-one"], let preflightTwo = preflightRefs["field-two"] else {
        throw TestFailure.failed("preflight refs were missing")
    }
    let performedBeforePreflight = actions.performedCount
    let badPrecondition = try signedTransaction(
        snapshotId: preflightSnapshot.snapshotId,
        steps: [
            .init(stepId: "would-run", element: preflightOne, action: .setValue, value: .string("x")),
            .init(
                stepId: "must-stop", element: preflightTwo, action: .setValue, value: .string("y"),
                precondition: .init(expectedRole: "AXSlider")
            ),
        ]
    )
    let preflightResponse = core.handle(request(
        "transaction-preflight", session: session.sessionId,
        body: .semanticTransaction(badPrecondition)
    ))
    try expect(preflightResponse.error?.code == "transaction_precondition_failed",
               "a false later precondition was not rejected before mutation")
    try expect(actions.performedCount == performedBeforePreflight,
               "a transaction mutated its prefix before all steps passed preflight")

    // Once execution starts, a later refusal reports the delivered prefix instead of hiding it.
    let stoppedSnapshot = preflightSnapshot
    actions.failure = .executionFailed(.failure)
    actions.failureOnAttempt = actions.attemptCount + 2
    let stopped = try signedTransaction(
        snapshotId: stoppedSnapshot.snapshotId,
        steps: [
            .init(stepId: "selected-one", element: preflightOne, action: .setValue, value: .string("one")),
            .init(stepId: "selected-two", element: preflightTwo, action: .setValue, value: .string("two")),
        ]
    )
    let stoppedResponse = core.handle(request(
        "transaction-stopped", session: session.sessionId,
        body: .semanticTransaction(stopped)
    ))
    guard case .semanticTransactionReceipt(let stoppedReceipt) = stoppedResponse.body else {
        throw TestFailure.failed("partial transaction did not return a receipt")
    }
    try expect(stoppedReceipt.outcome == .stopped
        && stoppedReceipt.steps.map(\.stepId) == ["selected-one"]
        && stoppedReceipt.stoppedBeforeStepId == "selected-two",
        "partial transaction hid or misordered its delivered prefix")
    try expect(stoppedReceipt.failure?.code == "semantic_action_failed",
               "partial transaction lost its native refusal")

    // The hash binds the exact declared steps before any authority is consulted.
    var tampered = stopped
    tampered.steps[0].value = .string("different")
    let attemptsBeforeTamper = actions.attemptCount
    let tamperedResponse = core.handle(request(
        "transaction-tampered", session: session.sessionId,
        body: .semanticTransaction(tampered)
    ))
    try expect(tamperedResponse.error?.code == "transaction_manifest_mismatch",
               "a transaction accepted steps that did not match its manifest")
    try expect(actions.attemptCount == attemptsBeforeTamper,
               "a manifest mismatch reached the action executor")
}

private func testDataOnlyXPCTransport() throws {
    let listener = NSXPCListener.anonymous()
    let lifecycle = XPCConnectionLifecycle()
    let capture = FixedCaptureService()
    let delegate = BimaxCuXPCServiceDelegate(
        exportedObject: BimaxCuXPCService(core: BimaxCuServiceCore(
            permissions: FixedPermissions(), workspace: FixedWorkspace(), capture: capture
        )),
        identityValidator: AllowTestClient(),
        lifecycle: lifecycle
    )
    listener.delegate = delegate
    listener.resume()
    defer { listener.invalidate() }

    let client = BimaxCuXPCClient(endpoint: listener.endpoint)
    let response = try client.request(request("xpc", body: .handshake(.init(
        clientVersion: "test", supportedProtocols: [BimaxCuProtocolVersion.v1]
    ))))
    guard case .handshake(let handshake) = response.body else { throw TestFailure.failed("XPC handshake response was missing") }
    try expect(handshake.selectedProtocol == BimaxCuProtocolVersion.v1, "XPC changed the protocol envelope")
    try expect(lifecycle.snapshot().accepted == 1, "XPC connection was not tracked")

    let created = try client.request(request("xpc-image-create", body: .sessionCreate(requestedId: "xpc-image")))
    guard case .session(let imageSession) = created.body else {
        throw TestFailure.failed("XPC image session was not created")
    }
    let captureResponse = try client.request(request(
        "xpc-image-capture", session: imageSession.sessionId,
        body: .captureImage(.init(target: .window(.init(
            pid: 42, windowId: 7, generation: 3, title: "Draft"
        )), format: .png))
    ))
    guard case .captureImageReceipt(let receipt) = captureResponse.body else {
        throw TestFailure.failed("XPC capture did not return an image handle")
    }
    let rawImage = try client.readImage(.init(sessionId: imageSession.sessionId, image: receipt.image))
    try expect(rawImage == capture.bytes,
               "binary XPC redemption changed image bytes or routed them through the JSON body")
    client.close()
}

private func testTypedCaptureHandleLifecycle() throws {
    let capture = FixedCaptureService()
    let images = ImageHandleStore(maxHandlesPerSession: 2, maxBytesPerSession: 1_024)
    let core = BimaxCuServiceCore(
        permissions: FixedPermissions(), workspace: FixedWorkspace(),
        capture: capture, images: images
    )
    let created = core.handle(request("capture-create", body: .sessionCreate(requestedId: "capture-a")))
    guard case .session(let session) = created.body else {
        throw TestFailure.failed("capture session was not created")
    }
    let window = WindowRef(pid: 42, windowId: 7, generation: 3, title: "Draft")
    let captureRequest = CaptureImageRequest(
        target: .window(window), format: .png, maxDimension: 1_456,
        region: CuRect(x: 1, y: 0, width: 2, height: 1)
    )
    let roundTrip = try JSONDecoder().decode(
        RequestBody.self,
        from: JSONEncoder().encode(RequestBody.captureImage(captureRequest))
    )
    try expect(roundTrip == .captureImage(captureRequest), "typed capture request did not round-trip")

    let response = core.handle(request(
        "capture-run", session: session.sessionId, body: .captureImage(captureRequest)
    ))
    guard case .captureImageReceipt(let receipt) = response.body else {
        throw TestFailure.failed("typed capture did not return a handle: \(response)")
    }
    try expect(receipt.target == .window(window)
        && receipt.image.sessionId == session.sessionId
        && receipt.image.format == .png
        && receipt.image.pixelWidth == 2
        && receipt.image.pixelHeight == 1
        && receipt.image.byteCount == capture.bytes.count
        && receipt.image.sha256.count == 64,
        "capture receipt lost target, encoding, or integrity metadata")
    try expect(images.retainedCount(sessionId: session.sessionId) == 1,
               "capture bytes were not retained behind the handle")
    let read = core.readImage(.init(sessionId: session.sessionId, image: receipt.image))
    try expect(read.bytes == capture.bytes && read.error == nil,
               "valid image handle did not redeem raw bytes")

    let secondSessionResponse = core.handle(request(
        "capture-create-b", body: .sessionCreate(requestedId: "capture-b")
    ))
    guard case .session(let secondSession) = secondSessionResponse.body else {
        throw TestFailure.failed("second capture session was not created")
    }
    let crossSession = core.readImage(.init(sessionId: secondSession.sessionId, image: receipt.image))
    try expect(crossSession.error?.code == "invalid_image_handle",
               "image handle crossed its owning session")

    var forgedImage = receipt.image
    forgedImage.transform.outputWidth += 1
    let forged = core.readImage(.init(sessionId: session.sessionId, image: forgedImage))
    try expect(forged.error?.code == "invalid_image_handle",
               "image redemption accepted a forged transform")

    let releaseRoundTrip = try JSONDecoder().decode(
        RequestBody.self,
        from: JSONEncoder().encode(RequestBody.imageRelease(.init(image: receipt.image)))
    )
    try expect(releaseRoundTrip == .imageRelease(.init(image: receipt.image)),
               "image release request did not round-trip")
    let released = core.handle(request(
        "capture-release", session: session.sessionId,
        body: .imageRelease(.init(image: receipt.image))
    ))
    try expect(released.body == .imageReleased, "valid image handle was not released")
    try expect(core.readImage(.init(sessionId: session.sessionId, image: receipt.image)).error?.code
        == "invalid_image_handle", "released image handle remained redeemable")

    let attemptsBeforeStale = capture.requestCount
    let stale = core.handle(request(
        "capture-stale", session: session.sessionId,
        body: .captureImage(.init(target: .window(.init(
            pid: 42, windowId: 7, generation: 2, title: "Draft"
        ))))
    ))
    try expect(stale.error?.code == "stale_window_ref" && capture.requestCount == attemptsBeforeStale,
               "stale capture target reached the native provider")
    let invalidLimit = core.handle(request(
        "capture-limit", session: session.sessionId,
        body: .captureImage(.init(target: .display(displayId: 1), maxDimension: 0))
    ))
    try expect(invalidLimit.error?.code == "invalid_image_limit",
               "invalid model image limit reached capture")

    let retained = core.handle(request(
        "capture-retain", session: session.sessionId,
        body: .captureImage(.init(target: .display(displayId: 1), format: .jpeg))
    ))
    guard case .captureImageReceipt(let retainedReceipt) = retained.body else {
        throw TestFailure.failed("display capture did not return a handle")
    }
    _ = core.handle(request(
        "capture-reset", session: session.sessionId,
        body: .sessionReset(reason: "capture cleanup")
    ))
    try expect(core.readImage(.init(
        sessionId: session.sessionId, image: retainedReceipt.image
    )).error?.code == "invalid_image_handle", "session reset retained image bytes")
    try expect(capture.resets.contains(session.sessionId), "session reset did not reach capture service")
}

private func testSOMCaptureSnapshotAuthorityAndTransform() throws {
    let legacyRequest = try JSONDecoder().decode(
        CaptureImageRequest.self,
        from: Data(#"{"target":{"type":"display","displayId":1},"format":"png","maxDimension":1456,"jpegQuality":0.85}"#.utf8)
    )
    try expect(legacyRequest.mode == .image && legacyRequest.basedOnSnapshotId == nil,
               "capture request predating SOM did not default to plain image mode")

    let capture = FixedSOMCaptureService()
    let core = BimaxCuServiceCore(
        permissions: FixedPermissions(),
        workspace: FixedWorkspace(),
        accessibility: FixedAccessibility(),
        axEvents: UnavailableEventTracker(),
        capture: capture
    )
    let created = core.handle(request("som-create", body: .sessionCreate(requestedId: "som-a")))
    guard case .session(let session) = created.body else {
        throw TestFailure.failed("SOM session was not created")
    }
    let observed = core.handle(request(
        "som-observe", session: session.sessionId,
        body: .axObserve(.init(pid: 42, windowId: 7, windowGeneration: 3))
    ))
    guard case .axSnapshot(let snapshot) = observed.body,
          let expectedElement = snapshot.nodes.first?.elementRef else {
        throw TestFailure.failed("SOM authority snapshot was not retained")
    }
    let window = WindowRef(pid: 42, windowId: 7, generation: 3, title: "Draft")
    let somRequest = CaptureImageRequest(
        target: .window(window),
        mode: .som,
        format: .png,
        maxDimension: 164,
        jpegQuality: 1,
        basedOnSnapshotId: snapshot.snapshotId
    )
    let roundTrip = try JSONDecoder().decode(
        RequestBody.self,
        from: JSONEncoder().encode(RequestBody.captureImage(somRequest))
    )
    try expect(roundTrip == .captureImage(somRequest), "SOM capture request did not round-trip")

    let response = core.handle(request(
        "som-capture", session: session.sessionId, body: .captureImage(somRequest)
    ))
    guard case .captureImageReceipt(let receipt) = response.body,
          let mark = receipt.marks.first,
          let content = receipt.sourceContentRect else {
        throw TestFailure.failed("SOM capture did not return marks and a content transform: \(response)")
    }
    try expect(receipt.mode == .som && receipt.marks.count == 1,
               "SOM receipt lost its mode or authoritative marks")
    try expect(mark.index == 0 && mark.element == expectedElement,
               "SOM label was not bound to its retained authoritative ElementRef")
    try expect(receipt.image.pixelWidth == 164 && receipt.image.pixelHeight == 124,
               "SOM output did not report post-padding model scaling")
    let scaleX = 164.0 / 327.0
    let scaleY = 124.0 / 247.0
    func near(_ lhs: Double, _ rhs: Double) -> Bool { abs(lhs - rhs) < 0.000_000_1 }
    try expect(near(mark.bounds.x, 5 * scaleX)
        && near(mark.bounds.y, 5 * scaleY)
        && near(mark.bounds.width, 40 * scaleX)
        && near(mark.bounds.height, 12 * scaleY),
        "SOM mark did not map global AX points through source pixels, padding, and output scaling")
    try expect(near(content.x, 5 * scaleX)
        && near(content.y, 5 * scaleY)
        && near(content.width, 320 * scaleX)
        && near(content.height, 240 * scaleY),
        "SOM receipt did not expose the exact scaled source-content rectangle")
    try expect(capture.latestRequest == CaptureImageRequest(
        target: .window(window), mode: .image, format: .png,
        maxDimension: 4_096, jpegQuality: 1
    ), "SOM provider was not given an uncropped precision source request")

    let read = core.readImage(.init(sessionId: session.sessionId, image: receipt.image))
    guard let bytes = read.bytes,
          let source = CGImageSourceCreateWithData(bytes as CFData, nil),
          let decoded = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw TestFailure.failed("SOM image handle did not redeem a decodable image")
    }
    try expect(decoded.width == receipt.image.pixelWidth && decoded.height == receipt.image.pixelHeight,
               "SOM binary dimensions disagreed with its typed receipt")

    var legacyReceiptObject = try JSONSerialization.jsonObject(
        with: JSONEncoder().encode(receipt)
    ) as! [String: Any]
    legacyReceiptObject.removeValue(forKey: "mode")
    legacyReceiptObject.removeValue(forKey: "marks")
    legacyReceiptObject.removeValue(forKey: "sourceContentRect")
    let decodedLegacyReceipt = try JSONDecoder().decode(
        CaptureImageReceipt.self,
        from: try JSONSerialization.data(withJSONObject: legacyReceiptObject)
    )
    try expect(decodedLegacyReceipt.mode == .image
        && decodedLegacyReceipt.marks.isEmpty
        && decodedLegacyReceipt.sourceContentRect == nil,
        "capture receipt predating SOM invented annotation authority")

    let providerCount = capture.requestCount
    let display = core.handle(request(
        "som-display", session: session.sessionId,
        body: .captureImage(.init(
            target: .display(displayId: 1), mode: .som,
            basedOnSnapshotId: snapshot.snapshotId
        ))
    ))
    try expect(display.error?.code == "invalid_som_target" && capture.requestCount == providerCount,
               "display SOM reached the capture provider")
    let cropped = core.handle(request(
        "som-crop", session: session.sessionId,
        body: .captureImage(.init(
            target: .window(window), mode: .som,
            region: CuRect(x: 0, y: 0, width: 10, height: 10),
            basedOnSnapshotId: snapshot.snapshotId
        ))
    ))
    try expect(cropped.error?.code == "invalid_som_region" && capture.requestCount == providerCount,
               "cropped SOM reached the capture provider")
    let missing = core.handle(request(
        "som-missing", session: session.sessionId,
        body: .captureImage(.init(target: .window(window), mode: .som))
    ))
    try expect(missing.error?.code == "missing_som_snapshot" && capture.requestCount == providerCount,
               "SOM without snapshot authority reached the capture provider")
    let evicted = core.handle(request(
        "som-stale", session: session.sessionId,
        body: .captureImage(.init(
            target: .window(window), mode: .som, basedOnSnapshotId: "not-retained"
        ))
    ))
    try expect(evicted.error?.code == "stale_snapshot_ref" && capture.requestCount == providerCount,
               "SOM with an unknown snapshot reached the capture provider")

    let appObserved = core.handle(request(
        "som-app-observe", session: session.sessionId,
        body: .axObserve(.init(pid: 42, scope: .application))
    ))
    guard case .axSnapshot(let appSnapshot) = appObserved.body else {
        throw TestFailure.failed("application snapshot for SOM mismatch test was not retained")
    }
    let mismatched = core.handle(request(
        "som-mismatch", session: session.sessionId,
        body: .captureImage(.init(
            target: .window(window), mode: .som,
            basedOnSnapshotId: appSnapshot.snapshotId
        ))
    ))
    try expect(mismatched.error?.code == "snapshot_target_mismatch"
        && capture.requestCount == providerCount,
        "non-window AX snapshot authorized SOM labels for a window")
}

private func testZoomCaptureContract() throws {
    let capture = FixedSOMCaptureService()
    let core = BimaxCuServiceCore(
        permissions: FixedPermissions(), workspace: FixedWorkspace(), capture: capture
    )
    let created = core.handle(request("zoom-create", body: .sessionCreate(requestedId: "zoom-a")))
    guard case .session(let session) = created.body else {
        throw TestFailure.failed("zoom session was not created")
    }
    let window = WindowRef(pid: 42, windowId: 7, generation: 3, title: "Draft")
    let zoom = CaptureImageRequest(
        target: .window(window), mode: .zoom, format: .png,
        maxDimension: 100, jpegQuality: 1,
        region: CuRect(x: 20, y: 30, width: 40, height: 20), zoomFactor: 2
    )
    let roundTrip = try JSONDecoder().decode(
        RequestBody.self,
        from: JSONEncoder().encode(RequestBody.captureImage(zoom))
    )
    try expect(roundTrip == .captureImage(zoom), "zoom capture request did not round-trip")
    let response = core.handle(request(
        "zoom-capture", session: session.sessionId, body: .captureImage(zoom)
    ))
    guard case .captureImageReceipt(let receipt) = response.body else {
        throw TestFailure.failed("zoom capture did not return a handle: \(response)")
    }
    try expect(receipt.mode == .zoom && receipt.marks.isEmpty
        && receipt.sourceContentRect == nil,
        "zoom receipt invented SOM authority")
    try expect(receipt.image.pixelWidth == 80 && receipt.image.pixelHeight == 40,
               "zoom factor was not applied before the max-dimension ceiling")
    try expect(receipt.image.transform.sourcePixelRect == zoom.region
        && receipt.image.transform.outputWidth == 80
        && receipt.image.transform.outputHeight == 40,
        "zoom receipt lost the exact source-to-output transform")
    let read = core.readImage(.init(sessionId: session.sessionId, image: receipt.image))
    guard let bytes = read.bytes,
          let source = CGImageSourceCreateWithData(bytes as CFData, nil),
          let decoded = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw TestFailure.failed("zoom handle did not redeem a decodable image")
    }
    try expect(decoded.width == 80 && decoded.height == 40,
               "zoom binary dimensions disagreed with its transform")

    let providerCount = capture.requestCount
    let missingRegion = core.handle(request(
        "zoom-no-region", session: session.sessionId,
        body: .captureImage(.init(target: .window(window), mode: .zoom, zoomFactor: 2))
    ))
    try expect(missingRegion.error?.code == "missing_zoom_region"
        && capture.requestCount == providerCount,
        "zoom without a region reached the provider")
    let display = core.handle(request(
        "zoom-display", session: session.sessionId,
        body: .captureImage(.init(
            target: .display(displayId: 1), mode: .zoom,
            region: CuRect(x: 0, y: 0, width: 40, height: 20), zoomFactor: 2
        ))
    ))
    try expect(display.error?.code == "invalid_zoom_target"
        && capture.requestCount == providerCount,
        "display zoom reached the window-only provider path")
    let oversized = core.handle(request(
        "zoom-factor", session: session.sessionId,
        body: .captureImage(.init(
            target: .window(window), mode: .zoom,
            region: CuRect(x: 0, y: 0, width: 40, height: 20), zoomFactor: 9
        ))
    ))
    try expect(oversized.error?.code == "invalid_zoom_factor"
        && capture.requestCount == providerCount,
        "unbounded zoom factor reached the provider")
    let plainScaled = core.handle(request(
        "zoom-plain", session: session.sessionId,
        body: .captureImage(.init(target: .window(window), zoomFactor: 2))
    ))
    try expect(plainScaled.error?.code == "unexpected_zoom_factor"
        && capture.requestCount == providerCount,
        "plain image capture silently acquired zoom behavior")
}

private func testImageAnalysisHandleContract() throws {
    let core = BimaxCuServiceCore(
        permissions: FixedPermissions(), workspace: FixedWorkspace(),
        capture: FixedAnalysisCaptureService()
    )
    let created = core.handle(request(
        "analysis-create", body: .sessionCreate(requestedId: "analysis-a")
    ))
    guard case .session(let session) = created.body else {
        throw TestFailure.failed("image-analysis session was not created")
    }
    let captured = core.handle(request(
        "analysis-capture", session: session.sessionId,
        body: .captureImage(.init(
            target: .window(.init(pid: 42, windowId: 7, generation: 3, title: "Draft")),
            format: .png, maxDimension: 4_096
        ))
    ))
    guard case .captureImageReceipt(let imageReceipt) = captured.body else {
        throw TestFailure.failed("analysis fixture image was not retained")
    }
    let analysisRequest = ImageAnalysisRequest(
        image: imageReceipt.image,
        fingerprintRegions: [
            .init(id: "top", bounds: CuRect(x: 20, y: 20, width: 120, height: 80)),
            .init(id: "bottom", bounds: CuRect(x: 20, y: 220, width: 120, height: 80)),
        ],
        ocrRegion: CuRect(x: 250, y: 0, width: 390, height: 320),
        ocrQuery: "HELLO"
    )
    let roundTrip = try JSONDecoder().decode(
        RequestBody.self,
        from: JSONEncoder().encode(RequestBody.imageAnalyze(analysisRequest))
    )
    try expect(roundTrip == .imageAnalyze(analysisRequest),
               "typed image-analysis request did not round-trip")
    let analysed = core.handle(request(
        "analysis-run", session: session.sessionId,
        body: .imageAnalyze(analysisRequest)
    ))
    guard case .imageAnalysis(let receipt) = analysed.body else {
        throw TestFailure.failed("image analysis did not return a typed receipt: \(analysed)")
    }
    try expect(receipt.image == imageReceipt.image
        && receipt.fingerprints.map(\.id) == ["top", "bottom"],
        "image analysis lost handle authority or region order")
    try expect(receipt.fingerprints[0].colorName == "red"
        && receipt.fingerprints[1].colorName == "blue",
        "sRGB sampling did not preserve top-left screenshot orientation: \(receipt.fingerprints.map(\.colorName))")
    try expect(receipt.fingerprints.allSatisfy {
        $0.sourceColorSpace == "sRGB" && $0.sampleCount == 49 && $0.confidence == 1
    }, "visual fingerprint lost its source profile or bounded sample grid")
    if receipt.errors.isEmpty {
        try expect(receipt.texts.contains(where: { $0.text.uppercased().contains("HELLO") }),
                   "bounded accurate OCR did not recover the fixture text")
    } else {
        try expect(receipt.texts.isEmpty && receipt.errors.allSatisfy { $0.hasPrefix("ocr: ") },
                   "OCR failure was mixed with invented text or untyped errors")
    }
    try expect(receipt.texts.allSatisfy {
        $0.bounds.x >= 0 && $0.bounds.y >= 0
            && $0.bounds.x + $0.bounds.width <= 640
            && $0.bounds.y + $0.bounds.height <= 320
    }, "OCR returned a frame outside top-left image pixels")

    var forged = imageReceipt.image
    forged.pixelWidth += 1
    let forgedResponse = core.handle(request(
        "analysis-forged", session: session.sessionId,
        body: .imageAnalyze(.init(
            image: forged,
            fingerprintRegions: [.init(
                id: "forged", bounds: CuRect(x: 0, y: 0, width: 10, height: 10)
            )]
        ))
    ))
    try expect(forgedResponse.error?.code == "invalid_image_handle",
               "forged image descriptor acquired analysis authority")
    let duplicate = core.handle(request(
        "analysis-duplicate", session: session.sessionId,
        body: .imageAnalyze(.init(
            image: imageReceipt.image,
            fingerprintRegions: [
                .init(id: "same", bounds: CuRect(x: 0, y: 0, width: 10, height: 10)),
                .init(id: "same", bounds: CuRect(x: 20, y: 20, width: 10, height: 10)),
            ]
        ))
    ))
    try expect(duplicate.error?.code == "duplicate_image_region",
               "duplicate region IDs entered the evidence map")
    let tooMany = (0...160).map {
        ImageAnalysisRegion(
            id: "region-\($0)", bounds: CuRect(x: 0, y: 0, width: 1, height: 1)
        )
    }
    let bounded = core.handle(request(
        "analysis-cap", session: session.sessionId,
        body: .imageAnalyze(.init(image: imageReceipt.image, fingerprintRegions: tooMany))
    ))
    try expect(bounded.error?.code == "too_many_image_regions",
               "visual analysis exceeded Bimax's 160-region cap")
    let empty = core.handle(request(
        "analysis-empty", session: session.sessionId,
        body: .imageAnalyze(.init(image: imageReceipt.image))
    ))
    try expect(empty.error?.code == "empty_image_analysis",
               "empty image analysis was reported as evidence")
}

private func testAdaptiveEvidenceAndPostconditions() throws {
    let clock = TestClock()
    let accessibility = FixedAccessibility()
    let events = ManualEventTracker()
    let actions = FixedSemanticActions()
    let core = BimaxCuServiceCore(
        permissions: FixedPermissions(), workspace: FixedWorkspace(),
        accessibility: accessibility, axEvents: events, semanticActions: actions,
        evidenceSettler: AdaptiveEvidenceSettler(
            now: clock.now,
            sleep: { microseconds in clock.advance(Int64(microseconds / 1_000)) }
        )
    )
    let created = core.handle(request(
        "evidence-create", body: .sessionCreate(requestedId: "evidence-a")
    ))
    guard case .session(let session) = created.body else {
        throw TestFailure.failed("evidence session was not created")
    }
    func observe(_ id: String) throws -> AXSnapshot {
        let response = core.handle(request(
            id, session: session.sessionId,
            body: .axObserve(.init(pid: 42, windowId: 7, windowGeneration: 3))
        ))
        guard case .axSnapshot(let snapshot) = response.body else {
            throw TestFailure.failed("evidence authority observation failed: \(response)")
        }
        return snapshot
    }

    let initial = try observe("evidence-observe")
    let element = initial.nodes[0].elementRef!
    let signed = SemanticActionRequest(
        element: element,
        action: .invoke,
        expectedEventRevision: initial.eventRevision,
        evidence: .init(
            tier: .semantic,
            postcondition: .init(text: "Save As"),
            settleTimeoutMs: 200
        )
    )
    let roundTrip = try JSONDecoder().decode(
        RequestBody.self,
        from: JSONEncoder().encode(RequestBody.semanticAction(signed))
    )
    try expect(roundTrip == .semanticAction(signed),
               "evidence requirement did not round-trip")
    let delivered = core.handle(request(
        "evidence-deliver", session: session.sessionId,
        body: .semanticAction(signed)
    ))
    guard case .semanticActionReceipt(let receipt) = delivered.body,
          let evidence = receipt.evidence else {
        throw TestFailure.failed("semantic action did not return evidence: \(delivered)")
    }
    try expect(evidence.requiredTier == .semantic
        && evidence.achievedTier == .semantic
        && evidence.outcome == .satisfied
        && evidence.postconditionMatched == true
        && evidence.attempts == 1,
        "fresh AX postcondition was not adaptively settled")

    let fresh = try observe("evidence-refresh")
    let freshElement = fresh.nodes[0].elementRef!
    let attemptsBeforePreexisting = actions.attemptCount
    let preexisting = core.handle(request(
        "evidence-preexisting", session: session.sessionId,
        body: .semanticAction(.init(
            element: freshElement,
            action: .invoke,
            expectedEventRevision: fresh.eventRevision,
            evidence: .init(
                tier: .semantic,
                postcondition: .init(text: "Save As"),
                settleTimeoutMs: 200
            )
        ))
    ))
    try expect(preexisting.error?.code == "postcondition_preexisting"
        && actions.attemptCount == attemptsBeforePreexisting,
        "a condition already true was used as proof of a new action")

    let unavailable = core.handle(request(
        "evidence-tier", session: session.sessionId,
        body: .semanticAction(.init(
            element: freshElement,
            action: .invoke,
            expectedEventRevision: fresh.eventRevision,
            evidence: .init(tier: .audit, settleTimeoutMs: 200)
        ))
    ))
    try expect(unavailable.error?.code == "evidence_tier_unavailable"
        && actions.attemptCount == attemptsBeforePreexisting,
        "unsupported audit evidence reached delivery")

    let timedOut = core.handle(request(
        "evidence-timeout", session: session.sessionId,
        body: .semanticAction(.init(
            element: freshElement,
            action: .invoke,
            expectedEventRevision: fresh.eventRevision,
            evidence: .init(
                tier: .semantic,
                postcondition: .init(text: "Never appears"),
                settleTimeoutMs: 50
            )
        ))
    ))
    guard case .semanticActionReceipt(let timeoutReceipt) = timedOut.body,
          let timeoutEvidence = timeoutReceipt.evidence else {
        throw TestFailure.failed("settle timeout hid the delivered action: \(timedOut)")
    }
    try expect(timeoutEvidence.outcome == .timedOut
        && timeoutEvidence.postconditionMatched == false
        && timeoutEvidence.attempts > 1,
        "deadline-based settle did not report its newest unmatched state")

    let before = AXNode(
        token: "before", parentToken: nil, role: "AXCheckBox", subrole: nil,
        label: "Choice", value: "old", identifier: "choice", bounds: nil,
        enabled: true, focused: false, actions: ["AXPress"], childCount: 0,
        stablePathHash: "choice", selected: false
    )
    var after = before
    after.value = "new"
    after.focused = true
    after.selected = true
    let state = AXSnapshot(
        snapshotId: "evidence-state", sessionId: "evidence-a", pid: 42,
        windowId: 7, windowGeneration: 3, revision: 2, capturedAtMs: 1,
        profile: "flash", scope: .window, nodes: [after],
        visitedCount: 1, truncated: false
    )
    try expect(SemanticEvidencePolicy.matches(
        .init(valueMustChange: true, expectedFocused: true, expectedSelected: true),
        before: before, snapshot: state, stablePathHash: "choice"
    ), "value/focus/selection postconditions were not conjunctive")
    try expect(SemanticEvidencePolicy.matches(
        .init(text: "missing", textPresence: .absent),
        before: before, snapshot: state, stablePathHash: "choice"
    ), "text-absence postcondition did not evaluate against fresh AX state")
}

private func testCaptureGeometryMixedDPI() throws {
    let geometry = CaptureGeometry(displays: [
        DisplayInfo(
            displayId: 10,
            bounds: CuRect(x: 0, y: 0, width: 1512, height: 982),
            pixelWidth: 3024, pixelHeight: 1964, scale: 2, main: true
        ),
        DisplayInfo(
            displayId: 20,
            bounds: CuRect(x: 1512, y: 100, width: 1920, height: 1080),
            pixelWidth: 1920, pixelHeight: 1080, scale: 1, main: false
        ),
    ])

    let retinaPoint = geometry.pixelPoint(x: 100, y: 50)
    try expect(retinaPoint == CapturePixelRegion(
        displayId: 10, rect: CuRect(x: 200, y: 100, width: 0, height: 0)
    ), "Retina point did not map with its display scale")

    let externalPoint = geometry.pixelPoint(x: 1612, y: 150)
    try expect(externalPoint == CapturePixelRegion(
        displayId: 20, rect: CuRect(x: 100, y: 50, width: 0, height: 0)
    ), "offset external display point did not become display-local pixels")
    try expect(geometry.pixelPoint(x: -1, y: -1) == nil,
               "off-display point acquired capture authority")

    let crossing = geometry.pixelRegions(for: CuRect(x: 1502, y: 120, width: 30, height: 20))
    try expect(crossing == [
        CapturePixelRegion(displayId: 10, rect: CuRect(x: 3004, y: 240, width: 20, height: 40)),
        CapturePixelRegion(displayId: 20, rect: CuRect(x: 0, y: 20, width: 20, height: 20)),
    ], "mixed-DPI cross-display rectangle was not split into exact local regions")

    let invalid = CaptureGeometry(displays: [
        DisplayInfo(
            displayId: 30, bounds: CuRect(x: 0, y: 0, width: 0, height: 10),
            pixelWidth: 100, pixelHeight: 100, scale: 1, main: false
        ),
    ])
    try expect(invalid.pixelRegions(for: CuRect(x: 0, y: 0, width: 10, height: 10)).isEmpty,
               "invalid display geometry was accepted")
}

private func testCaptureStreamPoolLifecycle() throws {
    try waitForAsync {
        let driver = FakeCaptureStreamDriver()
        let pool = try CaptureStreamPool(maxStreams: 2, driver: driver)
        let targetA = CaptureStreamTarget.window(pid: 10, windowId: 100)
        let targetB = CaptureStreamTarget.window(pid: 20, windowId: 200)
        let targetC = CaptureStreamTarget.display(displayId: 30)
        let targetD = CaptureStreamTarget.display(displayId: 40)

        let a1 = try await pool.acquire(target: targetA)
        let a2 = try await pool.acquire(target: targetA)
        try expect(driver.starts == [targetA], "same target did not reuse its warm stream")
        let sharedSnapshot = await pool.snapshot()
        try expect(sharedSnapshot == CaptureStreamPoolSnapshot(
            activeStreams: 1, activeLeases: 2, idleStreams: 0
        ), "shared stream lease counts were wrong")
        let stats = try await pool.stats(for: a1)
        try expect(stats?.completeFrames == 1 && stats?.width == 2_560,
                   "lease did not route statistics to its retained driver handle")
        let image = try await pool.image(for: a1, request: .init(format: .png))
        try expect(image?.format == .png && image?.pixelWidth == 10 && image?.bytes.count == 4,
                   "lease did not route encoded image retrieval to its retained driver handle")

        try await pool.release(a1)
        try await pool.release(a2)
        let b = try await pool.acquire(target: targetB)
        try await pool.release(b)
        let c = try await pool.acquire(target: targetC)
        try expect(driver.starts == [targetA, targetB, targetC],
                   "new targets did not start exactly one stream each")
        try expect(driver.stops == ["capture-1"],
                   "capacity did not evict the least-recently-used idle stream")

        let b2 = try await pool.acquire(target: targetB)
        do {
            _ = try await pool.acquire(target: targetD)
            throw TestFailure.failed("pool stole a stream while every entry was leased")
        } catch CaptureStreamPoolError.capacityExhausted {
            // Expected: a live lease cannot be evicted.
        }
        do {
            try await pool.release(CaptureStreamLease(id: UUID(), target: targetB))
            throw TestFailure.failed("pool accepted a forged lease")
        } catch CaptureStreamPoolError.invalidLease {
            // Expected.
        }

        try await pool.release(b2)
        try await pool.release(c)
        await pool.reset()
        try expect(driver.stops == ["capture-1", "capture-2", "capture-3"],
                   "pool reset did not stop every retained stream")
        try expect(driver.retainedHandleCount == 0, "pool reset leaked a driver handle")
        let resetSnapshot = await pool.snapshot()
        try expect(resetSnapshot == CaptureStreamPoolSnapshot(
            activeStreams: 0, activeLeases: 0, idleStreams: 0
        ), "pool reset retained lease state")
    }
}

private func testImageHandleStoreAndTransforms() throws {
    let transform = try CaptureImageTransform(
        sourcePixelRect: CuRect(x: 200, y: 100, width: 1_000, height: 500),
        outputWidth: 500,
        outputHeight: 250
    )
    try expect(transform.sourcePixel(x: 100, y: 50) == CuRect(
        x: 400, y: 200, width: 0, height: 0
    ), "model pixel did not map through the declared crop and scale")
    try expect(transform.outputPixel(sourceX: 400, sourceY: 200) == CuRect(
        x: 100, y: 50, width: 0, height: 0
    ), "source pixel did not round-trip through the image transform")
    try expect(transform.sourcePixel(x: 500, y: 0) == nil,
               "out-of-image model coordinate acquired a source mapping")
    do {
        _ = try CaptureImageTransform(
            sourcePixelRect: CuRect(x: 0, y: 0, width: 0, height: 10),
            outputWidth: 10, outputHeight: 10
        )
        throw TestFailure.failed("invalid image transform was accepted")
    } catch ImageHandleStoreError.invalidTransform {
        // Expected.
    }

    let store = ImageHandleStore(maxHandlesPerSession: 2, maxBytesPerSession: 6, now: { 1_000 })
    let first = try store.retain(
        sessionId: "image-a", bytes: Data([1, 2, 3]), format: .png,
        pixelWidth: 500, pixelHeight: 250, transform: transform
    )
    let resolved = try store.resolve(sessionId: "image-a", handle: first)
    try expect(resolved.bytes == Data([1, 2, 3]) && first.byteCount == 3
        && first.sha256.count == 64 && first.createdAtMs == 1_000,
        "retained image lost bytes or immutable metadata")
    do {
        _ = try store.resolve(sessionId: "image-b", handle: first)
        throw TestFailure.failed("image handle crossed its owning session")
    } catch ImageHandleStoreError.invalidHandle {
        // Expected.
    }

    let second = try store.retain(
        sessionId: "image-a", bytes: Data([4, 5, 6]), format: .jpeg,
        pixelWidth: 500, pixelHeight: 250, transform: transform
    )
    let third = try store.retain(
        sessionId: "image-a", bytes: Data([7, 8, 9]), format: .png,
        pixelWidth: 500, pixelHeight: 250, transform: transform
    )
    try expect(store.retainedCount(sessionId: "image-a") == 2
        && store.retainedBytes(sessionId: "image-a") == 6,
        "image store exceeded its per-session handle or byte budget")
    do {
        _ = try store.resolve(sessionId: "image-a", handle: first)
        throw TestFailure.failed("evicted image handle remained resolvable")
    } catch ImageHandleStoreError.invalidHandle {
        // Expected.
    }
    _ = try store.resolve(sessionId: "image-a", handle: second)
    _ = try store.resolve(sessionId: "image-a", handle: third)

    var forged = third
    forged = CaptureImageHandle(
        token: forged.token, sessionId: forged.sessionId, format: forged.format,
        pixelWidth: forged.pixelWidth, pixelHeight: forged.pixelHeight,
        byteCount: forged.byteCount, sha256: String(repeating: "0", count: 64),
        createdAtMs: forged.createdAtMs
    )
    do {
        _ = try store.resolve(sessionId: "image-a", handle: forged)
        throw TestFailure.failed("mutated image descriptor resolved by token alone")
    } catch ImageHandleStoreError.invalidHandle {
        // Expected.
    }
    store.reset(sessionId: "image-a")
    try expect(store.retainedCount(sessionId: "image-a") == 0,
               "session reset retained image bytes")
}

private func testCaptureImageEncodingPolicy() throws {
    let width = 4
    let height = 2
    guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
          let fixture = CGContext(
            data: nil, width: width, height: height,
            bitsPerComponent: 8, bytesPerRow: width * 4, space: colorSpace,
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue)
                .union(.byteOrder32Big).rawValue
          ) else {
        throw TestFailure.failed("could not construct synthetic capture image")
    }
    fixture.setFillColor(CGColor(red: 0, green: 0, blue: 1, alpha: 1))
    fixture.fill(CGRect(x: 0, y: 0, width: width, height: height))
    // Quartz drawing space is bottom-left: this is visually the upper half.
    fixture.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
    fixture.fill(CGRect(x: 0, y: 1, width: width, height: 1))
    guard let source = fixture.makeImage() else {
        throw TestFailure.failed("could not finish synthetic capture image")
    }

    let encoder = try CaptureImageEncoder()
    let topRow = try encoder.encode(source, request: .init(
        format: .png,
        maxDimension: 1_456,
        sourcePixelRect: CuRect(x: 0, y: 0, width: 4, height: 1)
    ))
    try expect(Array(topRow.bytes.prefix(8)) == [137, 80, 78, 71, 13, 10, 26, 10],
               "precision capture was not encoded as PNG")
    try expect(topRow.pixelWidth == 4 && topRow.pixelHeight == 1,
               "PNG crop dimensions changed")
    try expect(topRow.transform.sourcePixelRect == CuRect(x: 0, y: 0, width: 4, height: 1),
               "encoded image lost its top-left crop transform")

    guard let decodedSource = CGImageSourceCreateWithData(topRow.bytes as CFData, nil),
          let decoded = CGImageSourceCreateImageAtIndex(decodedSource, 0, nil) else {
        throw TestFailure.failed("encoded PNG could not be decoded")
    }
    var sampled = [UInt8](repeating: 0, count: 4)
    sampled.withUnsafeMutableBytes { storage in
        let sampleContext = CGContext(
            data: storage.baseAddress, width: 1, height: 1,
            bitsPerComponent: 8, bytesPerRow: 4, space: colorSpace,
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue)
                .union(.byteOrder32Big).rawValue
        )!
        sampleContext.draw(decoded, in: CGRect(x: 0, y: 0, width: 1, height: 1))
    }
    guard sampled[0] > 220,
          Int(sampled[0]) - Int(sampled[1]) > 150,
          Int(sampled[0]) - Int(sampled[2]) > 150 else {
        throw TestFailure.failed("top-left crop was vertically inverted during encoding: \(sampled)")
    }

    let modelImage = try encoder.encode(source, request: .init(
        format: .jpeg, maxDimension: 2, jpegQuality: 0.85
    ))
    try expect(Array(modelImage.bytes.prefix(2)) == [255, 216],
               "vision capture was not encoded as JPEG")
    try expect(modelImage.pixelWidth == 2 && modelImage.pixelHeight == 1,
               "longest-edge model scaling did not preserve aspect ratio")
    guard let jpegSource = CGImageSourceCreateWithData(modelImage.bytes as CFData, nil),
          let jpeg = CGImageSourceCreateImageAtIndex(jpegSource, 0, nil) else {
        throw TestFailure.failed("encoded JPEG could not be decoded")
    }
    try expect(jpeg.width == 2 && jpeg.height == 1, "JPEG metadata disagreed with its descriptor")

    let encodedStore = ImageHandleStore(maxHandlesPerSession: 1, maxBytesPerSession: 1_024)
    let encodedHandle = try encodedStore.retain(sessionId: "encoded", image: modelImage)
    let retainedEncoding = try encodedStore.resolve(sessionId: "encoded", handle: encodedHandle)
    try expect(retainedEncoding.bytes == modelImage.bytes
        && retainedEncoding.transform == modelImage.transform
        && retainedEncoding.handle.format == .jpeg,
        "encoded pool frame lost bytes or transform when retained by handle")

    do {
        _ = try encoder.encode(source, request: .init(maxDimension: 0))
        throw TestFailure.failed("zero image dimension limit was accepted")
    } catch CaptureImageEncoderError.invalidLimit {
        // Expected.
    }
    do {
        _ = try encoder.encode(source, request: .init(jpegQuality: 1.1))
        throw TestFailure.failed("invalid JPEG quality was accepted")
    } catch CaptureImageEncoderError.invalidQuality {
        // Expected.
    }
    do {
        _ = try encoder.encode(source, request: .init(
            sourcePixelRect: CuRect(x: 3, y: 0, width: 2, height: 1)
        ))
        throw TestFailure.failed("out-of-bounds crop was accepted")
    } catch CaptureImageEncoderError.invalidCrop {
        // Expected.
    }
}

private func testSOMRenderingLayout() throws {
    guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(
            data: nil, width: 100, height: 60,
            bitsPerComponent: 8, bytesPerRow: 400, space: colorSpace,
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue)
                .union(.byteOrder32Big).rawValue
          ) else {
        throw TestFailure.failed("could not construct SOM source image")
    }
    context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: 100, height: 60))
    guard let source = context.makeImage() else {
        throw TestFailure.failed("could not finish SOM source image")
    }

    let elements = [
        SOMElement(index: 0, bounds: CuRect(x: 1, y: 1, width: 20, height: 10)),
        SOMElement(index: 1, bounds: CuRect(x: 1, y: 1, width: 20, height: 10)),
        SOMElement(index: 2, bounds: CuRect(x: 30, y: 20, width: 0, height: 10)),
        SOMElement(index: 3, bounds: CuRect(x: 70, y: 50, width: 40, height: 20)),
    ]
    let renderer = SOMRenderer()
    let rendered = try renderer.render(source: source, elements: elements)
    try expect(rendered.image.width == 107 && rendered.image.height == 67,
               "SOM canvas did not preserve the upstream 1.5x padding rule")
    try expect(rendered.sourceContentRect == CuRect(x: 5, y: 5, width: 100, height: 60),
               "SOM result did not report the source image's padded location")
    try expect(rendered.annotations.map(\.index) == [0, 3],
               "SOM did not suppress duplicate/empty boxes while preserving original indexes")
    try expect(rendered.annotations[0].bounds == CuRect(x: 6, y: 6, width: 20, height: 10),
               "SOM box was not shifted by the declared padding")
    try expect(rendered.annotations[0].tagBounds.y == 16,
               "top-edge SOM label was not moved below its box")
    try expect(rendered.annotations[1].bounds == CuRect(x: 75, y: 55, width: 30, height: 10),
               "partially off-image SOM box was not clipped before annotation")

    let repeated = try renderer.render(source: source, elements: elements)
    try expect(repeated.annotations.map(\.color) == rendered.annotations.map(\.color),
               "SOM colors were not deterministic per original index")
    let encoded = try CaptureImageEncoder().encode(rendered.image, request: .init(
        format: .png, maxDimension: 4_096
    ))
    try expect(encoded.pixelWidth == 107 && encoded.pixelHeight == 67,
               "SOM image could not pass through precision PNG encoding")
}

do {
    let tests: [(String, () throws -> Void)] = [
        ("wire round-trips", testWireRoundTrips),
        ("handshake", testHandshake),
        ("protocol fail-closed", testProtocolFailClosed),
        ("session isolation", testSessionIsolation),
        ("malformed wire error", testMalformedWireError),
        ("workspace requires session", testWorkspaceRequiresSession),
        ("workspace snapshot", testWorkspaceSnapshot),
        ("AX observation is session-bound", testAXObservationIsSessionBound),
        ("AX capture race fails closed", testAXCaptureRaceFailsClosed),
        ("semantic action live revalidation", testSemanticActionLiveRevalidation),
        ("semantic action races fail closed", testSemanticActionRacesFailClosed),
        ("semantic action authority policy", testSemanticActionAuthorityPolicy),
        ("observation scope and partial policy", testObservationScopeAndPartialPolicy),
        ("text and scroll wire round-trips", testTextScrollWireRoundTrips),
        ("text match resolution", testTextMatchResolution),
        ("text range and caret bounds", testTextRangeAndCaretBounds),
        ("text and scroll request shape policy", testTextScrollRequestShapePolicy),
        ("selection range AXValue encoding", testSelectionRangeEncoding),
        ("scroll percent parsing", testScrollPercentParsing),
        ("scroll pattern mapping", testScrollPatternMapping),
        ("text and scroll action pipeline", testTextScrollActionPipeline),
        ("hung application does not block other sessions", testHungApplicationDoesNotBlockOtherSessions),
        ("observation query filtering", testObservationQueryFiltering),
        ("query-filtered snapshots are not diffed against full state", testQueryFilteredSnapshotsAreNotDiffedAgainstFullState),
        ("app workspace resolve and launch policy", testAppWorkspaceResolveAndLaunchPolicy),
        ("app workspace path refusal and foreground honesty", testAppWorkspaceRefusesPathsAndReportsForegroundTheft),
        ("app workspace service operations", testAppWorkspaceServiceOperations),
        ("file workspace policy", testFileWorkspacePolicy),
        ("file workspace deletion and scheme refusal", testFileWorkspaceRefusesDangerousDeletionAndSchemes),
        ("file workspace service operations", testFileWorkspaceServiceOperations),
        ("window operation honesty", testWindowOperationHonesty),
        ("window operation request policy", testWindowOperationRequestPolicy),
        ("display usable bounds geometry", testDisplayUsableBoundsGeometry),
        ("control pattern classification", testControlPatternClassification),
        ("selection state and scroll-to-visible policy", testSelectionStateAndScrollToVisiblePolicy),
        ("scroll-to-fraction policy", testScrollToFractionPolicy),
        ("window intersection clipping", testWindowIntersectionClipping),
        ("development identity policy", testDevelopmentIdentityPolicy),
        ("connection lifecycle diagnostics", testConnectionLifecycleDiagnostics),
        ("retained snapshot diff replay and eviction", testRetainedSnapshotDiffReplayAndEviction),
        ("snapshot session isolation and malformed diff", testSnapshotSessionIsolationAndMalformedDiff),
        ("data-only XPC transport", testDataOnlyXPCTransport),
        ("typed capture handle lifecycle", testTypedCaptureHandleLifecycle),
        ("SOM snapshot authority and transform", testSOMCaptureSnapshotAuthorityAndTransform),
        ("zoom capture contract", testZoomCaptureContract),
        ("image analysis handle contract", testImageAnalysisHandleContract),
        ("adaptive evidence and postconditions", testAdaptiveEvidenceAndPostconditions),
        ("focus lease restore semantics", testFocusLeaseRestoreSemantics),
        ("desktop focus broker contract", testDesktopFocusBrokerContract),
        ("delivery policy authorization", testDeliveryPolicyAuthorization),
        ("delivery policy wire round-trips", testDeliveryPolicyWireRoundTrips),
        ("delivery ladder", testDeliveryLadder),
        ("physical input arbiter", testPhysicalInputArbiter),
        ("semantic transaction manifest vector", testSemanticTransactionManifestVector),
        ("semantic transactions", testSemanticTransactions),
        ("capture geometry mixed DPI", testCaptureGeometryMixedDPI),
        ("capture stream pool lifecycle", testCaptureStreamPoolLifecycle),
        ("image handle store and transforms", testImageHandleStoreAndTransforms),
        ("capture image encoding policy", testCaptureImageEncodingPolicy),
        ("SOM rendering layout", testSOMRenderingLayout),
    ]
    for (name, test) in tests {
        try test()
        FileHandle.standardOutput.write(Data("PASS \(name)\n".utf8))
    }
    FileHandle.standardOutput.write(Data("Bimax-Cu native foundation: \(tests.count)/\(tests.count) passed\n".utf8))
} catch {
    FileHandle.standardError.write(Data("FAIL \(error)\n".utf8))
    exit(EXIT_FAILURE)
}
