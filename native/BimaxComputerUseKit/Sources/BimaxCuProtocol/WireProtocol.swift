import CryptoKit
import Foundation

public enum BimaxCuProtocolVersion {
    public static let v1 = "bimax.cu.v1"
}

public enum PermissionDisposition: String, Codable, Equatable, Sendable {
    case granted
    case denied
    case unknown
    case notRequired = "not_required"
}

public struct PermissionState: Codable, Equatable, Sendable {
    public var accessibility: PermissionDisposition
    public var screenRecording: PermissionDisposition
    public var screenCapturable: Bool?
    public var inputMonitoring: PermissionDisposition
    /// Production signing: a real identity that is NOT ad-hoc. Unchanged meaning — the fields below
    /// are additive and never widen this one.
    public var serviceSigned: Bool
    public var signingIdentifier: String?
    /// Additive in `bimax.cu.v1`. Optional so an older service that omits them decodes unchanged,
    /// and so a missing field can never read as a satisfied check.
    public var adHocSigned: Bool?
    /// The signature still covers the bytes on disk. True for an intact ad-hoc signature: it proves
    /// the binary was not modified after sealing, and says nothing about who sealed it.
    public var signatureIntact: Bool?
    /// Content-addressed identity of exactly these bytes, for approval records.
    public var codeDirectoryHash: String?

    public init(
        accessibility: PermissionDisposition,
        screenRecording: PermissionDisposition,
        screenCapturable: Bool?,
        inputMonitoring: PermissionDisposition,
        serviceSigned: Bool,
        signingIdentifier: String? = nil,
        adHocSigned: Bool? = nil,
        signatureIntact: Bool? = nil,
        codeDirectoryHash: String? = nil
    ) {
        self.accessibility = accessibility
        self.screenRecording = screenRecording
        self.screenCapturable = screenCapturable
        self.inputMonitoring = inputMonitoring
        self.serviceSigned = serviceSigned
        self.signingIdentifier = signingIdentifier
        self.adHocSigned = adHocSigned
        self.signatureIntact = signatureIntact
        self.codeDirectoryHash = codeDirectoryHash
    }
}

public struct ObserveCapabilities: Codable, Equatable, Sendable {
    public var profiles: [String]
    public var scopes: [String]
    public var axDiff: Bool
    public var eventRevisions: Bool
    public var som: Bool
    public var regionCapture: Bool
    public var zoom: Bool
    public var streams: Bool
    /// Additive in `bimax.cu.v1`: server-side element search and per-element capability discovery.
    public var query: Bool
    public var capabilityDiscovery: Bool

    public init(profiles: [String] = [], scopes: [String] = [], axDiff: Bool = false, eventRevisions: Bool = false, som: Bool = false, regionCapture: Bool = false, zoom: Bool = false, streams: Bool = false, query: Bool = false, capabilityDiscovery: Bool = false) {
        self.profiles = profiles
        self.scopes = scopes
        self.axDiff = axDiff
        self.eventRevisions = eventRevisions
        self.som = som
        self.regionCapture = regionCapture
        self.zoom = zoom
        self.streams = streams
        self.query = query
        self.capabilityDiscovery = capabilityDiscovery
    }

    private enum CodingKeys: String, CodingKey {
        case profiles, scopes, axDiff, eventRevisions, som, regionCapture, zoom, streams
        case query, capabilityDiscovery
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        profiles = try container.decodeIfPresent([String].self, forKey: .profiles) ?? []
        scopes = try container.decodeIfPresent([String].self, forKey: .scopes) ?? []
        axDiff = try container.decodeIfPresent(Bool.self, forKey: .axDiff) ?? false
        eventRevisions = try container.decodeIfPresent(Bool.self, forKey: .eventRevisions) ?? false
        som = try container.decodeIfPresent(Bool.self, forKey: .som) ?? false
        regionCapture = try container.decodeIfPresent(Bool.self, forKey: .regionCapture) ?? false
        zoom = try container.decodeIfPresent(Bool.self, forKey: .zoom) ?? false
        streams = try container.decodeIfPresent(Bool.self, forKey: .streams) ?? false
        query = try container.decodeIfPresent(Bool.self, forKey: .query) ?? false
        capabilityDiscovery = try container.decodeIfPresent(Bool.self, forKey: .capabilityDiscovery) ?? false
    }
}

public struct DeliveryCapabilities: Codable, Equatable, Sendable {
    /// Every delivery policy the service will accept.
    public var policies: [String]
    /// The subset whose focus behavior has been proven against a live workspace by
    /// `--self-test-focus`. Advertised is "will be attempted"; verified is "has been observed to do
    /// what it claims". Additive in `bimax.cu.v1`; an older service reports none.
    public var verifiedDeliveryPolicies: [String]
    /// Every action the service will accept.
    public var semanticActions: [String]
    /// The subset proven to produce a real effect against a live Accessibility server by
    /// `--self-test-catalog`. Additive in `bimax.cu.v1`; an older service reports none, and a
    /// caller must treat "advertised" as "will be attempted", not "known to work".
    public var verifiedSemanticActions: [String]
    public var targetedEvents: Bool
    public var physicalInput: Bool
    public var focusLease: Bool
    /// Bounded, same-snapshot semantic transactions. Additive in `bimax.cu.v1`.
    public var semanticTransactions: Bool

    public init(policies: [String] = [], verifiedDeliveryPolicies: [String] = [], semanticActions: [String] = [], verifiedSemanticActions: [String] = [], targetedEvents: Bool = false, physicalInput: Bool = false, focusLease: Bool = false, semanticTransactions: Bool = false) {
        self.policies = policies
        self.verifiedDeliveryPolicies = verifiedDeliveryPolicies
        self.semanticActions = semanticActions
        self.verifiedSemanticActions = verifiedSemanticActions
        self.targetedEvents = targetedEvents
        self.physicalInput = physicalInput
        self.focusLease = focusLease
        self.semanticTransactions = semanticTransactions
    }

    private enum CodingKeys: String, CodingKey {
        case policies, verifiedDeliveryPolicies, semanticActions, verifiedSemanticActions
        case targetedEvents, physicalInput, focusLease, semanticTransactions
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        policies = try container.decodeIfPresent([String].self, forKey: .policies) ?? []
        verifiedDeliveryPolicies = try container.decodeIfPresent([String].self, forKey: .verifiedDeliveryPolicies) ?? []
        semanticActions = try container.decodeIfPresent([String].self, forKey: .semanticActions) ?? []
        verifiedSemanticActions = try container.decodeIfPresent([String].self, forKey: .verifiedSemanticActions) ?? []
        targetedEvents = try container.decodeIfPresent(Bool.self, forKey: .targetedEvents) ?? false
        physicalInput = try container.decodeIfPresent(Bool.self, forKey: .physicalInput) ?? false
        focusLease = try container.decodeIfPresent(Bool.self, forKey: .focusLease) ?? false
        semanticTransactions = try container.decodeIfPresent(Bool.self, forKey: .semanticTransactions) ?? false
    }
}

public struct WorkspaceCapabilities: Codable, Equatable, Sendable {
    public var apps: Bool
    public var windows: Bool
    public var displays: Bool
    public var spaces: Bool
    public var files: [String]
    /// Every mutating workspace operation the service will accept. Additive in `bimax.cu.v1`.
    public var operations: [String]
    /// The subset proven against a live workspace by `--self-test-workspace`. Advertised is "will
    /// be attempted"; verified is "has been observed to do what it claims". An older service
    /// reports none, and absent must read as nothing proven.
    public var verifiedOperations: [String]

    public init(apps: Bool = false, windows: Bool = false, displays: Bool = false, spaces: Bool = false, files: [String] = [], operations: [String] = [], verifiedOperations: [String] = []) {
        self.apps = apps
        self.windows = windows
        self.displays = displays
        self.spaces = spaces
        self.files = files
        self.operations = operations
        self.verifiedOperations = verifiedOperations
    }

    private enum CodingKeys: String, CodingKey {
        case apps, windows, displays, spaces, files, operations, verifiedOperations
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        apps = try container.decodeIfPresent(Bool.self, forKey: .apps) ?? false
        windows = try container.decodeIfPresent(Bool.self, forKey: .windows) ?? false
        displays = try container.decodeIfPresent(Bool.self, forKey: .displays) ?? false
        spaces = try container.decodeIfPresent(Bool.self, forKey: .spaces) ?? false
        files = try container.decodeIfPresent([String].self, forKey: .files) ?? []
        operations = try container.decodeIfPresent([String].self, forKey: .operations) ?? []
        verifiedOperations = try container.decodeIfPresent([String].self, forKey: .verifiedOperations) ?? []
    }
}

/// Mutating workspace operations, named once so the service, the conformance run, and the
/// coordinator cannot drift apart on spelling.
public enum WorkspaceOperationKind: String, Codable, Equatable, Sendable, CaseIterable {
    case resolveApp = "resolve_app"
    case launchApp = "launch_app"
    case inspectFile = "inspect_file"
    case openFile = "open_file"
    case revealFile = "reveal_file"
    case trashFile = "trash_file"
    case duplicateFile = "duplicate_file"
    case openUrl = "open_url"
    case moveWindow = "move_window"
    case resizeWindow = "resize_window"
    case setWindowFrame = "set_window_frame"
    case minimizeWindow = "minimize_window"
    case unminimizeWindow = "unminimize_window"
    case closeWindow = "close_window"
    case setWindowFullScreen = "set_window_fullscreen"
}

public struct BrowserCapabilities: Codable, Equatable, Sendable {
    public var typedRoute: Bool
    public var dialogs: Bool
    public var fileInput: Bool
    public var downloads: Bool

    public init(typedRoute: Bool = false, dialogs: Bool = false, fileInput: Bool = false, downloads: Bool = false) {
        self.typedRoute = typedRoute
        self.dialogs = dialogs
        self.fileInput = fileInput
        self.downloads = downloads
    }
}

public struct RecordingCapabilities: Codable, Equatable, Sendable {
    public var trajectory: Bool
    public var video: Bool
    public var replayModes: [String]

    public init(trajectory: Bool = false, video: Bool = false, replayModes: [String] = []) {
        self.trajectory = trajectory
        self.video = video
        self.replayModes = replayModes
    }
}

/// Presentation-only overlay capabilities. A cursor overlay is never an input or observation
/// coordinate surface.
public struct OverlayCapabilities: Codable, Equatable, Sendable {
    public var cursor: Bool

    public init(cursor: Bool = false) { self.cursor = cursor }
}

public struct CapabilitySet: Codable, Equatable, Sendable {
    public var observe: ObserveCapabilities
    public var delivery: DeliveryCapabilities
    public var workspace: WorkspaceCapabilities
    public var browser: BrowserCapabilities
    public var recording: RecordingCapabilities
    /// Optional so an older `bimax.cu.v1` handshake decodes as unsupported, never as enabled.
    public var overlay: OverlayCapabilities?

    public init(
        observe: ObserveCapabilities = .init(),
        delivery: DeliveryCapabilities = .init(),
        workspace: WorkspaceCapabilities = .init(),
        browser: BrowserCapabilities = .init(),
        recording: RecordingCapabilities = .init(),
        overlay: OverlayCapabilities? = nil
    ) {
        self.observe = observe
        self.delivery = delivery
        self.workspace = workspace
        self.browser = browser
        self.recording = recording
        self.overlay = overlay
    }
}

public struct ProtocolLimits: Codable, Equatable, Sendable {
    public var maxTransactionSteps: Int
    public var maxElements: Int
    public var maxDiffOperations: Int
    public var maxImageDimension: Int
    public var maxConcurrentReadSessions: Int
    public var maxCaptureStreams: Int

    public init(maxTransactionSteps: Int = 5, maxElements: Int = 2_000, maxDiffOperations: Int = 5_000, maxImageDimension: Int = 4_096, maxConcurrentReadSessions: Int = 4, maxCaptureStreams: Int = 2) {
        self.maxTransactionSteps = maxTransactionSteps
        self.maxElements = maxElements
        self.maxDiffOperations = maxDiffOperations
        self.maxImageDimension = maxImageDimension
        self.maxConcurrentReadSessions = maxConcurrentReadSessions
        self.maxCaptureStreams = maxCaptureStreams
    }
}

public struct PlatformInfo: Codable, Equatable, Sendable {
    public var os: String
    public var version: String
    public var architecture: String

    public init(os: String, version: String, architecture: String) {
        self.os = os
        self.version = version
        self.architecture = architecture
    }
}

public struct HandshakeRequest: Codable, Equatable, Sendable {
    public var clientVersion: String
    public var supportedProtocols: [String]
    public var requestedFeatures: [String]?

    public init(clientVersion: String, supportedProtocols: [String], requestedFeatures: [String]? = nil) {
        self.clientVersion = clientVersion
        self.supportedProtocols = supportedProtocols
        self.requestedFeatures = requestedFeatures
    }
}

public struct HandshakeResponse: Codable, Equatable, Sendable {
    public var selectedProtocol: String
    public var serviceVersion: String
    public var platform: PlatformInfo
    public var capabilities: CapabilitySet
    public var limits: ProtocolLimits
    public var permissions: PermissionState

    public init(selectedProtocol: String, serviceVersion: String, platform: PlatformInfo, capabilities: CapabilitySet, limits: ProtocolLimits, permissions: PermissionState) {
        self.selectedProtocol = selectedProtocol
        self.serviceVersion = serviceVersion
        self.platform = platform
        self.capabilities = capabilities
        self.limits = limits
        self.permissions = permissions
    }
}

public struct SessionInfo: Codable, Equatable, Sendable {
    public var sessionId: String
    public var generation: UInt64
    public var createdAtMs: Int64
    public var targetRevision: UInt64

    public init(sessionId: String, generation: UInt64, createdAtMs: Int64, targetRevision: UInt64 = 0) {
        self.sessionId = sessionId
        self.generation = generation
        self.createdAtMs = createdAtMs
        self.targetRevision = targetRevision
    }
}

public struct CuRect: Codable, Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

/// A process identity that remains distinct when macOS reuses a PID.
public struct AppRef: Codable, Equatable, Sendable {
    public var bundleId: String?
    public var pid: Int32
    public var launchId: String
    public var displayName: String?

    public init(bundleId: String?, pid: Int32, launchId: String, displayName: String?) {
        self.bundleId = bundleId
        self.pid = pid
        self.launchId = launchId
        self.displayName = displayName
    }
}

public struct AppInfo: Codable, Equatable, Sendable {
    public var app: AppRef
    public var activationPolicy: String
    public var active: Bool
    public var hidden: Bool
    public var finishedLaunching: Bool

    public init(app: AppRef, activationPolicy: String, active: Bool, hidden: Bool, finishedLaunching: Bool) {
        self.app = app
        self.activationPolicy = activationPolicy
        self.active = active
        self.hidden = hidden
        self.finishedLaunching = finishedLaunching
    }
}

