import Foundation
import BimaxCuProtocol

private struct ServiceFault: Error {
    var code: String
    var message: String
    var retryable = false
}

public struct BinaryImageReadResult: Sendable {
    public var bytes: Data?
    public var error: CuError?

    public init(bytes: Data? = nil, error: CuError? = nil) {
        self.bytes = bytes
        self.error = error
    }
}

public final class BimaxCuServiceCore: @unchecked Sendable {
    public let serviceVersion: String
    public let sessions: SessionRegistry
    private let permissions: any PermissionStateProviding
    private let workspace: any WorkspaceInventoryProviding
    private let appWorkspace: any AppWorkspaceOperating
    private let fileWorkspace: any FileWorkspaceOperating
    private let windowOperations: any WindowOperating
    private let accessibility: any AXObserving
    public let axSnapshots: AXSnapshotStore
    public let axEvents: any AXEventTracking
    public let semanticActions: any AXSemanticActionExecuting
    public let focusLeases: any FocusLeasing
    /// Gates physical input. Targeted keyboard posting is implemented; global-stream mouse and
    /// keyboard delivery remains unavailable.
    public let physicalInput: PhysicalInputArbiter
    public let capture: any CaptureServicing
    public let images: ImageHandleStore
    public let somComposer: SOMCaptureComposer
    public let imageAnalysis: ImageAnalysisService
    public let evidenceSettler: AdaptiveEvidenceSettler
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(
        serviceVersion: String = "0.7.0",
        sessions: SessionRegistry = SessionRegistry(),
        permissions: any PermissionStateProviding = PermissionDoctor(),
        workspace: any WorkspaceInventoryProviding = WorkspaceInventory(),
        appWorkspace: any AppWorkspaceOperating = AppWorkspace(),
        fileWorkspace: any FileWorkspaceOperating = FileWorkspace(),
        windowOperations: any WindowOperating = WindowOperations(),
        accessibility: any AXObserving = AccessibilityEngine(),
        axSnapshots: AXSnapshotStore = AXSnapshotStore(),
        axEvents: any AXEventTracking = AXEventTracker(),
        semanticActions: any AXSemanticActionExecuting = AXSemanticActionEngine(),
        focusLeases: any FocusLeasing = FocusLeaseManager(),
        physicalInput: PhysicalInputArbiter = PhysicalInputArbiter(),
        capture: any CaptureServicing = ScreenCaptureService(),
        images: ImageHandleStore = ImageHandleStore(),
        somComposer: SOMCaptureComposer = SOMCaptureComposer(),
        imageAnalysis: ImageAnalysisService = ImageAnalysisService(),
        evidenceSettler: AdaptiveEvidenceSettler = AdaptiveEvidenceSettler()
    ) {
        self.serviceVersion = serviceVersion
        self.sessions = sessions
        self.permissions = permissions
        self.workspace = workspace
        self.appWorkspace = appWorkspace
        self.fileWorkspace = fileWorkspace
        self.windowOperations = windowOperations
        self.accessibility = accessibility
        self.axSnapshots = axSnapshots
        self.axEvents = axEvents
        self.semanticActions = semanticActions
        self.focusLeases = focusLeases
        self.physicalInput = physicalInput
        self.capture = capture
        self.images = images
        self.somComposer = somComposer
        self.imageAnalysis = imageAnalysis
        self.evidenceSettler = evidenceSettler
        encoder.outputFormatting = [.sortedKeys]
    }

    public func handle(data: Data) -> Data {
        do {
            let request = try decoder.decode(RequestEnvelope.self, from: data)
            return try encoder.encode(handle(request))
        } catch {
            let response = ResponseEnvelope(
                requestId: "unknown",
                sessionId: "",
                serviceVersion: serviceVersion,
                error: CuError(code: "malformed_request", message: String(describing: error))
            )
            return (try? encoder.encode(response)) ?? Data()
        }
    }

