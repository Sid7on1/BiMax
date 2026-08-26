import Foundation
import Security
import Darwin
import BimaxCuProtocol

// RECONSTRUCTED 2026-08-17 — the XPC listener plumbing the eviction took with it.
//
// The contract is pinned by three surviving places: `main.swift` resumes an `NSXPCListener.service()`
// over `BimaxCuXPCService()` and `BimaxCuXPCServiceDelegate(exportedObject:)`; `BimaxCuBridge`
// documents the peer as "the same core the XPC service hosts" and drives it through
// `core.handle(data:) -> Data`; and `BimaxCuTests` pins the delegate's full signature
// (`exportedObject:identityValidator:lifecycle:`) plus the exact trust semantics asserted below.
// The interface is Data in, Data out: the envelope is already JSON, so the XPC boundary never has
// to agree with the peer about Swift types and needs no class allowlist beyond `NSData`.

/// The outcome of validating a connecting client.
///
/// Carries the reason as well as the verdict because the refusals are diagnosable states a caller
/// acts on differently — `uid_mismatch` is a different problem from an unsigned binary.
public struct XPCClientTrustDecision: Equatable, Sendable {
    public var accepted: Bool
    public var reason: String

    public init(accepted: Bool, reason: String) {
        self.accepted = accepted
        self.reason = reason
    }
}

/// Decides whether a connecting process may talk to the service.
public protocol XPCClientIdentityValidating: Sendable {
    /// Installed on the connection so the kernel evaluates it against the immutable audit token.
    /// Nil disables the kernel-side check, which only a development validator should do.
    var kernelCodeSigningRequirement: String? { get }
    func validate(processIdentifier: pid_t, effectiveUserIdentifier: uid_t) -> XPCClientTrustDecision
}

/// Production validator: same user, plausible pid, and a code-signing requirement the kernel
/// enforces on the connection.
///
/// The uid check is not redundant with the signing requirement. A correctly signed copy of the app
/// running as ANOTHER user on the same machine satisfies the signature and must still be refused —
/// this service acts on one user's desktop and holds that user's TCC grants.
public struct CodeSigningXPCClientValidator: XPCClientIdentityValidating {
    public let kernelCodeSigningRequirement: String?
    private let allowUnsignedDevelopment: Bool
    private let expectedUserIdentifier: uid_t

    public init(
        requirement: String,
        allowUnsignedDevelopment: Bool = false,
        expectedUserIdentifier: uid_t = getuid()
    ) {
        // A development build deliberately drops the kernel requirement; keeping it would refuse
        // every unsigned local build, and pretending it is installed would be worse.
        self.kernelCodeSigningRequirement = allowUnsignedDevelopment ? nil : requirement
        self.allowUnsignedDevelopment = allowUnsignedDevelopment
        self.expectedUserIdentifier = expectedUserIdentifier
    }