/// `generation` changes if a WindowServer id disappears and is later reused.
public struct WindowRef: Codable, Equatable, Sendable {
    public var pid: Int32
    public var windowId: UInt32
    public var generation: UInt64
    public var title: String?

    public init(pid: Int32, windowId: UInt32, generation: UInt64, title: String?) {
        self.pid = pid
        self.windowId = windowId
        self.generation = generation
        self.title = title
    }
}

public struct WindowInfo: Codable, Equatable, Sendable {
    public var window: WindowRef
    public var ownerName: String?
    public var bounds: CuRect
    public var layer: Int
    public var alpha: Double
    public var onScreen: Bool

    public init(window: WindowRef, ownerName: String?, bounds: CuRect, layer: Int, alpha: Double, onScreen: Bool) {
        self.window = window
        self.ownerName = ownerName
        self.bounds = bounds
        self.layer = layer
        self.alpha = alpha
        self.onScreen = onScreen
    }
}

public struct DisplayInfo: Codable, Equatable, Sendable {
    public var displayId: UInt32
    public var bounds: CuRect
    /// The part of `bounds` not covered by the menu bar or Dock, in the same top-left global
    /// coordinate space. Absent when no live screen matches this display: a usable area is
    /// measured or omitted, never assumed to equal the full bounds.
    public var usableBounds: CuRect?
    public var pixelWidth: Int
    public var pixelHeight: Int
    public var scale: Double
    public var main: Bool

    public init(displayId: UInt32, bounds: CuRect, usableBounds: CuRect? = nil, pixelWidth: Int, pixelHeight: Int, scale: Double, main: Bool) {
        self.displayId = displayId
        self.bounds = bounds
        self.usableBounds = usableBounds
        self.pixelWidth = pixelWidth
        self.pixelHeight = pixelHeight
        self.scale = scale
        self.main = main
    }

    private enum CodingKeys: String, CodingKey {
        case displayId, bounds, usableBounds, pixelWidth, pixelHeight, scale, main
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        displayId = try container.decode(UInt32.self, forKey: .displayId)
        bounds = try container.decode(CuRect.self, forKey: .bounds)
        usableBounds = try container.decodeIfPresent(CuRect.self, forKey: .usableBounds)
        pixelWidth = try container.decode(Int.self, forKey: .pixelWidth)
        pixelHeight = try container.decode(Int.self, forKey: .pixelHeight)
        scale = try container.decode(Double.self, forKey: .scale)
        main = try container.decode(Bool.self, forKey: .main)
    }
}

public struct WorkspaceSnapshotRequest: Codable, Equatable, Sendable {
    public var pid: Int32?
    public var includeOffscreenWindows: Bool

    public init(pid: Int32? = nil, includeOffscreenWindows: Bool = false) {
        self.pid = pid
        self.includeOffscreenWindows = includeOffscreenWindows
    }
}

public struct WorkspaceSnapshot: Codable, Equatable, Sendable {
    public var capturedAtMs: Int64
    public var frontmostPid: Int32?
    public var apps: [AppInfo]
    public var windows: [WindowInfo]
    public var displays: [DisplayInfo]
    /// Whether each display has its own set of Spaces. This is the one publicly readable Spaces
    /// fact; it is reported because it changes what a display-scoped answer means, not because the
    /// service can enumerate or switch Spaces.
    public var displaysHaveSeparateSpaces: Bool

    public init(capturedAtMs: Int64, frontmostPid: Int32?, apps: [AppInfo], windows: [WindowInfo], displays: [DisplayInfo], displaysHaveSeparateSpaces: Bool = false) {
        self.capturedAtMs = capturedAtMs
        self.frontmostPid = frontmostPid
        self.apps = apps
        self.windows = windows
        self.displays = displays
        self.displaysHaveSeparateSpaces = displaysHaveSeparateSpaces
    }

    private enum CodingKeys: String, CodingKey {
        case capturedAtMs, frontmostPid, apps, windows, displays, displaysHaveSeparateSpaces
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        capturedAtMs = try container.decode(Int64.self, forKey: .capturedAtMs)
        frontmostPid = try container.decodeIfPresent(Int32.self, forKey: .frontmostPid)
        apps = try container.decode([AppInfo].self, forKey: .apps)
        windows = try container.decode([WindowInfo].self, forKey: .windows)
        displays = try container.decode([DisplayInfo].self, forKey: .displays)
        displaysHaveSeparateSpaces = try container.decodeIfPresent(Bool.self, forKey: .displaysHaveSeparateSpaces) ?? false
    }
}

/// How an application is named for resolution or launch.
///
/// There is deliberately no filesystem-path case. Launch Services resolves a registered
/// application from a bundle identifier or a display name; the protocol therefore has no way to
/// ask the service to execute an arbitrary binary on disk.
public enum AppLookup: Equatable, Sendable {
    case bundleId(String)
    case name(String)

    public var value: String {
        switch self {
        case .bundleId(let value), .name(let value): return value
        }
    }

    public var kind: String {
        switch self {
        case .bundleId: return "bundle_id"
        case .name: return "name"
        }
    }
}

extension AppLookup: Codable {
    private enum CodingKeys: String, CodingKey { case kind, value }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let value = try container.decode(String.self, forKey: .value)
        switch try container.decode(String.self, forKey: .kind) {
        case "bundle_id": self = .bundleId(value)
        case "name": self = .name(value)
        case let other:
            throw DecodingError.dataCorruptedError(forKey: .kind, in: container, debugDescription: "unknown app lookup kind \(other)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(kind, forKey: .kind)
        try container.encode(value, forKey: .value)
    }
}

public struct AppResolveRequest: Codable, Equatable, Sendable {
    public var lookup: AppLookup

    public init(lookup: AppLookup) {
        self.lookup = lookup
    }
}

/// Read-only Launch Services resolution. Resolving never launches, activates, or opens anything.
public struct ResolvedApplication: Codable, Equatable, Sendable {
    public var lookup: AppLookup
    public var resolved: Bool
    public var bundlePath: String?
    public var bundleId: String?
    public var displayName: String?
    /// Every currently running instance of the resolved bundle, so a caller can see that a launch
    /// would be a no-op before requesting one.
    public var running: [AppRef]

    public init(lookup: AppLookup, resolved: Bool, bundlePath: String? = nil, bundleId: String? = nil, displayName: String? = nil, running: [AppRef] = []) {
        self.lookup = lookup
        self.resolved = resolved
        self.bundlePath = bundlePath
        self.bundleId = bundleId
        self.displayName = displayName
        self.running = running
    }
}

public struct AppLaunchRequest: Codable, Equatable, Sendable {
    public var lookup: AppLookup
    /// How long the service may wait for the launched process to report `isFinishedLaunching`.
    /// `0` returns as soon as the process exists.
    public var readinessTimeoutMs: Int

    public init(lookup: AppLookup, readinessTimeoutMs: Int = 3_000) {
        self.lookup = lookup
        self.readinessTimeoutMs = readinessTimeoutMs
    }
}

public enum AppLaunchOutcome: String, Codable, Equatable, Sendable {
    /// The bundle already had a running instance. Nothing was launched: opening a running
    /// application raises it, which a background launch must never do.
    case alreadyRunning = "already_running"
    case launched
}

/// A launch receipt reports observed foreground state rather than trusting the launch API.
///
/// Every activation route in this kit has at some point returned success while changing nothing,
/// so `frontmostPidBefore`/`frontmostPidAfter` are measured around the call and `frontmostChanged`
/// is derived from them. A background launch that moved the human's foreground is reported, not
/// hidden.
public struct AppLaunchReceipt: Codable, Equatable, Sendable {
    public var outcome: AppLaunchOutcome
    public var app: AppRef?
    public var bundlePath: String?
    public var bundleId: String?
    /// Always false for this slice: the service requests a non-activating open.
    public var requestedActivation: Bool
    public var frontmostPidBefore: Int32?
    public var frontmostPidAfter: Int32?
    public var finishedLaunching: Bool
    public var durationMs: Int

    /// Derived, never stored: a receipt cannot claim the foreground was untouched while its own
    /// before/after measurements disagree.
    public var frontmostChanged: Bool { frontmostPidBefore != frontmostPidAfter }

    public init(outcome: AppLaunchOutcome, app: AppRef?, bundlePath: String?, bundleId: String?, requestedActivation: Bool, frontmostPidBefore: Int32?, frontmostPidAfter: Int32?, finishedLaunching: Bool, durationMs: Int) {
        self.outcome = outcome
        self.app = app
        self.bundlePath = bundlePath
        self.bundleId = bundleId
        self.requestedActivation = requestedActivation
        self.frontmostPidBefore = frontmostPidBefore
        self.frontmostPidAfter = frontmostPidAfter
        self.finishedLaunching = finishedLaunching
        self.durationMs = durationMs
    }

    private enum CodingKeys: String, CodingKey {
        case outcome, app, bundlePath, bundleId, requestedActivation
        case frontmostPidBefore, frontmostPidAfter, frontmostChanged, finishedLaunching, durationMs
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        outcome = try container.decode(AppLaunchOutcome.self, forKey: .outcome)
        app = try container.decodeIfPresent(AppRef.self, forKey: .app)
        bundlePath = try container.decodeIfPresent(String.self, forKey: .bundlePath)
        bundleId = try container.decodeIfPresent(String.self, forKey: .bundleId)
        requestedActivation = try container.decode(Bool.self, forKey: .requestedActivation)
        frontmostPidBefore = try container.decodeIfPresent(Int32.self, forKey: .frontmostPidBefore)
        frontmostPidAfter = try container.decodeIfPresent(Int32.self, forKey: .frontmostPidAfter)
        finishedLaunching = try container.decode(Bool.self, forKey: .finishedLaunching)
        durationMs = try container.decode(Int.self, forKey: .durationMs)
        // `frontmostChanged` on the wire is output only. A sender that disagrees with its own
        // measurements does not get to redefine what changed.
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(outcome, forKey: .outcome)
        try container.encodeIfPresent(app, forKey: .app)
        try container.encodeIfPresent(bundlePath, forKey: .bundlePath)
        try container.encodeIfPresent(bundleId, forKey: .bundleId)
        try container.encode(requestedActivation, forKey: .requestedActivation)
        try container.encodeIfPresent(frontmostPidBefore, forKey: .frontmostPidBefore)
        try container.encodeIfPresent(frontmostPidAfter, forKey: .frontmostPidAfter)
        try container.encode(frontmostChanged, forKey: .frontmostChanged)
        try container.encode(finishedLaunching, forKey: .finishedLaunching)
        try container.encode(durationMs, forKey: .durationMs)
    }
}

/// Read-only file description. Never contains file contents or directory listings.
public struct FileInspectRequest: Codable, Equatable, Sendable {
    /// Absolute path. The service does not expand `~`, resolve relative paths, or accept globs;
    /// workspace scoping happens in the coordinator before the path reaches here.
    public var path: String

    public init(path: String) {
        self.path = path
    }
}

public struct FileInfoReceipt: Codable, Equatable, Sendable {
    public var path: String
    public var exists: Bool
    public var isDirectory: Bool
    public var isPackage: Bool
    public var isSymbolicLink: Bool
    public var byteSize: Int64?
    public var contentType: String?
    public var contentTypeDescription: String?
    public var defaultApplicationPath: String?
    public var modifiedAtMs: Int64?

    public init(path: String, exists: Bool, isDirectory: Bool = false, isPackage: Bool = false, isSymbolicLink: Bool = false, byteSize: Int64? = nil, contentType: String? = nil, contentTypeDescription: String? = nil, defaultApplicationPath: String? = nil, modifiedAtMs: Int64? = nil) {
        self.path = path
        self.exists = exists
        self.isDirectory = isDirectory
        self.isPackage = isPackage
        self.isSymbolicLink = isSymbolicLink
        self.byteSize = byteSize
        self.contentType = contentType
        self.contentTypeDescription = contentTypeDescription
        self.defaultApplicationPath = defaultApplicationPath
        self.modifiedAtMs = modifiedAtMs
    }
}

public enum FileOperationKind: String, Codable, Equatable, Sendable, CaseIterable {
    /// Hand the file to an application through Launch Services, without activating it.
    case open = "open_file"
    /// Select the file in Finder. Finder comes forward; this is the one file operation that is
    /// foreground-changing by construction.
    case reveal = "reveal_file"
    /// Recoverable delete through `FileManager.trashItem`, which reports where the item landed.
    case trash = "trash_file"
    case duplicate = "duplicate_file"
}

public struct FileOperationRequest: Codable, Equatable, Sendable {
    public var operation: FileOperationKind
    public var path: String
    /// Only meaningful for `open_file`. Absent means the registered default handler.
    public var application: AppLookup?

    public init(operation: FileOperationKind, path: String, application: AppLookup? = nil) {
        self.operation = operation
        self.path = path
        self.application = application
    }
}

public struct FileOperationReceipt: Codable, Equatable, Sendable {
    public var operation: FileOperationKind
    public var path: String
    public var performed: Bool
    /// Where a trashed item landed, or where a duplicate was written. Present only when the
    /// filesystem reported an exact result; a receipt never guesses one.
    public var resultingPath: String?
    public var applicationBundlePath: String?
    public var app: AppRef?
    public var requestedActivation: Bool
    public var frontmostPidBefore: Int32?
    public var frontmostPidAfter: Int32?
    public var durationMs: Int

    public var frontmostChanged: Bool { frontmostPidBefore != frontmostPidAfter }

    public init(operation: FileOperationKind, path: String, performed: Bool, resultingPath: String? = nil, applicationBundlePath: String? = nil, app: AppRef? = nil, requestedActivation: Bool, frontmostPidBefore: Int32?, frontmostPidAfter: Int32?, durationMs: Int) {
        self.operation = operation
        self.path = path
        self.performed = performed
        self.resultingPath = resultingPath
        self.applicationBundlePath = applicationBundlePath
        self.app = app
        self.requestedActivation = requestedActivation
        self.frontmostPidBefore = frontmostPidBefore
        self.frontmostPidAfter = frontmostPidAfter
        self.durationMs = durationMs
    }

