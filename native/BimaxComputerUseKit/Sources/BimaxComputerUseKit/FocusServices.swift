import AppKit
import Foundation
import BimaxCuProtocol

// RECONSTRUCTED 2026-08-17 — the focus seam the eviction took with it.
//
// Shapes are pinned by `BimaxCuTests`: the suite's own `FakeFocusController` and
// `FakeActivationBroker` conform to these protocols, so their members ARE the declarations, and the
// brokered-controller assertions define the delegation rules exactly.

/// Who currently has focus. `pid` is nil when the workspace reports no frontmost application.
public struct FocusObservation: Equatable, Sendable {
    public var pid: Int32?
    public var bundleId: String?

    public init(pid: Int32?, bundleId: String?) {
        self.pid = pid
        self.bundleId = bundleId
    }
}

/// Reads and changes which application is frontmost.
///
/// `requestActivation` returns whether the request was ACCEPTED, not whether the target ended up in
/// front — an application may accept and still not come forward. Callers verify separately, which is
/// why `FocusLeaseManager` polls rather than trusting this return value.
public protocol FocusControlling: Sendable {
    func observeFrontmost() -> FocusObservation
    func requestActivation(pid: Int32) -> Bool
}

/// Asks an out-of-process broker to bring an application forward.
///
/// Takes the bundle id as well as the pid because the broker lives in a different process and cannot
/// trust a bare pid: the pid it is handed must match the identity it is told to activate.
public protocol FocusActivationBrokerRequesting: Sendable {
    func requestActivation(pid: Int32, bundleId: String) -> Bool
}

/// Production focus controller over AppKit.
public struct AppKitFocusController: FocusControlling {
    public init() {}

    public func observeFrontmost() -> FocusObservation {
        let app = NSWorkspace.shared.frontmostApplication
        return FocusObservation(pid: app?.processIdentifier, bundleId: app?.bundleIdentifier)
    }

    public func requestActivation(pid: Int32) -> Bool {
        guard let app = NSRunningApplication(processIdentifier: pid) else { return false }
        return app.activate(options: [])
    }
}

/// Routes activation through a desktop broker while still observing focus locally.
///
/// Three rules, each asserted by the suite:
/// - observation stays local (the broker is not asked who is in front);
/// - an unresolved pid never reaches the broker, because the broker's whole safety property is that
///   it activates a named identity rather than whatever process happens to hold a pid;
/// - a broker refusal is final and must NOT fall through to in-process AppKit activation, which
///   would silently bypass the very approval the broker exists to obtain.
public struct BrokeredFocusController: FocusControlling {
    private let local: any FocusControlling
    private let broker: any FocusActivationBrokerRequesting
    private let bundleIdForPid: @Sendable (Int32) -> String?

    public init(
        local: any FocusControlling,
        broker: any FocusActivationBrokerRequesting,
        bundleIdForPid: @escaping @Sendable (Int32) -> String?
    ) {
        self.local = local
        self.broker = broker
        self.bundleIdForPid = bundleIdForPid
    }

    public func observeFrontmost() -> FocusObservation { local.observeFrontmost() }

    public func requestActivation(pid: Int32) -> Bool {
        guard let bundleId = bundleIdForPid(pid) else { return false }
        return broker.requestActivation(pid: pid, bundleId: bundleId)
    }
}

/// HTTP broker over a loopback capability endpoint.
///
/// The initializer is failable and refuses two configurations outright, because both would turn a
/// local approval channel into a remote one:
/// - a non-loopback host: an activation capability that can be reached off-machine is a remote
///   control surface, whatever scheme it uses;
/// - a short capability token: the token IS the authorization, so a guessable one is equivalent to
///   no check at all. 64 characters is the length the suite pins.
public struct HTTPFocusActivationBroker: FocusActivationBrokerRequesting {
    public static let minimumTokenLength = 64

    private let endpoint: URL
    private let token: String
    private let timeout: TimeInterval

    public init?(endpoint: String, token: String, timeout: TimeInterval = 2) {
        guard let url = URL(string: endpoint), let host = url.host else { return nil }
        // Loopback only, and by literal address — a name can resolve anywhere, including off-box.
        guard host == "127.0.0.1" || host == "::1" || host == "localhost" else { return nil }
        guard url.scheme == "http" else { return nil }
        guard token.count >= Self.minimumTokenLength else { return nil }
        self.endpoint = url
        self.token = token
        self.timeout = timeout
    }

    public func requestActivation(pid: Int32, bundleId: String) -> Bool {
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = timeout
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(
            withJSONObject: ["pid": Int(pid), "bundleId": bundleId]
        )

        let semaphore = DispatchSemaphore(value: 0)
        let accepted = FocusBrokerReplyBox()
        URLSession.shared.dataTask(with: request) { _, response, _ in
            if let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
                accepted.set(true)
            }
            semaphore.signal()
        }.resume()
        // A broker that does not answer is a refusal, never an acceptance: failing open here would
        // grant foreground control precisely when the approval path is broken.
        guard semaphore.wait(timeout: .now() + timeout + 1) == .success else { return false }
        return accepted.value
    }
}

private final class FocusBrokerReplyBox: @unchecked Sendable {
    private let lock = NSLock()
    private var accepted = false
    func set(_ newValue: Bool) { lock.withLock { accepted = newValue } }
    var value: Bool { lock.withLock { accepted } }
}