    public func validate(
        processIdentifier: pid_t,
        effectiveUserIdentifier: uid_t
    ) -> XPCClientTrustDecision {
        guard effectiveUserIdentifier == expectedUserIdentifier else {
            return .init(accepted: false, reason: "uid_mismatch")
        }
        // pid 0 is the kernel and negative pids are nonsense; either means the audit token was not
        // read properly, and a caller we cannot identify is not a caller we accept.
        guard processIdentifier > 0 else {
            return .init(accepted: false, reason: "invalid_pid")
        }
        if allowUnsignedDevelopment {
            return .init(accepted: true, reason: "development")
        }
        guard let requirement = kernelCodeSigningRequirement else {
            return .init(accepted: false, reason: "missing_signing_requirement")
        }

        var guest: SecCode?
        let attributes = [kSecGuestAttributePid as String: NSNumber(value: processIdentifier)] as CFDictionary
        guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &guest) == errSecSuccess,
              let guest else {
            return .init(accepted: false, reason: "client_code_unavailable")
        }
        var compiled: SecRequirement?
        guard SecRequirementCreateWithString(requirement as CFString, [], &compiled) == errSecSuccess,
              let compiled else {
            return .init(accepted: false, reason: "invalid_signing_requirement")
        }
        guard SecCodeCheckValidity(guest, [], compiled) == errSecSuccess else {
            return .init(accepted: false, reason: "signing_requirement_failed")
        }
        return .init(accepted: true, reason: "signed")
    }

    /// Resolve the executable's own designated requirement after verifying its current seal.
    ///
    /// The XPC service uses this for the exact bridge and containing app that were packaged beside
    /// it. A Developer ID build therefore binds to its stable signer/identifier requirement, while
    /// a manual-alpha ad-hoc build binds to the exact sealed code directory. No hard-coded Team ID
    /// or development certificate name is needed, and a sibling copied from another build fails.
    public static func designatedRequirement(forExecutableAt path: String) throws -> String {
        var staticCode: SecStaticCode?
        let create = SecStaticCodeCreateWithPath(URL(fileURLWithPath: path) as CFURL, [], &staticCode)
        guard create == errSecSuccess, let staticCode else {
            throw CodeSigningRequirementError.couldNotLoad(path, create)
        }
        let validity = SecStaticCodeCheckValidity(staticCode, [], nil)
        guard validity == errSecSuccess else {
            throw CodeSigningRequirementError.invalidSeal(path, validity)
        }
        var requirement: SecRequirement?
        let copy = SecCodeCopyDesignatedRequirement(staticCode, [], &requirement)
        guard copy == errSecSuccess, let requirement else {
            throw CodeSigningRequirementError.missingDesignatedRequirement(path, copy)
        }
        var text: CFString?
        let stringify = SecRequirementCopyString(requirement, [], &text)
        guard stringify == errSecSuccess, let text else {
            throw CodeSigningRequirementError.couldNotStringify(path, stringify)
        }
        return text as String
    }
}

public enum CodeSigningRequirementError: Error, CustomStringConvertible, Sendable {
    case couldNotLoad(String, OSStatus)
    case invalidSeal(String, OSStatus)
    case missingDesignatedRequirement(String, OSStatus)
    case couldNotStringify(String, OSStatus)

    public var description: String {
        switch self {
        case .couldNotLoad(let path, let status):
            return "could not load signed code at \(path) (\(status))"
        case .invalidSeal(let path, let status):
            return "code signature is invalid at \(path) (\(status))"
        case .missingDesignatedRequirement(let path, let status):
            return "code has no designated requirement at \(path) (\(status))"
        case .couldNotStringify(let path, let status):
            return "could not serialize the designated requirement at \(path) (\(status))"
        }
    }
}

/// Read a process's immutable parent relation from libproc. Failure is an authorization failure,
/// never a reason to skip an ancestor, because a missing link would let a detached bridge hide its
/// real launcher.
public func bimaxParentProcessIdentifier(_ processIdentifier: pid_t) -> pid_t? {
    guard processIdentifier > 1 else { return nil }
    var info = proc_bsdinfo()
    let count = withUnsafeMutablePointer(to: &info) { pointer in
        proc_pidinfo(
            processIdentifier,
            PROC_PIDTBSDINFO,
            0,
            pointer,
            Int32(MemoryLayout<proc_bsdinfo>.size)
        )
    }
    guard count == Int32(MemoryLayout<proc_bsdinfo>.size), info.pbi_ppid > 0 else { return nil }
    return pid_t(info.pbi_ppid)
}

/// Accepts a client when it, or one of its ancestors, is a signed Bimax process.
///
/// The bridge is launched as a child of the engine, which is itself a child of the app, so the
/// immediate peer is often not the signed binary — the signed ancestor is. Walking up is what makes
/// the check meaningful without weakening it to "any process owned by this user".
public struct BimaxSignedAncestorAuthorizer: Sendable {
    private let validator: any XPCClientIdentityValidating
    private let parentLookup: @Sendable (pid_t) -> pid_t?
    private let maximumDepth: Int

    public init(
        validator: any XPCClientIdentityValidating,
        parentLookup: @escaping @Sendable (pid_t) -> pid_t?,
        maximumDepth: Int = 32
    ) {
        self.validator = validator
        self.parentLookup = parentLookup
        self.maximumDepth = maximumDepth
    }