    private enum CodingKeys: String, CodingKey {
        case operation, path, performed, resultingPath, applicationBundlePath, app
        case requestedActivation, frontmostPidBefore, frontmostPidAfter, frontmostChanged, durationMs
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        operation = try container.decode(FileOperationKind.self, forKey: .operation)
        path = try container.decode(String.self, forKey: .path)
        performed = try container.decode(Bool.self, forKey: .performed)
        resultingPath = try container.decodeIfPresent(String.self, forKey: .resultingPath)
        applicationBundlePath = try container.decodeIfPresent(String.self, forKey: .applicationBundlePath)
        app = try container.decodeIfPresent(AppRef.self, forKey: .app)
        requestedActivation = try container.decode(Bool.self, forKey: .requestedActivation)
        frontmostPidBefore = try container.decodeIfPresent(Int32.self, forKey: .frontmostPidBefore)
        frontmostPidAfter = try container.decodeIfPresent(Int32.self, forKey: .frontmostPidAfter)
        durationMs = try container.decode(Int.self, forKey: .durationMs)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(operation, forKey: .operation)
        try container.encode(path, forKey: .path)
        try container.encode(performed, forKey: .performed)
        try container.encodeIfPresent(resultingPath, forKey: .resultingPath)
        try container.encodeIfPresent(applicationBundlePath, forKey: .applicationBundlePath)
        try container.encodeIfPresent(app, forKey: .app)
        try container.encode(requestedActivation, forKey: .requestedActivation)
        try container.encodeIfPresent(frontmostPidBefore, forKey: .frontmostPidBefore)
        try container.encodeIfPresent(frontmostPidAfter, forKey: .frontmostPidAfter)
        try container.encode(frontmostChanged, forKey: .frontmostChanged)
        try container.encode(durationMs, forKey: .durationMs)
    }
}

public struct OpenURLRequest: Codable, Equatable, Sendable {
    /// Only `http` and `https` are accepted. A custom scheme is a request to run whichever local
    /// application claims it, which is not something a computer-use protocol should be able to say.
    public var url: String
    public var application: AppLookup?

    public init(url: String, application: AppLookup? = nil) {
        self.url = url
        self.application = application
    }
}

public struct OpenURLReceipt: Codable, Equatable, Sendable {
    public var url: String
    public var scheme: String
    public var host: String?
    public var opened: Bool
    public var applicationBundlePath: String?
    public var app: AppRef?
    public var requestedActivation: Bool
    public var frontmostPidBefore: Int32?
    public var frontmostPidAfter: Int32?
    public var durationMs: Int

    public var frontmostChanged: Bool { frontmostPidBefore != frontmostPidAfter }

    public init(url: String, scheme: String, host: String?, opened: Bool, applicationBundlePath: String? = nil, app: AppRef? = nil, requestedActivation: Bool, frontmostPidBefore: Int32?, frontmostPidAfter: Int32?, durationMs: Int) {
        self.url = url
        self.scheme = scheme
        self.host = host
        self.opened = opened
        self.applicationBundlePath = applicationBundlePath
        self.app = app
        self.requestedActivation = requestedActivation
        self.frontmostPidBefore = frontmostPidBefore
        self.frontmostPidAfter = frontmostPidAfter
        self.durationMs = durationMs
    }

    private enum CodingKeys: String, CodingKey {
        case url, scheme, host, opened, applicationBundlePath, app
        case requestedActivation, frontmostPidBefore, frontmostPidAfter, frontmostChanged, durationMs
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        url = try container.decode(String.self, forKey: .url)
        scheme = try container.decode(String.self, forKey: .scheme)
        host = try container.decodeIfPresent(String.self, forKey: .host)
        opened = try container.decode(Bool.self, forKey: .opened)
        applicationBundlePath = try container.decodeIfPresent(String.self, forKey: .applicationBundlePath)
        app = try container.decodeIfPresent(AppRef.self, forKey: .app)
        requestedActivation = try container.decode(Bool.self, forKey: .requestedActivation)
        frontmostPidBefore = try container.decodeIfPresent(Int32.self, forKey: .frontmostPidBefore)
        frontmostPidAfter = try container.decodeIfPresent(Int32.self, forKey: .frontmostPidAfter)
        durationMs = try container.decode(Int.self, forKey: .durationMs)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(url, forKey: .url)
        try container.encode(scheme, forKey: .scheme)
        try container.encodeIfPresent(host, forKey: .host)
        try container.encode(opened, forKey: .opened)
        try container.encodeIfPresent(applicationBundlePath, forKey: .applicationBundlePath)
        try container.encodeIfPresent(app, forKey: .app)
        try container.encode(requestedActivation, forKey: .requestedActivation)
        try container.encodeIfPresent(frontmostPidBefore, forKey: .frontmostPidBefore)
        try container.encodeIfPresent(frontmostPidAfter, forKey: .frontmostPidAfter)
        try container.encode(frontmostChanged, forKey: .frontmostChanged)
        try container.encode(durationMs, forKey: .durationMs)
    }
}

public enum WindowOperationKind: String, Codable, Equatable, Sendable, CaseIterable {
    case move = "move_window"
    case resize = "resize_window"
    case setFrame = "set_window_frame"
    case minimize = "minimize_window"
    case unminimize = "unminimize_window"
    /// A commit action: an application may lose unsaved work. It is never routine.
    case close = "close_window"
    case setFullScreen = "set_window_fullscreen"
}

public struct WindowOperationRequest: Codable, Equatable, Sendable {
    public var operation: WindowOperationKind
    /// Exact target: PID, WindowServer id, and the service-issued generation. A stale generation
    /// is refused before any Accessibility write.
    public var window: WindowRef
    /// Requested geometry in top-left global points. `move` reads the origin, `resize` reads the
    /// size, `set_window_frame` reads both.
    public var frame: CuRect?
    public var fullScreen: Bool?

    public init(operation: WindowOperationKind, window: WindowRef, frame: CuRect? = nil, fullScreen: Bool? = nil) {
        self.operation = operation
        self.window = window
        self.frame = frame
        self.fullScreen = fullScreen
    }
}

/// A window receipt reports what the window *became*, not what was asked for.
///
/// `AXUIElementSetAttributeValue` returns `.success` and ignores the write on several toolkits, and
/// applications legitimately clamp geometry to their own minimum and maximum sizes. So `honored` is
/// computed by reading the window back, and the applied bounds are always reported.
public struct WindowOperationReceipt: Codable, Equatable, Sendable {
    public var operation: WindowOperationKind
    public var window: WindowRef
    public var attempted: Bool
    public var honored: Bool
    public var boundsBefore: CuRect?
    public var boundsAfter: CuRect?
    public var minimizedBefore: Bool?
    public var minimizedAfter: Bool?
    public var fullScreenBefore: Bool?
    public var fullScreenAfter: Bool?
    /// Present when the window is gone after the operation, which is what a successful close means.
    public var windowGone: Bool
    public var frontmostPidBefore: Int32?
    public var frontmostPidAfter: Int32?
    public var durationMs: Int

    public var frontmostChanged: Bool { frontmostPidBefore != frontmostPidAfter }

    public init(operation: WindowOperationKind, window: WindowRef, attempted: Bool, honored: Bool, boundsBefore: CuRect? = nil, boundsAfter: CuRect? = nil, minimizedBefore: Bool? = nil, minimizedAfter: Bool? = nil, fullScreenBefore: Bool? = nil, fullScreenAfter: Bool? = nil, windowGone: Bool = false, frontmostPidBefore: Int32?, frontmostPidAfter: Int32?, durationMs: Int) {
        self.operation = operation
        self.window = window
        self.attempted = attempted
        self.honored = honored
        self.boundsBefore = boundsBefore
        self.boundsAfter = boundsAfter
        self.minimizedBefore = minimizedBefore
        self.minimizedAfter = minimizedAfter
        self.fullScreenBefore = fullScreenBefore
        self.fullScreenAfter = fullScreenAfter
        self.windowGone = windowGone
        self.frontmostPidBefore = frontmostPidBefore
        self.frontmostPidAfter = frontmostPidAfter
        self.durationMs = durationMs
    }

    private enum CodingKeys: String, CodingKey {
        case operation, window, attempted, honored, boundsBefore, boundsAfter
        case minimizedBefore, minimizedAfter, fullScreenBefore, fullScreenAfter, windowGone
        case frontmostPidBefore, frontmostPidAfter, frontmostChanged, durationMs
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        operation = try container.decode(WindowOperationKind.self, forKey: .operation)
        window = try container.decode(WindowRef.self, forKey: .window)
        attempted = try container.decode(Bool.self, forKey: .attempted)
        honored = try container.decode(Bool.self, forKey: .honored)
        boundsBefore = try container.decodeIfPresent(CuRect.self, forKey: .boundsBefore)
        boundsAfter = try container.decodeIfPresent(CuRect.self, forKey: .boundsAfter)
        minimizedBefore = try container.decodeIfPresent(Bool.self, forKey: .minimizedBefore)
        minimizedAfter = try container.decodeIfPresent(Bool.self, forKey: .minimizedAfter)
        fullScreenBefore = try container.decodeIfPresent(Bool.self, forKey: .fullScreenBefore)
        fullScreenAfter = try container.decodeIfPresent(Bool.self, forKey: .fullScreenAfter)
        windowGone = try container.decodeIfPresent(Bool.self, forKey: .windowGone) ?? false
        frontmostPidBefore = try container.decodeIfPresent(Int32.self, forKey: .frontmostPidBefore)
        frontmostPidAfter = try container.decodeIfPresent(Int32.self, forKey: .frontmostPidAfter)
        durationMs = try container.decode(Int.self, forKey: .durationMs)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(operation, forKey: .operation)
        try container.encode(window, forKey: .window)
        try container.encode(attempted, forKey: .attempted)
        try container.encode(honored, forKey: .honored)
        try container.encodeIfPresent(boundsBefore, forKey: .boundsBefore)
        try container.encodeIfPresent(boundsAfter, forKey: .boundsAfter)
        try container.encodeIfPresent(minimizedBefore, forKey: .minimizedBefore)
        try container.encodeIfPresent(minimizedAfter, forKey: .minimizedAfter)
        try container.encodeIfPresent(fullScreenBefore, forKey: .fullScreenBefore)
        try container.encodeIfPresent(fullScreenAfter, forKey: .fullScreenAfter)
        try container.encode(windowGone, forKey: .windowGone)
        try container.encodeIfPresent(frontmostPidBefore, forKey: .frontmostPidBefore)
        try container.encodeIfPresent(frontmostPidAfter, forKey: .frontmostPidAfter)
        try container.encode(frontmostChanged, forKey: .frontmostChanged)
        try container.encode(durationMs, forKey: .durationMs)
    }
}

public enum AXObservationScope: String, Codable, Equatable, Sendable, CaseIterable {
    case application
    case window
    case systemUI = "system_ui"
}

public enum AXObservationIssueCode: String, Codable, Equatable, Sendable {
    case axTimeout = "ax_timeout"
    case axReadFailed = "ax_read_failed"
    case captureBudgetExceeded = "capture_budget_exceeded"
}

public struct AXObservationIssue: Codable, Equatable, Sendable {
    public var code: AXObservationIssueCode
    public var stage: String
    public var count: Int

    public init(code: AXObservationIssueCode, stage: String, count: Int = 1) {
        self.code = code
        self.stage = stage
        self.count = count
    }
}

public struct AXObserveRequest: Codable, Equatable, Sendable {
    public var pid: Int32
    public var windowId: UInt32?
    public var windowGeneration: UInt64?
    public var scope: AXObservationScope
    public var profile: String
    public var maxElements: Int
    public var maxDurationMs: Int
    public var sinceSnapshotId: String?
    /// Additive in `bimax.cu.v1`. A case-insensitive substring filter over each emitted node's
    /// label, value, identifier, and role. Absent means "no filter"; it never widens traversal.
    public var query: String?

    public init(pid: Int32, windowId: UInt32? = nil, windowGeneration: UInt64? = nil, scope: AXObservationScope? = nil, profile: String = "flash", maxElements: Int = 500, maxDurationMs: Int = 750, sinceSnapshotId: String? = nil, query: String? = nil) {
        self.pid = pid
        self.windowId = windowId
        self.windowGeneration = windowGeneration
        self.scope = scope ?? (windowId == nil ? .application : .window)
        self.profile = profile
        self.maxElements = maxElements
        self.maxDurationMs = maxDurationMs
        self.sinceSnapshotId = sinceSnapshotId
        self.query = query
    }

    private enum CodingKeys: String, CodingKey {
        case pid, windowId, windowGeneration, scope, profile, maxElements, maxDurationMs, sinceSnapshotId, query
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        pid = try container.decode(Int32.self, forKey: .pid)
        windowId = try container.decodeIfPresent(UInt32.self, forKey: .windowId)
        windowGeneration = try container.decodeIfPresent(UInt64.self, forKey: .windowGeneration)
        scope = try container.decodeIfPresent(AXObservationScope.self, forKey: .scope)
            ?? (windowId == nil ? .application : .window)
        profile = try container.decodeIfPresent(String.self, forKey: .profile) ?? "flash"
        maxElements = try container.decodeIfPresent(Int.self, forKey: .maxElements) ?? 500
        maxDurationMs = try container.decodeIfPresent(Int.self, forKey: .maxDurationMs) ?? 750
        sinceSnapshotId = try container.decodeIfPresent(String.self, forKey: .sinceSnapshotId)
        query = try container.decodeIfPresent(String.self, forKey: .query)
    }
}

/// Control patterns an element supports, derived from its live role, advertised actions, and
/// settable attributes. This is the model-facing form of the control catalog: capability data on
/// every node rather than a per-role class hierarchy.
public enum AXControlPattern: String, Codable, Equatable, Sendable, CaseIterable {
    case invoke
    /// A distinct secondary action such as the Accessibility `AXShowMenu` context menu. It is not
    /// represented as a right-click: semantic delivery must not invent pointer coordinates.
    case secondaryAction = "secondary_action"
    case value
    case rangeValue = "range_value"
    case toggle
    case expandCollapse = "expand_collapse"
    case scroll
    case scrollToVisible = "scroll_to_visible"
    case selection
    case text
    case window
}

public struct ElementRef: Codable, Equatable, Sendable {
    public var token: String
    public var snapshotId: String
    public var pid: Int32
    public var windowId: UInt32?
    public var windowGeneration: UInt64?
    public var axRevision: UInt64
    public var stablePathHash: String

    public init(token: String, snapshotId: String, pid: Int32, windowId: UInt32?, windowGeneration: UInt64?, axRevision: UInt64, stablePathHash: String) {
        self.token = token
        self.snapshotId = snapshotId
        self.pid = pid
        self.windowId = windowId
        self.windowGeneration = windowGeneration
        self.axRevision = axRevision
        self.stablePathHash = stablePathHash
    }
}

public enum SemanticActionKind: String, Codable, Equatable, Sendable, CaseIterable {
    case invoke
    /// Perform the element's advertised `AXShowMenu` action without moving the pointer.
    case showMenu = "show_menu"
    case setValue = "set_value"
    case increment
    case decrement
    case toggle
    case expand
    case collapse
    case select
    case selectTextRange = "select_text_range"
    case selectText = "select_text"
    case setCaret = "set_caret"
    case scrollPage = "scroll_page"
    /// Explicit selection state for one item through `AXSelected`. Callers must not assume
    /// sequential true writes accumulate; the semantic transaction path uses the container's
    /// selected-row/children array for atomic multi-selection.
    case setSelected = "set_selected"
    /// Brings an element into its scroll container's visible region without moving the pointer,
    /// changing focus, or raising a window.
    case scrollToVisible = "scroll_to_visible"
    /// Absolute scroll position via the scroll bar's own `AXValue`. This is the scrolling primitive
    /// macOS actually implements; see `scroll_page` for why it is not the default.
    case scrollToFraction = "scroll_to_fraction"
    /// Types Unicode text into the focused element of one named process.
    ///
    /// Unlike `set_value`, which replaces an attribute wholesale, this produces the keystrokes an
    /// application's own input handling sees — so validation, autocomplete, and change notifications
    /// all fire. Delivered by `CGEvent.postToPid`, which names the recipient process rather than
    /// letting the window server pick it, and therefore neither requires nor takes the foreground.
    case typeText = "type_text"
}

public enum ScrollAxis: String, Codable, Equatable, Sendable, CaseIterable {
    case horizontal
    case vertical
}

/// Absolute scroll position, 0.0 (start) to 1.0 (end), applied to the container's scroll bar.
public struct ScrollFractionSelection: Codable, Equatable, Sendable {
    public var axis: ScrollAxis
    public var fraction: Double

