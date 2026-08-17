import ApplicationServices
import CoreGraphics
import Foundation
import BimaxCuProtocol

// The two-stage batch traversal and role-policy behavior are translated from MacOS-Use
// (Copyright 2025 CursorTouch, MIT). See /THIRD_PARTY_NOTICES.md. Bimax adds bounded iterative
// traversal, typed session snapshots, XPC isolation, revisions, privacy caps, and fail-closed TCC.

public enum AXObservationError: Error, Equatable {
    case permissionDenied
    case invalidPid
    case windowNotFound
    case timedOut
    case unsupportedProfile
}

public protocol AXObserving: Sendable {
    func observe(sessionId: String, request: AXObserveRequest) throws -> AXSnapshot
    func reset(sessionId: String)
}

/// Bounded, iterative Accessibility traversal with two batched reads per emitted element.
public final class AccessibilityEngine: AXObserving, @unchecked Sendable {
    private struct Pending {
        var element: AXUIElement
        var path: String
        var parentToken: String?
        var parentStablePathHash: String?
    }

    private struct Early {
        var role: String
        var hidden: Bool
        var enabled: Bool
        var focused: Bool
        var help: String?
        var hasPopup: Bool
        var bounds: CuRect?
        var children: [AXUIElement]
        /// Some controls publish their visible name through a sibling accessibility element.
        /// The reference is read only for label enrichment; action authority stays on `element`.
        var titleUIElement: AXUIElement?
    }

    private struct IssueKey: Hashable {
        var code: AXObservationIssueCode
        var stage: String
    }

    private struct Diagnostics {
        var counts: [IssueKey: Int] = [:]

        mutating func record(_ error: AXError, stage: String) {
            let code: AXObservationIssueCode = error == .cannotComplete ? .axTimeout : .axReadFailed
            counts[IssueKey(code: code, stage: stage), default: 0] += 1
        }

        mutating func recordBudget() {
            counts[IssueKey(code: .captureBudgetExceeded, stage: "traversal")] = 1
        }

        var issues: [AXObservationIssue] {
            counts.map { AXObservationIssue(code: $0.key.code, stage: $0.key.stage, count: $0.value) }
                .sorted {
                    $0.code.rawValue == $1.code.rawValue
                        ? $0.stage < $1.stage
                        : $0.code.rawValue < $1.code.rawValue
                }
        }
    }

    private let lock = NSLock()
    private var revisions: [String: UInt64] = [:]

    private static let interactiveRoles: Set<String> = [
        "AXButton", "AXCheckBox", "AXRadioButton", "AXTextField", "AXTextArea", "AXSearchField",
        "AXComboBox", "AXPopUpButton", "AXSlider", "AXIncrementor", "AXLink", "AXMenuItem",
        "AXMenuButton", "AXMenuBarItem", "AXTab", "AXDockItem", "AXCell", "AXToggle", "AXSwitch",
        "AXDisclosureTriangle", "AXColorWell",
    ]
    /// Container roles that are themselves action targets: they carry the page-scroll actions, and
    /// their rows are the addressable units for selection and scroll-to-visible. Without these an
    /// element can advertise `AXScrollDownByPage` and still be unreachable, because only emitted
    /// nodes receive an `ElementRef`. This is a macOS-universal AX role set, not a per-app table.
    private static let containerRoles: Set<String> = [
        "AXScrollArea", "AXOutline", "AXTable", "AXList", "AXBrowser", "AXWebArea", "AXRow",
    ]
    private static let prunableRoles: Set<String> = [
        "AXScrollBar", "AXGrowArea", "AXUnknown", "AXValueIndicator", "AXLevelIndicator",
        "AXProgressIndicator", "AXSeparator", "AXSplitter", "AXHandle", "AXRuler",
        "AXRulerMarker", "AXBusyIndicator", "AXRelevanceIndicator", "AXSizeHandle", "AXResizeIndicator",
    ]
    private static let earlyAttributes: [String] = [
        kAXRoleAttribute, kAXHiddenAttribute, kAXEnabledAttribute, kAXFocusedAttribute,
        kAXHelpAttribute, "AXHasPopup", kAXPositionAttribute, kAXSizeAttribute, kAXChildrenAttribute,
        kAXTitleUIElementAttribute,
    ]
    private static let lateAttributes: [String] = [
        kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, "AXIdentifier",
        kAXValueAttribute, kAXPlaceholderValueAttribute, kAXSelectedAttribute, kAXExpandedAttribute,
    ]
    /// Settability is probed only for the attributes Bimax-Cu can actually act on. Enumerating
    /// every attribute name would multiply AX round trips for capabilities nothing consumes.
    static let settableCandidates: [String] = [
        kAXValueAttribute, kAXSelectedTextRangeAttribute, kAXSelectedAttribute, kAXExpandedAttribute,
    ]
    static let textPatternRoles: Set<String> = [
        "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox",
    ]
    private static let togglePatternRoles: Set<String> = ["AXCheckBox", "AXToggle", "AXSwitch"]
    private static let scrollPageActions: Set<String> = [
        "AXScrollUpByPage", "AXScrollDownByPage", "AXScrollLeftByPage", "AXScrollRightByPage",
    ]