    public func authorize(parentPID: pid_t, userIdentifier: uid_t) -> XPCClientTrustDecision {
        var current: pid_t? = parentPID
        // A pid graph should be a tree, but a lookup that lies can produce a cycle. Track what has
        // been seen and bound the depth: an unbounded walk on a cycle hangs the accept path, which
        // is a denial of service on the whole service rather than a refusal of one client.
        var seen: Set<pid_t> = []
        var depth = 0
        while let pid = current, pid > 1, depth < maximumDepth {
            if !seen.insert(pid).inserted { break }
            if validator.validate(
                processIdentifier: pid, effectiveUserIdentifier: userIdentifier
            ).accepted {
                return .init(accepted: true, reason: "signed_bimax_ancestor")
            }
            current = parentLookup(pid)
            depth += 1
        }
        return .init(accepted: false, reason: "signed_bimax_ancestor_required")
    }
}

/// Connection counters, so a refusal storm or a leak is visible instead of silent.
public struct XPCConnectionLifecycleSnapshot: Equatable, Sendable {
    public var active: Int
    public var accepted: Int
    public var rejected: Int
    public var interrupted: Int
    public var invalidated: Int

    public init(
        active: Int = 0, accepted: Int = 0, rejected: Int = 0,
        interrupted: Int = 0, invalidated: Int = 0
    ) {
        self.active = active
        self.accepted = accepted
        self.rejected = rejected
        self.interrupted = interrupted
        self.invalidated = invalidated
    }
}

public final class XPCConnectionLifecycle: @unchecked Sendable {
    private let lock = NSLock()
    private var state = XPCConnectionLifecycleSnapshot()

    public init() {}

    public func didAccept() { lock.withLock { state.accepted += 1; state.active += 1 } }
    public func didReject() { lock.withLock { state.rejected += 1 } }
    /// Interruption is not termination — the peer crashed but the connection object survives, so
    /// `active` is decremented only on invalidation.
    public func didInterrupt() { lock.withLock { state.interrupted += 1 } }
    public func didInvalidate() {
        lock.withLock {
            state.invalidated += 1
            state.active = max(0, state.active - 1)
        }
    }
    public func snapshot() -> XPCConnectionLifecycleSnapshot { lock.withLock { state } }
}

/// The exported XPC interface.
///
/// Two methods, both Data-shaped: the protocol envelope, and the separate binary image channel
/// (image bytes never ride the JSON envelope).
@objc public protocol BimaxCuXPCServicing {
    func exchange(_ request: Data, reply: @escaping (Data) -> Void)
    func readImage(_ request: Data, reply: @escaping (Data?, Data?) -> Void)
}

/// Hosts one `BimaxCuServiceCore` for the lifetime of the service process.
///
/// The core is shared across connections deliberately: sessions, retained AX authorities and image
/// handles are per-session state that must survive a client reconnect within the same session, and
/// a core per connection would silently reset them.
public final class BimaxCuXPCService: NSObject, BimaxCuXPCServicing {
    private let core: BimaxCuServiceCore

    public init(core: BimaxCuServiceCore = BimaxCuServiceCore()) {
        self.core = core
        super.init()
    }

    public func exchange(_ request: Data, reply: @escaping (Data) -> Void) {
        // `handle(data:)` turns every fault into an error envelope, so a malformed or hostile
        // request produces a reply rather than a crash. Never let an error escape: an XPC method
        // that fails to call its reply block hangs the client until it times out, which reads as
        // the service being dead rather than the request being bad.
        reply(core.handle(data: request))
    }

    public func readImage(_ request: Data, reply: @escaping (Data?, Data?) -> Void) {
        do {
            let decoded = try JSONDecoder().decode(ImageHandleReadRequest.self, from: request)
            let result = core.readImage(decoded)
            if let failure = result.error {
                // The error rides the second argument rather than an empty first one, so "no
                // bytes" and "failed" cannot be confused by the client.
                reply(nil, try? JSONEncoder().encode(failure))
            } else {
                reply(result.bytes, nil)
            }
        } catch {
            reply(nil, Data(String(describing: error).utf8))
        }
    }
}