    public init(axis: ScrollAxis, fraction: Double) {
        self.axis = axis
        self.fraction = fraction
    }
}

/// A bounded character range in UTF-16 code units, matching AppKit `AXSelectedTextRange`.
public struct TextRangeSelection: Codable, Equatable, Sendable {
    public var location: Int
    public var length: Int

    public init(location: Int, length: Int) {
        self.location = location
        self.length = length
    }
}

public enum TextMatchPlacement: String, Codable, Equatable, Sendable, CaseIterable {
    /// Select the matched range.
    case select
    /// Place a zero-length caret immediately before the matched range.
    case before
    /// Place a zero-length caret immediately after the matched range.
    case after
}

/// Exact-text selection. `prefix`/`suffix` disambiguate repeated occurrences; a request that still
/// matches more than once is refused rather than resolved by guesswork.
public struct TextMatchSelection: Codable, Equatable, Sendable {
    public var text: String
    public var prefix: String?
    public var suffix: String?
    public var placement: TextMatchPlacement

    public init(text: String, prefix: String? = nil, suffix: String? = nil, placement: TextMatchPlacement = .select) {
        self.text = text
        self.prefix = prefix
        self.suffix = suffix
        self.placement = placement
    }

    private enum CodingKeys: String, CodingKey { case text, prefix, suffix, placement }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        text = try container.decode(String.self, forKey: .text)
        prefix = try container.decodeIfPresent(String.self, forKey: .prefix)
        suffix = try container.decodeIfPresent(String.self, forKey: .suffix)
        placement = try container.decodeIfPresent(TextMatchPlacement.self, forKey: .placement) ?? .select
    }
}

public enum CaretAnchor: String, Codable, Equatable, Sendable, CaseIterable {
    case index
    case start
    case end
}

public struct CaretPlacement: Codable, Equatable, Sendable {
    public var anchor: CaretAnchor
    public var index: Int?

    public init(anchor: CaretAnchor, index: Int? = nil) {
        self.anchor = anchor
        self.index = index
    }
}

public enum ScrollPageDirection: String, Codable, Equatable, Sendable, CaseIterable {
    case up
    case down
    case left
    case right
}

/// One page per request. Repeating a page is an explicit new caller decision, never a retry.
public struct ScrollPageSelection: Codable, Equatable, Sendable {
    public var direction: ScrollPageDirection

    public init(direction: ScrollPageDirection) {
        self.direction = direction
    }
}

/// Discriminated payload for the text and scroll actions. An unknown `kind` fails to decode
/// instead of degrading to a known action.
public enum SemanticActionPayload: Equatable, Sendable {
    case textRange(TextRangeSelection)
    case textMatch(TextMatchSelection)
    case caret(CaretPlacement)
    case scroll(ScrollPageSelection)
    case scrollFraction(ScrollFractionSelection)
}

extension SemanticActionPayload: Codable {
    private enum CodingKeys: String, CodingKey { case kind, range, match, caret, scroll, scrollFraction }
    private enum Kind: String, Codable {
        case textRange = "text_range"
        case textMatch = "text_match"
        case caret
        case scroll
        case scrollFraction = "scroll_fraction"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(Kind.self, forKey: .kind) {
        case .textRange: self = .textRange(try container.decode(TextRangeSelection.self, forKey: .range))
        case .textMatch: self = .textMatch(try container.decode(TextMatchSelection.self, forKey: .match))
        case .caret: self = .caret(try container.decode(CaretPlacement.self, forKey: .caret))
        case .scroll: self = .scroll(try container.decode(ScrollPageSelection.self, forKey: .scroll))
        case .scrollFraction: self = .scrollFraction(try container.decode(ScrollFractionSelection.self, forKey: .scrollFraction))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .textRange(let range):
            try container.encode(Kind.textRange, forKey: .kind)
            try container.encode(range, forKey: .range)
        case .textMatch(let match):
            try container.encode(Kind.textMatch, forKey: .kind)
            try container.encode(match, forKey: .match)
        case .caret(let caret):
            try container.encode(Kind.caret, forKey: .kind)
            try container.encode(caret, forKey: .caret)
        case .scroll(let scroll):
            try container.encode(Kind.scroll, forKey: .kind)
            try container.encode(scroll, forKey: .scroll)
        case .scrollFraction(let scroll):
            try container.encode(Kind.scrollFraction, forKey: .kind)
            try container.encode(scroll, forKey: .scrollFraction)
        }
    }
}

public enum SemanticDeliveryPolicy: String, Codable, Equatable, Sendable, CaseIterable {
    /// Native AX delivery only: never activates an application, raises a window, or posts global
    /// keyboard/mouse events. The recipient application can still react to its own control action.
    ///
    /// The original `bimax.cu.v1` spelling, kept because shipped clients send it. Semantically
    /// identical to `background_only`.
    case backgroundNative = "background_native"
    /// Use only background delivery; fail if it is unavailable.
    case backgroundOnly = "background_only"
    /// Try background delivery. When it is refused for a reason a foreground retry could plausibly
    /// change, return an escalation proposal instead of performing anything. Never escalates by
    /// itself: the proposal is a request for a decision, not a decision.
    case backgroundPreferred = "background_preferred"
    /// With a coordinator-issued approval, take a temporary focus lease, act, and restore the
    /// previous frontmost application.
    case foregroundOnce = "foreground_once"
    /// With a coordinator-issued approval, bring the target forward and leave it there.
    case foregroundPersistent = "foreground_persistent"

    /// True when the policy forbids any focus change. These policies can never acquire a lease.
    public var isBackground: Bool {
        switch self {
        case .backgroundNative, .backgroundOnly, .backgroundPreferred: return true
        case .foregroundOnce, .foregroundPersistent: return false
        }
    }

    /// The service changes focus only under an approval the coordinator obtained from the human.
    public var requiresApproval: Bool { !isBackground }

    /// Whether the target keeps focus after the action instead of the previous application.
    public var keepsForeground: Bool { self == .foregroundPersistent }

    /// The restore behavior a lease under this policy is created with.
    public var restorePolicy: FocusRestorePolicy { keepsForeground ? .never : .ifUnchanged }
}

public enum FocusRestorePolicy: String, Codable, Equatable, Sendable, CaseIterable {
    /// Restore the previous frontmost application even if the human moved focus during the lease.
    case always
    /// Restore only if the target is still frontmost at release. If the human moved focus, their
    /// choice wins and nothing is restored.
    case ifUnchanged = "if_unchanged"
    /// Leave focus where the lease put it.
    case never
}

/// The coordinator's record that a human authorized one specific foreground change.
///
/// The service never asks for approval and never infers it — `docs/BIMAX_CU_SECURITY_MODEL.md`
/// puts approvals in the TypeScript coordinator. Binding the approval to a policy and a target is
/// what stops one "yes" from authorizing a different action against a different application.
public struct ForegroundApproval: Codable, Equatable, Sendable {
    public var approvalId: String
    /// The exact policy approved. An approval for `foreground_once` never authorizes
    /// `foreground_persistent`.
    public var policy: SemanticDeliveryPolicy
    public var targetPid: Int32
    /// Optional, and checked when present: an approval scoped to one window cannot be replayed
    /// against another window of the same process.
    public var targetWindowId: UInt32?
    public var grantedAtMs: Int64
    public var expiresAtMs: Int64

    public init(
        approvalId: String,
        policy: SemanticDeliveryPolicy,
        targetPid: Int32,
        targetWindowId: UInt32? = nil,
        grantedAtMs: Int64,
        expiresAtMs: Int64
    ) {
        self.approvalId = approvalId
        self.policy = policy
        self.targetPid = targetPid
        self.targetWindowId = targetWindowId
        self.grantedAtMs = grantedAtMs
        self.expiresAtMs = expiresAtMs
    }

    private enum CodingKeys: String, CodingKey {
        case approvalId, policy, targetPid, targetWindowId, grantedAtMs, expiresAtMs
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        approvalId = try container.decode(String.self, forKey: .approvalId)
        policy = try container.decode(SemanticDeliveryPolicy.self, forKey: .policy)
        targetPid = try container.decode(Int32.self, forKey: .targetPid)
        targetWindowId = try container.decodeIfPresent(UInt32.self, forKey: .targetWindowId)
        grantedAtMs = try container.decode(Int64.self, forKey: .grantedAtMs)
        expiresAtMs = try container.decode(Int64.self, forKey: .expiresAtMs)
    }
}

/// Lease shape requested by the caller. Defaults are deliberately short: a lease that outlives its
/// action is a focus change nobody is watching.
public struct FocusLeaseOptions: Codable, Equatable, Sendable {
    public var restorePolicy: FocusRestorePolicy?
    public var ttlMs: Int
    /// How long to wait for the target to actually reach the front. Activation is asynchronous and
    /// can be refused, so this bounds the wait rather than assuming the request landed.
    public var activationTimeoutMs: Int

    public init(restorePolicy: FocusRestorePolicy? = nil, ttlMs: Int = 5_000, activationTimeoutMs: Int = 1_500) {
        self.restorePolicy = restorePolicy
        self.ttlMs = ttlMs
        self.activationTimeoutMs = activationTimeoutMs
    }

    private enum CodingKeys: String, CodingKey { case restorePolicy, ttlMs, activationTimeoutMs }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        restorePolicy = try container.decodeIfPresent(FocusRestorePolicy.self, forKey: .restorePolicy)
        ttlMs = try container.decodeIfPresent(Int.self, forKey: .ttlMs) ?? 5_000
        activationTimeoutMs = try container.decodeIfPresent(Int.self, forKey: .activationTimeoutMs) ?? 1_500
    }
}

/// A held foreground claim. Application-level: slice 1 activates the owning application and does
/// not raise an individual window, because AX exposes no CGWindowID by which to identify one.
/// `targetWindowId` scopes the lease's identity and approval check, not its effect.
public struct FocusLease: Codable, Equatable, Sendable {
    public var leaseId: String
    public var sessionId: String
    public var targetPid: Int32
    public var targetWindowId: UInt32?
    public var previousFrontmostPid: Int32?
    public var previousFrontmostBundleId: String?
    public var acquiredAtMs: Int64
    public var expiresAtMs: Int64
    public var restorePolicy: FocusRestorePolicy
    /// Whether the target actually reached the front, polled from the WindowServer. An accepted
    /// activation request is not evidence that focus moved.
    public var targetBecameFrontmost: Bool
    public var frontmostPidAfterAcquire: Int32?

    public init(
        leaseId: String,
        sessionId: String,
        targetPid: Int32,
        targetWindowId: UInt32? = nil,
        previousFrontmostPid: Int32? = nil,
        previousFrontmostBundleId: String? = nil,
        acquiredAtMs: Int64,
        expiresAtMs: Int64,
        restorePolicy: FocusRestorePolicy,
        targetBecameFrontmost: Bool,
        frontmostPidAfterAcquire: Int32? = nil
    ) {
        self.leaseId = leaseId
        self.sessionId = sessionId
        self.targetPid = targetPid
        self.targetWindowId = targetWindowId
        self.previousFrontmostPid = previousFrontmostPid
        self.previousFrontmostBundleId = previousFrontmostBundleId
        self.acquiredAtMs = acquiredAtMs
        self.expiresAtMs = expiresAtMs
        self.restorePolicy = restorePolicy
        self.targetBecameFrontmost = targetBecameFrontmost
        self.frontmostPidAfterAcquire = frontmostPidAfterAcquire
    }
}

public enum FocusRestoreOutcome: String, Codable, Equatable, Sendable {
    /// The previous frontmost application was reactivated and observed back in front.
    case restored
    /// The human moved focus during the lease. Their choice wins; nothing was restored.
    case humanOverride = "human_override"
    /// The policy deliberately left focus with the target (`foreground_persistent`).
    case retained
    /// Restore was attempted and the previous application never came back to the front.
    case restoreFailed = "restore_failed"
    /// There was no previous frontmost application to return to.
    case nothingToRestore = "nothing_to_restore"
}

/// What a lease actually did. Every field is observed, not assumed: a lease that failed to move
/// focus reports `targetBecameFrontmost: false` rather than reporting success.
public struct FocusLeaseReceipt: Codable, Equatable, Sendable {
    public var leaseId: String
    public var targetPid: Int32
    public var targetWindowId: UInt32?
    public var previousFrontmostPid: Int32?
    public var previousFrontmostBundleId: String?
    public var restorePolicy: FocusRestorePolicy
    public var acquiredAtMs: Int64
    public var releasedAtMs: Int64
    public var expiresAtMs: Int64
    public var targetBecameFrontmost: Bool
    public var frontmostPidAfterAcquire: Int32?
    public var frontmostPidAtRelease: Int32?
    public var restoreOutcome: FocusRestoreOutcome
    /// The lease outlived its deadline before release. It still restores.
    public var expired: Bool

    public init(
        leaseId: String,
        targetPid: Int32,
        targetWindowId: UInt32? = nil,
        previousFrontmostPid: Int32? = nil,
        previousFrontmostBundleId: String? = nil,
        restorePolicy: FocusRestorePolicy,
        acquiredAtMs: Int64,
        releasedAtMs: Int64,
        expiresAtMs: Int64,
        targetBecameFrontmost: Bool,
        frontmostPidAfterAcquire: Int32? = nil,
        frontmostPidAtRelease: Int32? = nil,
        restoreOutcome: FocusRestoreOutcome,
        expired: Bool
    ) {
        self.leaseId = leaseId
        self.targetPid = targetPid
        self.targetWindowId = targetWindowId
        self.previousFrontmostPid = previousFrontmostPid
        self.previousFrontmostBundleId = previousFrontmostBundleId
        self.restorePolicy = restorePolicy
        self.acquiredAtMs = acquiredAtMs
        self.releasedAtMs = releasedAtMs
        self.expiresAtMs = expiresAtMs
        self.targetBecameFrontmost = targetBecameFrontmost
        self.frontmostPidAfterAcquire = frontmostPidAfterAcquire
        self.frontmostPidAtRelease = frontmostPidAtRelease
        self.restoreOutcome = restoreOutcome
        self.expired = expired
    }
}

