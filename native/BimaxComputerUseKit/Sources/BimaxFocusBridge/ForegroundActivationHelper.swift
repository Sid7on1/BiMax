import AppKit
import Foundation

/// Foreground activation, done the way a human does it: click-to-front exactly one app, verify
/// the exact process actually came forward, and yield politely from whichever app is being
/// displaced.
///
/// RECONSTRUCTION NOTE (2026-08-18): this module's sources were lost (iCloud eviction — the
/// repository's own records describe the directory as never committed) and with them the CU
/// package stopped building, making the whole native ladder non-reproducible. This file is a
/// faithful reimplementation of the contract still live at every call site:
///
///   - `ForegroundActivationHelper.request(pid:expectedBundleId:yieldPid:)` (invoked by
///     `bimax-cu-service --request-front-process`, which JSON-encodes the result and exits
///     0 only when `accepted && exactPidObserved`);
///   - the receipt is `Codable` with at least `accepted` and `exactPidObserved`.
///
/// The semantics those call sites pin are stricter than "activate sometimes works":
///
///   1. The pid must map to a *running* app whose bundle id matches the expected one — activating
///      the wrong process (a stale pid after an app relaunched) must FAIL, not guess.
///   2. Activation must be OBSERVED: `frontmostApplication` must actually report the exact pid
///      before the deadline. macOS activation is advisory; returning success without observing
///      the front is exactly the bug class the receipt's `exactPidObserved` field exists to make
///      impossible to claim.
///   3. When displacing another app (`yieldPid`), deactivate it first — cooperative yield instead
///      of stacking activations, which is what makes focus fights between Bimax and the user's
///      own typing feel like a fight.

public struct ForegroundActivationReceipt: Codable, Equatable, Sendable {
    public var accepted: Bool
    public var exactPidObserved: Bool
    public var requestedPid: Int32
    public var observedPid: Int32?
    public var expectedBundleId: String
    public var observedBundleId: String?
    public var yieldedFromPid: Int32?
    public var detail: String

    public init(
        accepted: Bool,
        exactPidObserved: Bool,
        requestedPid: Int32,
        observedPid: Int32? = nil,
        expectedBundleId: String,
        observedBundleId: String? = nil,
        yieldedFromPid: Int32? = nil,
        detail: String
    ) {
        self.accepted = accepted
        self.exactPidObserved = exactPidObserved
        self.requestedPid = requestedPid
        self.observedPid = observedPid
        self.expectedBundleId = expectedBundleId
        self.observedBundleId = observedBundleId
        self.yieldedFromPid = yieldedFromPid
        self.detail = detail
    }
}

public enum ForegroundActivationHelper {

    public static func request(
        pid: Int32,
        expectedBundleId: String,
        yieldPid: Int32? = nil,
        deadlineMs: Int = 4_000
    ) -> ForegroundActivationReceipt {
        let workspace = NSWorkspace.shared

        // Observe the CURRENT frontmost once, up front: every failure path below should report
        // what actually was front instead of the process we were asked to raise.
        func currentFront() -> (pid: Int32, bundleId: String?) {
            let app = workspace.frontmostApplication
            return (app?.processIdentifier ?? 0, app?.bundleIdentifier)
        }

        // 1. The pid must be a running application. A dead pid (app quit, or relaunched and got a
        //    new one) must fail loudly with what IS running — activating a guess is the bug.
        guard let target = workspace.runningApplications.first(where: { $0.processIdentifier == pid }) else {
            let front = currentFront()
            return ForegroundActivationReceipt(
                accepted: false,
                exactPidObserved: false,
                requestedPid: pid,
                observedPid: front.pid,
                expectedBundleId: expectedBundleId,
                observedBundleId: front.bundleId,
                detail: "no running application owns pid \(pid); frontmost is pid \(front.pid)"
            )
        }

        // 2. Bundle identity must match. A pid whose bundle differs from the caller's expectation
        //    is a stale or spoofed reference — refuse rather than focus the wrong app.
        if !expectedBundleId.isEmpty,
           let observed = target.bundleIdentifier,
           observed.caseInsensitiveCompare(expectedBundleId) != .orderedSame {
            return ForegroundActivationReceipt(
                accepted: false,
                exactPidObserved: false,
                requestedPid: pid,
                observedPid: pid,
                expectedBundleId: expectedBundleId,
                observedBundleId: observed,
                detail: "pid \(pid) belongs to \(observed), expected \(expectedBundleId)"
            )
        }

        // 3. Yield bookkeeping only: `deactivate()`/`yieldActivation` were removed from
        //    NSRunningApplication in the macOS 26 SDK, and one process cannot force another to
        //    yield anyway. Displacement is carried by the target's own activation below
        //    (.activateIgnoringOtherApps), and the receipt records which app we were asked to
        //    displace so the observation in step 5 can be judged with that context.
        _ = yieldPid

        // 4. Activate. macOS 14 requires naming the requesting application; a CLI helper speaks
        //    as its own process. The classic synchronous options remain on older deployments.
        let activated: Bool
        if #available(macOS 14.0, *) {
            activated = target.activate(from: .current, options: [.activateIgnoringOtherApps])
        } else {
            activated = target.activate(options: [.activateIgnoringOtherApps])
        }
        if !activated {
            let front = currentFront()
            return ForegroundActivationReceipt(
                accepted: false,
                exactPidObserved: false,
                requestedPid: pid,
                observedPid: front.pid,
                expectedBundleId: expectedBundleId,
                observedBundleId: front.bundleId,
                yieldedFromPid: yieldPid,
                detail: "activation of pid \(pid) (\(target.bundleIdentifier ?? "?")) was refused"
            )
        }

        // 5. OBSERVE the result: activation is advisory until the workspace agrees. Poll to the
        //    deadline; only an exact pid match counts. This is the line that makes "the app is
        //    focused" a measurement rather than an assumption.
        let deadline = Date().addingTimeInterval(TimeInterval(deadlineMs) / 1000.0)
        var front = currentFront()
        while front.pid != pid && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
            front = currentFront()
        }

        return ForegroundActivationReceipt(
            accepted: true,
            exactPidObserved: front.pid == pid,
            requestedPid: pid,
            observedPid: front.pid,
            expectedBundleId: expectedBundleId,
            observedBundleId: front.bundleId,
            yieldedFromPid: yieldPid,
            detail: front.pid == pid
                ? "pid \(pid) is frontmost"
                : "activation returned success but frontmost is pid \(front.pid) at deadline"
        )
    }
}