    public init() {}

    public func reset(sessionId: String) { lock.withLock { _ = revisions.removeValue(forKey: sessionId) } }

    public func observe(sessionId: String, request: AXObserveRequest) throws -> AXSnapshot {
        guard AXIsProcessTrusted() else { throw AXObservationError.permissionDenied }
        guard request.pid > 0 else { throw AXObservationError.invalidPid }
        guard request.profile == "flash" || request.profile == "balanced" else { throw AXObservationError.unsupportedProfile }
        let maxElements = min(max(1, request.maxElements), 2_000)
        let startedNanos = DispatchTime.now().uptimeNanoseconds
        let budgetNanos = UInt64(max(1, request.maxDurationMs)) * 1_000_000
        let budgetExceeded = {
            DispatchTime.now().uptimeNanoseconds - startedNanos >= budgetNanos
        }
        let app = AXUIElementCreateApplication(request.pid)
        AXUIElementSetMessagingTimeout(app, 0.5)
        let revision = lock.withLock { () -> UInt64 in
            let next = (revisions[sessionId] ?? 0) + 1
            revisions[sessionId] = next
            return next
        }
        let snapshotId = UUID().uuidString.lowercased()
        let root: AXUIElement
        do {
            root = try Self.resolveRoot(app: app, request: request)
        } catch AXObservationError.timedOut {
            return AXSnapshot(
                snapshotId: snapshotId,
                sessionId: sessionId,
                pid: request.pid,
                windowId: request.windowId,
                windowGeneration: request.windowGeneration,
                revision: revision,
                capturedAtMs: Int64(Date().timeIntervalSince1970 * 1_000),
                profile: request.profile,
                scope: request.scope,
                nodes: [],
                visitedCount: 0,
                truncated: true,
                partial: true,
                issues: [.init(code: .axTimeout, stage: "root_resolution")],
                query: request.query
            )
        }
        let clippingBounds: CuRect?
        if request.scope == .window {
            guard let bounds = Self.frame(root) else { throw AXObservationError.windowNotFound }
            clippingBounds = bounds
        } else {
            clippingBounds = nil
        }
        var stack = [Pending(element: root, path: "0", parentToken: nil, parentStablePathHash: nil)]
        var seen: [CFHashCode: [AXUIElement]] = [:]
        var nodes: [AXNode] = []
        var visited = 0
        var truncated = false
        var clippedNodeCount = 0
        var diagnostics = Diagnostics()

        while let pending = stack.popLast() {
            if budgetExceeded() {
                diagnostics.recordBudget()
                truncated = true
                break
            }
            let identity = CFHash(pending.element)
            if seen[identity, default: []].contains(where: { CFEqual($0, pending.element) }) { continue }
            seen[identity, default: []].append(pending.element)
            visited += 1
            if visited > maxElements * 12 { truncated = true; break }
            guard let early = Self.readEarly(pending.element, diagnostics: &diagnostics), !early.hidden,
                  !Self.prunableRoles.contains(early.role) else { continue }

            var emittedBounds = early.bounds
            if let clippingBounds, let elementBounds = early.bounds {
                guard let clipped = Self.intersection(elementBounds, clippingBounds),
                      clipped.width > 1, clipped.height > 1 else {
                    clippedNodeCount += 1
                    continue
                }
                emittedBounds = clipped
            }
            let visible = emittedBounds.map { $0.width > 1 && $0.height > 1 } ?? false
            let candidate = (Self.interactiveRoles.contains(early.role) && early.enabled)
                || (Self.containerRoles.contains(early.role) && early.enabled)
                || early.help != nil || early.hasPopup
                || early.titleUIElement != nil
                || (request.profile == "balanced" && early.role == "AXStaticText")
            let shouldEmit = candidate && visible
            let stablePathHash = Self.stableHash(pending.path)
            let token = UUID().uuidString.lowercased()
            var childParent = pending.parentToken
            var childParentStablePathHash = pending.parentStablePathHash

            if shouldEmit {
                if budgetExceeded() {
                    diagnostics.recordBudget()
                    truncated = true
                    break
                }
                let late = Self.readLate(pending.element, diagnostics: &diagnostics)
                if budgetExceeded() {
                    diagnostics.recordBudget()
                    truncated = true
                    break
                }
                let actions = Self.actions(pending.element, diagnostics: &diagnostics)
                let ownLabel = Self.firstNonEmpty(late[1], late[2], late[4])
                let titleUIElementText = ownLabel == nil ? early.titleUIElement.flatMap {
                    Self.titleUIElementText($0, diagnostics: &diagnostics)
                } : nil
                // Prefer the control's own human-readable fields. A referenced title is still a
                // better name than an implementation identifier or help text, but it never
                // replaces a real title/value/description published by the target itself.
                let baseLabel = Self.preferredLabel(
                    title: late[1], description: late[2], value: late[4],
                    titleUIElementText: titleUIElementText,
                    identifier: late[3], help: early.help
                )
                let label = Self.correctedLabel(
                    role: early.role,
                    subrole: late[0],
                    base: baseLabel,
                    children: early.children
                )
                let value = Self.bounded(late[4])
                let identifier = late[3]
                // A query filters what is emitted, never what is traversed or authorized.
                let matched = request.query.map {
                    Self.matchesQuery($0, role: early.role, label: label, value: value, identifier: identifier)
                } ?? true
                if matched {
                    let settable = Self.settableAttributes(pending.element)
                    nodes.append(AXNode(
                        token: token,
                        parentToken: pending.parentToken,
                        role: early.role,
                        subrole: late[0],
                        label: label,
                        value: value,
                        identifier: identifier,
                        bounds: emittedBounds,
                        enabled: early.enabled,
                        focused: early.focused,
                        actions: actions,
                        childCount: early.children.count,
                        stablePathHash: stablePathHash,
                        parentStablePathHash: pending.parentStablePathHash,
                        elementRef: ElementRef(
                            token: token,
                            snapshotId: snapshotId,
                            pid: request.pid,
                            windowId: request.windowId,
                            windowGeneration: request.windowGeneration,
                            axRevision: revision,
                            stablePathHash: stablePathHash
                        ),
                        order: nodes.count,
                        selected: Self.parseBool(late[6]) ?? false,
                        settableAttributes: settable,
                        patterns: Self.patterns(
                            role: early.role,
                            actions: actions,
                            settable: settable,
                            expandable: late[7] != nil
                        )
                    ))
                    childParent = token
                    childParentStablePathHash = stablePathHash
                    if nodes.count >= maxElements { truncated = !early.children.isEmpty || !stack.isEmpty; break }
                }
            }

            for (index, child) in early.children.enumerated().reversed() {
                stack.append(Pending(
                    element: child,
                    path: "\(pending.path).\(index)",
                    parentToken: childParent,
                    parentStablePathHash: childParentStablePathHash
                ))
            }
        }
        if budgetExceeded() {
            diagnostics.recordBudget()
            truncated = true
        }
        return AXSnapshot(
            snapshotId: snapshotId,
            sessionId: sessionId,
            pid: request.pid,
            windowId: request.windowId,
            windowGeneration: request.windowGeneration,
            revision: revision,
            capturedAtMs: Int64(Date().timeIntervalSince1970 * 1_000),
            profile: request.profile,
            scope: request.scope,
            nodes: nodes,
            visitedCount: visited,
            truncated: truncated,
            partial: !diagnostics.issues.isEmpty,
            issues: diagnostics.issues,
            clippedNodeCount: clippedNodeCount,
            query: request.query
        )
    }