/// The answer to a `background_preferred` call whose background delivery was refused.
///
/// It is not a receipt and not an error: nothing was performed, and the coordinator must obtain a
/// human decision before any of it happens. `recommendedAction` is present when the safer next rung
/// is a different semantic operation, such as process-targeted `type_text` after a text value write
/// is refused. It is never inferred for an operation that cannot be reproduced by typing.
public struct EscalationProposal: Codable, Equatable, Sendable {
    public var proposalId: String
    public var element: ElementRef
    public var action: SemanticActionKind
    public var requestedPolicy: SemanticDeliveryPolicy
    /// The native error code that refused background delivery.
    public var blockedBy: String
    public var message: String
    public var recommendedPolicy: SemanticDeliveryPolicy
    public var recommendedAction: SemanticActionKind?
    /// The `docs/BIMAX_CU_MASTER_REFACTOR_PLAN` §7.2 rung the recommendation corresponds to.
    public var recommendedRung: Int
    public var requiresApproval: Bool
    public var physicalInputAvailable: Bool
    /// The background rungs that were actually walked before this proposal. A proposal that cannot
    /// say what it already tried is asking for a decision without showing its work.
    public var exhaustedPaths: [DeliveryAttempt]

    public init(
        proposalId: String,
        element: ElementRef,
        action: SemanticActionKind,
        requestedPolicy: SemanticDeliveryPolicy,
        blockedBy: String,
        message: String,
        recommendedPolicy: SemanticDeliveryPolicy,
        recommendedRung: Int,
        recommendedAction: SemanticActionKind? = nil,
        requiresApproval: Bool = true,
        physicalInputAvailable: Bool = false,
        exhaustedPaths: [DeliveryAttempt] = []
    ) {
        self.proposalId = proposalId
        self.element = element
        self.action = action
        self.requestedPolicy = requestedPolicy
        self.blockedBy = blockedBy
        self.message = message
        self.recommendedPolicy = recommendedPolicy
        self.recommendedAction = recommendedAction
        self.recommendedRung = recommendedRung
        self.requiresApproval = requiresApproval
        self.physicalInputAvailable = physicalInputAvailable
        self.exhaustedPaths = exhaustedPaths
    }

    private enum CodingKeys: String, CodingKey {
        case proposalId, element, action, requestedPolicy, blockedBy, message
        case recommendedPolicy, recommendedAction, recommendedRung, requiresApproval, physicalInputAvailable
        case exhaustedPaths
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        proposalId = try container.decode(String.self, forKey: .proposalId)
        element = try container.decode(ElementRef.self, forKey: .element)
        action = try container.decode(SemanticActionKind.self, forKey: .action)
        requestedPolicy = try container.decode(SemanticDeliveryPolicy.self, forKey: .requestedPolicy)
        blockedBy = try container.decode(String.self, forKey: .blockedBy)
        message = try container.decode(String.self, forKey: .message)
        recommendedPolicy = try container.decode(SemanticDeliveryPolicy.self, forKey: .recommendedPolicy)
        recommendedAction = try container.decodeIfPresent(SemanticActionKind.self, forKey: .recommendedAction)
        recommendedRung = try container.decode(Int.self, forKey: .recommendedRung)
        requiresApproval = try container.decode(Bool.self, forKey: .requiresApproval)
        physicalInputAvailable = try container.decode(Bool.self, forKey: .physicalInputAvailable)
        exhaustedPaths = try container.decodeIfPresent([DeliveryAttempt].self, forKey: .exhaustedPaths) ?? []
    }
}

public enum SemanticValue: Equatable, Sendable {
    case string(String)
    case number(Double)
    case boolean(Bool)
}

extension SemanticValue: Codable {
    private enum CodingKeys: String, CodingKey { case type, value }
    private enum ValueType: String, Codable { case string, number, boolean }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(ValueType.self, forKey: .type) {
        case .string: self = .string(try container.decode(String.self, forKey: .value))
        case .number: self = .number(try container.decode(Double.self, forKey: .value))
        case .boolean: self = .boolean(try container.decode(Bool.self, forKey: .value))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .string(let value):
            try container.encode(ValueType.string, forKey: .type)
            try container.encode(value, forKey: .value)
        case .number(let value):
            try container.encode(ValueType.number, forKey: .type)
            try container.encode(value, forKey: .value)
        case .boolean(let value):
            try container.encode(ValueType.boolean, forKey: .type)
            try container.encode(value, forKey: .value)
        }
    }
}

public enum EvidenceTier: Int, Codable, Equatable, Comparable, Sendable {
    case delivery = 0
    case semantic = 1
    case provenTarget = 2
    case region = 3
    case audit = 4

    public static func < (lhs: EvidenceTier, rhs: EvidenceTier) -> Bool {
        lhs.rawValue < rhs.rawValue
    }
}

public enum TextPresence: String, Codable, Equatable, Sendable {
    case present
    case absent
}

/// Conjunctive native postcondition evaluated against fresh AX state after delivery.
public struct SemanticPostcondition: Codable, Equatable, Sendable {
    public var text: String?
    public var textPresence: TextPresence
    public var expectedValue: String?
    public var valueMustChange: Bool
    public var expectedFocused: Bool?
    public var expectedSelected: Bool?
    public var elementExists: Bool?

    public init(
        text: String? = nil,
        textPresence: TextPresence = .present,
        expectedValue: String? = nil,
        valueMustChange: Bool = false,
        expectedFocused: Bool? = nil,
        expectedSelected: Bool? = nil,
        elementExists: Bool? = nil
    ) {
        self.text = text
        self.textPresence = textPresence
        self.expectedValue = expectedValue
        self.valueMustChange = valueMustChange
        self.expectedFocused = expectedFocused
        self.expectedSelected = expectedSelected
        self.elementExists = elementExists
    }
}

public struct EvidenceRequirement: Codable, Equatable, Sendable {
    public var tier: EvidenceTier
    public var postcondition: SemanticPostcondition?
    public var settleTimeoutMs: Int

    public init(
        tier: EvidenceTier,
        postcondition: SemanticPostcondition? = nil,
        settleTimeoutMs: Int = 750
    ) {
        self.tier = tier
        self.postcondition = postcondition
        self.settleTimeoutMs = settleTimeoutMs
    }
}

public enum EvidenceOutcome: String, Codable, Equatable, Sendable {
    case satisfied
    case missed
    case timedOut = "timed_out"
    case unavailable
}

public struct EvidenceReceipt: Codable, Equatable, Sendable {
    public var requiredTier: EvidenceTier
    public var achievedTier: EvidenceTier
    public var outcome: EvidenceOutcome
    public var eventChanged: Bool
    public var postconditionMatched: Bool?
    public var attempts: Int
    public var settledAtMs: Int64

    public init(
        requiredTier: EvidenceTier,
        achievedTier: EvidenceTier,
        outcome: EvidenceOutcome,
        eventChanged: Bool,
        postconditionMatched: Bool?,
        attempts: Int,
        settledAtMs: Int64
    ) {
        self.requiredTier = requiredTier
        self.achievedTier = achievedTier
        self.outcome = outcome
        self.eventChanged = eventChanged
        self.postconditionMatched = postconditionMatched
        self.attempts = attempts
        self.settledAtMs = settledAtMs
    }
}

public struct SemanticActionRequest: Codable, Equatable, Sendable {
    public var element: ElementRef
    public var action: SemanticActionKind
    public var value: SemanticValue?
    /// Additive in `bimax.cu.v1`: absent means "no text/scroll payload", which every pre-slice-6
    /// action already required.
    public var payload: SemanticActionPayload?
    public var expectedEventRevision: UInt64
    public var deliveryPolicy: SemanticDeliveryPolicy
    /// Required by every foreground policy and refused on every background one. Additive in
    /// `bimax.cu.v1`: absent is the only thing a pre-slice-7 client ever sent.
    public var approval: ForegroundApproval?
    /// Shape of the lease a foreground policy takes. Ignored by background policies, which the
    /// service refuses to give a lease at all.
    public var focusLease: FocusLeaseOptions?
    /// Optional minimum evidence. The service refuses unsupported tiers before delivery.
    public var evidence: EvidenceRequirement?

    public init(
        element: ElementRef,
        action: SemanticActionKind,
        value: SemanticValue? = nil,
        payload: SemanticActionPayload? = nil,
        expectedEventRevision: UInt64,
        deliveryPolicy: SemanticDeliveryPolicy = .backgroundNative,
        approval: ForegroundApproval? = nil,
        focusLease: FocusLeaseOptions? = nil,
        evidence: EvidenceRequirement? = nil
    ) {
        self.element = element
        self.action = action
        self.value = value
        self.payload = payload
        self.expectedEventRevision = expectedEventRevision
        self.deliveryPolicy = deliveryPolicy
        self.approval = approval
        self.focusLease = focusLease
        self.evidence = evidence
    }

    private enum CodingKeys: String, CodingKey {
        case element, action, value, payload, expectedEventRevision, deliveryPolicy
        case approval, focusLease, evidence
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        element = try container.decode(ElementRef.self, forKey: .element)
        action = try container.decode(SemanticActionKind.self, forKey: .action)
        value = try container.decodeIfPresent(SemanticValue.self, forKey: .value)
        payload = try container.decodeIfPresent(SemanticActionPayload.self, forKey: .payload)
        expectedEventRevision = try container.decode(UInt64.self, forKey: .expectedEventRevision)
        deliveryPolicy = try container.decode(SemanticDeliveryPolicy.self, forKey: .deliveryPolicy)
        approval = try container.decodeIfPresent(ForegroundApproval.self, forKey: .approval)
        focusLease = try container.decodeIfPresent(FocusLeaseOptions.self, forKey: .focusLease)
        evidence = try container.decodeIfPresent(EvidenceRequirement.self, forKey: .evidence)
    }
}

/// Preconditions evaluated from the retained authorizing snapshot before any transaction step is
/// allowed to mutate. They are intentionally limited to content-free control state; secret or
/// surrounding text never enters a transaction receipt.
public struct SemanticTransactionPrecondition: Codable, Equatable, Sendable {
    public var expectedRole: String?
    public var expectedValue: String?
    public var expectedFocused: Bool?
    public var expectedSelected: Bool?

    public init(
        expectedRole: String? = nil,
        expectedValue: String? = nil,
        expectedFocused: Bool? = nil,
        expectedSelected: Bool? = nil
    ) {
        self.expectedRole = expectedRole
        self.expectedValue = expectedValue
        self.expectedFocused = expectedFocused
        self.expectedSelected = expectedSelected
    }
}

/// One bounded semantic mutation. Phase 4 intentionally accepts only `set_value` and
/// `set_selected`: they are the two operations needed for multi-edit and additive multi-select,
/// and neither crosses a commit boundary.
public struct SemanticTransactionStep: Codable, Equatable, Sendable {
    public var stepId: String
    public var element: ElementRef
    public var action: SemanticActionKind
    public var value: SemanticValue?
    public var payload: SemanticActionPayload?
    public var precondition: SemanticTransactionPrecondition?

    public init(
        stepId: String,
        element: ElementRef,
        action: SemanticActionKind,
        value: SemanticValue? = nil,
        payload: SemanticActionPayload? = nil,
        precondition: SemanticTransactionPrecondition? = nil
    ) {
        self.stepId = stepId
        self.element = element
        self.action = action
        self.value = value
        self.payload = payload
        self.precondition = precondition
    }
}

/// A checked, same-target semantic transaction. The manifest hash is SHA-256 over the canonical
/// delivery/based-on/steps payload and is recomputed by the service before any live target work.
/// The coordinator still owns approval decisions; this binding prevents an approved manifest from
/// being paired with different steps in transit.
public struct SemanticTransactionRequest: Codable, Equatable, Sendable {
    public var basedOnSnapshotId: String
    public var steps: [SemanticTransactionStep]
    public var deliveryPolicy: SemanticDeliveryPolicy
    public var approvalManifestHash: String

    public init(
        basedOnSnapshotId: String,
        steps: [SemanticTransactionStep],
        deliveryPolicy: SemanticDeliveryPolicy = .backgroundNative,
        approvalManifestHash: String
    ) {
        self.basedOnSnapshotId = basedOnSnapshotId
        self.steps = steps
        self.deliveryPolicy = deliveryPolicy
        self.approvalManifestHash = approvalManifestHash
    }

    private struct Manifest: Codable {
        var basedOnSnapshotId: String
        var steps: [SemanticTransactionStep]
        var deliveryPolicy: SemanticDeliveryPolicy
    }

    public func computedManifestHash() throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(Manifest(
            basedOnSnapshotId: basedOnSnapshotId,
            steps: steps,
            deliveryPolicy: deliveryPolicy
        ))
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

public enum SemanticTransactionOutcome: String, Codable, Equatable, Sendable {
    case completed
    /// At least one step may have delivered before a later step failed. The receipt names both.
    case stopped
}

public struct SemanticTransactionStepReceipt: Codable, Equatable, Sendable {
    public var stepId: String
    public var receipt: SemanticActionReceipt

    public init(stepId: String, receipt: SemanticActionReceipt) {
        self.stepId = stepId
        self.receipt = receipt
    }
}

/// A transaction always reports partial completion. A later refusal is data on the receipt rather
/// than a top-level error that could hide earlier mutations.
public struct SemanticTransactionReceipt: Codable, Equatable, Sendable {
    public var transactionId: String
    public var basedOnSnapshotId: String
    public var deliveryPolicy: SemanticDeliveryPolicy
    public var outcome: SemanticTransactionOutcome
    public var startedAtMs: Int64
    public var completedAtMs: Int64
    public var steps: [SemanticTransactionStepReceipt]
    public var stoppedBeforeStepId: String?
    public var failure: CuError?

    public init(
        transactionId: String,
        basedOnSnapshotId: String,
        deliveryPolicy: SemanticDeliveryPolicy,
        outcome: SemanticTransactionOutcome,
        startedAtMs: Int64,
        completedAtMs: Int64,
        steps: [SemanticTransactionStepReceipt],
        stoppedBeforeStepId: String? = nil,
        failure: CuError? = nil
    ) {
        self.transactionId = transactionId
        self.basedOnSnapshotId = basedOnSnapshotId
        self.deliveryPolicy = deliveryPolicy
        self.outcome = outcome
        self.startedAtMs = startedAtMs
        self.completedAtMs = completedAtMs
        self.steps = steps
        self.stoppedBeforeStepId = stoppedBeforeStepId
        self.failure = failure
    }
}

/// Selection evidence. Character offsets and counts only: no selected text, surrounding text, or
/// any other content ever enters a receipt.
///
/// `location`/`length` are re-read from the control *after* the write, so they describe where the
/// selection actually landed. Some toolkits — Electron text areas among them — return `.success`
/// from `AXUIElementSetAttributeValue` and then ignore the write entirely. `honored` reports that
/// divergence explicitly, because an AX call succeeding is not evidence that the selection moved.
public struct TextSelectionReceipt: Codable, Equatable, Sendable {
    public var location: Int
    public var length: Int
    public var characterCount: Int?
    public var requested: TextRangeSelection?
    public var honored: Bool?

