import AppKit
import Foundation

/// RECONSTRUCTED 2026-08-18 — the workspace inventory the evicted files took with them.
///
/// `ServiceCore` holds `any WorkspaceInventoryProviding` and defaults it to `WorkspaceInventory()`;
/// `PhysicalInputArbiter` reads `frontmostPid()` to know WHERE physical input would land. The
/// protocol is the seam so tests can simulate focus; the concrete type is the truth source.

public protocol WorkspaceInventoryProviding: Sendable {
    /// The process that would receive keyboard input right now, or nil when the workspace
    /// reports none (no user session, or the frontmost process already exited).
    func frontmostPid() -> Int32?
    /// The frontmost application's bundle identifier, when it publishes one.
    func frontmostBundleIdentifier() -> String?
    /// Whether a pid currently maps to a running application.
    func isRunning(pid: Int32) -> Bool
}

public struct WorkspaceInventory: WorkspaceInventoryProviding {
    public init() {}

    /// Call sites that need the frontmost pid as a plain fact — `PhysicalInputArbiter`'s default
    /// `frontmost` closure and `AppWorkspace.frontmostPid()` — reach for this type-level form rather
    /// than constructing an inventory. The instance method exists to satisfy the protocol seam and
    /// delegates here, so there is exactly one implementation of "who has focus".
    public static func frontmostPid() -> Int32? {
        NSWorkspace.shared.frontmostApplication?.processIdentifier
    }

    public func frontmostPid() -> Int32? {
        Self.frontmostPid()
    }

    public func frontmostBundleIdentifier() -> String? {
        NSWorkspace.shared.frontmostApplication?.bundleIdentifier
    }

    public func isRunning(pid: Int32) -> Bool {
        NSWorkspace.shared.runningApplications.contains { $0.processIdentifier == pid }
    }
}