    /// Rewalks the current native tree from the same target root and resolves a snapshot path hash.
    /// The returned AXUIElement is short-lived and must never enter a store or cross XPC.
    func resolveLiveElement(ref: ElementRef, expected: AXNode, maxVisited: Int = 24_000) throws -> AXUIElement {
        guard AXIsProcessTrusted() else { throw AXSemanticActionError.permissionDenied }
        guard ref.pid > 0 else { throw AXSemanticActionError.liveElementNotFound }
        let app = AXUIElementCreateApplication(ref.pid)
        AXUIElementSetMessagingTimeout(app, 0.5)
        let root: AXUIElement
        do {
            root = try Self.resolveRoot(
                app: app,
                request: .init(
                    pid: ref.pid,
                    windowId: ref.windowId,
                    windowGeneration: ref.windowGeneration,
                    profile: "flash",
                    maxElements: 1
                )
            )
        } catch {
            throw AXSemanticActionError.liveElementNotFound
        }
        let clippingBounds = ref.windowId == nil ? nil : Self.frame(root)
        if ref.windowId != nil && clippingBounds == nil { throw AXSemanticActionError.liveElementNotFound }

        var stack = [Pending(element: root, path: "0", parentToken: nil, parentStablePathHash: nil)]
        var seen: [CFHashCode: [AXUIElement]] = [:]
        var visited = 0
        while let pending = stack.popLast() {
            visited += 1
            guard visited <= maxVisited else { throw AXSemanticActionError.liveTraversalLimit }
            let identity = CFHash(pending.element)
            if seen[identity, default: []].contains(where: { CFEqual($0, pending.element) }) { continue }
            seen[identity, default: []].append(pending.element)
            guard let early = Self.readEarly(pending.element), !early.hidden,
                  !Self.prunableRoles.contains(early.role) else { continue }
            var liveBounds = early.bounds
            if let clippingBounds, let elementBounds = early.bounds {
                guard let clipped = Self.intersection(elementBounds, clippingBounds),
                      clipped.width > 1, clipped.height > 1 else { continue }
                liveBounds = clipped
            }

            if Self.stableHash(pending.path) == ref.stablePathHash {
                guard early.role == expected.role, early.enabled else {
                    throw AXSemanticActionError.liveIdentityMismatch
                }
                let late = Self.readLate(pending.element)
                if let expectedSubrole = expected.subrole, late[0] != expectedSubrole {
                    throw AXSemanticActionError.liveIdentityMismatch
                }
                if let expectedIdentifier = expected.identifier, late[3] != expectedIdentifier {
                    throw AXSemanticActionError.liveIdentityMismatch
                }
                guard Self.compatibleBounds(expected.bounds, liveBounds) else {
                    throw AXSemanticActionError.liveIdentityMismatch
                }
                return pending.element
            }

            for (index, child) in early.children.enumerated().reversed() {
                stack.append(Pending(element: child, path: "\(pending.path).\(index)", parentToken: nil, parentStablePathHash: nil))
            }
        }
        throw AXSemanticActionError.liveElementNotFound
    }