    public init(
        location: Int,
        length: Int,
        characterCount: Int? = nil,
        requested: TextRangeSelection? = nil,
        honored: Bool? = nil
    ) {
        self.location = location
        self.length = length
        self.characterCount = characterCount
        self.requested = requested
        self.honored = honored
    }

    private enum CodingKeys: String, CodingKey {
        case location, length, characterCount, requested, honored
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        location = try container.decode(Int.self, forKey: .location)
        length = try container.decode(Int.self, forKey: .length)
        characterCount = try container.decodeIfPresent(Int.self, forKey: .characterCount)
        requested = try container.decodeIfPresent(TextRangeSelection.self, forKey: .requested)
        honored = try container.decodeIfPresent(Bool.self, forKey: .honored)
    }
}

/// Scroll evidence derived from scrollbar positions. `changed` is nil when neither scrollbar
/// position could be read, which is reported as unknown rather than assumed successful.
public struct ScrollReceipt: Codable, Equatable, Sendable {
    public var direction: ScrollPageDirection?
    public var axis: ScrollAxis?
    public var horizontalPercentBefore: Double?
    public var horizontalPercentAfter: Double?
    public var verticalPercentBefore: Double?
    public var verticalPercentAfter: Double?
    public var changed: Bool?
    public var requestedPercent: Double?
    public var honored: Bool?

    public init(
        direction: ScrollPageDirection? = nil,
        axis: ScrollAxis? = nil,
        horizontalPercentBefore: Double? = nil,
        horizontalPercentAfter: Double? = nil,
        verticalPercentBefore: Double? = nil,
        verticalPercentAfter: Double? = nil,
        changed: Bool? = nil,
        requestedPercent: Double? = nil,
        honored: Bool? = nil
    ) {
        self.direction = direction
        self.axis = axis
        self.horizontalPercentBefore = horizontalPercentBefore
        self.horizontalPercentAfter = horizontalPercentAfter
        self.verticalPercentBefore = verticalPercentBefore
        self.verticalPercentAfter = verticalPercentAfter
        self.changed = changed
        self.requestedPercent = requestedPercent
        self.honored = honored
    }
}

/// Typing evidence. Lengths only — the typed text, the surrounding text, and the control's value
/// never enter a receipt, exactly as selection receipts carry offsets and not content.
public struct TypedTextReceipt: Codable, Equatable, Sendable {
    public var requestedUnitCount: Int
    public var characterCountBefore: Int?
    public var characterCountAfter: Int?
    /// Read back from the control, never inferred from the post succeeding. `postToPid` reports
    /// nothing about whether the application consumed the event. nil means unreadable.
    public var honored: Bool?

    public init(
        requestedUnitCount: Int,
        characterCountBefore: Int? = nil,
        characterCountAfter: Int? = nil,
        honored: Bool? = nil
    ) {
        self.requestedUnitCount = requestedUnitCount
        self.characterCountBefore = characterCountBefore
        self.characterCountAfter = characterCountAfter
        self.honored = honored
    }

    private enum CodingKeys: String, CodingKey {
        case requestedUnitCount, characterCountBefore, characterCountAfter, honored
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        requestedUnitCount = try container.decode(Int.self, forKey: .requestedUnitCount)
        characterCountBefore = try container.decodeIfPresent(Int.self, forKey: .characterCountBefore)
        characterCountAfter = try container.decodeIfPresent(Int.self, forKey: .characterCountAfter)
        honored = try container.decodeIfPresent(Bool.self, forKey: .honored)
    }
}

public enum SemanticActionOutcome: String, Codable, Equatable, Sendable {
    case performed
    case alreadySatisfied = "already_satisfied"
}

/// A rung of the §7.2 delivery ladder. Only the two background rungs exist in this build; the rest
/// are named so a receipt can say which rung delivered without the vocabulary shifting later.
public enum DeliveryPath: String, Codable, Equatable, Sendable, CaseIterable {
    case browserSemantic = "browser_semantic"
    /// Mutating an AX attribute: `AXValue`, `AXSelected`, `AXExpanded`, `AXSelectedTextRange`.
    case axAttribute = "ax_attribute"
    /// Performing an action the element advertises: `AXPress`, `AXIncrement`, `AXConfirm`.
    case axAction = "ax_action"
    case targetedEvent = "targeted_event"
    case foregroundSemantic = "foreground_semantic"
    case foregroundTargetedEvent = "foreground_targeted_event"
    case physicalCgEvent = "physical_cgevent"
}

public enum DeliveryAttemptOutcome: String, Codable, Equatable, Sendable {
    case performed
    case alreadySatisfied = "already_satisfied"
    /// The element does not offer this rung at all — the attribute is not settable, or the action
    /// is not advertised. Distinct from `refused`: nothing was attempted.
    case unavailable
    /// The rung was offered and the application refused it.
    case refused
    /// The rung was offered and the application neither confirmed nor refused it within the
    /// messaging timeout. Per `AXUIElement.h`, `kAXErrorCannotComplete` from
    /// `AXUIElementPerformAction` "does not necessarily mean that the function has failed" — an
    /// application doing modal processing inside its action callback may already have performed it.
    /// The action's real outcome is only knowable by re-reading state, so it is never a refusal and
    /// never licenses a second delivery attempt.
    case indeterminate
}

/// One rung, tried. The ladder records what it walked, so a receipt says *how* delivery happened
/// and a refusal says which rungs were actually exhausted rather than naming a single error.
///
/// Carries no element content: a primitive name and a native error code only.
public struct DeliveryAttempt: Codable, Equatable, Sendable {
    public var path: DeliveryPath
    public var primitive: String
    public var outcome: DeliveryAttemptOutcome
    /// The raw `AXError` when the application refused the rung.
    public var axError: Int32?

    public init(path: DeliveryPath, primitive: String, outcome: DeliveryAttemptOutcome, axError: Int32? = nil) {
        self.path = path
        self.primitive = primitive
        self.outcome = outcome
        self.axError = axError
    }

    private enum CodingKeys: String, CodingKey { case path, primitive, outcome, axError }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        path = try container.decode(DeliveryPath.self, forKey: .path)
        primitive = try container.decode(String.self, forKey: .primitive)
        outcome = try container.decode(DeliveryAttemptOutcome.self, forKey: .outcome)
        axError = try container.decodeIfPresent(Int32.self, forKey: .axError)
    }
}

public struct SemanticActionReceipt: Codable, Equatable, Sendable {
    public var actionId: String
    public var element: ElementRef
    public var action: SemanticActionKind
    public var primitive: String
    public var outcome: SemanticActionOutcome
    public var deliveryPolicy: SemanticDeliveryPolicy
    public var startedAtMs: Int64
    public var completedAtMs: Int64
    public var eventRevisionBefore: UInt64
    public var eventRevisionAfter: UInt64
    public var frontmostPidBefore: Int32?
    public var frontmostPidAfter: Int32?
    /// Additive in `bimax.cu.v1`. Absent for every non-text action and for older services.
    public var textSelection: TextSelectionReceipt?
    /// Additive in `bimax.cu.v1`. Absent for every non-scroll action and for older services.
    public var scroll: ScrollReceipt?
    /// Additive in `bimax.cu.v1`. Absent for every action other than `type_text`.
    public var typedText: TypedTextReceipt?
    /// Present only when the action ran under a foreground policy. Its absence on a background
    /// receipt is the evidence that no focus change was taken, not merely that none was reported.
    public var focusLease: FocusLeaseReceipt?
    /// Which ladder rung actually delivered. `primitive` names the specific call; this names the
    /// kind of delivery, so a caller can tell an attribute write from a performed action without
    /// parsing strings.
    public var deliveryPath: DeliveryPath?
    /// Every rung walked, in order, including the ones the element did not offer. Additive: an
    /// older service reports none, which reads as "not recorded", not "only one rung exists".
    public var attemptedPaths: [DeliveryAttempt]
    public var evidence: EvidenceReceipt?

    public init(
        actionId: String,
        element: ElementRef,
        action: SemanticActionKind,
        primitive: String,
        outcome: SemanticActionOutcome,
        deliveryPolicy: SemanticDeliveryPolicy,
        startedAtMs: Int64,
        completedAtMs: Int64,
        eventRevisionBefore: UInt64,
        eventRevisionAfter: UInt64,
        frontmostPidBefore: Int32?,
        frontmostPidAfter: Int32?,
        textSelection: TextSelectionReceipt? = nil,
        scroll: ScrollReceipt? = nil,
        focusLease: FocusLeaseReceipt? = nil,
        deliveryPath: DeliveryPath? = nil,
        attemptedPaths: [DeliveryAttempt] = [],
        typedText: TypedTextReceipt? = nil,
        evidence: EvidenceReceipt? = nil
    ) {
        self.actionId = actionId
        self.element = element
        self.action = action
        self.primitive = primitive
        self.outcome = outcome
        self.deliveryPolicy = deliveryPolicy
        self.startedAtMs = startedAtMs
        self.completedAtMs = completedAtMs
        self.eventRevisionBefore = eventRevisionBefore
        self.eventRevisionAfter = eventRevisionAfter
        self.frontmostPidBefore = frontmostPidBefore
        self.frontmostPidAfter = frontmostPidAfter
        self.textSelection = textSelection
        self.scroll = scroll
        self.focusLease = focusLease
        self.deliveryPath = deliveryPath
        self.attemptedPaths = attemptedPaths
        self.typedText = typedText
        self.evidence = evidence
    }

    private enum CodingKeys: String, CodingKey {
        case actionId, element, action, primitive, outcome, deliveryPolicy
        case startedAtMs, completedAtMs, eventRevisionBefore, eventRevisionAfter
        case frontmostPidBefore, frontmostPidAfter, textSelection, scroll, focusLease
        case deliveryPath, attemptedPaths, typedText, evidence
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        actionId = try container.decode(String.self, forKey: .actionId)
        element = try container.decode(ElementRef.self, forKey: .element)
        action = try container.decode(SemanticActionKind.self, forKey: .action)
        primitive = try container.decode(String.self, forKey: .primitive)
        outcome = try container.decode(SemanticActionOutcome.self, forKey: .outcome)
        deliveryPolicy = try container.decode(SemanticDeliveryPolicy.self, forKey: .deliveryPolicy)
        startedAtMs = try container.decode(Int64.self, forKey: .startedAtMs)
        completedAtMs = try container.decode(Int64.self, forKey: .completedAtMs)
        eventRevisionBefore = try container.decode(UInt64.self, forKey: .eventRevisionBefore)
        eventRevisionAfter = try container.decode(UInt64.self, forKey: .eventRevisionAfter)
        frontmostPidBefore = try container.decodeIfPresent(Int32.self, forKey: .frontmostPidBefore)
        frontmostPidAfter = try container.decodeIfPresent(Int32.self, forKey: .frontmostPidAfter)
        textSelection = try container.decodeIfPresent(TextSelectionReceipt.self, forKey: .textSelection)
        scroll = try container.decodeIfPresent(ScrollReceipt.self, forKey: .scroll)
        focusLease = try container.decodeIfPresent(FocusLeaseReceipt.self, forKey: .focusLease)
        deliveryPath = try container.decodeIfPresent(DeliveryPath.self, forKey: .deliveryPath)
        attemptedPaths = try container.decodeIfPresent([DeliveryAttempt].self, forKey: .attemptedPaths) ?? []
        typedText = try container.decodeIfPresent(TypedTextReceipt.self, forKey: .typedText)
        evidence = try container.decodeIfPresent(EvidenceReceipt.self, forKey: .evidence)
    }
}

public struct AXNode: Codable, Equatable, Sendable {
    public var token: String
    public var parentToken: String?
    public var role: String
    public var subrole: String?
    public var label: String?
    public var value: String?
    public var identifier: String?
    public var bounds: CuRect?
    public var enabled: Bool
    public var focused: Bool
    public var selected: Bool
    public var actions: [String]
    public var childCount: Int
    public var stablePathHash: String
    public var parentStablePathHash: String?
    public var elementRef: ElementRef?
    public var order: Int
    /// Additive in `bimax.cu.v1`. Which AX attributes this element reports as writable.
    public var settableAttributes: [String]
    /// Additive in `bimax.cu.v1`. Raw `AXControlPattern` values supported by this element.
    public var patterns: [String]

    public init(token: String, parentToken: String?, role: String, subrole: String?, label: String?, value: String?, identifier: String?, bounds: CuRect?, enabled: Bool, focused: Bool, actions: [String], childCount: Int, stablePathHash: String = "", parentStablePathHash: String? = nil, elementRef: ElementRef? = nil, order: Int = 0, selected: Bool = false, settableAttributes: [String] = [], patterns: [String] = []) {
        self.token = token
        self.parentToken = parentToken
        self.role = role
        self.subrole = subrole
        self.label = label
        self.value = value
        self.identifier = identifier
        self.bounds = bounds
        self.enabled = enabled
        self.focused = focused
        self.selected = selected
        self.actions = actions
        self.childCount = childCount
        self.stablePathHash = stablePathHash
        self.parentStablePathHash = parentStablePathHash
        self.elementRef = elementRef
        self.order = order
        self.settableAttributes = settableAttributes
        self.patterns = patterns
    }

    private enum CodingKeys: String, CodingKey {
        case token, parentToken, role, subrole, label, value, identifier, bounds
        case enabled, focused, selected, actions, childCount, stablePathHash
        case parentStablePathHash, elementRef, order, settableAttributes, patterns
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        token = try container.decode(String.self, forKey: .token)
        parentToken = try container.decodeIfPresent(String.self, forKey: .parentToken)
        role = try container.decode(String.self, forKey: .role)
        subrole = try container.decodeIfPresent(String.self, forKey: .subrole)
        label = try container.decodeIfPresent(String.self, forKey: .label)
        value = try container.decodeIfPresent(String.self, forKey: .value)
        identifier = try container.decodeIfPresent(String.self, forKey: .identifier)
        bounds = try container.decodeIfPresent(CuRect.self, forKey: .bounds)
        enabled = try container.decode(Bool.self, forKey: .enabled)
        focused = try container.decode(Bool.self, forKey: .focused)
        selected = try container.decodeIfPresent(Bool.self, forKey: .selected) ?? false
        actions = try container.decode([String].self, forKey: .actions)
        childCount = try container.decode(Int.self, forKey: .childCount)
        stablePathHash = try container.decodeIfPresent(String.self, forKey: .stablePathHash) ?? ""
        parentStablePathHash = try container.decodeIfPresent(String.self, forKey: .parentStablePathHash)
        elementRef = try container.decodeIfPresent(ElementRef.self, forKey: .elementRef)
        order = try container.decodeIfPresent(Int.self, forKey: .order) ?? 0
        // A service that predates capability discovery reports no capabilities, never a guess.
        settableAttributes = try container.decodeIfPresent([String].self, forKey: .settableAttributes) ?? []
        patterns = try container.decodeIfPresent([String].self, forKey: .patterns) ?? []
    }
}