    public func handle(_ request: RequestEnvelope) -> ResponseEnvelope {
        do {
            guard request.protocol == BimaxCuProtocolVersion.v1 else {
                throw ServiceFault(code: "incompatible_protocol", message: "service supports only \(BimaxCuProtocolVersion.v1)")
            }
            guard (1...120_000).contains(request.deadlineMs) else {
                throw ServiceFault(code: "invalid_deadline", message: "deadlineMs must be between 1 and 120000")
            }
            let body: ResponseBody
            switch request.body {
            case .handshake(let handshake):
                guard handshake.supportedProtocols.contains(BimaxCuProtocolVersion.v1) else {
                    throw ServiceFault(code: "no_common_protocol", message: "client does not support \(BimaxCuProtocolVersion.v1)")
                }
                body = .handshake(handshakeResponse())
            case .sessionCreate(let requestedId):
                body = .session(try sessions.create(requestedId: requestedId))
            case .sessionStatus:
                body = .session(try sessions.status(request.sessionId))
            case .sessionReset:
                body = .session(try sessions.reset(request.sessionId))
                accessibility.reset(sessionId: request.sessionId)
                axSnapshots.reset(sessionId: request.sessionId)
                axEvents.reset(sessionId: request.sessionId)
                images.reset(sessionId: request.sessionId)
                capture.reset(sessionId: request.sessionId)
                // Cancellation must not leave the human looking at an application Bimax raised.
                focusLeases.releaseAll(sessionId: request.sessionId)
            case .sessionClose:
                try sessions.close(request.sessionId)
                accessibility.reset(sessionId: request.sessionId)
                axSnapshots.reset(sessionId: request.sessionId)
                axEvents.reset(sessionId: request.sessionId)
                images.reset(sessionId: request.sessionId)
                capture.reset(sessionId: request.sessionId)
                focusLeases.releaseAll(sessionId: request.sessionId)
                body = .sessionClosed
            case .workspaceSnapshot(let snapshotRequest):
                // Inventory is read-only but still session-bound: no task may receive target
                // identities outside an explicitly created lifecycle.
                _ = try sessions.status(request.sessionId)
                body = .workspace(try workspace.snapshot(snapshotRequest))
            case .appResolve(let resolveRequest):
                // Read-only Launch Services lookup. It starts nothing, so it needs no capability
                // beyond a live session — but it is still session-bound, like every other
                // identity-producing operation.
                _ = try sessions.status(request.sessionId)
                body = .appResolved(try appWorkspace.resolve(resolveRequest))
            case .appLaunch(let launchRequest):
                _ = try sessions.status(request.sessionId)
                body = .appLaunchReceipt(try appWorkspace.launch(launchRequest))
            case .fileInspect(let inspectRequest):
                _ = try sessions.status(request.sessionId)
                body = .fileInfo(try fileWorkspace.inspect(inspectRequest))
            case .fileOperation(let fileRequest):
                _ = try sessions.status(request.sessionId)
                body = .fileOperationReceipt(try fileWorkspace.perform(fileRequest, resolving: resolveApplicationBundle))
            case .windowOperation(let windowRequest):
                _ = try sessions.status(request.sessionId)
                // The exact-window rule: a generation issued by an earlier inventory cannot
                // authorize a mutation of whatever window now holds that id.
                try validateWindowGeneration(windowRequest.window)
                body = .windowOperationReceipt(try windowOperations.perform(
                    windowRequest, frontmostPid: { WorkspaceInventory.frontmostPid() }
                ))
            case .urlOpen(let urlRequest):
                _ = try sessions.status(request.sessionId)
                body = .urlOpenReceipt(try fileWorkspace.openURL(urlRequest, resolving: resolveApplicationBundle))
            case .axObserve(let observeRequest):
                _ = try sessions.status(request.sessionId)
                var effectiveRequest = observeRequest
                guard (1...2_000).contains(observeRequest.maxElements) else {
                    throw ServiceFault(code: "invalid_ax_limit", message: "maxElements must be between 1 and 2000")
                }
                guard (100...5_000).contains(observeRequest.maxDurationMs) else {
                    throw ServiceFault(code: "invalid_ax_duration", message: "maxDurationMs must be between 100 and 5000")
                }
                effectiveRequest.maxDurationMs = min(observeRequest.maxDurationMs, request.deadlineMs)
                guard observeRequest.profile == "flash" || observeRequest.profile == "balanced" else {
                    throw ServiceFault(code: "unsupported_observation_profile", message: "profile must be flash or balanced")
                }
                if let query = observeRequest.query {
                    guard !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                          query.count <= 256, !query.contains("\0") else {
                        throw ServiceFault(code: "invalid_observation_query", message: "query must be 1-256 characters and contain no NUL")
                    }
                }
                switch observeRequest.scope {
                case .window:
                    guard let windowId = observeRequest.windowId else {
                        throw ServiceFault(code: "invalid_observation_scope", message: "window scope requires windowId")
                    }
                    let snapshot = try workspace.snapshot(.init(pid: observeRequest.pid, includeOffscreenWindows: true))
                    guard let window = snapshot.windows.first(where: {
                        $0.window.pid == observeRequest.pid && $0.window.windowId == windowId
                    }) else {
                        throw ServiceFault(code: "window_not_found", message: "window is no longer owned by the requested process")
                    }
                    if let expectedGeneration = observeRequest.windowGeneration,
                       window.window.generation != expectedGeneration {
                        throw ServiceFault(code: "stale_window_ref", message: "window generation changed; resolve the target again")
                    }
                    if let bundleId = snapshot.apps.first(where: { $0.app.pid == observeRequest.pid })?.app.bundleId?.lowercased(),
                       Self.systemUIBundleIds.contains(bundleId) {
                        throw ServiceFault(code: "system_ui_scope_required", message: "allowlisted macOS system UI processes require system_ui scope")
                    }
                case .application:
                    guard observeRequest.windowId == nil, observeRequest.windowGeneration == nil else {
                        throw ServiceFault(code: "invalid_observation_scope", message: "application scope cannot include a window ref")
                    }
                    let snapshot = try workspace.snapshot(.init(pid: observeRequest.pid, includeOffscreenWindows: true))
                    if let bundleId = snapshot.apps.first(where: { $0.app.pid == observeRequest.pid })?.app.bundleId?.lowercased(),
                       Self.systemUIBundleIds.contains(bundleId) {
                        throw ServiceFault(code: "system_ui_scope_required", message: "allowlisted macOS system UI processes require system_ui scope")
                    }
                case .systemUI:
                    guard observeRequest.windowId == nil, observeRequest.windowGeneration == nil else {
                        throw ServiceFault(code: "invalid_observation_scope", message: "system_ui scope cannot include a window ref")
                    }
                    let snapshot = try workspace.snapshot(.init(pid: observeRequest.pid, includeOffscreenWindows: true))
                    guard let bundleId = snapshot.apps.first(where: { $0.app.pid == observeRequest.pid })?.app.bundleId?.lowercased(),
                          Self.systemUIBundleIds.contains(bundleId) else {
                        throw ServiceFault(code: "system_ui_scope_denied", message: "PID is not an allowlisted macOS system UI process")
                    }
                }
                let before = axEvents.begin(sessionId: request.sessionId, pid: observeRequest.pid)
                var full = try accessibility.observe(sessionId: request.sessionId, request: effectiveRequest)
                let after = axEvents.checkpoint(sessionId: request.sessionId, pid: observeRequest.pid)
                full.scope = effectiveRequest.scope
                full.partial = full.partial || !full.issues.isEmpty
                full.eventTracking = before.tracking && after.tracking
                full.eventRevision = after.revision
                full.changedDuringCapture = full.eventTracking && before.revision != after.revision
                // A graph that changed while it was being walked may contain mixed epochs. Return
                // it as explicit unstable evidence, but do not retain its refs or use it as a diff.
                body = .axSnapshot(full.changedDuringCapture || full.partial || full.truncated
                    ? full
                    : try axSnapshots.retain(full: full, since: observeRequest.sinceSnapshotId))
            case .semanticAction(let actionRequest):
                _ = try sessions.status(request.sessionId)
                body = try performSemanticAction(
                    actionRequest,
                    sessionId: request.sessionId,
                    deadlineMs: request.deadlineMs
                )
            case .semanticTransaction(let transactionRequest):
                _ = try sessions.status(request.sessionId)
                body = .semanticTransactionReceipt(try performSemanticTransaction(
                    transactionRequest,
                    sessionId: request.sessionId
                ))
            case .captureImage(let captureRequest):
                _ = try sessions.status(request.sessionId)
                body = .captureImageReceipt(try performCapture(
                    captureRequest,
                    sessionId: request.sessionId
                ))
            case .imageRelease(let releaseRequest):
                _ = try sessions.status(request.sessionId)
                let handle = Self.internalImageHandle(releaseRequest.image)
                let stored = try images.resolve(sessionId: request.sessionId, handle: handle)
                guard Self.wireTransform(stored.transform) == releaseRequest.image.transform else {
                    throw ImageHandleStoreError.invalidHandle
                }
                try images.release(sessionId: request.sessionId, handle: handle)
                body = .imageReleased
            case .imageAnalyze(let analysisRequest):
                _ = try sessions.status(request.sessionId)
                let handle = Self.internalImageHandle(analysisRequest.image)
                let stored = try images.resolve(sessionId: request.sessionId, handle: handle)
                guard Self.wireTransform(stored.transform) == analysisRequest.image.transform else {
                    throw ImageHandleStoreError.invalidHandle
                }
                guard !analysisRequest.fingerprintRegions.isEmpty
                        || analysisRequest.ocrRegion != nil else {
                    throw ServiceFault(
                        code: "empty_image_analysis",
                        message: "image analysis requires fingerprint regions or an OCR region"
                    )
                }
                let result = try imageAnalysis.analyze(
                    bytes: stored.bytes,
                    expectedWidth: stored.handle.pixelWidth,
                    expectedHeight: stored.handle.pixelHeight,
                    fingerprintRegions: analysisRequest.fingerprintRegions,
                    ocrRegion: analysisRequest.ocrRegion,
                    ocrQuery: analysisRequest.ocrQuery
                )
                body = .imageAnalysis(.init(
                    image: analysisRequest.image,
                    fingerprints: result.fingerprints,
                    texts: result.texts,
                    errors: result.errors,
                    latencyMs: result.latencyMs
                ))
            }
            return ResponseEnvelope(
                requestId: request.requestId,
                sessionId: request.sessionId,
                serviceVersion: serviceVersion,
                body: body
            )
        } catch let fault as ServiceFault {
            return failure(request, code: fault.code, message: fault.message, retryable: fault.retryable)
        } catch let error as SessionRegistryError {
            return failure(request, code: Self.sessionErrorCode(error), message: String(describing: error))
        } catch let error as AXObservationError {
            return failure(request, code: Self.axErrorCode(error), message: String(describing: error), retryable: error == .permissionDenied)
        } catch let error as AXSnapshotStoreError {
            return failure(request, code: Self.snapshotErrorCode(error), message: String(describing: error))
        } catch let error as AXSemanticActionError {
            return failure(request, code: Self.semanticActionErrorCode(error), message: Self.semanticActionErrorMessage(error))
        } catch let error as FocusLeaseError {
            return failure(request, code: Self.focusLeaseErrorCode(error), message: String(describing: error))
        } catch let error as CaptureServiceError {
            return failure(
                request,
                code: Self.captureErrorCode(error),
                message: String(describing: error),
                retryable: error == .permissionDenied || error == .timedOut
            )
        } catch let error as ImageHandleStoreError {
            return failure(request, code: Self.imageErrorCode(error), message: String(describing: error))
        } catch let error as ImageAnalysisError {
            return failure(request, code: Self.imageAnalysisErrorCode(error), message: String(describing: error))
        } catch let error as AppWorkspaceError {
            return failure(
                request,
                code: Self.appWorkspaceErrorCode(error),
                message: Self.appWorkspaceErrorMessage(error),
                retryable: error == .launchTimedOut
            )
        } catch let error as FileWorkspaceError {
            return failure(
                request,
                code: Self.fileWorkspaceErrorCode(error),
                message: Self.fileWorkspaceErrorMessage(error)
            )
        } catch let error as WindowOperationError {
            return failure(
                request,
                code: Self.windowOperationErrorCode(error),
                message: Self.windowOperationErrorMessage(error)
            )
        } catch {
            return failure(request, code: "internal_error", message: String(describing: error), retryable: true)
        }
    }