/// Accepts connections, installs the code-signing requirement, and records lifecycle events.
///
/// From macOS 13 the requirement is evaluated against the connection's immutable audit token, which
/// is why the product floor is 13.0 — below it `NSXPCConnection` falls back to a PID-based check
/// defeatable by pid reuse.
public final class BimaxCuXPCServiceDelegate: NSObject, NSXPCListenerDelegate {
    private let exportedObject: BimaxCuXPCService
    private let identityValidator: any XPCClientIdentityValidating
    private let ancestorAuthorizer: BimaxSignedAncestorAuthorizer?
    private let lifecycle: XPCConnectionLifecycle

    /// Admits only a caller signed as the Bimax app.
    public static let defaultRequirement = "identifier \"ai.bimax.app\" and anchor apple generic"

    public init(
        exportedObject: BimaxCuXPCService,
        identityValidator: any XPCClientIdentityValidating
            = CodeSigningXPCClientValidator(requirement: BimaxCuXPCServiceDelegate.defaultRequirement),
        lifecycle: XPCConnectionLifecycle = XPCConnectionLifecycle(),
        ancestorAuthorizer: BimaxSignedAncestorAuthorizer? = nil
    ) {
        self.exportedObject = exportedObject
        self.identityValidator = identityValidator
        self.lifecycle = lifecycle
        self.ancestorAuthorizer = ancestorAuthorizer
        super.init()
    }

    public func listener(
        _ listener: NSXPCListener,
        shouldAcceptNewConnection connection: NSXPCConnection
    ) -> Bool {
        guard identityValidator.validate(
            processIdentifier: connection.processIdentifier,
            effectiveUserIdentifier: connection.effectiveUserIdentifier
        ).accepted else {
            lifecycle.didReject()
            return false
        }
        if let ancestorAuthorizer {
            let ancestry = ancestorAuthorizer.authorize(
                parentPID: connection.processIdentifier,
                userIdentifier: connection.effectiveUserIdentifier
            )
            guard ancestry.accepted else {
                lifecycle.didReject()
                return false
            }
        }
        if let requirement = identityValidator.kernelCodeSigningRequirement {
            // Belt and braces: the check above reads the audit token ourselves, this makes the
            // kernel enforce it for the connection's whole life.
            if #available(macOS 13.0, *) { connection.setCodeSigningRequirement(requirement) }
        }

        let interface = NSXPCInterface(with: BimaxCuXPCServicing.self)
        // Data is not allowlisted for reply arguments by default, and an un-allowlisted class is
        // DROPPED rather than refused — the client would receive an empty reply and read it as a
        // protocol violation instead of a configuration mistake.
        let allowed = NSSet(array: [NSData.self]) as! Set<AnyHashable>
        interface.setClasses(
            allowed, for: #selector(BimaxCuXPCServicing.exchange(_:reply:)),
            argumentIndex: 0, ofReply: true
        )
        interface.setClasses(
            allowed, for: #selector(BimaxCuXPCServicing.readImage(_:reply:)),
            argumentIndex: 0, ofReply: true
        )
        interface.setClasses(
            allowed, for: #selector(BimaxCuXPCServicing.readImage(_:reply:)),
            argumentIndex: 1, ofReply: true
        )
        connection.exportedInterface = interface
        connection.exportedObject = exportedObject
        connection.interruptionHandler = { [lifecycle] in lifecycle.didInterrupt() }
        connection.invalidationHandler = { [lifecycle] in lifecycle.didInvalidate() }
        connection.resume()
        lifecycle.didAccept()
        return true
    }
}

public enum BimaxCuXPCClientError: Error, Equatable, Sendable {
    case transport(String)
    case malformedResponse
    case imageUnavailable(String)
}

/// Synchronous client for the Data-only interface.
///
/// Synchronous on purpose: the host runs strictly one exchange at a time, and an async client would
/// invite concurrent requests the service's session model does not support.
public final class BimaxCuXPCClient: @unchecked Sendable {
    private let connection: NSXPCConnection
    private let timeout: TimeInterval

    public init(endpoint: NSXPCListenerEndpoint, timeout: TimeInterval = 30) {
        self.connection = NSXPCConnection(listenerEndpoint: endpoint)
        self.timeout = timeout
        configureConnection()
    }