    /// Exact-window resolution for callers outside observation — today, window mutation.
    ///
    /// Deliberately the same code path as an observation's root resolution: a window operation and
    /// an observation must never disagree about which window a `pid`/`windowId` pair means.
    public static func resolveWindowElement(pid: Int32, windowId: UInt32) throws -> AXUIElement {
        try resolveRoot(
            app: AXUIElementCreateApplication(pid),
            request: AXObserveRequest(pid: pid, windowId: windowId)
        )
    }

    /// The window's live frame, for callers that already hold the element.
    public static func windowFrame(_ element: AXUIElement) -> CuRect? { frame(element) }

    private static func resolveRoot(app: AXUIElement, request: AXObserveRequest) throws -> AXUIElement {
        guard let requestedWindowId = request.windowId else { return app }
        let rows = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        guard let row = rows.first(where: {
            ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == request.pid
                && ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == requestedWindowId
        }), let targetBounds = cgRect(row[kCGWindowBounds as String]) else { throw AXObservationError.windowNotFound }
        let targetTitle = nonEmpty(row[kCGWindowName as String] as? String)

        var rawWindows: CFTypeRef?
        let windowError = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &rawWindows)
        if windowError == .cannotComplete { throw AXObservationError.timedOut }
        guard windowError == .success, let windows = rawWindows as? [AXUIElement] else {
            throw AXObservationError.windowNotFound
        }
        let measured = windows.compactMap { window -> (element: AXUIElement, bounds: CuRect, title: String?)? in
            guard let bounds = frame(window) else { return nil }
            return (window, bounds, attributeString(window, kAXTitleAttribute))
        }