    public func readImage(_ request: ImageHandleReadRequest) -> BinaryImageReadResult {
        do {
            _ = try sessions.status(request.sessionId)
            let handle = Self.internalImageHandle(request.image)
            let stored = try images.resolve(sessionId: request.sessionId, handle: handle)
            guard Self.wireTransform(stored.transform) == request.image.transform else {
                throw ImageHandleStoreError.invalidHandle
            }
            return BinaryImageReadResult(bytes: stored.bytes)
        } catch let error as SessionRegistryError {
            return BinaryImageReadResult(error: CuError(
                code: Self.sessionErrorCode(error), message: String(describing: error)
            ))
        } catch let error as ImageHandleStoreError {
            return BinaryImageReadResult(error: CuError(
                code: Self.imageErrorCode(error), message: String(describing: error)
            ))
        } catch {
            return BinaryImageReadResult(error: CuError(
                code: "internal_error", message: String(describing: error), retryable: true
            ))
        }
    }

    private func performCapture(
        _ request: CaptureImageRequest,
        sessionId: String
    ) throws -> CaptureImageReceipt {
        guard (1...4_096).contains(request.maxDimension) else {
            throw ServiceFault(code: "invalid_image_limit", message: "maxDimension must be between 1 and 4096")
        }
        guard request.jpegQuality >= 0, request.jpegQuality <= 1 else {
            throw ServiceFault(code: "invalid_jpeg_quality", message: "jpegQuality must be between 0 and 1")
        }
        guard request.zoomFactor > 0, request.zoomFactor <= 8 else {
            throw ServiceFault(code: "invalid_zoom_factor", message: "zoomFactor must be greater than 0 and at most 8")
        }
        if let region = request.region {
            guard region.x >= 0, region.y >= 0, region.width > 0, region.height > 0 else {
                throw ServiceFault(code: "invalid_capture_region", message: "region must be a positive top-left pixel rectangle")
            }
        }
        let current = try workspace.snapshot(.init(includeOffscreenWindows: true))
        var targetWindow: WindowInfo?
        switch request.target {
        case .window(let target):
            guard let window = current.windows.first(where: {
                $0.window.pid == target.pid
                    && $0.window.windowId == target.windowId
                    && $0.window.generation == target.generation
            }) else {
                throw ServiceFault(code: "stale_window_ref", message: "capture target window generation is stale")
            }
            targetWindow = window
        case .display(let displayId):
            guard current.displays.contains(where: { $0.displayId == displayId }) else {
                throw ServiceFault(code: "display_not_found", message: "capture target display is unavailable")
            }
        }

        let encoded: EncodedCaptureImage
        var marks: [SOMMarkRef] = []
        var sourceContentRect: CuRect?
        switch request.mode {
        case .image:
            guard request.basedOnSnapshotId == nil else {
                throw ServiceFault(
                    code: "unexpected_capture_snapshot",
                    message: "basedOnSnapshotId is valid only for SOM captures"
                )
            }
            guard request.zoomFactor == 1 else {
                throw ServiceFault(code: "unexpected_zoom_factor", message: "zoomFactor is valid only for zoom captures")
            }
            encoded = try capture.capture(sessionId: sessionId, request: request)
        case .som:
            guard request.zoomFactor == 1 else {
                throw ServiceFault(code: "unexpected_zoom_factor", message: "SOM capture cannot apply an additional zoom factor")
            }
            guard case .window(let target) = request.target, let targetWindow else {
                throw ServiceFault(code: "invalid_som_target", message: "SOM capture requires an exact window target")
            }
            guard request.region == nil else {
                throw ServiceFault(code: "invalid_som_region", message: "SOM capture cannot be combined with a source crop")
            }
            guard let snapshotId = request.basedOnSnapshotId,
                  !snapshotId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  !snapshotId.contains("\0") else {
                throw ServiceFault(code: "missing_som_snapshot", message: "SOM capture requires basedOnSnapshotId")
            }
            let snapshot = try axSnapshots.resolveSnapshot(
                sessionId: sessionId,
                snapshotId: snapshotId
            )
            guard snapshot.pid == target.pid,
                  snapshot.windowId == target.windowId,
                  snapshot.windowGeneration == target.generation,
                  snapshot.scope == .window else {
                throw ServiceFault(
                    code: "snapshot_target_mismatch",
                    message: "the retained AX snapshot does not authorize this exact window generation"
                )
            }
            let sourceRequest = CaptureImageRequest(
                target: request.target,
                mode: .image,
                format: .png,
                maxDimension: 4_096,
                jpegQuality: 1
            )
            let source = try capture.capture(sessionId: sessionId, request: sourceRequest)
            do {
                let composition = try somComposer.compose(
                    source: source,
                    windowBounds: targetWindow.bounds,
                    snapshot: snapshot,
                    format: request.format,
                    maxDimension: request.maxDimension,
                    jpegQuality: request.jpegQuality
                )
                encoded = composition.encoded
                marks = composition.marks
                sourceContentRect = composition.sourceContentRect
            } catch {
                throw ServiceFault(code: "som_compose_failed", message: String(describing: error))
            }
        case .zoom:
            guard case .window = request.target, targetWindow != nil else {
                throw ServiceFault(code: "invalid_zoom_target", message: "zoom capture requires an exact window target")
            }
            guard request.region != nil else {
                throw ServiceFault(code: "missing_zoom_region", message: "zoom capture requires a source pixel rectangle")
            }
            guard request.basedOnSnapshotId == nil else {
                throw ServiceFault(code: "unexpected_capture_snapshot", message: "zoom capture does not consume AX snapshot authority")
            }
            encoded = try capture.capture(sessionId: sessionId, request: request)
        }
        let handle = try images.retain(sessionId: sessionId, image: encoded)
        return CaptureImageReceipt(
            target: request.target,
            image: Self.wireImageHandle(handle, transform: encoded.transform),
            mode: request.mode,
            marks: marks,
            sourceContentRect: sourceContentRect
        )
    }

