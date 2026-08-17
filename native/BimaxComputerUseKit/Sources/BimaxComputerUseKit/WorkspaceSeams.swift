import AppKit
import ApplicationServices
import Foundation
import UniformTypeIdentifiers
import BimaxCuProtocol

// RECONSTRUCTED 2026-08-17 — the injected seams behind `FileWorkspace` and `WindowOperations`.
//
// Shapes are pinned by `BimaxCuTests`' own doubles (`FakeFileServices`, `FakeWindowAccess`), which
// conform to these protocols — so their members are the declarations, verbatim.

// MARK: - File services

/// What the filesystem and Launch Services report about a path.
public struct FileAttributesRecord: Equatable, Sendable {
    public var isDirectory: Bool
    public var isSymbolicLink: Bool
    public var byteSize: Int64?
    public var modifiedAtMs: Int64?

    public init(
        isDirectory: Bool,
        isSymbolicLink: Bool,
        byteSize: Int64? = nil,
        modifiedAtMs: Int64? = nil
    ) {
        self.isDirectory = isDirectory
        self.isSymbolicLink = isSymbolicLink
        self.byteSize = byteSize
        self.modifiedAtMs = modifiedAtMs
    }
}

/// Every filesystem and Launch Services effect `FileWorkspace` can have.
///
/// It exists so the refusal policy is testable without a scratch directory: the policy is the part
/// that must never regress, and a test that has to create real files to check it will eventually be
/// weakened rather than fixed.
public protocol FileServicesProviding: Sendable {
    func attributes(_ path: String) -> FileAttributesRecord?
    func contentType(_ path: String) -> (identifier: String?, description: String?)
    func isPackage(_ path: String) -> Bool
    func defaultApplicationPath(for path: String) -> String?
    func frontmostPid() -> Int32?
    func open(path: String, withApplicationAt bundle: URL?, timeoutMs: Int) throws -> AppRef?
    func reveal(path: String) -> Bool
    func trash(path: String) throws -> String?
    func duplicate(path: String) throws -> String?
    func openURL(_ url: URL, withApplicationAt bundle: URL?, timeoutMs: Int) throws -> AppRef?
}

/// The real filesystem and Launch Services.
public struct SystemFileServices: FileServicesProviding {
    public init() {}

    public func attributes(_ path: String) -> FileAttributesRecord? {
        let url = URL(fileURLWithPath: path)
        guard FileManager.default.fileExists(atPath: path),
              let values = try? url.resourceValues(forKeys: [
                  .isDirectoryKey, .isSymbolicLinkKey, .fileSizeKey, .contentModificationDateKey,
              ]) else { return nil }
        return FileAttributesRecord(
            isDirectory: values.isDirectory ?? false,
            isSymbolicLink: values.isSymbolicLink ?? false,
            byteSize: values.fileSize.map(Int64.init),
            modifiedAtMs: values.contentModificationDate.map { Int64($0.timeIntervalSince1970 * 1_000) }
        )
    }

    public func contentType(_ path: String) -> (identifier: String?, description: String?) {
        guard let type = try? URL(fileURLWithPath: path)
            .resourceValues(forKeys: [.contentTypeKey]).contentType else { return (nil, nil) }
        return (type.identifier, type.localizedDescription)
    }

    public func isPackage(_ path: String) -> Bool {
        (try? URL(fileURLWithPath: path)
            .resourceValues(forKeys: [.isPackageKey]).isPackage) ?? false ?? false
    }

    public func defaultApplicationPath(for path: String) -> String? {
        NSWorkspace.shared.urlForApplication(toOpen: URL(fileURLWithPath: path))?.path
    }

    public func frontmostPid() -> Int32? { WorkspaceInventory.frontmostPid() }

    public func open(path: String, withApplicationAt bundle: URL?, timeoutMs: Int) throws -> AppRef? {
        let url = URL(fileURLWithPath: path)
        guard let bundle else {
            guard NSWorkspace.shared.open(url) else {
                throw FileWorkspaceError.operationFailed("the file could not be opened")
            }
            return nil
        }
        return try Self.wait(timeoutMs: timeoutMs) { completion in
            NSWorkspace.shared.open(
                [url], withApplicationAt: bundle, configuration: NSWorkspace.OpenConfiguration(),
                completionHandler: completion
            )
        }
    }