public enum AXDiffOperation: Equatable, Sendable {
    case insert(AXNode)
    case update(AXNode)
    case remove(stablePathHash: String, token: String)
}

extension AXDiffOperation: Codable {
    private enum CodingKeys: String, CodingKey { case op, node, stablePathHash, token }
    private enum Operation: String, Codable { case insert, update, remove }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        switch try values.decode(Operation.self, forKey: .op) {
        case .insert: self = .insert(try values.decode(AXNode.self, forKey: .node))
        case .update: self = .update(try values.decode(AXNode.self, forKey: .node))
        case .remove: self = .remove(
            stablePathHash: try values.decode(String.self, forKey: .stablePathHash),
            token: try values.decode(String.self, forKey: .token)
        )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .insert(let node):
            try values.encode(Operation.insert, forKey: .op)
            try values.encode(node, forKey: .node)
        case .update(let node):
            try values.encode(Operation.update, forKey: .op)
            try values.encode(node, forKey: .node)
        case .remove(let stablePathHash, let token):
            try values.encode(Operation.remove, forKey: .op)
            try values.encode(stablePathHash, forKey: .stablePathHash)
            try values.encode(token, forKey: .token)
        }
    }
}

public struct AXSnapshot: Codable, Equatable, Sendable {
    public var snapshotId: String
    public var sessionId: String
    public var pid: Int32
    public var windowId: UInt32?
    public var windowGeneration: UInt64?
    public var revision: UInt64
    public var capturedAtMs: Int64
    public var profile: String
    public var scope: AXObservationScope
    public var nodes: [AXNode]
    public var visitedCount: Int
    public var truncated: Bool
    public var partial: Bool
    public var issues: [AXObservationIssue]
    public var clippedNodeCount: Int
    /// A diff response has an empty `nodes` array and identifies its retained base here.
    public var baseSnapshotId: String?
    public var diff: [AXDiffOperation]?
    public var fullNodeCount: Int
    public var eventTracking: Bool
    public var eventRevision: UInt64
    public var changedDuringCapture: Bool
    /// The query this snapshot was filtered by, echoed so a filtered view can never be diffed
    /// against an unfiltered one. Nil means the snapshot is the complete emitted graph.
    public var query: String?

    public init(snapshotId: String, sessionId: String, pid: Int32, windowId: UInt32?, windowGeneration: UInt64?, revision: UInt64, capturedAtMs: Int64, profile: String, scope: AXObservationScope? = nil, nodes: [AXNode], visitedCount: Int, truncated: Bool, partial: Bool = false, issues: [AXObservationIssue] = [], clippedNodeCount: Int = 0, baseSnapshotId: String? = nil, diff: [AXDiffOperation]? = nil, fullNodeCount: Int? = nil, eventTracking: Bool = false, eventRevision: UInt64 = 0, changedDuringCapture: Bool = false, query: String? = nil) {
        self.snapshotId = snapshotId
        self.sessionId = sessionId
        self.pid = pid
        self.windowId = windowId
        self.windowGeneration = windowGeneration
        self.revision = revision
        self.capturedAtMs = capturedAtMs
        self.profile = profile
        self.scope = scope ?? (windowId == nil ? .application : .window)
        self.nodes = nodes
        self.visitedCount = visitedCount
        self.truncated = truncated
        self.partial = partial
        self.issues = issues
        self.clippedNodeCount = clippedNodeCount
        self.baseSnapshotId = baseSnapshotId
        self.diff = diff
        self.fullNodeCount = fullNodeCount ?? nodes.count
        self.eventTracking = eventTracking
        self.eventRevision = eventRevision
        self.changedDuringCapture = changedDuringCapture
        self.query = query
    }

    private enum CodingKeys: String, CodingKey {
        case snapshotId, sessionId, pid, windowId, windowGeneration, revision, capturedAtMs, profile, scope
        case nodes, visitedCount, truncated, partial, issues, clippedNodeCount, baseSnapshotId, diff, fullNodeCount
        case eventTracking, eventRevision, changedDuringCapture, query
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        snapshotId = try container.decode(String.self, forKey: .snapshotId)
        sessionId = try container.decode(String.self, forKey: .sessionId)
        pid = try container.decode(Int32.self, forKey: .pid)
        windowId = try container.decodeIfPresent(UInt32.self, forKey: .windowId)
        windowGeneration = try container.decodeIfPresent(UInt64.self, forKey: .windowGeneration)
        revision = try container.decode(UInt64.self, forKey: .revision)
        capturedAtMs = try container.decode(Int64.self, forKey: .capturedAtMs)
        profile = try container.decode(String.self, forKey: .profile)
        scope = try container.decodeIfPresent(AXObservationScope.self, forKey: .scope)
            ?? (windowId == nil ? .application : .window)
        nodes = try container.decode([AXNode].self, forKey: .nodes)
        visitedCount = try container.decode(Int.self, forKey: .visitedCount)
        truncated = try container.decode(Bool.self, forKey: .truncated)
        partial = try container.decodeIfPresent(Bool.self, forKey: .partial) ?? false
        issues = try container.decodeIfPresent([AXObservationIssue].self, forKey: .issues) ?? []
        clippedNodeCount = try container.decodeIfPresent(Int.self, forKey: .clippedNodeCount) ?? 0
        baseSnapshotId = try container.decodeIfPresent(String.self, forKey: .baseSnapshotId)
        diff = try container.decodeIfPresent([AXDiffOperation].self, forKey: .diff)
        fullNodeCount = try container.decodeIfPresent(Int.self, forKey: .fullNodeCount) ?? nodes.count
        eventTracking = try container.decodeIfPresent(Bool.self, forKey: .eventTracking) ?? false
        eventRevision = try container.decodeIfPresent(UInt64.self, forKey: .eventRevision) ?? 0
        changedDuringCapture = try container.decodeIfPresent(Bool.self, forKey: .changedDuringCapture) ?? false
        query = try container.decodeIfPresent(String.self, forKey: .query)
    }
}

public enum CaptureWireFormat: String, Codable, Equatable, Sendable {
    case png
    case jpeg
}

public enum CaptureMode: String, Codable, Equatable, Sendable {
    case image
    case som
    case zoom
}

public enum CaptureTargetRef: Equatable, Sendable {
    case window(WindowRef)
    case display(displayId: UInt32)
}

extension CaptureTargetRef: Codable {
    private enum CodingKeys: String, CodingKey { case type, window, displayId }
    private enum TargetType: String, Codable { case window, display }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(TargetType.self, forKey: .type) {
        case .window: self = .window(try container.decode(WindowRef.self, forKey: .window))
        case .display: self = .display(displayId: try container.decode(UInt32.self, forKey: .displayId))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .window(let window):
            try container.encode(TargetType.window, forKey: .type)
            try container.encode(window, forKey: .window)
        case .display(let displayId):
            try container.encode(TargetType.display, forKey: .type)
            try container.encode(displayId, forKey: .displayId)
        }
    }
}

public struct CaptureImageRequest: Codable, Equatable, Sendable {
    public var target: CaptureTargetRef
    public var mode: CaptureMode
    public var format: CaptureWireFormat
    public var maxDimension: Int
    public var jpegQuality: Double
    /// Source-image pixels, top-left origin. Nil captures the complete target.
    public var region: CuRect?
    /// Required for SOM. Marks are derived only from this retained authoritative AX snapshot.
    public var basedOnSnapshotId: String?
    /// Zoom-only multiplier, bounded by the service and the final maxDimension ceiling.
    public var zoomFactor: Double

    public init(
        target: CaptureTargetRef,
        mode: CaptureMode = .image,
        format: CaptureWireFormat = .jpeg,
        maxDimension: Int = 1_456,
        jpegQuality: Double = 0.85,
        region: CuRect? = nil,
        basedOnSnapshotId: String? = nil,
        zoomFactor: Double = 1
    ) {
        self.target = target
        self.mode = mode
        self.format = format
        self.maxDimension = maxDimension
        self.jpegQuality = jpegQuality
        self.region = region
        self.basedOnSnapshotId = basedOnSnapshotId
        self.zoomFactor = zoomFactor
    }

    private enum CodingKeys: String, CodingKey {
        case target, mode, format, maxDimension, jpegQuality, region, basedOnSnapshotId, zoomFactor
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        target = try container.decode(CaptureTargetRef.self, forKey: .target)
        mode = try container.decodeIfPresent(CaptureMode.self, forKey: .mode) ?? .image
        format = try container.decode(CaptureWireFormat.self, forKey: .format)
        maxDimension = try container.decode(Int.self, forKey: .maxDimension)
        jpegQuality = try container.decode(Double.self, forKey: .jpegQuality)
        region = try container.decodeIfPresent(CuRect.self, forKey: .region)
        basedOnSnapshotId = try container.decodeIfPresent(String.self, forKey: .basedOnSnapshotId)
        zoomFactor = try container.decodeIfPresent(Double.self, forKey: .zoomFactor) ?? 1
    }
}

public struct CaptureTransformRef: Codable, Equatable, Sendable {
    public var sourcePixelRect: CuRect
    public var outputWidth: Int
    public var outputHeight: Int

    public init(sourcePixelRect: CuRect, outputWidth: Int, outputHeight: Int) {
        self.sourcePixelRect = sourcePixelRect
        self.outputWidth = outputWidth
        self.outputHeight = outputHeight
    }
}

public struct ImageHandleRef: Codable, Equatable, Sendable {
    public var token: String
    public var sessionId: String
    public var format: CaptureWireFormat
    public var pixelWidth: Int
    public var pixelHeight: Int
    public var byteCount: Int
    public var sha256: String
    public var createdAtMs: Int64
    public var transform: CaptureTransformRef

    public init(
        token: String,
        sessionId: String,
        format: CaptureWireFormat,
        pixelWidth: Int,
        pixelHeight: Int,
        byteCount: Int,
        sha256: String,
        createdAtMs: Int64,
        transform: CaptureTransformRef
    ) {
        self.token = token
        self.sessionId = sessionId
        self.format = format
        self.pixelWidth = pixelWidth
        self.pixelHeight = pixelHeight
        self.byteCount = byteCount
        self.sha256 = sha256
        self.createdAtMs = createdAtMs
        self.transform = transform
    }
}

public struct SOMMarkRef: Codable, Equatable, Sendable {
    public var index: Int
    public var element: ElementRef
    /// Final encoded-image pixels, top-left origin.
    public var bounds: CuRect

    public init(index: Int, element: ElementRef, bounds: CuRect) {
        self.index = index
        self.element = element
        self.bounds = bounds
    }
}

public struct CaptureImageReceipt: Codable, Equatable, Sendable {
    public var target: CaptureTargetRef
    public var image: ImageHandleRef
    public var mode: CaptureMode
    public var marks: [SOMMarkRef]
    /// Final encoded-image pixels occupied by the unmodified source capture after SOM padding.
    public var sourceContentRect: CuRect?

    public init(
        target: CaptureTargetRef,
        image: ImageHandleRef,
        mode: CaptureMode = .image,
        marks: [SOMMarkRef] = [],
        sourceContentRect: CuRect? = nil
    ) {
        self.target = target
        self.image = image
        self.mode = mode
        self.marks = marks
        self.sourceContentRect = sourceContentRect
    }

    private enum CodingKeys: String, CodingKey {
        case target, image, mode, marks, sourceContentRect
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        target = try container.decode(CaptureTargetRef.self, forKey: .target)
        image = try container.decode(ImageHandleRef.self, forKey: .image)
        mode = try container.decodeIfPresent(CaptureMode.self, forKey: .mode) ?? .image
        marks = try container.decodeIfPresent([SOMMarkRef].self, forKey: .marks) ?? []
        sourceContentRect = try container.decodeIfPresent(CuRect.self, forKey: .sourceContentRect)
    }
}

/// Authorization payload for the separate binary XPC image channel.
public struct ImageHandleReadRequest: Codable, Equatable, Sendable {
    public var sessionId: String
    public var image: ImageHandleRef

    public init(sessionId: String, image: ImageHandleRef) {
        self.sessionId = sessionId
        self.image = image
    }
}

public struct ImageHandleReleaseRequest: Codable, Equatable, Sendable {
    public var image: ImageHandleRef

    public init(image: ImageHandleRef) { self.image = image }
}

public struct ImageAnalysisRegion: Codable, Equatable, Sendable {
    public var id: String
    /// Encoded-image pixels, top-left origin.
    public var bounds: CuRect

    public init(id: String, bounds: CuRect) {
        self.id = id
        self.bounds = bounds
    }
}

public struct RGBColorRef: Codable, Equatable, Sendable {
    public var red: Int
    public var green: Int
    public var blue: Int

    public init(red: Int, green: Int, blue: Int) {
        self.red = red
        self.green = green
        self.blue = blue
    }
}

public struct OKLabColorRef: Codable, Equatable, Sendable {
    public var lightness: Double
    public var a: Double
    public var b: Double

    public init(lightness: Double, a: Double, b: Double) {
        self.lightness = lightness
        self.a = a
        self.b = b
    }
}

public struct VisualDominantColorRef: Codable, Equatable, Sendable {
    public var rgb: RGBColorRef
    public var coverage: Double

    public init(rgb: RGBColorRef, coverage: Double) {
        self.rgb = rgb
        self.coverage = coverage
    }
}

public struct VisualFingerprintRef: Codable, Equatable, Sendable {
    public var id: String
    public var centerRGB: RGBColorRef
    public var medianRGB: RGBColorRef
    public var dominant: [VisualDominantColorRef]
    public var oklab: OKLabColorRef
    public var luminance: Double
    public var chroma: Double
    public var colorName: String
    public var entropy: Double
    public var confidence: Double
    public var sampleCount: Int
    public var sourceColorSpace: String

    public init(
        id: String, centerRGB: RGBColorRef, medianRGB: RGBColorRef,
        dominant: [VisualDominantColorRef], oklab: OKLabColorRef,
        luminance: Double, chroma: Double, colorName: String,
        entropy: Double, confidence: Double, sampleCount: Int,
        sourceColorSpace: String = "sRGB"
    ) {
        self.id = id
        self.centerRGB = centerRGB
        self.medianRGB = medianRGB
        self.dominant = dominant
        self.oklab = oklab
        self.luminance = luminance
        self.chroma = chroma
        self.colorName = colorName
        self.entropy = entropy
        self.confidence = confidence
        self.sampleCount = sampleCount
        self.sourceColorSpace = sourceColorSpace
    }
}

public struct OCRTextRef: Codable, Equatable, Sendable {
    public var text: String
    public var confidence: Double
    /// Encoded-image pixels, top-left origin.
    public var bounds: CuRect

    public init(text: String, confidence: Double, bounds: CuRect) {
        self.text = text
        self.confidence = confidence
        self.bounds = bounds
    }
}

public struct ImageAnalysisRequest: Codable, Equatable, Sendable {
    public var image: ImageHandleRef
    public var fingerprintRegions: [ImageAnalysisRegion]
    public var ocrRegion: CuRect?
    public var ocrQuery: String?