    /// Delivery is decided here, once, before anything is performed.
    ///
    /// The order matters: the policy is authorized, then the target is revalidated, then a lease is
    /// taken only if the policy earned one. A lease is always released on the way out — including
    /// when the action throws — so a refused action can never leave the human's focus somewhere
    /// they did not put it.
    private func performSemanticAction(
        _ actionRequest: SemanticActionRequest,
        sessionId: String,
        deadlineMs: Int
    ) throws -> ResponseBody {
        let policy = actionRequest.deliveryPolicy
        try authorizeDelivery(actionRequest)

        guard actionRequest.element.windowId != nil,
              actionRequest.element.windowGeneration != nil else {
            throw ServiceFault(
                code: "action_requires_exact_window",
                message: "semantic actions currently require a generation-bound window element ref"
            )
        }
        let authority = try axSnapshots.resolveAuthority(sessionId: sessionId, ref: actionRequest.element)
        let automaticEvidenceTier = SemanticEvidencePolicy.automaticTier(for: actionRequest.action)
        let evidenceRequirement = actionRequest.evidence ?? EvidenceRequirement(
            tier: automaticEvidenceTier,
            settleTimeoutMs: min(750, deadlineMs)
        )
        guard (50...5_000).contains(evidenceRequirement.settleTimeoutMs) else {
            throw ServiceFault(
                code: "invalid_settle_timeout",
                message: "settleTimeoutMs must be between 50 and 5000"
            )
        }
        guard evidenceRequirement.tier <= automaticEvidenceTier else {
            throw ServiceFault(
                code: "evidence_tier_unavailable",
                message: "this semantic delivery path cannot produce the requested evidence tier"
            )
        }
        if let postcondition = evidenceRequirement.postcondition {
            do { try SemanticEvidencePolicy.validate(postcondition) }
            catch {
                throw ServiceFault(code: "invalid_postcondition", message: String(describing: error))
            }
            if SemanticEvidencePolicy.matches(
                postcondition,
                before: authority.node,
                snapshot: authority.snapshot,
                stablePathHash: authority.node.stablePathHash
            ) {
                throw ServiceFault(
                    code: "postcondition_preexisting",
                    message: "the declared postcondition was already true before delivery"
                )
            }
        }
        guard authority.snapshot.eventTracking else {
            throw ServiceFault(
                code: "event_tracking_unavailable",
                message: "the authorizing snapshot was captured without AX event tracking"
            )
        }
        guard actionRequest.expectedEventRevision == authority.snapshot.eventRevision else {
            throw ServiceFault(code: "stale_event_revision", message: "expected event revision does not match the authorizing snapshot")
        }
        let startedAtMs = Self.nowMs
        let workspaceBefore = try validatedWorkspace(for: actionRequest.element)
        let epochBefore = axEvents.checkpoint(sessionId: sessionId, pid: actionRequest.element.pid)
        guard epochBefore.tracking,
              epochBefore.revision == authority.snapshot.eventRevision else {
            throw ServiceFault(code: "stale_element_ref", message: "the target changed after the authorizing snapshot")
        }

        var leaseReceipt: FocusLeaseReceipt?
        var heldLeaseId: String?
        if policy.requiresApproval {
            let lease = try focusLeases.acquire(
                sessionId: sessionId,
                policy: policy,
                targetPid: actionRequest.element.pid,
                targetWindowId: actionRequest.element.windowId,
                options: actionRequest.focusLease ?? FocusLeaseOptions()
            )
            heldLeaseId = lease.leaseId
        }
        func releaseLease() {
            guard let heldLeaseId else { return }
            leaseReceipt = try? focusLeases.release(leaseId: heldLeaseId)
        }

        if actionRequest.action == .typeText {
            let mechanism: PhysicalInputMechanism = policy.requiresApproval
                ? .globalStream : .targetedProcess
            let decision = physicalInput.decide(
                mechanism: mechanism,
                policy: policy,
                targetPid: actionRequest.element.pid,
                targetWindowId: actionRequest.element.windowId,
                holdsFocusLease: heldLeaseId != nil
            )
            guard decision.allowed else {
                releaseLease()
                throw ServiceFault(
                    code: decision.refusals.first?.rawValue ?? "physical_input_refused",
                    message: "physical input refused: "
                        + decision.refusals.map(\.rawValue).joined(separator: ", ")
                )
            }
        }

        let execution: AXActionExecution
        do {
            execution = try semanticActions.execute(
                request: actionRequest,
                expected: authority.node
            ) { [self] in
                let latest = axEvents.checkpoint(sessionId: sessionId, pid: actionRequest.element.pid)
                guard latest.tracking, latest.revision == epochBefore.revision else {
                    throw ServiceFault(code: "action_preflight_race", message: "the target changed during live action revalidation")
                }
                _ = try validatedWorkspace(for: actionRequest.element)
            }
        } catch {
            releaseLease()
            // Only `background_preferred` may answer a refusal with a proposal, and only for the
            // refusals a foreground retry could plausibly change. Everything else is still an error:
            // offering to escalate past a stale ref or a missing action would be theatre.
            if policy == .backgroundPreferred,
               let proposal = escalationProposal(for: error, request: actionRequest) {
                return .escalationProposal(proposal)
            }
            throw error
        }

        let observeRequest = AXObserveRequest(
            pid: actionRequest.element.pid,
            windowId: actionRequest.element.windowId,
            windowGeneration: actionRequest.element.windowGeneration,
            scope: .window,
            profile: "flash",
            maxElements: 500,
            maxDurationMs: min(evidenceRequirement.settleTimeoutMs, deadlineMs)
        )
        let evidence = evidenceSettler.settle(
            requirement: evidenceRequirement,
            achievedTier: automaticEvidenceTier,
            before: authority.node,
            eventRevisionBefore: epochBefore.revision,
            observe: { [self] in
                try accessibility.observe(sessionId: sessionId, request: observeRequest)
            },
            eventRevision: { [self] in
                axEvents.checkpoint(
                    sessionId: sessionId,
                    pid: actionRequest.element.pid
                ).revision
            }
        )
        let epochAfter = axEvents.checkpoint(sessionId: sessionId, pid: actionRequest.element.pid)
        let workspaceAfter = try? workspace.snapshot(.init(pid: actionRequest.element.pid, includeOffscreenWindows: true))
        releaseLease()
        // A successful mutation invalidates every retained authority for this exact target,
        // even when the recipient has not delivered its AX notification yet.
        axSnapshots.invalidate(
            sessionId: sessionId,
            pid: actionRequest.element.pid,
            windowId: actionRequest.element.windowId
        )
        return .semanticActionReceipt(.init(
            actionId: UUID().uuidString.lowercased(),
            element: actionRequest.element,
            action: actionRequest.action,
            primitive: execution.primitive,
            outcome: execution.outcome,
            deliveryPolicy: policy,
            startedAtMs: startedAtMs,
            completedAtMs: Self.nowMs,
            eventRevisionBefore: epochBefore.revision,
            eventRevisionAfter: epochAfter.revision,
            frontmostPidBefore: workspaceBefore.frontmostPid,
            frontmostPidAfter: workspaceAfter?.frontmostPid,
            // Offsets, counts, and scroll percentages only. Selected text, surrounding
            // text, and element values never enter a receipt.
            textSelection: execution.textSelection,
            scroll: execution.scroll,
            // Absent on every background receipt, which is what makes its absence evidence.
            focusLease: leaseReceipt,
            deliveryPath: execution.deliveryPath,
            attemptedPaths: execution.attemptedPaths,
            typedText: execution.typedText,
            evidence: evidence
        ))
    }

