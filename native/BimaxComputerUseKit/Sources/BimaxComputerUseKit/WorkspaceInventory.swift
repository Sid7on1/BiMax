import AppKit
import Foundation
import BimaxCuProtocol

/// RECONSTRUCTED 2026-08-18 — the workspace inventory the evicted files took with them.
///
/// `ServiceCore` holds `any WorkspaceInventoryProviding` and defaults it to `WorkspaceInventory()`;
/// `PhysicalInputArbiter` reads `frontmostPid()` to know WHERE physical input would land. The
/// protocol is the seam so tests can simulate focus; the concrete type is the truth source.

public protocol WorkspaceInventoryProviding: Sendable {
    /// The windows, apps and displays as they are right now.
    ///
    /// MUST be declared here rather than only in an extension. `ServiceCore` holds this as
    /// `any WorkspaceInventoryProviding`, and a method that exists only in a protocol extension is
    /// dispatched STATICALLY — the existential would call the extension's default and never reach
    /// `WorkspaceInventory`'s real implementation. That produced an empty window list, which every
    /// caller reported as `no_target_window` against a window that was plainly on screen.
    func snapshot(_ request: WorkspaceSnapshotRequest) throws -> WorkspaceSnapshot
}

/// The focus reads are extension members, not requirements: they have one correct implementation
/// (ask NSWorkspace) and no test has ever needed to vary them independently of `snapshot`. Making
/// them requirements would force every double to restate them.
public extension WorkspaceInventoryProviding {
    /// The process that would receive keyboard input right now, or nil when the workspace reports
    /// none (no user session, or the frontmost process already exited).
    func frontmostPid() -> Int32? { WorkspaceInventory.frontmostPid() }
    /// The frontmost application's bundle identifier, when it publishes one.
    func frontmostBundleIdentifier() -> String? {
        NSWorkspace.shared.frontmostApplication?.bundleIdentifier
    }
    /// Whether a pid currently maps to a running application.
    func isRunning(pid: Int32) -> Bool {
        NSWorkspace.shared.runningApplications.contains { $0.processIdentifier == pid }
    }
}

public struct WorkspaceInventory: WorkspaceInventoryProviding {
    public init() {}

    /// Converts an AppKit rect (bottom-left origin, y growing upward, relative to the zero screen)
    /// into the top-left global space every other coordinate in this service uses.
    ///
    /// The flip is around the ZERO screen's height, not the rect's own — that is what keeps a second
    /// display above the primary at a negative y instead of folding it onto the primary. Screens
    /// below or to the right keep their offsets for the same reason.
    public static func flipToGlobalTopLeft(
        visibleFrame: CGRect,
        zeroScreenFrame: CGRect
    ) -> CuRect {
        CuRect(
            x: Double(visibleFrame.origin.x),
            y: Double(zeroScreenFrame.height - (visibleFrame.origin.y + visibleFrame.height)),
            width: Double(visibleFrame.width),
            height: Double(visibleFrame.height)
        )
    }

    /// Call sites that need the frontmost pid as a plain fact — `PhysicalInputArbiter`'s default
    /// `frontmost` closure and `AppWorkspace.frontmostPid()` — reach for this type-level form rather
    /// than constructing an inventory. The instance method exists to satisfy the protocol seam and
    /// delegates here, so there is exactly one implementation of "who has focus".
    public static func frontmostPid() -> Int32? {
        NSWorkspace.shared.frontmostApplication?.processIdentifier
    }

}
