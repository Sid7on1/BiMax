import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import UniformTypeIdentifiers
import Vision
import BimaxCuProtocol

// RECONSTRUCTED 2026-08-17 — the service seams the FocusBridge eviction took with them.
//
// Every protocol shape below is read off a surviving `ServiceCore` call site, and every payload is
// a wire type from WireProtocol.swift. Nothing here invents capability, and where the lost
// implementation encoded a policy that no surviving artefact pins, the reconstruction fails closed
// and says so in a comment — a service that quietly does less is recoverable; one that quietly does
// more, or that reports success it did not verify, is not.
//
// The one place a definition had to be CHOSEN rather than recovered is the colour vocabulary in
// `ImageAnalysisService` (see the note there). It is documented, standard, and must be validated
// against real captures before any downstream logic is allowed to trust `colorName`.

/// `ServiceCore` names the resolved authority as a top-level type; the store owns the definition.
/// A typealias rather than a second struct, so there is exactly one authority shape in the build.
public typealias AXElementAuthority = AXSnapshotStore.Authority

/// Carries a completion's result back to the waiting thread.
///
/// The semaphore does order the write before the read, but Swift 6 cannot prove that and neither
/// can a future reader — "it happens to be ordered" is the reasoning that rots into a real race the
/// first time someone moves the wait. The lock makes the ordering explicit instead of implied.
private final class ResultBox<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value?
    func set(_ newValue: Value?) { lock.withLock { value = newValue } }
    var current: Value? { lock.withLock { value } }
}

private func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1_000) }

private extension CuRect {
    /// The wire `CuRect` has no CGRect bridge — non-finite AX/CoreGraphics bounds are a real
    /// occurrence and must surface as nil rather than poisoning arithmetic downstream.
    init?(finite rect: CGRect) {
        guard rect.origin.x.isFinite, rect.origin.y.isFinite,
              rect.size.width.isFinite, rect.size.height.isFinite else { return nil }
        self.init(
            x: Double(rect.origin.x), y: Double(rect.origin.y),
            width: Double(rect.size.width), height: Double(rect.size.height)
        )
    }
    var cgRect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
}

// MARK: - Workspace inventory