    /// Executes the Phase 4 multi-edit/multi-select subset as one checked transaction.
    ///
    /// Every step is authorized from the same retained snapshot and shape-checked before the first
    /// mutation. Each mutation then revalidates the event epoch and exact window immediately before
    /// delivery. A late refusal returns a stopped receipt containing the steps that already ran;
    /// it is never flattened into an error that hides partial completion.
    private func performSemanticTransaction(
        _ request: SemanticTransactionRequest,
        sessionId: String
    ) throws -> SemanticTransactionReceipt {
        guard (1...5).contains(request.steps.count) else {
            throw ServiceFault(code: "invalid_transaction_size", message: "semantic transactions require 1-5 steps")
        }
        guard request.deliveryPolicy == .backgroundNative || request.deliveryPolicy == .backgroundOnly else {
            throw ServiceFault(
                code: "transaction_policy_unsupported",
                message: "Phase 4 semantic transactions accept only background_native or background_only"
            )
        }
        guard request.approvalManifestHash.count == 64,
              request.approvalManifestHash.allSatisfy({ $0.isHexDigit }),
              request.approvalManifestHash.lowercased() == (try request.computedManifestHash()) else {
            throw ServiceFault(code: "transaction_manifest_mismatch", message: "transaction steps do not match the manifest hash")
        }
        let ids = request.steps.map(\.stepId)
        guard Set(ids).count == ids.count,
              ids.allSatisfy({ !$0.isEmpty && $0.count <= 64 && !$0.contains("\0") }) else {
            throw ServiceFault(code: "invalid_transaction_step_id", message: "step ids must be unique, non-empty, and at most 64 characters")
        }
        let allowedActions: Set<SemanticActionKind> = [.setValue, .setSelected]
        guard request.steps.allSatisfy({ allowedActions.contains($0.action) }) else {
            throw ServiceFault(
                code: "transaction_action_unsupported",
                message: "Phase 4 semantic transactions accept only set_value and set_selected"
            )
        }
        guard let first = request.steps.first else {
            throw ServiceFault(code: "invalid_transaction_size", message: "semantic transactions require at least one step")
        }
        guard request.steps.allSatisfy({ step in
            step.element.snapshotId == request.basedOnSnapshotId
                && step.element.pid == first.element.pid
                && step.element.windowId == first.element.windowId
                && step.element.windowGeneration == first.element.windowGeneration
        }) else {
            throw ServiceFault(
                code: "transaction_target_mismatch",
                message: "every transaction step must use the same retained snapshot and exact target window"
            )
        }
        guard first.element.windowId != nil, first.element.windowGeneration != nil else {
            throw ServiceFault(code: "action_requires_exact_window", message: "transactions require a generation-bound window")
        }

        // Resolve and shape-check the full manifest before anything can mutate.
        let authorities: [AXElementAuthority] = try request.steps.map { step in
            let authority = try axSnapshots.resolveAuthority(sessionId: sessionId, ref: step.element)
            guard authority.snapshot.snapshotId == request.basedOnSnapshotId,
                  authority.snapshot.eventTracking else {
                throw ServiceFault(code: "event_tracking_unavailable", message: "the transaction snapshot is not authoritative")
            }
            let action = SemanticActionRequest(
                element: step.element,
                action: step.action,
                value: step.value,
                payload: step.payload,
                expectedEventRevision: authority.snapshot.eventRevision,
                deliveryPolicy: request.deliveryPolicy
            )
            try AXSemanticActionEngine.validateRequestShape(action, expected: authority.node)
            try Self.validate(step.precondition, against: authority.node)
            return authority
        }
        let authorizingRevision = authorities[0].snapshot.eventRevision
        guard authorities.allSatisfy({ $0.snapshot.eventRevision == authorizingRevision }) else {
            throw ServiceFault(code: "transaction_snapshot_mismatch", message: "transaction steps were not authorized by one event revision")
        }
        let workspaceBefore = try validatedWorkspace(for: first.element)
        var acceptedRevision = axEvents.checkpoint(sessionId: sessionId, pid: first.element.pid)
        guard acceptedRevision.tracking, acceptedRevision.revision == authorizingRevision else {
            throw ServiceFault(code: "stale_element_ref", message: "the target changed after the transaction snapshot")
        }

        let transactionId = UUID().uuidString.lowercased()
        let startedAtMs = Self.nowMs
        var completed: [SemanticTransactionStepReceipt] = []
        let actionRequests = request.steps.map { step in
            SemanticActionRequest(
                element: step.element,
                action: step.action,
                value: step.value,
                payload: step.payload,
                expectedEventRevision: authorizingRevision,
                deliveryPolicy: request.deliveryPolicy
            )
        }

        // Some operations compose only when delivered as one native write. AppKit row-level
        // AXSelected writes replace each other, for example; AXSelectedRows atomically describes
        // the final multi-selection. Let the engine claim such a primitive before falling back to
        // ordered execution.
        do {
            if let executions = try semanticActions.executeBatch(
                requests: actionRequests,
                expected: authorities.map(\.node),
                validateBeforeMutation: { [self] in
                    let latest = axEvents.checkpoint(sessionId: sessionId, pid: first.element.pid)
                    guard latest.tracking, latest.revision == acceptedRevision.revision else {
                        throw ServiceFault(code: "transaction_preflight_race", message: "the target changed before atomic transaction delivery")
                    }
                    _ = try validatedWorkspace(for: first.element)
                }
            ) {
                guard executions.count == request.steps.count else {
                    throw ServiceFault(code: "internal_error", message: "atomic transaction returned the wrong receipt count")
                }
                let after = axEvents.checkpoint(sessionId: sessionId, pid: first.element.pid)
                let workspaceAfter = try? workspace.snapshot(.init(pid: first.element.pid, includeOffscreenWindows: true))
                let completedAtMs = Self.nowMs
                completed = zip(request.steps, executions).map { step, execution in
                    SemanticTransactionStepReceipt(
                        stepId: step.stepId,
                        receipt: SemanticActionReceipt(
                            actionId: UUID().uuidString.lowercased(), element: step.element,
                            action: step.action, primitive: execution.primitive,
                            outcome: execution.outcome, deliveryPolicy: request.deliveryPolicy,
                            startedAtMs: startedAtMs, completedAtMs: completedAtMs,
                            eventRevisionBefore: acceptedRevision.revision,
                            eventRevisionAfter: after.revision,
                            frontmostPidBefore: workspaceBefore.frontmostPid,
                            frontmostPidAfter: workspaceAfter?.frontmostPid,
                            textSelection: execution.textSelection, scroll: execution.scroll,
                            deliveryPath: execution.deliveryPath,
                            attemptedPaths: execution.attemptedPaths,
                            typedText: execution.typedText
                        )
                    )
                }
                axSnapshots.invalidate(
                    sessionId: sessionId, pid: first.element.pid, windowId: first.element.windowId
                )
                return SemanticTransactionReceipt(
                    transactionId: transactionId,
                    basedOnSnapshotId: request.basedOnSnapshotId,
                    deliveryPolicy: request.deliveryPolicy,
                    outcome: .completed,
                    startedAtMs: startedAtMs,
                    completedAtMs: completedAtMs,
                    steps: completed
                )
            }
        } catch {
            // The native batch may have been accepted before a read-back exposed dishonor. Consume
            // the authority conservatively even though no step is claimed complete.
            axSnapshots.invalidate(
                sessionId: sessionId, pid: first.element.pid, windowId: first.element.windowId
            )
            return SemanticTransactionReceipt(
                transactionId: transactionId,
                basedOnSnapshotId: request.basedOnSnapshotId,
                deliveryPolicy: request.deliveryPolicy,
                outcome: .stopped,
                startedAtMs: startedAtMs,
                completedAtMs: Self.nowMs,
                steps: [],
                stoppedBeforeStepId: first.stepId,
                failure: Self.cuError(for: error)
            )
        }
        for (index, step) in request.steps.enumerated() {
            let actionStartedAtMs = Self.nowMs
            let action = actionRequests[index]
            do {
                let execution = try semanticActions.execute(
                    request: action,
                    expected: authorities[index].node
                ) { [self] in
                    let latest = axEvents.checkpoint(sessionId: sessionId, pid: step.element.pid)
                    guard latest.tracking, latest.revision == acceptedRevision.revision else {
                        throw ServiceFault(
                            code: "transaction_preflight_race",
                            message: "the target changed between transaction steps"
                        )
                    }
                    _ = try validatedWorkspace(for: step.element)
                }
                let after = axEvents.checkpoint(sessionId: sessionId, pid: step.element.pid)
                let workspaceAfter = try? workspace.snapshot(.init(pid: step.element.pid, includeOffscreenWindows: true))
                let receipt = SemanticActionReceipt(
                    actionId: UUID().uuidString.lowercased(),
                    element: step.element,
                    action: step.action,
                    primitive: execution.primitive,
                    outcome: execution.outcome,
                    deliveryPolicy: request.deliveryPolicy,
                    startedAtMs: actionStartedAtMs,
                    completedAtMs: Self.nowMs,
                    eventRevisionBefore: acceptedRevision.revision,
                    eventRevisionAfter: after.revision,
                    frontmostPidBefore: workspaceBefore.frontmostPid,
                    frontmostPidAfter: workspaceAfter?.frontmostPid,
                    textSelection: execution.textSelection,
                    scroll: execution.scroll,
                    deliveryPath: execution.deliveryPath,
                    attemptedPaths: execution.attemptedPaths,
                    typedText: execution.typedText
                )
                completed.append(.init(stepId: step.stepId, receipt: receipt))
                acceptedRevision = after
            } catch {
                if !completed.isEmpty {
                    axSnapshots.invalidate(
                        sessionId: sessionId,
                        pid: first.element.pid,
                        windowId: first.element.windowId
                    )
                }
                return SemanticTransactionReceipt(
                    transactionId: transactionId,
                    basedOnSnapshotId: request.basedOnSnapshotId,
                    deliveryPolicy: request.deliveryPolicy,
                    outcome: .stopped,
                    startedAtMs: startedAtMs,
                    completedAtMs: Self.nowMs,
                    steps: completed,
                    stoppedBeforeStepId: step.stepId,
                    failure: Self.cuError(for: error)
                )
            }
        }
        axSnapshots.invalidate(
            sessionId: sessionId,
            pid: first.element.pid,
            windowId: first.element.windowId
        )
        return SemanticTransactionReceipt(
            transactionId: transactionId,
            basedOnSnapshotId: request.basedOnSnapshotId,
            deliveryPolicy: request.deliveryPolicy,
            outcome: .completed,
            startedAtMs: startedAtMs,
            completedAtMs: Self.nowMs,
            steps: completed
        )
    }