    public func reveal(path: String) -> Bool {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
        return true
    }

    public func trash(path: String) throws -> String? {
        var trashed: NSURL?
        do {
            try FileManager.default.trashItem(at: URL(fileURLWithPath: path), resultingItemURL: &trashed)
        } catch {
            throw FileWorkspaceError.operationFailed(error.localizedDescription)
        }
        return (trashed as URL?)?.path
    }

    public func duplicate(path: String) throws -> String? {
        let url = URL(fileURLWithPath: path)
        let destination = Self.duplicateDestination(for: url)
        do {
            try FileManager.default.copyItem(at: url, to: destination)
        } catch {
            throw FileWorkspaceError.operationFailed(error.localizedDescription)
        }
        return destination.path
    }

    public func openURL(_ url: URL, withApplicationAt bundle: URL?, timeoutMs: Int) throws -> AppRef? {
        guard let bundle else {
            guard NSWorkspace.shared.open(url) else {
                throw FileWorkspaceError.operationFailed("the url could not be opened")
            }
            return nil
        }
        return try Self.wait(timeoutMs: timeoutMs) { completion in
            NSWorkspace.shared.open(
                [url], withApplicationAt: bundle, configuration: NSWorkspace.OpenConfiguration(),
                completionHandler: completion
            )
        }
    }

    /// Runs an async Launch Services open and reports what it actually launched.
    private static func wait(
        timeoutMs: Int,
        _ body: (@escaping @Sendable (NSRunningApplication?, Error?) -> Void) -> Void
    ) throws -> AppRef? {
        let semaphore = DispatchSemaphore(value: 0)
        let box = OpenResultBox()
        body { app, error in
            box.set(app: app, error: error)
            semaphore.signal()
        }
        guard semaphore.wait(timeout: .now() + .milliseconds(max(timeoutMs, 1))) == .success else {
            throw FileWorkspaceError.operationFailed("the open request did not complete in time")
        }
        if let failure = box.error { throw FileWorkspaceError.operationFailed(failure) }
        guard let pid = box.pid else { return nil }
        return AppRef(
            bundleId: box.bundleId, pid: pid,
            launchId: "\(pid):1", displayName: box.displayName
        )
    }

    /// Never overwrite: pick the first free " copy"/" copy N" name, the way Finder does.
    private static func duplicateDestination(for url: URL) -> URL {
        let directory = url.deletingLastPathComponent()
        let base = url.deletingPathExtension().lastPathComponent
        let ext = url.pathExtension
        for suffix in 0...999 {
            let name = suffix == 0 ? "\(base) copy" : "\(base) copy \(suffix + 1)"
            let candidate = ext.isEmpty
                ? directory.appendingPathComponent(name)
                : directory.appendingPathComponent(name).appendingPathExtension(ext)
            if !FileManager.default.fileExists(atPath: candidate.path) { return candidate }
        }
        return directory.appendingPathComponent("\(base) copy \(UUID().uuidString)")
    }
}

/// Carries a Launch Services completion across the wait. Explicitly locked for the reason given on
/// the other reply boxes in this module: the ordering is real but not provable.
private final class OpenResultBox: @unchecked Sendable {
    private let lock = NSLock()
    private var storedPid: Int32?
    private var storedBundleId: String?
    private var storedName: String?
    private var storedError: String?

    func set(app: NSRunningApplication?, error: Error?) {
        lock.withLock {
            storedPid = app?.processIdentifier
            storedBundleId = app?.bundleIdentifier
            storedName = app?.localizedName
            storedError = error.map { String(describing: $0) }
        }
    }
    var pid: Int32? { lock.withLock { storedPid } }
    var bundleId: String? { lock.withLock { storedBundleId } }
    var displayName: String? { lock.withLock { storedName } }
    var error: String? { lock.withLock { storedError } }
}

// MARK: - Window element access