        // WindowServer already exposes the exact identity bridge for AX windows. Use it before
        // any geometry/title heuristic so a scaled, shadowed, or temporarily relocated window
        // cannot be mistaken for a sibling — and so observation resolves the same native object
        // as `AXWindowElementAccess`. Some third-party toolkits do not support this SPI, which is
        // why the bounded fallbacks below remain necessary.
        if let exact = windows.first(where: { candidate in
            var identifier = CGWindowID(0)
            return _AXUIElementGetWindow(candidate, &identifier) == .success
                && identifier == requestedWindowId
        }) {
            return exact
        }

        // Primary: near-exact geometry. Applications that report AX frames matching WindowServer.
        let ranked = measured.compactMap { candidate -> (AXUIElement, Double)? in
            let delta = abs(candidate.bounds.x - targetBounds.x) + abs(candidate.bounds.y - targetBounds.y)
                + abs(candidate.bounds.width - targetBounds.width) + abs(candidate.bounds.height - targetBounds.height)
            guard delta <= 24 else { return nil }
            let titleBonus = targetTitle != nil && candidate.title == targetTitle ? 100.0 : 0
            return (candidate.element, titleBonus - delta)
        }.sorted { $0.1 > $1.1 }
        if let match = ranked.first?.0 { return match }

        // Fallback for toolkits whose AX frame legitimately differs from the WindowServer frame —
        // Electron and other embedders inset for shadows and client-side decoration. Accept only an
        // unambiguous candidate: its center lies inside the target and its area is comparable.
        // Ambiguity is refused rather than resolved by ranking, and the AX app element is built
        // from the validated PID, so this can never cross an application boundary.
        let targetArea = targetBounds.width * targetBounds.height
        guard targetArea > 0 else { throw AXObservationError.windowNotFound }
        let contained = measured.filter { candidate in
            let centerX = candidate.bounds.x + candidate.bounds.width / 2
            let centerY = candidate.bounds.y + candidate.bounds.height / 2
            guard centerX >= targetBounds.x, centerX <= targetBounds.x + targetBounds.width,
                  centerY >= targetBounds.y, centerY <= targetBounds.y + targetBounds.height else {
                return false
            }
            let area = candidate.bounds.width * candidate.bounds.height
            return area > 0 && abs(area - targetArea) / targetArea <= 0.25
        }
        if contained.count == 1 { return contained[0].element }