    private static func validate(
        _ precondition: SemanticTransactionPrecondition?,
        against node: AXNode
    ) throws {
        guard let precondition else { return }
        if let role = precondition.expectedRole, node.role != role {
            throw ServiceFault(code: "transaction_precondition_failed", message: "expected role did not match")
        }
        if let value = precondition.expectedValue, node.value != value {
            throw ServiceFault(code: "transaction_precondition_failed", message: "expected value did not match")
        }
        if let focused = precondition.expectedFocused, node.focused != focused {
            throw ServiceFault(code: "transaction_precondition_failed", message: "expected focus state did not match")
        }
        if let selected = precondition.expectedSelected, node.selected != selected {
            throw ServiceFault(code: "transaction_precondition_failed", message: "expected selection state did not match")
        }
    }

    private static func cuError(for error: Error) -> CuError {
        switch error {
        case let fault as ServiceFault:
            return CuError(code: fault.code, message: fault.message, retryable: fault.retryable)
        case let error as AXSnapshotStoreError:
            return CuError(code: snapshotErrorCode(error), message: String(describing: error))
        case let error as AXSemanticActionError:
            return CuError(code: semanticActionErrorCode(error), message: semanticActionErrorMessage(error))
        case let error as AXObservationError:
            return CuError(code: axErrorCode(error), message: String(describing: error), retryable: error == .permissionDenied)
        case let error as AppWorkspaceError:
            return CuError(code: appWorkspaceErrorCode(error), message: appWorkspaceErrorMessage(error), retryable: error == .launchTimedOut)
        case let error as FileWorkspaceError:
            return CuError(code: fileWorkspaceErrorCode(error), message: fileWorkspaceErrorMessage(error))
        case let error as WindowOperationError:
            return CuError(code: windowOperationErrorCode(error), message: windowOperationErrorMessage(error))
        default:
            return CuError(code: "internal_error", message: String(describing: error), retryable: true)
        }
    }

    /// Whether this call is allowed to change focus at all, decided before any target work.
    ///
    /// The coordinator owns approvals; the service owns the refusal. An approval names one policy
    /// and one target, so a "yes" for a temporary lease on one window cannot be spent on a
    /// persistent one somewhere else.
    private func authorizeDelivery(_ actionRequest: SemanticActionRequest) throws {
        let policy = actionRequest.deliveryPolicy
        guard policy.requiresApproval else {
            guard actionRequest.approval == nil else {
                throw ServiceFault(
                    code: "approval_not_applicable",
                    message: "a background delivery policy cannot carry a foreground approval"
                )
            }
            guard actionRequest.focusLease == nil else {
                throw ServiceFault(
                    code: "lease_not_applicable",
                    message: "a background delivery policy cannot request a focus lease"
                )
            }
            return
        }
        guard let approval = actionRequest.approval else {
            throw ServiceFault(
                code: "foreground_approval_required",
                message: "\(policy.rawValue) requires a coordinator-issued approval"
            )
        }
        guard approval.policy == policy else {
            throw ServiceFault(
                code: "foreground_approval_policy_mismatch",
                message: "the approval authorizes \(approval.policy.rawValue), not \(policy.rawValue)"
            )
        }
        guard approval.targetPid == actionRequest.element.pid else {
            throw ServiceFault(
                code: "foreground_approval_target_mismatch",
                message: "the approval names a different process than the action target"
            )
        }
        if let approvedWindow = approval.targetWindowId,
           approvedWindow != actionRequest.element.windowId {
            throw ServiceFault(
                code: "foreground_approval_target_mismatch",
                message: "the approval names a different window than the action target"
            )
        }
        guard approval.expiresAtMs > Self.nowMs else {
            throw ServiceFault(code: "foreground_approval_expired", message: "the foreground approval has expired")
        }
    }

    /// Refusals a foreground retry could plausibly change.
    ///
    /// Slice 1 adds exactly one thing to a retry: the application is in front while the same AX
    /// call runs. That genuinely fixes settability that depends on focus — an AppKit text field's
    /// selection range is one — and genuinely cannot conjure an action an element does not
    /// advertise. `semantic_action_unsupported` is therefore deliberately absent.
    private static let focusDependentRefusals: Set<String> = [
        "semantic_action_failed",
        "ax_value_not_settable",
        "ax_selection_not_settable",
    ]

    private func escalationProposal(
        for error: Error,
        request: SemanticActionRequest
    ) -> EscalationProposal? {
        let code: String
        switch error {
        case let semantic as AXSemanticActionError: code = Self.semanticActionErrorCode(semantic)
        case let fault as ServiceFault: code = fault.code
        default: return nil
        }
        guard Self.focusDependentRefusals.contains(code) else { return nil }
        let physicalTypingFallback: Bool
        if request.action == .setValue, case .string? = request.value {
            physicalTypingFallback = physicalInput.implemented(.globalStream)
        } else {
            physicalTypingFallback = false
        }
        return EscalationProposal(
            proposalId: UUID().uuidString.lowercased(),
            element: request.element,
            action: request.action,
            requestedPolicy: request.deliveryPolicy,
            blockedBy: code,
            message: physicalTypingFallback
                ? "the AX value write was refused; retry the same text as type_text through the "
                    + "approved foreground physical keyboard path"
                : "background delivery was refused by the application; a foreground retry runs "
                    + "the same semantic action with the application in front and may still fail",
            recommendedPolicy: .foregroundOnce,
            recommendedRung: 6,
            recommendedAction: physicalTypingFallback ? .typeText : nil,
            requiresApproval: true,
            // Availability is scoped to an equivalent fallback for this exact request. A working
            // keyboard path is not a physical fallback for selecting a range or toggling a box.
            physicalInputAvailable: physicalTypingFallback,
            exhaustedPaths: (error as? AXSemanticActionError).map(Self.exhaustedPaths(for:)) ?? []
        )
    }

    /// The rungs a refusal implies were walked. The engine throws rather than returning its record,
    /// so a refusal reports the rung its error names instead of inventing a full walk.
    private static func exhaustedPaths(for error: AXSemanticActionError) -> [DeliveryAttempt] {
        switch error {
        case .valueNotSettable:
            return [.init(path: .axAttribute, primitive: "AXSetAttribute:AXValue", outcome: .unavailable)]
        case .selectionNotSettable:
            return [.init(path: .axAttribute, primitive: "AXSetAttribute:AXSelectedTextRange", outcome: .unavailable)]
        case .executionFailed(let axError):
            return [.init(path: .axAction, primitive: "AXPerformAction", outcome: .refused, axError: axError.rawValue)]
        case .executionIndeterminate(let axError):
            return [.init(path: .axAction, primitive: "AXPerformAction", outcome: .indeterminate, axError: axError.rawValue)]
        default:
            return []
        }
    }