    /// Production connection to the application-embedded service. `serviceName` is intentionally
    /// distinct from a Mach service: launchd resolves it from Bimax.app/Contents/XPCServices and
    /// starts the isolated service on demand.
    public init(serviceName: String, timeout: TimeInterval = 30) {
        self.connection = NSXPCConnection(serviceName: serviceName)
        self.timeout = timeout
        configureConnection()
    }

    private func configureConnection() {
        let interface = NSXPCInterface(with: BimaxCuXPCServicing.self)
        let allowed = NSSet(array: [NSData.self]) as! Set<AnyHashable>
        interface.setClasses(
            allowed, for: #selector(BimaxCuXPCServicing.exchange(_:reply:)),
            argumentIndex: 0, ofReply: true
        )
        interface.setClasses(
            allowed, for: #selector(BimaxCuXPCServicing.readImage(_:reply:)),
            argumentIndex: 0, ofReply: true
        )
        interface.setClasses(
            allowed, for: #selector(BimaxCuXPCServicing.readImage(_:reply:)),
            argumentIndex: 1, ofReply: true
        )
        connection.remoteObjectInterface = interface
        connection.resume()
    }

    deinit { connection.invalidate() }

    /// Tears the connection down explicitly. Relying on `deinit` leaves the peer's connection alive
    /// for however long the client object survives, which shows up as a leaked `active` count.
    public func close() { connection.invalidate() }

    public func request(_ envelope: RequestEnvelope) throws -> ResponseEnvelope {
        let data = try request(data: JSONEncoder().encode(envelope))
        return try JSONDecoder().decode(ResponseEnvelope.self, from: data)
    }

    /// Preserve the exact JSON envelope across the stdio/XPC boundary. The bridge has no business
    /// decoding and re-encoding an operation owned by the service protocol.
    public func request(data payload: Data) throws -> Data {
        let semaphore = DispatchSemaphore(value: 0)
        let box = XPCReplyBox<Data>()
        guard let proxy = connection.remoteObjectProxyWithErrorHandler({ error in
            box.fail(String(describing: error))
            semaphore.signal()
        }) as? BimaxCuXPCServicing else {
            throw BimaxCuXPCClientError.transport("remote proxy was unavailable")
        }
        proxy.exchange(payload) { data in
            box.succeed(data)
            semaphore.signal()
        }
        guard semaphore.wait(timeout: .now() + timeout) == .success else {
            throw BimaxCuXPCClientError.transport("timed out")
        }
        if let failure = box.failure { throw BimaxCuXPCClientError.transport(failure) }
        guard let data = box.value else { throw BimaxCuXPCClientError.malformedResponse }
        return data
    }

    public func readImage(_ read: ImageHandleReadRequest) throws -> Data {
        let payload = try JSONEncoder().encode(read)
        let semaphore = DispatchSemaphore(value: 0)
        let box = XPCReplyBox<Data>()
        guard let proxy = connection.remoteObjectProxyWithErrorHandler({ error in
            box.fail(String(describing: error))
            semaphore.signal()
        }) as? BimaxCuXPCServicing else {
            throw BimaxCuXPCClientError.transport("remote proxy was unavailable")
        }
        proxy.readImage(payload) { bytes, failure in
            if let failure { box.fail(String(decoding: failure, as: UTF8.self)) }
            else { box.succeed(bytes) }
            semaphore.signal()
        }
        guard semaphore.wait(timeout: .now() + timeout) == .success else {
            throw BimaxCuXPCClientError.transport("timed out")
        }
        if let failure = box.failure { throw BimaxCuXPCClientError.imageUnavailable(failure) }
        guard let data = box.value else { throw BimaxCuXPCClientError.malformedResponse }
        return data
    }
}

/// Carries a reply across the XPC callback boundary.
///
/// The semaphore orders the write before the read, but that ordering is not something the compiler
/// can prove or a future reader can see — the lock states it.
private final class XPCReplyBox<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value?
    private var error: String?

    func succeed(_ value: Value?) { lock.withLock { stored = value } }
    func fail(_ reason: String) { lock.withLock { error = reason } }
    var value: Value? { lock.withLock { stored } }
    var failure: String? { lock.withLock { error } }
}