/// The AX reads and writes `WindowOperations` performs, behind a seam so the honoring rules can be
/// tested against an application that lies — which real ones do.
public protocol WindowElementAccessing: Sendable {
    func bounds(pid: Int32, windowId: UInt32) throws -> CuRect
    func flag(pid: Int32, windowId: UInt32, attribute: String) throws -> Bool
    func setFrame(
        pid: Int32, windowId: UInt32, frame: CuRect, moveOnly: Bool, resizeOnly: Bool
    ) throws
    func setFlag(pid: Int32, windowId: UInt32, attribute: String, value: Bool) throws
    func pressWindowButton(pid: Int32, windowId: UInt32, attribute: String) throws
}

/// Live accessibility access to a window.
public struct AXWindowElementAccess: WindowElementAccessing {
    public init() {}

    private func element(pid: Int32, windowId: UInt32) throws -> AXUIElement {
        guard AXIsProcessTrusted() else {
            throw WindowOperationError.attributeUnavailable("accessibility is not trusted")
        }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 2.0)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success,
              let windows = value as? [AXUIElement] else {
            throw WindowOperationError.windowNotFound
        }
        for candidate in windows {
            var identifier = CGWindowID(0)
            if _AXUIElementGetWindow(candidate, &identifier) == .success, identifier == windowId {
                return candidate
            }
        }
        throw WindowOperationError.windowNotFound
    }

    public func bounds(pid: Int32, windowId: UInt32) throws -> CuRect {
        let window = try element(pid: pid, windowId: windowId)
        var positionValue: CFTypeRef?
        var sizeValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &positionValue) == .success,
              AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &sizeValue) == .success,
              let positionValue, let sizeValue else {
            throw WindowOperationError.attributeUnavailable("window geometry")
        }
        var origin = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(positionValue as! AXValue, .cgPoint, &origin),
              AXValueGetValue(sizeValue as! AXValue, .cgSize, &size) else {
            throw WindowOperationError.attributeUnavailable("window geometry")
        }
        return CuRect(
            x: Double(origin.x), y: Double(origin.y),
            width: Double(size.width), height: Double(size.height)
        )
    }

    public func flag(pid: Int32, windowId: UInt32, attribute: String) throws -> Bool {
        let window = try element(pid: pid, windowId: windowId)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(window, attribute as CFString, &value) == .success,
              let number = value as? NSNumber else {
            throw WindowOperationError.attributeUnavailable(attribute)
        }
        return number.boolValue
    }

    public func setFrame(
        pid: Int32, windowId: UInt32, frame: CuRect, moveOnly: Bool, resizeOnly: Bool
    ) throws {
        let window = try element(pid: pid, windowId: windowId)
        if !resizeOnly {
            var origin = CGPoint(x: frame.x, y: frame.y)
            guard let value = AXValueCreate(.cgPoint, &origin) else {
                throw WindowOperationError.writeFailed("position could not be encoded")
            }
            _ = AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, value)
        }
        if !moveOnly {
            var size = CGSize(width: frame.width, height: frame.height)
            guard let value = AXValueCreate(.cgSize, &size) else {
                throw WindowOperationError.writeFailed("size could not be encoded")
            }
            _ = AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, value)
        }
    }

    public func setFlag(pid: Int32, windowId: UInt32, attribute: String, value: Bool) throws {
        let window = try element(pid: pid, windowId: windowId)
        var settable: DarwinBoolean = false
        guard AXUIElementIsAttributeSettable(window, attribute as CFString, &settable) == .success,
              settable.boolValue else {
            throw WindowOperationError.attributeUnavailable(attribute)
        }
        _ = AXUIElementSetAttributeValue(window, attribute as CFString, value as CFBoolean)
    }

    public func pressWindowButton(pid: Int32, windowId: UInt32, attribute: String) throws {
        let window = try element(pid: pid, windowId: windowId)
        var button: CFTypeRef?
        guard AXUIElementCopyAttributeValue(window, attribute as CFString, &button) == .success,
              let button else {
            throw WindowOperationError.attributeUnavailable(attribute)
        }
        let result = AXUIElementPerformAction(button as! AXUIElement, kAXPressAction as CFString)
        // Same rule as the semantic engine: `cannotComplete` is not a failure, it is an unknown
        // outcome. The caller re-reads state to decide, so it must not be told the press failed.
        guard result == .success || result == .cannotComplete else {
            throw WindowOperationError.writeFailed("the window button refused the press")
        }
    }
}