    public func handshakeResponse() -> HandshakeResponse {
        HandshakeResponse(
            selectedProtocol: BimaxCuProtocolVersion.v1,
            serviceVersion: serviceVersion,
            platform: PlatformInfo(
                os: "macos",
                version: ProcessInfo.processInfo.operatingSystemVersionString,
                architecture: Self.architecture
            ),
            // Capability negotiation is deliberately honest: only implemented and tested native
            // observation/workspace/semantic delivery features are advertised.
            capabilities: CapabilitySet(
                observe: ObserveCapabilities(
                    profiles: ["flash", "balanced"],
                    scopes: AXObservationScope.allCases.map(\.rawValue),
                    axDiff: true,
                    eventRevisions: true,
                    som: true,
                    regionCapture: true,
                    zoom: true,
                    query: true,
                    capabilityDiscovery: true
                ),
                delivery: DeliveryCapabilities(
                    policies: SemanticDeliveryPolicy.allCases.map(\.rawValue),
                    verifiedDeliveryPolicies: Self.verifiedDeliveryPolicies,
                    semanticActions: SemanticActionKind.allCases.map(\.rawValue),
                    verifiedSemanticActions: Self.verifiedSemanticActions,
                    targetedEvents: physicalInput.implemented(.targetedProcess),
                    physicalInput: physicalInput.implemented(.globalStream),
                    // Derived, never asserted: the lease capability is exactly whether a
                    // focus-changing policy has been proven, so it cannot drift from the evidence.
                    focusLease: Self.verifiedDeliveryPolicies.contains {
                        SemanticDeliveryPolicy(rawValue: $0)?.requiresApproval == true
                    },
                    semanticTransactions: true
                ),
                workspace: WorkspaceCapabilities(
                    apps: true,
                    windows: true,
                    displays: true,
                    operations: WorkspaceOperationKind.allCases.map(\.rawValue),
                    verifiedOperations: Self.verifiedWorkspaceOperations
                ),
                // State contracts exist, but no native overlay window has passed its privacy and
                // liveness gates yet. Explicit false is preferable to an implied capability.
                overlay: OverlayCapabilities(cursor: false)
            ),
            limits: ProtocolLimits(),
            permissions: permissions.current()
        )
    }

    private func failure(_ request: RequestEnvelope, code: String, message: String, retryable: Bool = false) -> ResponseEnvelope {
        ResponseEnvelope(
            requestId: request.requestId,
            sessionId: request.sessionId,
            serviceVersion: serviceVersion,
            error: CuError(code: code, message: message, retryable: retryable)
        )
    }

    private static var architecture: String {
        #if arch(arm64)
        return "arm64"
        #elseif arch(x86_64)
        return "x86_64"
        #else
        return "unknown"
        #endif
    }

    private func validatedWorkspace(for ref: ElementRef) throws -> WorkspaceSnapshot {
        let snapshot = try workspace.snapshot(.init(pid: ref.pid, includeOffscreenWindows: true))
        guard let windowId = ref.windowId,
              let generation = ref.windowGeneration,
              let window = snapshot.windows.first(where: {
                  $0.window.pid == ref.pid && $0.window.windowId == windowId
              }) else {
            throw ServiceFault(code: "window_not_found", message: "the action target window no longer exists")
        }
        guard window.window.generation == generation else {
            throw ServiceFault(code: "stale_window_ref", message: "the action target window generation changed")
        }
        return snapshot
    }

    /// Actions proven to produce a real effect against a live Accessibility server by
    /// `bimax-cu-service --self-test-catalog` against `BimaxCuFixture.app`. Maintained by that run,
    /// never by assumption.
    ///
    /// Deliberately absent:
    /// - `scroll_page`: `AXScroll*ByPage` is advertised by AppKit, SwiftUI, and Electron scroll
    ///   areas and returns `kAXErrorFailure` without moving anything. Use `scroll_to_fraction`.
    /// - `scroll_to_visible`: AppKit table rows do not advertise `AXScrollToVisible`.
    static let verifiedSemanticActions: [String] = [
        "invoke", "show_menu", "set_value", "increment", "decrement", "toggle", "expand", "collapse", "select",
        "select_text_range", "select_text", "set_caret", "set_selected", "scroll_to_fraction",
        // Foreground physical click + Unicode typing. The process-targeted background transport
        // remains absent; this verified route requires approval, an exact-PID focus lease,
        // recipient/quiet-period preflight, live element geometry and independent read-back.
        "type_text",
    ]

    /// Delivery policies whose focus behavior has been observed against a live workspace by
    /// `bimax-cu-service --self-test-focus` against `BimaxCuFixture.app`. Maintained by that run,
    /// never by assumption — a policy the service will *accept* is advertised in `policies`, and
    /// only a policy whose claimed focus behavior has actually been watched belongs here.
    ///
    /// Foreground policies use the desktop app's exact-PID broker. The live fixture run verifies
    /// both target acquisition and restoration of the exact prior process for `foreground_once`,
    /// and retained target focus for `foreground_persistent`; broker timeouts fail closed.
    static let verifiedDeliveryPolicies: [String] = [
        "background_native", "background_only", "background_preferred",
        "foreground_once", "foreground_persistent",
    ]

    /// Mutating workspace operations whose claimed behavior has been observed against a live
    /// workspace by `bimax-cu-service --self-test-workspace` against `BimaxCuFixture.app`.
    /// Maintained by that run, never by assumption: `operations` is what the service will attempt,
    /// this is what has been watched doing what it says.
    ///
    /// `launch_app` is here only because the run confirmed the fixture started while a different
    /// application stayed frontmost. If a future macOS build activates through a non-activating
    /// open, that run fails and this list must shrink.
    ///
    /// Deliberately absent:
    /// - `reveal_file` and `open_url`: both are foreground-disruptive to whoever is at the keyboard
    ///   — Finder comes forward, a browser opens a page — so there is no way to measure them
    ///   without commandeering the machine the run is on. They stay advertised and unverified.
    /// - `minimize_window` and `unminimize_window`: measured on AppKit, `AXMinimized` is readable
    ///   and **not settable**, and `AXMinimizeButton` advertises `AXPress`, returns `.success`, and
    ///   does not minimize the window. Both rungs of the ladder are inert, so there is no working
    ///   route to advertise as proven.
    /// - `close_window`: `AXCloseButton` press does work in isolation (an application's AX window
    ///   count went 1 to 0), but the conformance run could not reproduce it once the fixture
    ///   exposed more than one AX window. Advertised, implemented, and honestly unproven.
    static let verifiedWorkspaceOperations: [String] = [
        "resolve_app", "launch_app", "inspect_file", "open_file", "duplicate_file", "trash_file",
        "move_window", "resize_window", "set_window_frame",
    ]

    private static var nowMs: Int64 { Int64(Date().timeIntervalSince1970 * 1_000) }
    private static let systemUIBundleIds: Set<String> = [
        "com.apple.dock",
        "com.apple.controlcenter",
        "com.apple.systemuiserver",
        "com.apple.spotlight",
    ]

    private static func sessionErrorCode(_ error: SessionRegistryError) -> String {
        switch error {
        case .invalidId: return "session_invalid_id"
        case .alreadyExists: return "session_already_exists"
        case .notFound: return "session_not_found"
        case .capacityReached: return "session_capacity_reached"
        }
    }

    /// One application-resolution path for every operation that names a handler, so an
    /// `open_file` cannot reach a bundle a `launch_app` would refuse.
    private func resolveApplicationBundle(_ lookup: AppLookup) throws -> URL {
        let resolved = try appWorkspace.resolve(.init(lookup: lookup))
        guard resolved.resolved, let path = resolved.bundlePath else {
            throw AppWorkspaceError.notFound
        }
        return URL(fileURLWithPath: path)
    }

    /// A window mutation must name a window generation this service issued for that exact
    /// PID/window pair. WindowServer reuses ids; a stale generation is a different window.
    private func validateWindowGeneration(_ ref: WindowRef) throws {
        let snapshot = try workspace.snapshot(.init(pid: ref.pid, includeOffscreenWindows: true))
        guard let live = snapshot.windows.first(where: {
            $0.window.pid == ref.pid && $0.window.windowId == ref.windowId
        }) else {
            throw ServiceFault(code: "window_not_found", message: "the target window no longer exists")
        }
        guard live.window.generation == ref.generation else {
            throw ServiceFault(
                code: "window_generation_stale",
                message: "the window id was reissued; observe the workspace again before acting"
            )
        }
    }