        // Last resort: a unique, non-empty title match. Still one candidate or nothing.
        if let targetTitle {
            let titled = measured.filter { $0.title == targetTitle }
            if titled.count == 1 { return titled[0].element }
        }
        throw AXObservationError.windowNotFound
    }

    private static func readEarly(_ element: AXUIElement) -> Early? {
        var diagnostics = Diagnostics()
        return readEarly(element, diagnostics: &diagnostics)
    }

    private static func readEarly(_ element: AXUIElement, diagnostics: inout Diagnostics) -> Early? {
        let result = batch(element, earlyAttributes)
        guard result.error == .success, let values = result.values, values.count == earlyAttributes.count else {
            diagnostics.record(result.error, stage: "early_attributes")
            return nil
        }
        guard let role = string(values[0]), !role.isEmpty else {
            diagnostics.record(.failure, stage: "early_attributes")
            return nil
        }
        return Early(
            role: role,
            hidden: bool(values[1]) ?? false,
            enabled: bool(values[2]) ?? true,
            focused: bool(values[3]) ?? false,
            help: nonEmpty(string(values[4])),
            hasPopup: bool(values[5]) ?? false,
            bounds: rect(position: values[6], size: values[7]),
            children: values[8] as? [AXUIElement] ?? [],
            titleUIElement: axElement(values[9])
        )
    }

    private static func readLate(_ element: AXUIElement) -> [String?] {
        var diagnostics = Diagnostics()
        return readLate(element, diagnostics: &diagnostics)
    }

    private static func readLate(_ element: AXUIElement, diagnostics: inout Diagnostics) -> [String?] {
        let result = batch(element, lateAttributes)
        guard result.error == .success, let values = result.values, values.count == lateAttributes.count else {
            diagnostics.record(result.error, stage: "late_attributes")
            return Array(repeating: nil, count: lateAttributes.count)
        }
        return values.map { nonEmpty(string($0)) }
    }

    private static func batch(_ element: AXUIElement, _ attributes: [String]) -> (values: [Any]?, error: AXError) {
        var raw: CFArray?
        let error = AXUIElementCopyMultipleAttributeValues(element, attributes as CFArray, [], &raw)
        guard error == .success, let values = raw as? [Any] else { return (nil, error) }
        return (values.map { value in
            if CFGetTypeID(value as CFTypeRef) == AXValueGetTypeID(),
               AXValueGetType(value as! AXValue) == .axError { return NSNull() }
            return value
        }, error)
    }

    private static func actions(_ element: AXUIElement) -> [String] {
        var diagnostics = Diagnostics()
        return actions(element, diagnostics: &diagnostics)
    }

    private static func actions(_ element: AXUIElement, diagnostics: inout Diagnostics) -> [String] {
        var raw: CFArray?
        let error = AXUIElementCopyActionNames(element, &raw)
        guard error == .success else {
            diagnostics.record(error, stage: "action_names")
            return []
        }
        return (raw as? [String] ?? []).sorted()
    }

    /// Resolve only the bounded text fields of an AXTitleUIElement reference. The referenced
    /// element never receives a token or ElementRef, so borrowing its name cannot widen action
    /// authority or substitute one accessibility object for another.
    private static func titleUIElementText(
        _ element: AXUIElement,
        diagnostics: inout Diagnostics
    ) -> String? {
        let attributes = [kAXTitleAttribute, kAXValueAttribute, kAXDescriptionAttribute]
        let result = batch(element, attributes)
        guard result.error == .success, let values = result.values,
              values.count == attributes.count else {
            diagnostics.record(result.error, stage: "title_ui_element")
            return nil
        }
        return bounded(firstNonEmpty(string(values[0]), string(values[1]), string(values[2])))
    }

    private static func rect(position: Any, size: Any) -> CuRect? {
        guard !(position is NSNull), !(size is NSNull),
              CFGetTypeID(position as CFTypeRef) == AXValueGetTypeID(),
              CFGetTypeID(size as CFTypeRef) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero
        var dimensions = CGSize.zero
        guard AXValueGetValue(position as! AXValue, .cgPoint, &point),
              AXValueGetValue(size as! AXValue, .cgSize, &dimensions) else { return nil }
        return CuRect(x: point.x, y: point.y, width: dimensions.width, height: dimensions.height)
    }

    private static func frame(_ element: AXUIElement) -> CuRect? {
        var position: CFTypeRef?
        var size: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &position) == .success,
              AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &size) == .success,
              let position, let size else { return nil }
        return rect(position: position, size: size)
    }

    private static func attributeString(_ element: AXUIElement, _ attribute: String) -> String? {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success,
              let raw else { return nil }
        return string(raw)
    }

    private static func cgRect(_ value: Any?) -> CuRect? {
        guard let dictionary = value as? [String: Any] else { return nil }
        func number(_ key: String) -> Double? { (dictionary[key] as? NSNumber)?.doubleValue }
        guard let x = number("X"), let y = number("Y"), let width = number("Width"), let height = number("Height") else { return nil }
        return CuRect(x: x, y: y, width: width, height: height)
    }

    private static func string(_ value: Any) -> String? {
        if value is NSNull { return nil }
        if let value = value as? String { return value }
        if let value = value as? NSNumber { return value.stringValue }
        if let value = value as? URL { return value.absoluteString }
        return nil
    }
    private static func axElement(_ value: Any) -> AXUIElement? {
        guard !(value is NSNull),
              CFGetTypeID(value as CFTypeRef) == AXUIElementGetTypeID() else { return nil }
        return (value as! AXUIElement)
    }
    private static func bool(_ value: Any) -> Bool? { value is NSNull ? nil : (value as? NSNumber)?.boolValue }
    /// The late batch is stringified, so booleans arrive as "0"/"1" or "true"/"false".
    private static func parseBool(_ value: String?) -> Bool? {
        switch value?.lowercased() {
        case "1", "true", "yes": return true
        case "0", "false", "no": return false
        default: return nil
        }
    }
    private static func nonEmpty(_ value: String?) -> String? { value?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? value : nil }
    private static func firstNonEmpty(_ values: String?...) -> String? { values.compactMap(nonEmpty).first }
    private static func bounded(_ value: String?) -> String? {
        guard let value else { return nil }
        return value.count <= 512 ? value : String(value.prefix(512)) + "…"
    }

    /// Label precedence is public so the authority-sensitive ordering stays pinned by offline
    /// tests. The linked title is human-facing metadata, so it outranks implementation identifiers
    /// and help text, but it never overwrites a title/value/description owned by the target itself.
    public static func preferredLabel(
        title: String?,
        description: String?,
        value: String?,
        titleUIElementText: String?,
        identifier: String?,
        help: String?
    ) -> String? {
        bounded(firstNonEmpty(title, description, value, titleUIElementText, identifier, help))
    }

    private static func settableAttributes(_ element: AXUIElement) -> [String] {
        settableCandidates.filter { attribute in
            var settable = DarwinBoolean(false)
            guard AXUIElementIsAttributeSettable(element, attribute as CFString, &settable) == .success else {
                return false
            }
            return settable.boolValue
        }
    }

    /// Bounded metadata corrections derived from MacOS-Use's browser/desktop correction concepts.
    ///
    /// The upstream browser correction replaces an AXLink node with its AXHeading child while
    /// retaining the parent's action identity. Bimax never changes role or element authority: it
    /// borrows only the child's human-readable label. Likewise a cell/group may borrow the first
    /// static-text descendant's value, but remains the exact parent element the action will reach.
    /// This preserves the useful naming behavior without presenting one AX element as another.
    public static func correctedLabel(
        role: String,
        subrole: String?,
        base: String?,
        children: [AXUIElement]
    ) -> String? {
        let windowControlLabels: [String: String] = [
            "AXCloseButton": "Close",
            "AXMinimizeButton": "Minimize",
            "AXZoomButton": "Zoom",
            "AXFullScreenButton": "Full Screen",
        ]
        if role == "AXButton", let subrole, let corrected = windowControlLabels[subrole] {
            return base ?? corrected
        }

        if role == "AXLink", let first = children.first,
           let heading = correctionNode(first), heading.role == "AXHeading" {
            return heading.label ?? base
        }
        guard base == nil, role == "AXCell" || role == "AXGroup" else { return base }
        var current = children.first
        // Follow only the first-child chain, matching upstream, but cap it so malformed AX trees
        // cannot turn a label correction into an unbounded second traversal.
        for _ in 0..<8 {
            guard let element = current, let node = correctionNode(element) else { break }
            if node.role == "AXStaticText", let label = node.label { return label }
            current = node.children.first
        }
        return base
    }

    private static func correctionNode(
        _ element: AXUIElement
    ) -> (role: String, label: String?, children: [AXUIElement])? {
        let attrs = [kAXRoleAttribute, kAXTitleAttribute, kAXValueAttribute,
                     kAXDescriptionAttribute, kAXChildrenAttribute]
        let result = batch(element, attrs)
        guard result.error == .success, let values = result.values, values.count == attrs.count,
              let role = string(values[0]) else { return nil }
        return (
            role,
            firstNonEmpty(string(values[1]), string(values[2]), string(values[3])),
            values[4] as? [AXUIElement] ?? []
        )
    }

    /// Per-element capability discovery. Patterns are derived from what the live element actually
    /// advertises, never from a hardcoded per-application or per-bundle table.
    public static func patterns(role: String, actions: [String], settable: [String], expandable: Bool) -> [String] {
        let actionSet = Set(actions)
        let settableSet = Set(settable)
        var patterns: [AXControlPattern] = []
        if actionSet.contains(kAXPressAction as String) { patterns.append(.invoke) }
        if actionSet.contains(kAXShowMenuAction as String) { patterns.append(.secondaryAction) }
        if settableSet.contains(kAXValueAttribute) { patterns.append(.value) }
        if actionSet.contains(kAXIncrementAction as String) || actionSet.contains(kAXDecrementAction as String) {
            patterns.append(.rangeValue)
        }
        if togglePatternRoles.contains(role) && actionSet.contains(kAXPressAction as String) {
            patterns.append(.toggle)
        }
        if expandable || settableSet.contains(kAXExpandedAttribute) { patterns.append(.expandCollapse) }
        if !actionSet.isDisjoint(with: scrollPageActions) { patterns.append(.scroll) }
        if actionSet.contains("AXScrollToVisible") { patterns.append(.scrollToVisible) }
        if settableSet.contains(kAXSelectedAttribute) { patterns.append(.selection) }
        if settableSet.contains(kAXSelectedTextRangeAttribute) && textPatternRoles.contains(role) {
            patterns.append(.text)
        }
        if role == "AXWindow" || role == "AXSheet" || role == "AXDrawer" { patterns.append(.window) }
        return patterns.map(\.rawValue)
    }

    /// Case-insensitive substring search over the fields a caller can reasonably name. Matching is
    /// done on already-emitted metadata, so a query never widens traversal or unlocks new scope.
    public static func matchesQuery(_ query: String, role: String, label: String?, value: String?, identifier: String?) -> Bool {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return true }
        for field in [label, value, identifier, role] {
            guard let field else { continue }
            if field.range(of: needle, options: [.caseInsensitive, .diacriticInsensitive]) != nil { return true }
        }
        return false
    }

    private static func compatibleBounds(_ expected: CuRect?, _ live: CuRect?) -> Bool {
        guard let expected else { return true }
        guard let live else { return false }
        let delta = abs(expected.x - live.x) + abs(expected.y - live.y)
            + abs(expected.width - live.width) + abs(expected.height - live.height)
        return delta <= 32
    }

    public static func intersection(_ lhs: CuRect, _ rhs: CuRect) -> CuRect? {
        let left = max(lhs.x, rhs.x)
        let top = max(lhs.y, rhs.y)
        let right = min(lhs.x + lhs.width, rhs.x + rhs.width)
        let bottom = min(lhs.y + lhs.height, rhs.y + rhs.height)
        guard right > left, bottom > top else { return nil }
        return CuRect(x: left, y: top, width: right - left, height: bottom - top)
    }

    /// Deterministic FNV-1a path identity. This is an equality key, not an authorization token;
    /// actions use the random snapshot-bound ElementRef token above.
    private static func stableHash(_ value: String) -> String {
        var hash: UInt64 = 0xcbf29ce484222325
        for byte in value.utf8 { hash = (hash ^ UInt64(byte)) &* 0x100000001b3 }
        return String(format: "%016llx", hash)
    }
}