extension WorkspaceInventory {
    /// The one fact-gathering pass behind `workspace.snapshot`.
    ///
    /// `CGWindowListCopyWindowInfo` is the window source because it is the only API reporting owning
    /// pid, bounds, layer and on-screen state together. `onScreen` is carried through untouched: the
    /// project's own measurements record that capture ignores Spaces while click delivery does not,
    /// so this flag is the guard every delivery path reads rather than assuming visibility.
    public func snapshot(_ request: WorkspaceSnapshotRequest) throws -> WorkspaceSnapshot {
        let options: CGWindowListOption = request.includeOffscreenWindows
            ? [.excludeDesktopElements]
            : [.excludeDesktopElements, .optionOnScreenOnly]
        let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []

        var windows: [WindowInfo] = []
        for entry in raw {
            guard let pid = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
                  let windowId = (entry[kCGWindowNumber as String] as? NSNumber)?.uint32Value
            else { continue }
            if let wanted = request.pid, wanted != pid { continue }
            guard let boundsDict = entry[kCGWindowBounds as String] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation: boundsDict),
                  let bounds = CuRect(finite: rect) else { continue }
            windows.append(WindowInfo(
                window: WindowRef(
                    pid: pid,
                    windowId: windowId,
                    // A generation binds a mutation to the exact window that was observed. Window
                    // ids are recycled by the window server, so the id alone cannot authorize a
                    // write; the store issues and validates generations against this inventory.
                    generation: Self.generation(pid: pid, windowId: windowId),
                    title: entry[kCGWindowName as String] as? String
                ),
                ownerName: entry[kCGWindowOwnerName as String] as? String,
                bounds: bounds,
                layer: (entry[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0,
                alpha: (entry[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1,
                onScreen: (entry[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false
            ))
        }

        let apps: [AppInfo] = NSWorkspace.shared.runningApplications.compactMap { app in
            let pid = app.processIdentifier
            if let wanted = request.pid, wanted != pid { return nil }
            let policy: String
            switch app.activationPolicy {
            case .regular: policy = "regular"
            case .accessory: policy = "accessory"
            case .prohibited: policy = "prohibited"
            @unknown default: policy = "unknown"
            }
            return AppInfo(
                app: AppRef(
                    bundleId: app.bundleIdentifier,
                    pid: pid,
                    // This inventory did not launch anything, so it has no launch identity to
                    // report. Minting one here would let a caller treat an observation as a launch
                    // receipt; the empty string is the honest "not from a launch" value.
                    launchId: "",
                    displayName: app.localizedName
                ),
                activationPolicy: policy,
                active: app.isActive,
                hidden: app.isHidden,
                finishedLaunching: app.isFinishedLaunching
            )
        }

        let displays: [DisplayInfo] = NSScreen.screens.compactMap { screen in
            guard let number = screen.deviceDescription[
                NSDeviceDescriptionKey("NSScreenNumber")
            ] as? NSNumber, let bounds = CuRect(finite: screen.frame) else { return nil }
            return DisplayInfo(
                displayId: number.uint32Value,
                bounds: bounds,
                // Measured, never assumed equal to `bounds` — the menu bar and Dock are real.
                usableBounds: CuRect(finite: screen.visibleFrame),
                pixelWidth: Int(screen.frame.width * screen.backingScaleFactor),
                pixelHeight: Int(screen.frame.height * screen.backingScaleFactor),
                scale: Double(screen.backingScaleFactor),
                main: screen == NSScreen.main
            )
        }

        return WorkspaceSnapshot(
            capturedAtMs: nowMs(),
            frontmostPid: Self.frontmostPid(),
            apps: apps,
            windows: windows,
            displays: displays,
            displaysHaveSeparateSpaces: NSScreen.screensHaveSeparateSpaces
        )
    }

    /// A window's generation must change when the id is reused for a different window and stay
    /// stable while the same window lives. Derived from the identity the window server itself
    /// exposes — owning pid plus id — so two inventories of the same live window agree.
    private static func generation(pid: Int32, windowId: UInt32) -> UInt64 {
        (UInt64(UInt32(bitPattern: pid)) << 32) | UInt64(windowId)
    }
}

// MARK: - File workspace

/// Case names and payloads are pinned exactly by `ServiceCore.fileWorkspaceErrorCode` /
/// `fileWorkspaceErrorMessage`, which survived the eviction. The reasons carry the message; the
/// receipts stay content-free, because the caller already knows the path it sent.
public enum FileWorkspaceError: Error, Equatable, Sendable {
    case invalidPath(String)
    case notFound
    case refused(String)
    case operationFailed(String)
}

/// Read and Finder-shaped file operations, plus URL opening.
///
/// `resolving` is injected by `ServiceCore` and turns an `AppLookup` into a bundle URL, so this type
/// never resolves applications itself — one resolver, one place it can be wrong.
public protocol FileWorkspaceOperating: Sendable {
    func inspect(_ request: FileInspectRequest) throws -> FileInfoReceipt
    func perform(
        _ request: FileOperationRequest,
        resolving: (AppLookup) throws -> URL
    ) throws -> FileOperationReceipt
    func openURL(
        _ request: OpenURLRequest,
        resolving: (AppLookup) throws -> URL
    ) throws -> OpenURLReceipt
}

/// Policy over an injected `FileServicesProviding`.
///
/// The refusals are the point of this type; the effects are delegated. It accepts only absolute,
/// already-normalized paths — normalizing here would validate one path and act on another, which is
/// how a containment check gets bypassed.
public struct FileWorkspace: FileWorkspaceOperating {
    private let services: any FileServicesProviding
    private let homePath: String

    public init(
        services: any FileServicesProviding = SystemFileServices(),
        homePath: String = NSHomeDirectory()
    ) {
        self.services = services
        self.homePath = homePath
    }

    private func validated(_ path: String) throws -> String {
        guard path.hasPrefix("/") else {
            throw FileWorkspaceError.invalidPath("the path must be absolute")
        }
        guard !path.contains("/../"), !path.hasSuffix("/.."), !path.contains("//"),
              !path.hasPrefix("~") else {
            throw FileWorkspaceError.invalidPath("the path must already be normalized")
        }
        // A NUL truncates the path at every C boundary below this, so the string that gets checked
        // and the bytes that reach the filesystem are different — the classic way a containment
        // check is bypassed.
        guard !path.unicodeScalars.contains(where: { $0.value == 0 }) else {
            throw FileWorkspaceError.invalidPath("the path contains a NUL")
        }
        return path
    }

    public func inspect(_ request: FileInspectRequest) throws -> FileInfoReceipt {
        let path = try validated(request.path)
        // A missing file is a fact to report, not a fault: `exists: false` is a complete answer and
        // the caller decides whether that is an error.
        guard let attributes = services.attributes(path) else {
            return FileInfoReceipt(path: path, exists: false)
        }
        let type = services.contentType(path)
        return FileInfoReceipt(
            path: path,
            exists: true,
            isDirectory: attributes.isDirectory,
            isPackage: services.isPackage(path),
            isSymbolicLink: attributes.isSymbolicLink,
            byteSize: attributes.byteSize,
            contentType: type.identifier,
            contentTypeDescription: type.description,
            defaultApplicationPath: services.defaultApplicationPath(for: path),
            modifiedAtMs: attributes.modifiedAtMs
        )
    }

    public func perform(
        _ request: FileOperationRequest,
        resolving: (AppLookup) throws -> URL
    ) throws -> FileOperationReceipt {
        let started = Date()
        let path = try validated(request.path)
        guard services.attributes(path) != nil else { throw FileWorkspaceError.notFound }
        let frontmostBefore = services.frontmostPid()
        let bundle = try request.application.map(resolving)

        var resultingPath: String?
        var app: AppRef?
        var performed = false
        // `open` and `reveal` bring an application forward; `trash` and `duplicate` do not. The
        // receipt records the request, and the frontmost pids around it record what happened.
        let requestedActivation = request.operation == .open || request.operation == .reveal

        switch request.operation {
        case .open:
            app = try services.open(path: path, withApplicationAt: bundle, timeoutMs: 10_000)
            resultingPath = path
            performed = true
        case .reveal:
            performed = services.reveal(path: path)
            resultingPath = path
        case .trash:
            resultingPath = try services.trash(path: path)
            performed = true
        case .duplicate:
            resultingPath = try services.duplicate(path: path)
            performed = true
        }

        return FileOperationReceipt(
            operation: request.operation,
            path: path,
            performed: performed,
            resultingPath: resultingPath,
            applicationBundlePath: bundle?.path,
            app: app,
            requestedActivation: requestedActivation,
            frontmostPidBefore: frontmostBefore,
            frontmostPidAfter: services.frontmostPid(),
            durationMs: Int(Date().timeIntervalSince(started) * 1_000)
        )
    }

    public func openURL(
        _ request: OpenURLRequest,
        resolving: (AppLookup) throws -> URL
    ) throws -> OpenURLReceipt {
        let started = Date()
        guard let url = URL(string: request.url), let scheme = url.scheme else {
            throw FileWorkspaceError.invalidPath("the url could not be parsed")
        }
        // A file: URL routed through the URL verb would bypass the path checks above.
        guard scheme != "file" else {
            throw FileWorkspaceError.refused("file urls must use the file operation verb")
        }
        let frontmostBefore = services.frontmostPid()
        let bundle = try request.application.map(resolving)
        let app = try services.openURL(url, withApplicationAt: bundle, timeoutMs: 10_000)

        return OpenURLReceipt(
            url: request.url,
            scheme: scheme,
            host: url.host,
            opened: true,
            applicationBundlePath: bundle?.path,
            app: app,
            requestedActivation: true,
            frontmostPidBefore: frontmostBefore,
            frontmostPidAfter: services.frontmostPid(),
            durationMs: Int(Date().timeIntervalSince(started) * 1_000)
        )
    }
}

// MARK: - Window operations

/// Pinned by `ServiceCore.windowOperationErrorCode` / `windowOperationErrorMessage`.
public enum WindowOperationError: Error, Equatable, Sendable {
    case invalidRequest(String)
    case windowNotFound
    case attributeUnavailable(String)
    case writeFailed(String)
}

/// Window geometry and lifecycle through the accessibility API.
///
/// `frontmostPid` is injected because the operation itself can change the answer: the caller decides
/// which reading of "who was in front" the receipt is judged against.
public protocol WindowOperating: Sendable {
    func perform(
        _ request: WindowOperationRequest,
        frontmostPid: () -> Int32?
    ) throws -> WindowOperationReceipt
}

public struct WindowOperations: WindowOperating {
    private let access: any WindowElementAccessing
    private let settle: @Sendable () -> Void

    /// `settle` runs between the write and the verifying re-read. Injected because a window
    /// manager applies geometry asynchronously — reading back immediately reports the OLD frame and
    /// would mark every honored move as unhonored — and because a test must be able to make that
    /// wait free rather than sleeping.
    public init(
        access: any WindowElementAccessing = AXWindowElementAccess(),
        settle: @escaping @Sendable () -> Void = { Thread.sleep(forTimeInterval: 0.08) }
    ) {
        self.access = access
        self.settle = settle
    }

    /// Shape-checks a request before any AX read or write happens.
    ///
    /// Static because it is a property of the request alone, and separate from `perform` so a
    /// caller can reject a malformed manifest without touching a window — a transaction that
    /// half-applies before noticing step three is invalid is the failure this prevents.
    public static func validate(_ request: WindowOperationRequest) throws {
        switch request.operation {
        case .move, .resize, .setFrame:
            guard let frame = request.frame else {
                throw WindowOperationError.invalidRequest("a frame is required")
            }
            guard frame.width.isFinite, frame.height.isFinite,
                  frame.x.isFinite, frame.y.isFinite else {
                throw WindowOperationError.invalidRequest("the frame must be finite")
            }
            if request.operation != .move {
                guard frame.width > 0, frame.height > 0 else {
                    throw WindowOperationError.invalidRequest("the size must be positive")
                }
            }
        case .setFullScreen:
            guard request.fullScreen != nil else {
                throw WindowOperationError.invalidRequest("fullScreen is required")
            }
        case .minimize, .unminimize, .close:
            guard request.frame == nil, request.fullScreen == nil else {
                throw WindowOperationError.invalidRequest("this operation takes no geometry")
            }
        }
    }

    public func perform(
        _ request: WindowOperationRequest,
        frontmostPid: () -> Int32?
    ) throws -> WindowOperationReceipt {
        let startedAt = Date()
        try Self.validate(request)
        let frontmostBefore = frontmostPid()
        let pid = request.window.pid
        let windowId = request.window.windowId

        let boundsBefore = try? access.bounds(pid: pid, windowId: windowId)
        let minimizedBefore = try? access.flag(pid: pid, windowId: windowId, attribute: kAXMinimizedAttribute as String)
        let fullScreenBefore = try? access.flag(pid: pid, windowId: windowId, attribute: "AXFullScreen")
        // A window that cannot be read at all is not present. Continuing would write into whatever
        // now owns that id.
        if boundsBefore == nil && minimizedBefore == nil { throw WindowOperationError.windowNotFound }

        switch request.operation {
        case .move, .resize, .setFrame:
            guard let frame = request.frame else {
                throw WindowOperationError.invalidRequest("a frame is required")
            }
            try access.setFrame(
                pid: pid, windowId: windowId, frame: frame,
                moveOnly: request.operation == .move,
                resizeOnly: request.operation == .resize
            )
        case .minimize:
            try access.setFlag(pid: pid, windowId: windowId, attribute: kAXMinimizedAttribute as String, value: true)
        case .unminimize:
            try access.setFlag(pid: pid, windowId: windowId, attribute: kAXMinimizedAttribute as String, value: false)
        case .setFullScreen:
            guard let wanted = request.fullScreen else {
                throw WindowOperationError.invalidRequest("fullScreen is required")
            }
            try access.setFlag(pid: pid, windowId: windowId, attribute: "AXFullScreen", value: wanted)
        case .close:
            try access.pressWindowButton(
                pid: pid, windowId: windowId, attribute: kAXCloseButtonAttribute as String
            )
        }

        settle()
        // Re-read rather than trusting the write. AX writes can report success and be ignored
        // outright, and an application may clamp a size it accepted — `honored` is decided by
        // observation, never by the call's return.
        let boundsAfter = try? access.bounds(pid: pid, windowId: windowId)
        let minimizedAfter = try? access.flag(pid: pid, windowId: windowId, attribute: kAXMinimizedAttribute as String)
        let fullScreenAfter = try? access.flag(pid: pid, windowId: windowId, attribute: "AXFullScreen")
        let windowGone = boundsAfter == nil && minimizedAfter == nil

        let honored: Bool
        switch request.operation {
        case .move:
            honored = boundsAfter.map { $0.x == request.frame?.x && $0.y == request.frame?.y } ?? false
        case .resize, .setFrame:
            honored = boundsAfter != nil && boundsAfter != boundsBefore
        case .minimize: honored = minimizedAfter == true
        case .unminimize: honored = minimizedAfter == false
        case .setFullScreen: honored = fullScreenAfter == request.fullScreen
        case .close: honored = windowGone
        }

        return WindowOperationReceipt(
            operation: request.operation,
            window: request.window,
            attempted: true,
            honored: honored,
            boundsBefore: boundsBefore,
            boundsAfter: boundsAfter,
            minimizedBefore: minimizedBefore,
            minimizedAfter: minimizedAfter,
            fullScreenBefore: fullScreenBefore,
            fullScreenAfter: fullScreenAfter,
            windowGone: windowGone,
            frontmostPidBefore: frontmostBefore,
            frontmostPidAfter: frontmostPid(),
            durationMs: Int(Date().timeIntervalSince(startedAt) * 1_000)
        )
    }
}

/// Private but long-stable SPI: the only way to map an `AXUIElement` to a CoreGraphics window id,
/// which is what every window-scoped request is addressed by.
@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ identifier: UnsafeMutablePointer<CGWindowID>) -> AXError

// MARK: - AX event tracking

/// One reading of an application's accessibility event stream.
///
/// `tracking` is the load-bearing field. A revision of 0 from a live observer and a revision of 0
/// because no observer could be installed are the same number and completely different facts, so
/// every caller checks `tracking` before comparing revisions — a preflight that skipped it would
/// read "we cannot see changes" as "nothing changed".
public struct AXEventCheckpoint: Equatable, Sendable {
    public var tracking: Bool
    public var revision: UInt64
    /// The notification that last moved the revision. Diagnostic only: it says WHY the target is
    /// considered changed, which is the difference between "the app repainted" and "the element we
    /// were about to act on was destroyed".
    public var lastNotification: String?

    public init(tracking: Bool, revision: UInt64, lastNotification: String? = nil) {
        self.tracking = tracking
        self.revision = revision
        self.lastNotification = lastNotification
    }
}

/// Monotonic per-(session, pid) change counter, used to detect that a target moved underneath an
/// action between planning and delivery.
public protocol AXEventTracking: Sendable {
    func begin(sessionId: String, pid: Int32) -> AXEventCheckpoint
    func checkpoint(sessionId: String, pid: Int32) -> AXEventCheckpoint
    func reset(sessionId: String)
}

/// AXObserver-backed tracker.
///
/// Only structural/value notifications are subscribed. Focus notifications are deliberately NOT
/// counted: the project measured that value and selection events are registered ON the focused
/// element, so a typing action generates its own "change" and would invalidate its own preflight.
public final class AXEventTracker: AXEventTracking, @unchecked Sendable {
    private struct Key: Hashable { let sessionId: String; let pid: Int32 }
    private final class Watch {
        let observer: AXObserver
        var revision: UInt64 = 0
        var lastNotification: String?
        init(observer: AXObserver) { self.observer = observer }
    }

    private let lock = NSLock()
    private var watches: [Key: Watch] = [:]

    public init() {}

    private static let notifications = [
        kAXValueChangedNotification,
        kAXUIElementDestroyedNotification,
        kAXWindowCreatedNotification,
        kAXTitleChangedNotification,
        kAXSelectedChildrenChangedNotification,
        kAXRowCountChangedNotification,
    ]

    public func begin(sessionId: String, pid: Int32) -> AXEventCheckpoint {
        let key = Key(sessionId: sessionId, pid: pid)
        return lock.withLock {
            if let existing = watches[key] {
                return AXEventCheckpoint(tracking: true, revision: existing.revision)
            }
            guard AXIsProcessTrusted() else { return AXEventCheckpoint(tracking: false, revision: 0) }
            var observer: AXObserver?
            let callback: AXObserverCallback = { _, _, notification, refcon in
                guard let refcon else { return }
                let watch = Unmanaged<Watch>.fromOpaque(refcon).takeUnretainedValue()
                watch.revision &+= 1
                watch.lastNotification = notification as String
            }
            guard AXObserverCreate(pid, callback, &observer) == .success,
                  let observer else {
                return AXEventCheckpoint(tracking: false, revision: 0)
            }
            let watch = Watch(observer: observer)
            let element = AXUIElementCreateApplication(pid)
            let refcon = Unmanaged.passUnretained(watch).toOpaque()
            var subscribed = false
            for notification in Self.notifications {
                if AXObserverAddNotification(
                    observer, element, notification as CFString, refcon
                ) == .success { subscribed = true }
            }
            // A watch subscribed to nothing can never increment, and reporting it as tracking would
            // make every later comparison a false "nothing changed".
            guard subscribed else { return AXEventCheckpoint(tracking: false, revision: 0) }
            CFRunLoopAddSource(
                CFRunLoopGetMain(),
                AXObserverGetRunLoopSource(observer),
                .defaultMode
            )
            watches[key] = watch
            return AXEventCheckpoint(tracking: true, revision: 0)
        }
    }

    public func checkpoint(sessionId: String, pid: Int32) -> AXEventCheckpoint {
        let key = Key(sessionId: sessionId, pid: pid)
        let existing = lock.withLock { watches[key] }
        guard let existing else { return begin(sessionId: sessionId, pid: pid) }
        return AXEventCheckpoint(
            tracking: true, revision: existing.revision,
            lastNotification: existing.lastNotification
        )
    }

    public func reset(sessionId: String) {
        let dropped: [Watch] = lock.withLock {
            let matching = watches.filter { $0.key.sessionId == sessionId }
            matching.keys.forEach { watches.removeValue(forKey: $0) }
            return Array(matching.values)
        }
        for watch in dropped {
            CFRunLoopRemoveSource(
                CFRunLoopGetMain(),
                AXObserverGetRunLoopSource(watch.observer),
                .defaultMode
            )
        }
    }
}

// MARK: - Focus leases

/// Pinned by `ServiceCore.focusLeaseErrorCode`.
public enum FocusLeaseError: Error, Equatable, Sendable {
    case policyForbidsLease(SemanticDeliveryPolicy)
    case invalidLeaseWindow
    case leaseNotFound
    case leaseAlreadyHeld
}

/// Exclusive, time-bounded permission to take foreground focus.
///
/// A lease exists so foreground delivery is a bounded, receipted event rather than an ambient
/// capability: `ServiceCore` acquires one only when the policy requires approval and releases it on
/// every path out of the action, including failures.
public protocol FocusLeasing: Sendable {
    func acquire(
        sessionId: String,
        policy: SemanticDeliveryPolicy,
        targetPid: Int32,
        targetWindowId: UInt32?,
        options: FocusLeaseOptions
    ) throws -> FocusLeaseReceipt
    func release(leaseId: String) throws -> FocusLeaseReceipt
    /// Returns the receipts produced, so a caller can see WHAT was swept. A sweep that reports
    /// nothing is indistinguishable from a sweep that found nothing.
    @discardableResult
    func releaseAll(sessionId: String) -> [FocusLeaseReceipt]
}

public final class FocusLeaseManager: FocusLeasing, @unchecked Sendable {
    private struct Held {
        let sessionId: String
        var receipt: FocusLeaseReceipt
    }

    private let lock = NSLock()
    private var leases: [String: Held] = [:]
    private let focus: any FocusControlling
    private let clock: @Sendable () -> Int64
    private let sleep: @Sendable (TimeInterval) -> Void

    /// The clock and the sleep are injected so lease expiry is testable without waiting in real
    /// time — an expiry rule verified by a sleeping test is a rule nobody re-runs.
    public init(
        focus: any FocusControlling = AppKitFocusController(),
        clock: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1_000) },
        sleep: @escaping @Sendable (TimeInterval) -> Void = { Thread.sleep(forTimeInterval: $0) }
    ) {
        self.focus = focus
        self.clock = clock
        self.sleep = sleep
    }

    /// The lease a session currently holds, if any.
    public func heldLease(sessionId: String) -> FocusLeaseReceipt? {
        lock.withLock { leases.values.first { $0.sessionId == sessionId }?.receipt }
    }

    public func acquire(
        sessionId: String,
        policy: SemanticDeliveryPolicy,
        targetPid: Int32,
        targetWindowId: UInt32?,
        options: FocusLeaseOptions
    ) throws -> FocusLeaseReceipt {
        // One foreground lease at a time, globally. Two concurrent holders would each believe they
        // own the foreground and each restore over the other's target.
        try lock.withLock {
            guard leases.isEmpty else { throw FocusLeaseError.leaseAlreadyHeld }
        }
        guard policy.requiresApproval else { throw FocusLeaseError.policyForbidsLease(policy) }
        guard (1...600_000).contains(options.ttlMs),
              (1...60_000).contains(options.activationTimeoutMs) else {
            throw FocusLeaseError.invalidLeaseWindow
        }
        let previous = focus.observeFrontmost()
        let acquiredAt = clock()
        guard focus.requestActivation(pid: targetPid) else {
            throw FocusLeaseError.invalidLeaseWindow
        }

        // Poll for the activation actually landing rather than assuming it: accepting the request
        // is not the same as coming forward, and the receipt must say which happened.
        let deadline = acquiredAt + Int64(options.activationTimeoutMs)
        var becameFrontmost = false
        repeat {
            if focus.observeFrontmost().pid == targetPid { becameFrontmost = true; break }
            sleep(0.02)
        } while clock() < deadline

        let receipt = FocusLeaseReceipt(
            leaseId: UUID().uuidString,
            targetPid: targetPid,
            targetWindowId: targetWindowId,
            previousFrontmostPid: previous.pid,
            previousFrontmostBundleId: previous.bundleId,
            restorePolicy: options.restorePolicy ?? policy.restorePolicy,
            acquiredAtMs: acquiredAt,
            releasedAtMs: 0,
            expiresAtMs: acquiredAt + Int64(options.ttlMs),
            targetBecameFrontmost: becameFrontmost,
            frontmostPidAfterAcquire: focus.observeFrontmost().pid,
            frontmostPidAtRelease: nil,
            restoreOutcome: .nothingToRestore,
            expired: false
        )
        lock.withLock { leases[receipt.leaseId] = Held(sessionId: sessionId, receipt: receipt) }
        guard becameFrontmost else {
            _ = try? release(leaseId: receipt.leaseId)
            throw FocusLeaseError.invalidLeaseWindow
        }
        return receipt
    }

    public func release(leaseId: String) throws -> FocusLeaseReceipt {
        guard var held = lock.withLock({ leases.removeValue(forKey: leaseId) }) else {
            throw FocusLeaseError.leaseNotFound
        }
        let frontmostAtRelease = focus.observeFrontmost().pid
        var outcome: FocusRestoreOutcome = .nothingToRestore

        if let previousPid = held.receipt.previousFrontmostPid,
           previousPid != held.receipt.targetPid {
            switch held.receipt.restorePolicy {
            case .never:
                outcome = .retained
            case .always, .ifUnchanged:
                // `ifUnchanged` restores only when the target is still in front. If a HUMAN moved
                // focus somewhere else during the lease, yanking it back would fight the user —
                // that case is reported as humanOverride, not as a failure.
                if held.receipt.restorePolicy == .ifUnchanged,
                   frontmostAtRelease != held.receipt.targetPid {
                    outcome = .humanOverride
                } else if focus.requestActivation(pid: previousPid) {
                    outcome = focus.observeFrontmost().pid == previousPid ? .restored : .restoreFailed
                } else {
                    outcome = .restoreFailed
                }
            }
        }

        held.receipt.releasedAtMs = clock()
        // Expiry is recorded, never used as an excuse to keep focus — an expired lease still
        // restores, it just says it expired.
        held.receipt.expired = clock() >= held.receipt.expiresAtMs
        held.receipt.frontmostPidAtRelease = frontmostAtRelease
        held.receipt.restoreOutcome = outcome
        return held.receipt
    }

    @discardableResult
    public func releaseAll(sessionId: String) -> [FocusLeaseReceipt] {
        let ids = lock.withLock {
            leases.filter { $0.value.sessionId == sessionId }.map(\.key)
        }
        return ids.compactMap { try? release(leaseId: $0) }
    }
}

// MARK: - Image analysis

/// Pinned by `ServiceCore.imageAnalysisErrorCode`.
public enum ImageAnalysisError: Error, Equatable, Sendable {
    /// Undecodable bytes, or a decode whose dimensions disagree with the handle. Both are the same
    /// fault to a caller: the image it is holding is not the image that was analysed.
    case invalidImage
    case invalidRequest
    case tooManyRegions
    case invalidRegion
    case duplicateRegionId
}

public struct ImageAnalysisOutcome: Equatable, Sendable {
    public var fingerprints: [VisualFingerprintRef]
    public var texts: [OCRTextRef]
    /// Per-region failures. A region that could not be read is reported here rather than thrown, so
    /// one bad region does not discard the regions that succeeded.
    public var errors: [String]
    public var latencyMs: Int

    public init(
        fingerprints: [VisualFingerprintRef] = [],
        texts: [OCRTextRef] = [],
        errors: [String] = [],
        latencyMs: Int = 0
    ) {
        self.fingerprints = fingerprints
        self.texts = texts
        self.errors = errors
        self.latencyMs = latencyMs
    }
}

/// Region colour fingerprinting and OCR over an already-captured still.
///
/// RECONSTRUCTION CAVEAT — read before trusting `colorName`. The evicted implementation's colour
/// vocabulary is pinned by NO surviving artefact: `visual.fingerprint.ts` only validates ranges, and
/// `benchmark-computer-color.ts` feeds hardcoded names to downstream selection. The measurable
/// quantities below are standard and objective (sRGB→OKLab per Björn Ottosson's published
/// transform, Shannon entropy over a quantised histogram, coverage as a pixel fraction), but the
/// NAME assigned to a colour is a chosen taxonomy. Validate it against real captures before any
/// ranking logic depends on it, and treat a name mismatch as a reconstruction defect rather than a
/// perception failure.
public final class ImageAnalysisService: @unchecked Sendable {
    public init() {}

    public func analyze(
        bytes: Data,
        expectedWidth: Int,
        expectedHeight: Int,
        fingerprintRegions: [ImageAnalysisRegion],
        ocrRegion: CuRect?,
        ocrQuery: String?
    ) throws -> ImageAnalysisOutcome {
        let started = Date()
        guard let source = CGImageSourceCreateWithData(bytes as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            throw ImageAnalysisError.invalidImage
        }
        // Coordinates returned against a differently-sized decode would silently not correspond to
        // the frame the caller is holding, so disagreement is fatal rather than adjusted for.
        guard image.width == expectedWidth, image.height == expectedHeight else {
            throw ImageAnalysisError.invalidImage
        }

        var fingerprints: [VisualFingerprintRef] = []
        var texts: [OCRTextRef] = []
        var errors: [String] = []

        for region in fingerprintRegions {
            do { fingerprints.append(try Self.fingerprint(image, region: region)) }
            catch { errors.append("fingerprint \(region.id): \(String(describing: error))") }
        }
        if let ocrRegion {
            do { texts = try Self.recognizeText(image, region: ocrRegion, query: ocrQuery) }
            catch { errors.append("ocr: \(String(describing: error))") }
        }

        return ImageAnalysisOutcome(
            fingerprints: fingerprints,
            texts: texts,
            errors: errors,
            latencyMs: Int(Date().timeIntervalSince(started) * 1_000)
        )
    }

    private static func pixels(
        _ image: CGImage, rect: CGRect
    ) throws -> (data: [UInt8], width: Int, height: Int) {
        let bounded = rect.integral
        guard bounded.width >= 1, bounded.height >= 1,
              bounded.minX >= 0, bounded.minY >= 0,
              bounded.maxX <= CGFloat(image.width), bounded.maxY <= CGFloat(image.height),
              let cropped = image.cropping(to: bounded) else {
            throw ImageAnalysisError.invalidRegion
        }
        let width = cropped.width, height = cropped.height
        var buffer = [UInt8](repeating: 0, count: width * height * 4)
        guard let context = CGContext(
            data: &buffer, width: width, height: height,
            bitsPerComponent: 8, bytesPerRow: width * 4,
            space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { throw ImageAnalysisError.invalidImage }
        context.draw(cropped, in: CGRect(x: 0, y: 0, width: width, height: height))
        return (buffer, width, height)
    }

    private static func fingerprint(
        _ image: CGImage, region: ImageAnalysisRegion
    ) throws -> VisualFingerprintRef {
        let (buffer, width, height) = try pixels(image, rect: region.bounds.cgRect)
        let count = width * height
        guard count > 0 else { throw ImageAnalysisError.invalidRegion }

        var reds: [Int] = [], greens: [Int] = [], blues: [Int] = []
        reds.reserveCapacity(count); greens.reserveCapacity(count); blues.reserveCapacity(count)
        // 4 bits per channel: coarse enough that anti-aliasing does not shatter a flat fill into
        // hundreds of buckets, fine enough to separate UI colours that a user would call different.
        var histogram: [Int: Int] = [:]
        for index in stride(from: 0, to: count * 4, by: 4) {
            let red = Int(buffer[index]), green = Int(buffer[index + 1]), blue = Int(buffer[index + 2])
            reds.append(red); greens.append(green); blues.append(blue)
            let bucket = ((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4)
            histogram[bucket, default: 0] += 1
        }

        let centerIndex = ((height / 2) * width + (width / 2)) * 4
        let centerRGB = RGBColorRef(
            red: Int(buffer[centerIndex]),
            green: Int(buffer[centerIndex + 1]),
            blue: Int(buffer[centerIndex + 2])
        )
        let medianRGB = RGBColorRef(
            red: median(reds), green: median(greens), blue: median(blues)
        )

        let dominant = histogram.sorted { $0.value > $1.value }.prefix(3).map { entry -> VisualDominantColorRef in
            let bucket = entry.key
            return VisualDominantColorRef(
                // Bucket centre, not its floor: the floor consistently reads darker than the pixels.
                rgb: RGBColorRef(
                    red: (((bucket >> 8) & 0xF) << 4) | 0x8,
                    green: (((bucket >> 4) & 0xF) << 4) | 0x8,
                    blue: ((bucket & 0xF) << 4) | 0x8
                ),
                coverage: Double(entry.value) / Double(count)
            )
        }

        let oklab = Self.oklab(medianRGB)
        let chroma = (oklab.a * oklab.a + oklab.b * oklab.b).squareRoot()
        // Shannon entropy over the histogram, normalised to [0,1] by the maximum entropy this many
        // samples could carry. A flat fill approaches 0; photographic content approaches 1.
        var entropy = 0.0
        for value in histogram.values {
            let probability = Double(value) / Double(count)
            entropy -= probability * log2(probability)
        }
        let maxEntropy = log2(Double(min(histogram.count, count)))
        let normalisedEntropy = maxEntropy > 0 ? min(entropy / maxEntropy, 1) : 0

        return VisualFingerprintRef(
            id: region.id,
            centerRGB: centerRGB,
            medianRGB: medianRGB,
            dominant: dominant,
            oklab: OKLabColorRef(lightness: oklab.lightness, a: oklab.a, b: oklab.b),
            luminance: oklab.lightness,
            chroma: chroma,
            colorName: Self.name(oklab: oklab, chroma: chroma),
            entropy: normalisedEntropy,
            // Confidence is the top bucket's coverage: how much of the region actually IS the
            // colour being reported. A region of one flat colour reports ~1; a busy region reports
            // low, which is the honest signal that its "colour" is not a meaningful summary.
            confidence: dominant.first?.coverage ?? 0,
            sampleCount: count,
            sourceColorSpace: "sRGB"
        )
    }

    private static func median(_ values: [Int]) -> Int {
        guard !values.isEmpty else { return 0 }
        return values.sorted()[values.count / 2]
    }

    /// sRGB → OKLab, Björn Ottosson's published transform.
    private static func oklab(_ rgb: RGBColorRef) -> (lightness: Double, a: Double, b: Double) {
        func linear(_ channel: Int) -> Double {
            let value = Double(channel) / 255
            return value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
        }
        let red = linear(rgb.red), green = linear(rgb.green), blue = linear(rgb.blue)
        let l = cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue)
        let m = cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue)
        let s = cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue)
        return (
            0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
            1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
        )
    }

    /// Achromatic first (a hue angle is meaningless at near-zero chroma), then hue sectors. See the
    /// reconstruction caveat on the type: this taxonomy is chosen, not recovered.
    private static func name(
        oklab: (lightness: Double, a: Double, b: Double), chroma: Double
    ) -> String {
        if chroma < 0.04 {
            if oklab.lightness < 0.2 { return "black" }
            if oklab.lightness > 0.85 { return "white" }
            return "gray"
        }
        var degrees = atan2(oklab.b, oklab.a) * 180 / .pi
        if degrees < 0 { degrees += 360 }
        switch degrees {
        case ..<20, 345...: return oklab.lightness < 0.45 ? "brown" : "red"
        case ..<70: return oklab.lightness < 0.5 ? "brown" : "orange"
        case ..<105: return "yellow"
        case ..<165: return "green"
        case ..<200: return "teal"
        case ..<260: return "blue"
        case ..<300: return "purple"
        default: return "pink"
        }
    }

    private static func recognizeText(
        _ image: CGImage, region: CuRect, query: String?
    ) throws -> [OCRTextRef] {
        let rect = region.cgRect.integral
        guard rect.width >= 1, rect.height >= 1, rect.minX >= 0, rect.minY >= 0,
              rect.maxX <= CGFloat(image.width), rect.maxY <= CGFloat(image.height),
              let cropped = image.cropping(to: rect) else {
            throw ImageAnalysisError.invalidRegion
        }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        do {
            try VNImageRequestHandler(cgImage: cropped, options: [:]).perform([request])
        } catch {
            throw ImageAnalysisError.invalidRegion
        }
        let width = Double(cropped.width), height = Double(cropped.height)
        return (request.results ?? []).compactMap { observation -> OCRTextRef? in
            guard let candidate = observation.topCandidates(1).first else { return nil }
            if let query, !query.isEmpty,
               candidate.string.range(of: query, options: .caseInsensitive) == nil { return nil }
            // Vision reports a normalised, BOTTOM-left box; every other rect in this service is
            // top-left pixels in the ORIGINAL image, so convert and re-origin onto the region.
            let box = observation.boundingBox
            return OCRTextRef(
                text: candidate.string,
                confidence: Double(candidate.confidence),
                bounds: CuRect(
                    x: region.x + box.minX * width,
                    y: region.y + (1 - box.maxY) * height,
                    width: box.width * width,
                    height: box.height * height
                )
            )
        }
    }
}

// MARK: - Adaptive evidence settling

/// Waits for an action's effect to become observable, then reports what was actually achieved.
///
/// The contract that matters: this NEVER upgrades the achieved tier. It polls until the AX event
/// revision moves or the observed node differs from `before`, and if that has not happened inside
/// the requirement's budget it reports `timedOut` with the tier the caller already had. Reporting a
/// tier the evidence does not support would make every downstream "verified" claim unfalsifiable.
public final class AdaptiveEvidenceSettler: @unchecked Sendable {
    private let now: @Sendable () -> Int64
    private let sleep: @Sendable (Int64) -> Void

