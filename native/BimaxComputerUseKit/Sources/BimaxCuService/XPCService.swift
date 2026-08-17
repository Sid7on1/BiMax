import Foundation
import BimaxComputerUseKit

// RECONSTRUCTED 2026-08-17 — the XPC listener plumbing the eviction took with it.
//
// The contract is pinned from three surviving places: `main.swift` constructs
// `BimaxCuXPCService()` and `BimaxCuXPCServiceDelegate(exportedObject:)` and resumes an
// `NSXPCListener.service()`; `BimaxCuBridge/main.swift` documents the peer as "the same core the
// XPC service hosts" and drives it through `core.handle(data:) -> Data`; and electron-builder.yml
// describes the bridge as "the Data-only XPC client". So the exported interface is one Data in,
// one Data out — the envelope is already JSON, and keeping the interface Data-shaped means the XPC
// boundary never has to agree with the peer about Swift types.

/// The exported XPC interface.
///
/// Deliberately a single method taking and returning `Data`. Every request/response is a protocol
/// envelope, so the interface needs no class allowlist beyond `NSData` — a narrower attack surface
/// than exposing typed objects, and one that cannot drift out of sync with the wire protocol.
@objc public protocol BimaxCuXPCServicing {
    func exchange(_ request: Data, reply: @escaping (Data) -> Void)
}

/// Hosts one `BimaxCuServiceCore` for the lifetime of the service process.
///
/// The core is shared across connections on purpose: sessions, retained AX authorities and image
/// handles are per-session state that must survive a client reconnect within the same session, and
/// creating a core per connection would silently reset them.
public final class BimaxCuXPCService: NSObject, BimaxCuXPCServicing {
    private let core: BimaxCuServiceCore

    public init(core: BimaxCuServiceCore = BimaxCuServiceCore()) {
        self.core = core
        super.init()
    }

    public func exchange(_ request: Data, reply: @escaping (Data) -> Void) {
        // `handle(data:)` already turns every fault into an error envelope, so a malformed or
        // hostile request produces a reply rather than a crash. Never let an error escape here:
        // an XPC method that fails to call its reply block hangs the client until it times out,
        // which reads to the caller as the service being dead rather than the request being bad.
        reply(core.handle(data: request))
    }
}

/// Accepts connections and installs the code-signing requirement.
///
/// From macOS 13 the requirement is evaluated against the connection's immutable audit token, which
/// is why the product's support floor is 13.0 — below it `NSXPCConnection` falls back to a
/// PID-based check that is defeatable by pid reuse. On an older system the listener refuses rather
/// than accepting under the weaker check: a service that silently downgrades its caller
/// verification is worse than one that is unavailable.
public final class BimaxCuXPCServiceDelegate: NSObject, NSXPCListenerDelegate {
    private let exportedObject: BimaxCuXPCService
    private let requirement: String?

    /// The default requirement admits only a caller signed as the Bimax app. It is applied when the
    /// platform supports audit-token evaluation; `nil` disables the check and exists solely for
    /// local development against an unsigned build.
    public static let defaultRequirement = "identifier \"ai.bimax.app\""

    public init(
        exportedObject: BimaxCuXPCService,
        requirement: String? = BimaxCuXPCServiceDelegate.defaultRequirement
    ) {
        self.exportedObject = exportedObject
        self.requirement = requirement
        super.init()
    }

    public func listener(
        _ listener: NSXPCListener,
        shouldAcceptNewConnection connection: NSXPCConnection
    ) -> Bool {
        if let requirement {
            guard #available(macOS 13.0, *) else { return false }
            connection.setCodeSigningRequirement(requirement)
        }
        let interface = NSXPCInterface(with: BimaxCuXPCServicing.self)
        // Data is not in the default allowlist for a reply argument, and an un-allowlisted class is
        // dropped rather than refused — the client would receive an empty reply and read it as a
        // protocol violation instead of a configuration mistake.
        interface.setClasses(
            NSSet(array: [NSData.self]) as! Set<AnyHashable>,
            for: #selector(BimaxCuXPCServicing.exchange(_:reply:)),
            argumentIndex: 0,
            ofReply: true
        )
        connection.exportedInterface = interface
        connection.exportedObject = exportedObject
        connection.resume()
        return true
    }
}