    public init(
        image: ImageHandleRef,
        fingerprintRegions: [ImageAnalysisRegion] = [],
        ocrRegion: CuRect? = nil,
        ocrQuery: String? = nil
    ) {
        self.image = image
        self.fingerprintRegions = fingerprintRegions
        self.ocrRegion = ocrRegion
        self.ocrQuery = ocrQuery
    }
}

public struct ImageAnalysisReceipt: Codable, Equatable, Sendable {
    public var image: ImageHandleRef
    public var fingerprints: [VisualFingerprintRef]
    public var texts: [OCRTextRef]
    public var errors: [String]
    public var latencyMs: Int

    public init(
        image: ImageHandleRef,
        fingerprints: [VisualFingerprintRef],
        texts: [OCRTextRef],
        errors: [String],
        latencyMs: Int
    ) {
        self.image = image
        self.fingerprints = fingerprints
        self.texts = texts
        self.errors = errors
        self.latencyMs = latencyMs
    }
}

public enum RequestBody: Equatable, Sendable {
    case handshake(HandshakeRequest)
    case sessionCreate(requestedId: String?)
    case sessionStatus
    case sessionReset(reason: String)
    case sessionClose
    case workspaceSnapshot(WorkspaceSnapshotRequest)
    case appResolve(AppResolveRequest)
    case appLaunch(AppLaunchRequest)
    case fileInspect(FileInspectRequest)
    case fileOperation(FileOperationRequest)
    case urlOpen(OpenURLRequest)
    case windowOperation(WindowOperationRequest)
    case axObserve(AXObserveRequest)
    case semanticAction(SemanticActionRequest)
    case semanticTransaction(SemanticTransactionRequest)
    case captureImage(CaptureImageRequest)
    case imageRelease(ImageHandleReleaseRequest)
    case imageAnalyze(ImageAnalysisRequest)
}

extension RequestBody: Codable {
    private enum CodingKeys: String, CodingKey { case op, payload }
    private enum Operation: String, Codable {
        case handshake
        case sessionCreate = "session.create"
        case sessionStatus = "session.status"
        case sessionReset = "session.reset"
        case sessionClose = "session.close"
        case workspaceSnapshot = "workspace.snapshot"
        case appResolve = "workspace.app.resolve"
        case appLaunch = "workspace.app.launch"
        case fileInspect = "workspace.file.inspect"
        case fileOperation = "workspace.file.operate"
        case urlOpen = "workspace.url.open"
        case windowOperation = "workspace.window.operate"
        case axObserve = "ax.observe"
        case semanticAction = "semantic.action"
        case semanticTransaction = "semantic.transaction"
        case captureImage = "capture.image"
        case imageRelease = "image.release"
        case imageAnalyze = "image.analyze"
    }
    private struct OptionalId: Codable { var requestedId: String? }
    private struct Reset: Codable { var reason: String }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        switch try values.decode(Operation.self, forKey: .op) {
        case .handshake: self = .handshake(try values.decode(HandshakeRequest.self, forKey: .payload))
        case .sessionCreate: self = .sessionCreate(requestedId: try values.decodeIfPresent(OptionalId.self, forKey: .payload)?.requestedId)
        case .sessionStatus: self = .sessionStatus
        case .sessionReset: self = .sessionReset(reason: try values.decode(Reset.self, forKey: .payload).reason)
        case .sessionClose: self = .sessionClose
        case .workspaceSnapshot: self = .workspaceSnapshot(try values.decode(WorkspaceSnapshotRequest.self, forKey: .payload))
        case .appResolve: self = .appResolve(try values.decode(AppResolveRequest.self, forKey: .payload))
        case .appLaunch: self = .appLaunch(try values.decode(AppLaunchRequest.self, forKey: .payload))
        case .fileInspect: self = .fileInspect(try values.decode(FileInspectRequest.self, forKey: .payload))
        case .fileOperation: self = .fileOperation(try values.decode(FileOperationRequest.self, forKey: .payload))
        case .urlOpen: self = .urlOpen(try values.decode(OpenURLRequest.self, forKey: .payload))
        case .windowOperation: self = .windowOperation(try values.decode(WindowOperationRequest.self, forKey: .payload))
        case .axObserve: self = .axObserve(try values.decode(AXObserveRequest.self, forKey: .payload))
        case .semanticAction: self = .semanticAction(try values.decode(SemanticActionRequest.self, forKey: .payload))
        case .semanticTransaction: self = .semanticTransaction(try values.decode(SemanticTransactionRequest.self, forKey: .payload))
        case .captureImage: self = .captureImage(try values.decode(CaptureImageRequest.self, forKey: .payload))
        case .imageRelease: self = .imageRelease(try values.decode(ImageHandleReleaseRequest.self, forKey: .payload))
        case .imageAnalyze: self = .imageAnalyze(try values.decode(ImageAnalysisRequest.self, forKey: .payload))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .handshake(let request):
            try values.encode(Operation.handshake, forKey: .op)
            try values.encode(request, forKey: .payload)
        case .sessionCreate(let requestedId):
            try values.encode(Operation.sessionCreate, forKey: .op)
            try values.encode(OptionalId(requestedId: requestedId), forKey: .payload)
        case .sessionStatus: try values.encode(Operation.sessionStatus, forKey: .op)
        case .sessionReset(let reason):
            try values.encode(Operation.sessionReset, forKey: .op)
            try values.encode(Reset(reason: reason), forKey: .payload)
        case .sessionClose: try values.encode(Operation.sessionClose, forKey: .op)
        case .workspaceSnapshot(let request):
            try values.encode(Operation.workspaceSnapshot, forKey: .op)
            try values.encode(request, forKey: .payload)
        case .appResolve(let request):
            try values.encode(Operation.appResolve, forKey: .op)
            try values.encode(request, forKey: .payload)
        case .appLaunch(let request):
            try values.encode(Operation.appLaunch, forKey: .op)
            try values.encode(request, forKey: .payload)
        case .fileInspect(let request):
            try values.encode(Operation.fileInspect, forKey: .op)
            try values.encode(request, forKey: .payload)
        case .fileOperation(let request):
            try values.encode(Operation.fileOperation, forKey: .op)
            try values.encode(request, forKey: .payload)
        case .urlOpen(let request):
            try values.encode(Operation.urlOpen, forKey: .op)
            try values.encode(request, forKey: .payload)
        case .windowOperation(let request):
            try values.encode(Operation.windowOperation, forKey: .op)
            try values.encode(request, forKey: .payload)
        case .axObserve(let request):
            try values.encode(Operation.axObserve, forKey: .op)
            try values.encode(request, forKey: .payload)
        case .semanticAction(let request):
            try values.encode(Operation.semanticAction, forKey: .op)
            try values.encode(request, forKey: .payload)
        case .semanticTransaction(let request):
            try values.encode(Operation.semanticTransaction, forKey: .op)
            try values.encode(request, forKey: .payload)
        case .captureImage(let request):
            try values.encode(Operation.captureImage, forKey: .op)
            try values.encode(request, forKey: .payload)
        case .imageRelease(let request):
            try values.encode(Operation.imageRelease, forKey: .op)
            try values.encode(request, forKey: .payload)
        case .imageAnalyze(let request):
            try values.encode(Operation.imageAnalyze, forKey: .op)
            try values.encode(request, forKey: .payload)
        }
    }
}

public enum ResponseBody: Equatable, Sendable {
    case handshake(HandshakeResponse)
    case session(SessionInfo)
    case sessionClosed
    case workspace(WorkspaceSnapshot)
    case appResolved(ResolvedApplication)
    case appLaunchReceipt(AppLaunchReceipt)
    case fileInfo(FileInfoReceipt)
    case fileOperationReceipt(FileOperationReceipt)
    case urlOpenReceipt(OpenURLReceipt)
    case windowOperationReceipt(WindowOperationReceipt)
    case axSnapshot(AXSnapshot)
    case semanticActionReceipt(SemanticActionReceipt)
    case semanticTransactionReceipt(SemanticTransactionReceipt)
    /// A `background_preferred` call whose background delivery was refused. Nothing was performed.
    case escalationProposal(EscalationProposal)
    case captureImageReceipt(CaptureImageReceipt)
    case imageReleased
    case imageAnalysis(ImageAnalysisReceipt)
}

extension ResponseBody: Codable {
    private enum CodingKeys: String, CodingKey { case op, payload }
    private enum Operation: String, Codable {
        case handshake
        case session
        case sessionClosed = "session.closed"
        case workspaceSnapshot = "workspace.snapshot"
        case appResolved = "workspace.app.resolved"
        case appLaunchReceipt = "workspace.app.launch.receipt"
        case fileInfo = "workspace.file.info"
        case fileOperationReceipt = "workspace.file.receipt"
        case urlOpenReceipt = "workspace.url.receipt"
        case windowOperationReceipt = "workspace.window.receipt"
        case axSnapshot = "ax.snapshot"
        case semanticActionReceipt = "semantic.action.receipt"
        case semanticTransactionReceipt = "semantic.transaction.receipt"
        case escalationProposal = "delivery.escalation.proposal"
        case captureImageReceipt = "capture.image.receipt"
        case imageReleased = "image.released"
        case imageAnalysis = "image.analysis"
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        switch try values.decode(Operation.self, forKey: .op) {
        case .handshake: self = .handshake(try values.decode(HandshakeResponse.self, forKey: .payload))
        case .session: self = .session(try values.decode(SessionInfo.self, forKey: .payload))
        case .sessionClosed: self = .sessionClosed
        case .workspaceSnapshot: self = .workspace(try values.decode(WorkspaceSnapshot.self, forKey: .payload))
        case .appResolved: self = .appResolved(try values.decode(ResolvedApplication.self, forKey: .payload))
        case .appLaunchReceipt: self = .appLaunchReceipt(try values.decode(AppLaunchReceipt.self, forKey: .payload))
        case .fileInfo: self = .fileInfo(try values.decode(FileInfoReceipt.self, forKey: .payload))
        case .fileOperationReceipt: self = .fileOperationReceipt(try values.decode(FileOperationReceipt.self, forKey: .payload))
        case .urlOpenReceipt: self = .urlOpenReceipt(try values.decode(OpenURLReceipt.self, forKey: .payload))
        case .windowOperationReceipt: self = .windowOperationReceipt(try values.decode(WindowOperationReceipt.self, forKey: .payload))
        case .axSnapshot: self = .axSnapshot(try values.decode(AXSnapshot.self, forKey: .payload))
        case .semanticActionReceipt: self = .semanticActionReceipt(try values.decode(SemanticActionReceipt.self, forKey: .payload))
        case .semanticTransactionReceipt: self = .semanticTransactionReceipt(try values.decode(SemanticTransactionReceipt.self, forKey: .payload))
        case .escalationProposal: self = .escalationProposal(try values.decode(EscalationProposal.self, forKey: .payload))
        case .captureImageReceipt: self = .captureImageReceipt(try values.decode(CaptureImageReceipt.self, forKey: .payload))
        case .imageReleased: self = .imageReleased
        case .imageAnalysis: self = .imageAnalysis(try values.decode(ImageAnalysisReceipt.self, forKey: .payload))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .handshake(let response):
            try values.encode(Operation.handshake, forKey: .op)
            try values.encode(response, forKey: .payload)
        case .session(let session):
            try values.encode(Operation.session, forKey: .op)
            try values.encode(session, forKey: .payload)
        case .sessionClosed:
            try values.encode(Operation.sessionClosed, forKey: .op)
        case .workspace(let snapshot):
            try values.encode(Operation.workspaceSnapshot, forKey: .op)
            try values.encode(snapshot, forKey: .payload)
        case .appResolved(let resolved):
            try values.encode(Operation.appResolved, forKey: .op)
            try values.encode(resolved, forKey: .payload)
        case .appLaunchReceipt(let receipt):
            try values.encode(Operation.appLaunchReceipt, forKey: .op)
            try values.encode(receipt, forKey: .payload)
        case .fileInfo(let receipt):
            try values.encode(Operation.fileInfo, forKey: .op)
            try values.encode(receipt, forKey: .payload)
        case .fileOperationReceipt(let receipt):
            try values.encode(Operation.fileOperationReceipt, forKey: .op)
            try values.encode(receipt, forKey: .payload)
        case .urlOpenReceipt(let receipt):
            try values.encode(Operation.urlOpenReceipt, forKey: .op)
            try values.encode(receipt, forKey: .payload)
        case .windowOperationReceipt(let receipt):
            try values.encode(Operation.windowOperationReceipt, forKey: .op)
            try values.encode(receipt, forKey: .payload)
        case .axSnapshot(let snapshot):
            try values.encode(Operation.axSnapshot, forKey: .op)
            try values.encode(snapshot, forKey: .payload)
        case .semanticActionReceipt(let receipt):
            try values.encode(Operation.semanticActionReceipt, forKey: .op)
            try values.encode(receipt, forKey: .payload)
        case .semanticTransactionReceipt(let receipt):
            try values.encode(Operation.semanticTransactionReceipt, forKey: .op)
            try values.encode(receipt, forKey: .payload)
        case .escalationProposal(let proposal):
            try values.encode(Operation.escalationProposal, forKey: .op)
            try values.encode(proposal, forKey: .payload)
        case .captureImageReceipt(let receipt):
            try values.encode(Operation.captureImageReceipt, forKey: .op)
            try values.encode(receipt, forKey: .payload)
        case .imageReleased:
            try values.encode(Operation.imageReleased, forKey: .op)
        case .imageAnalysis(let receipt):
            try values.encode(Operation.imageAnalysis, forKey: .op)
            try values.encode(receipt, forKey: .payload)
        }
    }
}

public struct CuError: Codable, Equatable, Sendable {
    public var code: String
    public var message: String
    public var retryable: Bool

    public init(code: String, message: String, retryable: Bool = false) {
        self.code = code
        self.message = message
        self.retryable = retryable
    }
}

public struct RequestEnvelope: Codable, Equatable, Sendable {
    public var `protocol`: String
    public var requestId: String
    public var sessionId: String
    public var deadlineMs: Int
    public var body: RequestBody

    public init(protocol: String = BimaxCuProtocolVersion.v1, requestId: String, sessionId: String, deadlineMs: Int, body: RequestBody) {
        self.protocol = `protocol`
        self.requestId = requestId
        self.sessionId = sessionId
        self.deadlineMs = deadlineMs
        self.body = body
    }
}

public struct ResponseEnvelope: Codable, Equatable, Sendable {
    public var `protocol`: String
    public var requestId: String
    public var sessionId: String
    public var serviceVersion: String
    public var body: ResponseBody?
    public var error: CuError?

    public init(protocol: String = BimaxCuProtocolVersion.v1, requestId: String, sessionId: String, serviceVersion: String, body: ResponseBody? = nil, error: CuError? = nil) {
        self.protocol = `protocol`
        self.requestId = requestId
        self.sessionId = sessionId
        self.serviceVersion = serviceVersion
        self.body = body
        self.error = error
    }
}