    private static func windowOperationErrorCode(_ error: WindowOperationError) -> String {
        switch error {
        case .invalidRequest: return "invalid_window_operation"
        case .windowNotFound: return "window_not_found"
        case .attributeUnavailable: return "window_attribute_unavailable"
        case .writeFailed: return "window_write_failed"
        }
    }

    private static func windowOperationErrorMessage(_ error: WindowOperationError) -> String {
        switch error {
        case .invalidRequest(let reason), .attributeUnavailable(let reason), .writeFailed(let reason):
            return reason
        case .windowNotFound: return "the target window could not be resolved"
        }
    }

    private static func fileWorkspaceErrorCode(_ error: FileWorkspaceError) -> String {
        switch error {
        case .invalidPath: return "invalid_file_path"
        case .notFound: return "file_not_found"
        case .refused: return "file_operation_refused"
        case .operationFailed: return "file_operation_failed"
        }
    }

    /// Filesystem errors can carry a full path or a system message. Receipts and errors stay
    /// content-free; the caller already knows the path it sent.
    private static func fileWorkspaceErrorMessage(_ error: FileWorkspaceError) -> String {
        switch error {
        case .invalidPath(let reason), .refused(let reason), .operationFailed(let reason): return reason
        case .notFound: return "the path does not exist"
        }
    }

    private static func appWorkspaceErrorCode(_ error: AppWorkspaceError) -> String {
        switch error {
        case .invalidLookup: return "invalid_app_lookup"
        case .notFound: return "app_not_found"
        case .launchFailed: return "app_launch_failed"
        case .launchTimedOut: return "app_launch_timeout"
        }
    }

    /// Launch Services messages can name a bundle path. Errors stay content-free like receipts.
    private static func appWorkspaceErrorMessage(_ error: AppWorkspaceError) -> String {
        switch error {
        case .invalidLookup(let reason): return reason
        case .notFound: return "no registered application matched the lookup"
        case .launchFailed(let reason): return reason
        case .launchTimedOut: return "the application did not report a launch result in time"
        }
    }

    private static func axErrorCode(_ error: AXObservationError) -> String {
        switch error {
        case .permissionDenied: return "accessibility_permission_denied"
        case .invalidPid: return "invalid_pid"
        case .windowNotFound: return "window_not_found"
        case .timedOut: return "ax_timeout"
        case .unsupportedProfile: return "unsupported_observation_profile"
        }
    }

    private static func focusLeaseErrorCode(_ error: FocusLeaseError) -> String {
        switch error {
        case .policyForbidsLease: return "background_policy_cannot_lease_focus"
        case .invalidLeaseWindow: return "invalid_focus_lease_window"
        case .leaseNotFound: return "focus_lease_not_found"
        case .leaseAlreadyHeld: return "focus_lease_already_held"
        }
    }

    private static func snapshotErrorCode(_ error: AXSnapshotStoreError) -> String {
        switch error {
        case .malformedSnapshot: return "malformed_ax_snapshot"
        case .nonAuthoritativeSnapshot: return "non_authoritative_ax_snapshot"
        case .baseSnapshotNotFound: return "stale_snapshot_ref"
        case .baseSnapshotTargetMismatch: return "snapshot_target_mismatch"
        case .staleElementRef: return "stale_element_ref"
        case .elementNotFound: return "element_not_found"
        case .malformedDiff: return "malformed_ax_diff"
        }
    }

    private static func captureErrorCode(_ error: CaptureServiceError) -> String {
        switch error {
        case .permissionDenied: return "screen_recording_permission_denied"
        case .targetUnavailable: return "capture_target_unavailable"
        case .timedOut: return "capture_timeout"
        case .noFrame: return "capture_no_frame"
        case .invalidRequest: return "invalid_capture_request"
        }
    }

    private static func imageErrorCode(_ error: ImageHandleStoreError) -> String {
        switch error {
        case .invalidImage: return "invalid_image"
        case .imageTooLarge: return "image_too_large"
        case .invalidTransform: return "invalid_image_transform"
        case .invalidHandle: return "invalid_image_handle"
        // The store's own guards. A handle issued to another session and a store at capacity are
        // both refusals to serve a handle, but they are different faults to a caller: one is a
        // scoping error it can fix, the other is pressure it must back off from.
        case .sessionMismatch: return "image_handle_session_mismatch"
        case .storeLimitExceeded: return "image_store_limit_exceeded"
        }
    }

    private static func imageAnalysisErrorCode(_ error: ImageAnalysisError) -> String {
        switch error {
        case .invalidImage: return "invalid_image"
        case .invalidRequest: return "invalid_image_analysis"
        case .tooManyRegions: return "too_many_image_regions"
        case .invalidRegion: return "invalid_image_region"
        case .duplicateRegionId: return "duplicate_image_region"
        }
    }

    private static func wireTransform(_ transform: CaptureImageTransform) -> CaptureTransformRef {
        CaptureTransformRef(
            sourcePixelRect: transform.sourcePixelRect,
            outputWidth: transform.outputWidth,
            outputHeight: transform.outputHeight
        )
    }

    private static func wireImageHandle(
        _ handle: CaptureImageHandle,
        transform: CaptureImageTransform
    ) -> ImageHandleRef {
        ImageHandleRef(
            token: handle.token,
            sessionId: handle.sessionId,
            format: handle.format == .png ? .png : .jpeg,
            pixelWidth: handle.pixelWidth,
            pixelHeight: handle.pixelHeight,
            byteCount: handle.byteCount,
            sha256: handle.sha256,
            createdAtMs: handle.createdAtMs,
            transform: wireTransform(transform)
        )
    }

    private static func internalImageHandle(_ handle: ImageHandleRef) -> CaptureImageHandle {
        CaptureImageHandle(
            token: handle.token,
            sessionId: handle.sessionId,
            format: handle.format == .png ? .png : .jpeg,
            pixelWidth: handle.pixelWidth,
            pixelHeight: handle.pixelHeight,
            byteCount: handle.byteCount,
            sha256: handle.sha256,
            createdAtMs: handle.createdAtMs
        )
    }

    /// Names the native cause without echoing any element content.
    private static func semanticActionErrorMessage(_ error: AXSemanticActionError) -> String {
        if case .executionIndeterminate(let axError) = error {
            // Never call this a refusal. Saying "refused" would tell the caller the action did not
            // happen, which is the one thing this code does not establish — and would invite a
            // retry that performs the action a second time.
            return "the application did not answer the native AX call within the timeout "
                + "(AXError \(axError.rawValue)); it may or may not have been performed, so verify "
                + "against a fresh observation instead of retrying"
        }
        guard case .executionFailed(let axError) = error else { return String(describing: error) }
        return "the native AX call was refused by the application (AXError \(axError.rawValue))"
    }

    private static func semanticActionErrorCode(_ error: AXSemanticActionError) -> String {
        switch error {
        case .permissionDenied: return "accessibility_permission_denied"
        case .liveElementNotFound: return "live_element_not_found"
        case .liveIdentityMismatch: return "live_element_identity_mismatch"
        case .liveTraversalLimit: return "live_revalidation_limit"
        case .invalidPayload: return "invalid_semantic_action"
        case .sensitiveElement: return "sensitive_element_requires_secret_flow"
        case .actionUnsupported: return "semantic_action_unsupported"
        case .valueNotSettable: return "ax_value_not_settable"
        case .executionFailed: return "semantic_action_failed"
        case .executionIndeterminate: return "semantic_action_indeterminate"
        case .selectionNotSettable: return "ax_selection_not_settable"
        case .textUnavailable: return "text_state_unavailable"
        case .textTooLarge: return "text_context_too_large"
        case .textNotFound: return "text_not_found"
        case .ambiguousTextMatch: return "ambiguous_text_match"
        case .textRangeOutOfBounds: return "text_range_out_of_bounds"
        case .focusNotHonored: return "ax_focus_not_honored"
        }
    }
}