    /// Clock and sleep are injected in MICROSECONDS so a test can advance settling without waiting
    /// — a settle budget verified by a sleeping test is one nobody re-runs.
    public init(
        now: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1_000) },
        sleep: @escaping @Sendable (Int64) -> Void = { Thread.sleep(forTimeInterval: Double($0) / 1_000_000) }
    ) {
        self.now = now
        self.sleep = sleep
    }

    public func settle(
        requirement: EvidenceRequirement,
        achievedTier: EvidenceTier,
        before: AXNode,
        eventRevisionBefore: UInt64,
        observe: () throws -> AXSnapshot,
        eventRevision: () -> UInt64
    ) -> EvidenceReceipt {
        let started = now()
        let budget = Int64(max(requirement.settleTimeoutMs, 0))
        var attempts = 0
        var eventChanged = false
        var postconditionMatched: Bool?
        var observedChange = false

        repeat {
            attempts += 1
            if eventRevision() != eventRevisionBefore { eventChanged = true }
            if let snapshot = try? observe(),
               let node = snapshot.nodes.first(where: { $0.stablePathHash == before.stablePathHash }) {
                if node != before { observedChange = true }
                if let postcondition = requirement.postcondition {
                    postconditionMatched = Self.matches(postcondition, node: node)
                }
            }
            if eventChanged || observedChange || postconditionMatched == true { break }
            // A poll interval, not a settle time: the loop exits on the first observed change, so
            // this only bounds how finely the budget is subdivided.
            sleep(25_000)
        } while now() - started < budget

        let outcome: EvidenceOutcome
        if let postconditionMatched {
            outcome = postconditionMatched ? .satisfied : (eventChanged ? .missed : .timedOut)
        } else if eventChanged || observedChange {
            outcome = .satisfied
        } else {
            outcome = .timedOut
        }

        return EvidenceReceipt(
            requiredTier: requirement.tier,
            achievedTier: achievedTier,
            outcome: outcome,
            eventChanged: eventChanged,
            postconditionMatched: postconditionMatched,
            attempts: attempts,
            settledAtMs: now()
        )
    }

    /// Every stated clause must hold. An unstated clause is not evidence and is skipped rather
    /// than defaulted — a postcondition that silently passed on the parts it was not asked about
    /// would report `satisfied` for an action nobody checked.
    private static func matches(_ postcondition: SemanticPostcondition, node: AXNode) -> Bool {
        if let text = postcondition.text {
            let haystack = "\(node.label ?? "") \(node.value ?? "")"
            let found = haystack.range(of: text, options: .caseInsensitive) != nil
            if (postcondition.textPresence == .present) != found { return false }
        }
        if let expected = postcondition.expectedValue, node.value != expected { return false }
        if let focused = postcondition.expectedFocused, node.focused != focused { return false }
        if let selected = postcondition.expectedSelected, node.selected != selected { return false }
        return true
    }
}
