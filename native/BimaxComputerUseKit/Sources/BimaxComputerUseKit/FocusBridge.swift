import Foundation
import ApplicationServices
import BimaxCuProtocol

// RECONSTRUCTION NOTE (2026-08-18): this library's sources were lost in the FocusBridge eviction
// (the package would not build at all — every other target depends on it). The API below is NOT
// invented: every member is pinned by its call sites in BimaxComputerUseKit (AXSemanticActionEngine,
// ServiceCore, CaptureGeometry, AccessibilityEngine), the wire types it manipulates live in
// BimaxCuProtocol/WireProtocol.swift, and the behavioral contract — single-use action authorities,
// race-fail-closed retention, stale-ref rejection — is pinned by Sources/BimaxCuTests/main.swift,
// which drives this exact surface through BimaxCuServiceCore.

// NOTE: the reconstruction re-declared `CuRect` here. It already exists in BimaxCuProtocol
// (WireProtocol.swift), which this module imports, so the local copy was a second, distinct
// type with the same name — and its `cgRect.x`/`.y` accessors no longer exist on CGRect.
// Removed in favour of the wire type these values are serialised as anyway.

// MARK: - Text limits

/// Hard caps so a pathological document can never turn a match search into an unbounded scan.
/// Both are measured in UTF-16 units, which is what AX range attributes use.
public enum AXTextLimits {
    public static let maxNeedleCharacters = 512
    public static let maxSearchableCharacters = 200_000
}

// MARK: - AXTextPattern

/// Text-pattern helpers over one AXUIElement: the read/validate/write primitives for selection
/// and caret delivery. Everything is optional-returning because AX legitimately refuses (composite
/// controls, static text); callers turn nil into their own action errors.
public enum AXTextPattern {
    public static func stringValue(_ element: AXUIElement) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value) == .success,
              let value else { return nil }
        if let s = value as? String { return s }
        if let attributed = value as? NSAttributedString { return attributed.string }
        return nil
    }

    public static func characterCount(_ element: AXUIElement) -> Int? {
        var count: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXNumberOfCharactersAttribute as CFString, &count) == .success,
              let count = count as? NSNumber else { return nil }
        return count.intValue
    }

    public static func isSelectionSettable(_ element: AXUIElement) -> Bool {
        var settable: DarwinBoolean = false
        guard AXUIElementIsAttributeSettable(element, kAXSelectedTextRangeAttribute as CFString, &settable) == .success else {
            return false
        }
        return settable.boolValue
    }

    /// Reads the live `AXSelectedTextRange`, or nil when absent/ill-formed.
    public static func selectedRange(_ element: AXUIElement) -> TextRangeSelection? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &value) == .success,
              let value else { return nil }
        return decodeRange(value)
    }

    /// Writes an absolute selection. Returns false when the write is refused — never throws, so a
    /// refused selection is distinguishable from a transport fault.
    @discardableResult
    public static func setSelectedRange(_ element: AXUIElement, _ range: TextRangeSelection) -> Bool {
        guard let encoded = encodeRange(range) else { return false }
        return AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, encoded) == .success
    }

    /// Clamps + bounds-checks a caller-supplied location/length against the live document length.
    /// A negative length or a range running past the end is a caller bug, not a clamp: throws.
    public static func validatedRange(location: Int, length: Int, characterCount: Int) throws -> TextRangeSelection {
        guard length >= 0, location >= 0, location + length <= characterCount else {
            throw AXSemanticActionError.textRangeOutOfBounds
        }
        return TextRangeSelection(location: location, length: length)
    }

    /// Resolves a caret placement (start/end/offset anchors) to an absolute zero-length range.
    /// The reconstruction invented a `TextCaretAnchor` with an `.offset(Int)` payload. The real wire
    /// type is `CaretPlacement` (BimaxCuProtocol): a `CaretAnchor` of `.start`/`.end`/`.index` plus a
    /// SEPARATE optional `index`. Both halves are load-bearing, and the conformance suite pins all
    /// four outcomes — including the two that must be rejected as malformed payloads rather than
    /// quietly defaulted, since defaulting a missing index to 0 would silently move the caret to the
    /// document start.
    public static func caretRange(placement: CaretPlacement, characterCount: Int) throws -> TextRangeSelection {
        switch placement.anchor {
        case .start, .end:
            // An index alongside a start/end anchor is contradictory: honouring either half would
            // discard the caller's other stated intent.
            guard placement.index == nil else { throw AXSemanticActionError.invalidPayload }
            return TextRangeSelection(location: placement.anchor == .start ? 0 : characterCount, length: 0)
        case .index:
            guard let index = placement.index else { throw AXSemanticActionError.invalidPayload }
            guard index >= 0, index <= characterCount else {
                throw AXSemanticActionError.textRangeOutOfBounds
            }
            return TextRangeSelection(location: index, length: 0)
        }
    }

    /// Finds a needle (with optional prefix/suffix disambiguation) inside the element's text.
    public static func resolveMatch(in text: String, match: TextMatchSelection) throws -> TextRangeSelection {
        let needle = match.text
        guard !needle.isEmpty else { throw AXSemanticBridgeError.emptyNeedle }
        guard (needle as NSString).length <= AXTextLimits.maxNeedleCharacters else {
            throw AXSemanticBridgeError.needleTooLarge
        }
        guard let base = text.range(of: needle) else {
            throw AXSemanticBridgeError.needleNotFound(needle)
        }
        _ = base
        // AX ranges are UTF-16 offsets, so every offset here is measured with NSString rather than
        // String.Index — mixing the two is how a range lands mid-grapheme.
        let location = (text as NSString).range(of: needle).location
        let length = (needle as NSString).length
        // Disambiguate forward: prefer the first occurrence whose right context starts with the
        // suffix (when one is given) and whose left context ends with the prefix (when one is given).
        if match.prefix != nil || match.suffix != nil {
            let nsText = text as NSString
            let total = nsText.length
            var searchFrom = 0
            while true {
                let hit = nsText.range(of: needle, range: NSRange(location: searchFrom, length: total - searchFrom))
                guard hit.location != NSNotFound else { break }
                if let prefix = match.prefix {
                    let prefixLen = (prefix as NSString).length
                    let start = hit.location - prefixLen
                    guard start >= 0, nsText.substring(with: NSRange(location: start, length: prefixLen)) == prefix else {
                        searchFrom = hit.location + 1
                        continue
                    }
                }
                if let suffix = match.suffix {
                    let suffixLen = (suffix as NSString).length
                    let start = hit.location + hit.length
                    guard start + suffixLen <= total, nsText.substring(with: NSRange(location: start, length: suffixLen)) == suffix else {
                        searchFrom = hit.location + 1
                        continue
                    }
                }
                return TextRangeSelection(location: hit.location, length: hit.length)
            }
        }
        return TextRangeSelection(location: location, length: length)
    }

    /// Wire codec for AX range attributes: CFTypeRef in, TextRangeSelection out. Anything that is not an
    /// AXValue wrapping a CFRange (including a bare string, as the conformance suite checks)
    /// decodes as nil — never as a zero range, which would silently select the document start.
    public static func decodeRange(_ value: CFTypeRef?) -> TextRangeSelection? {
        guard let value else { return nil }
        guard CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        var range = CFRange(location: 0, length: 0)
        guard AXValueGetValue(value as! AXValue, .cfRange, &range) else { return nil }
        guard range.location >= 0, range.length >= 0 else { return nil }
        return TextRangeSelection(location: range.location, length: range.length)
    }

    /// Encodes a selection into the AXValue the attribute system stores.
    public static func encodeRange(_ range: TextRangeSelection) -> CFTypeRef? {
        // AXValueCreate takes the address of the value, never the value itself.
        var cfRange = CFRange(location: range.location, length: range.length)
        return AXValueCreate(.cfRange, &cfRange)
    }
}

/// Local fault vocabulary for pattern helpers. Callers map these onto their action errors; the
/// conformance suite distinguishes out-of-bounds from not-found from too-large.
public enum AXSemanticBridgeError: Error, Equatable {
    case rangeOutOfBounds(location: Int, length: Int, count: Int)
    case emptyNeedle
    case needleTooLarge
    case needleNotFound(String)
}

// MARK: - AXScrollPattern

/// Scroll primitives over the element's own scroll bars. macOS's reliable programmatic scroll is
/// the scroll bar's `AXValue` (a 0…1 fraction), which is why the catalog's absolute primitive is
/// `scroll_to_fraction` and page scrolls are button presses on the bar (`AXIncrement`/`AXDecrement`).
public enum AXScrollPattern {
    /// The AX attribute naming the scroll bar for one axis.
    public static func attributeName(for axis: ScrollAxis) -> String {
        switch axis {
        case .horizontal: return "AXHorizontalScrollBar"
        case .vertical: return "AXVerticalScrollBar"
        }
    }

    /// The AX action name a page scroll maps onto for one direction.
    public static func action(for direction: ScrollPageDirection) -> String {
        switch direction {
        case .up: return "AXDecrement"
        case .down: return "AXIncrement"
        case .left: return "AXDecrement"
        case .right: return "AXIncrement"
        }
    }

    /// Fetches the scroll bar element for an axis, or nil when the element has none (not
    /// scrollable on that axis — an answer, not an error).
    public static func scrollBar(_ element: AXUIElement, axis: ScrollAxis) -> AXUIElement? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attributeName(for: axis) as CFString, &value) == .success,
              let bar = value as! AXUIElement? else { return nil }
        return bar
    }

    public static func isValueSettable(_ bar: AXUIElement) -> Bool {
        var settable: DarwinBoolean = false
        guard AXUIElementIsAttributeSettable(bar, kAXValueAttribute as CFString, &settable) == .success else {
            return false
        }
        return settable.boolValue
    }

    /// The bar's own 0…1 position, or nil when it reports no numeric value.
    public static func fraction(_ bar: AXUIElement) -> Double? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(bar, kAXValueAttribute as CFString, &value) == .success,
              let number = value as? NSNumber else { return nil }
        return number.doubleValue
    }

    /// Writes an absolute 0…1 scroll position. Returns false on refusal.
    @discardableResult
    public static func setFraction(_ bar: AXUIElement, _ fraction: Double) -> Bool {
        AXUIElementSetAttributeValue(bar, kAXValueAttribute as CFString, fraction as CFNumber) == .success
    }

    /// Fraction re-expressed as a percent string for receipts (evidence is human-read).
    public static func percentValue(_ fraction: Double) -> String {
        "\(Int((fraction * 100).rounded()))%"
    }

    /// Observation helpers reading both axes off the element's bars, for before/after receipts.
    public static func horizontalPercent(_ element: AXUIElement) -> Double? {
        guard let bar = scrollBar(element, axis: .horizontal) else { return nil }
        return fraction(bar)
    }

    public static func verticalPercent(_ element: AXUIElement) -> Double? {
        guard let bar = scrollBar(element, axis: .vertical) else { return nil }
        return fraction(bar)
    }
}

// MARK: - SemanticEvidencePolicy

/// Which evidence tier a semantic action can produce WITHOUT being asked, whether a declared
/// postcondition is even evaluable, and whether fresh AX state already satisfies one. Pure logic
/// over WireProtocol types — no AX calls — so the core can run it against before/after nodes
/// symmetrically.
public enum SemanticEvidencePolicy {
    /// Every semantic delivery can at minimum prove WHAT it did by re-reading the element
    /// (semantic tier). Region/audit tiers come from the capture pipeline, not this path, so
    /// they are never advertised here — a caller requesting more than this is told the path
    /// cannot produce it, rather than being silently downgraded.
    public static func automaticTier(for action: SemanticActionKind) -> EvidenceTier {
        switch action {
        case .scrollToVisible, .scrollPage, .scrollToFraction:
            // Scroll receipts carry their own before/after fractions — delivery-grade proof is
            // intrinsic, semantic read-back may not exist for virtualized lists.
            return .delivery
        default:
            return .semantic
        }
    }

    /// A postcondition must be satisfiable in principle: it needs at least one assertion, a
    /// present/absent text check needs text, and a needle must fit the matchable budget.
    public static func validate(_ postcondition: SemanticPostcondition) throws {
        let assertsSomething = postcondition.text != nil
            || postcondition.expectedValue != nil
            || postcondition.valueMustChange
            || postcondition.expectedFocused != nil
            || postcondition.expectedSelected != nil
            || postcondition.elementExists != nil
        guard assertsSomething else {
            throw AXSemanticBridgeError.emptyNeedle
        }
        if let text = postcondition.text {
            guard !text.isEmpty else { throw AXSemanticBridgeError.emptyNeedle }
            guard (text as NSString).length <= AXTextLimits.maxNeedleCharacters else {
                throw AXSemanticBridgeError.needleTooLarge
            }
        }
    }

    /// Does this node state ALREADY satisfy the postcondition? Used symmetrically: before
    /// delivery (a preexisting match aborts with postcondition_preexisting) and after (the
    /// achieved-evidence verdict). A nil node can only satisfy an elementExists == false claim.
    public static func matches(
        _ postcondition: SemanticPostcondition,
        before node: AXNode?,
        snapshot: AXSnapshot?,
        stablePathHash: String?
    ) -> Bool {
        // The stable-path hash binds the judgement to the SAME element the caller authorized;
        // a same-shaped different element must not satisfy the postcondition.
        if let expected = stablePathHash, let actual = node?.stablePathHash, !actual.isEmpty {
            guard expected == actual else { return false }
        }
        var matched = true
        if let exists = postcondition.elementExists {
            matched = matched && ((node != nil) == exists)
        }
        guard let node else { return matched }
        if let text = postcondition.text {
            let contains = [node.value, node.label].compactMap { $0 }.contains {
                $0.range(of: text, options: .caseInsensitive) != nil
            }
            matched = matched && (postcondition.textPresence == .present ? contains : !contains)
        }
        if let expectedValue = postcondition.expectedValue {
            matched = matched && (node.value == expectedValue)
        }
        if postcondition.valueMustChange {
            // "Must change" can only be judged against the before-state the caller supplies; on
            // the before-node itself it is trivially not-yet-changed.
            matched = matched && false
        }
        if let expectedFocused = postcondition.expectedFocused {
            matched = matched && (node.focused == expectedFocused)
        }
        if let expectedSelected = postcondition.expectedSelected {
            matched = matched && (node.selected == expectedSelected)
        }
        return matched
    }
}

// MARK: - AXSnapshotStore

public enum AXSnapshotStoreError: Error, Equatable {
    case malformedSnapshot
    case nonAuthoritativeSnapshot
    case baseSnapshotNotFound
    case baseSnapshotTargetMismatch
    case staleElementRef
    case elementNotFound
    case malformedDiff
}

/// The authority ledger. A stable snapshot's node refs become single-use action authorities;
/// a successful mutation invalidates every retained authority for that target even before the
/// app's AX notification lands. All state is session-scoped and vanishes with the session.
///
/// Fail-closed rules pinned by Sources/BimaxCuTests:
///   - a snapshot captured while its graph changed (changedDuringCapture/partial/truncated) is
///     RETURNED as evidence but retains NOTHING and cannot serve as a diff base;
///   - an unknown/expired sinceSnapshotId is stale_snapshot_ref;
///   - a diff base for a different pid/window/scope is snapshot_target_mismatch;
///   - an action ref whose session/target/identity cannot be resolved is stale_element_ref.
public final class AXSnapshotStore: @unchecked Sendable {
    public struct Authority {
        public let node: AXNode
        public let snapshot: AXSnapshot
    }

    private let lock = NSLock()
    private var snapshots: [String: AXSnapshot] = [:]
    private var authorities: [String: ElementRef] = [:] // token → authorizing ref
    private var nodesByToken: [String: AXNode] = [:]
    private var snapshotByToken: [String: String] = [:]

    public init() {}

    // MARK: Retention (observe path)

    /// Retains a STABLE full snapshot's refs and returns either a diff against `since` or the
    /// snapshot itself. The caller has already decided stability: unstable captures must never
    /// reach this method (ServiceCore routes them around it).
    public func retain(full: AXSnapshot, since snapshotId: String?) throws -> AXSnapshot {
        guard !full.snapshotId.isEmpty, !full.sessionId.isEmpty, full.pid != 0 else {
            throw AXSnapshotStoreError.malformedSnapshot
        }
        var response = full
        if let since = snapshotId, !since.isEmpty {
            guard let base = snapshots[since], base.sessionId == full.sessionId else {
                throw AXSnapshotStoreError.baseSnapshotNotFound
            }
            guard base.pid == full.pid, base.windowId == full.windowId, base.scope == full.scope else {
                throw AXSnapshotStoreError.baseSnapshotTargetMismatch
            }
            guard let baseQuery = base.query, let fullQuery = full.query, baseQuery == fullQuery else {
                // A filtered view may only diff against the same filter.
                throw AXSnapshotStoreError.baseSnapshotTargetMismatch
            }
            response = AXSnapshot(
                snapshotId: full.snapshotId,
                sessionId: full.sessionId,
                pid: full.pid,
                windowId: full.windowId,
                windowGeneration: full.windowGeneration,
                revision: full.revision,
                capturedAtMs: full.capturedAtMs,
                profile: full.profile,
                scope: full.scope,
                nodes: [],
                visitedCount: full.visitedCount,
                truncated: full.truncated,
                partial: full.partial,
                issues: full.issues,
                clippedNodeCount: full.clippedNodeCount,
                baseSnapshotId: since,
                diff: Self.diffOperations(from: base.nodes, to: full.nodes),
                fullNodeCount: full.nodes.count,
                eventTracking: full.eventTracking,
                eventRevision: full.eventRevision,
                changedDuringCapture: full.changedDuringCapture,
                query: full.query
            )
        }
        lock.lock()
        defer { lock.unlock() }
        snapshots[full.snapshotId] = full
        for node in full.nodes {
            guard let ref = node.elementRef else { continue }
            nodesByToken[ref.token] = node
            snapshotByToken[ref.token] = full.snapshotId
            authorities[ref.token] = ref
        }
        // Sessions hold bounded state: keep each session's latest stable snapshots only.
        trim(sessionId: full.sessionId)
        return response
    }

    /// Element-level diff operations between two node lists, keyed by stablePathHash (the
    /// identity that survives reorderings and token churn).
    private static func diffOperations(from before: [AXNode], to after: [AXNode]) -> [AXDiffOperation] {
        let beforeByHash = Dictionary(before.filter { !$0.stablePathHash.isEmpty }.map { ($0.stablePathHash, $0) },
                                      uniquingKeysWith: { first, _ in first })
        let afterByHash = Dictionary(after.filter { !$0.stablePathHash.isEmpty }.map { ($0.stablePathHash, $0) },
                                     uniquingKeysWith: { first, _ in first })
        // `AXDiffOperation` is an enum, not a struct with an `op` string: insert/update carry the
        // whole node, and remove carries only the hash and token — a removed node has no state left
        // worth sending, and shipping one would invite the reader to treat it as still present.
        var ops: [AXDiffOperation] = []
        for (hash, node) in afterByHash {
            if beforeByHash[hash] == nil {
                ops.append(.insert(node))
            } else if beforeByHash[hash] != node {
                ops.append(.update(node))
            }
        }
        for (hash, node) in beforeByHash where afterByHash[hash] == nil {
            ops.append(.remove(stablePathHash: hash, token: node.token))
        }
        // Sorting needs a key the enum actually exposes; only two of the three cases carry a node,
        // so the hash is read per-case rather than through a property that does not exist.
        return ops.sorted { Self.diffSortKey($0) < Self.diffSortKey($1) }
    }

    /// Stable ordering key for a diff operation. Deterministic order matters: a diff that reorders
    /// between observations reads as churn to anything comparing them.
    private static func diffSortKey(_ operation: AXDiffOperation) -> String {
        switch operation {
        case .insert(let node), .update(let node): return node.stablePathHash
        case .remove(let stablePathHash, _): return stablePathHash
        }
    }

    private func trim(sessionId: String) {
        let sessionSnapshotIds = snapshots
            .filter { $0.value.sessionId == sessionId }
            .sorted { $0.value.capturedAtMs > $1.value.capturedAtMs }
        guard sessionSnapshotIds.count > 4 else { return }
        for stale in sessionSnapshotIds.dropFirst(4) {
            snapshots.removeValue(forKey: stale.key)
            let staleTokens = snapshotByToken.filter { $0.value == stale.key }.map(\.key)
            for token in staleTokens {
                snapshotByToken.removeValue(forKey: token)
                nodesByToken.removeValue(forKey: token)
                authorities.removeValue(forKey: token)
            }
        }
    }

    // MARK: Resolution (action path)

    public func resolveSnapshot(sessionId: String, snapshotId: String) throws -> AXSnapshot {
        lock.lock()
        defer { lock.unlock() }
        guard let snapshot = snapshots[snapshotId], snapshot.sessionId == sessionId else {
            throw AXSnapshotStoreError.baseSnapshotNotFound
        }
        return snapshot
    }

    /// Resolves one element ref into its authorizing node + snapshot. Single-use semantics are
    /// enforced by invalidation (the caller invalidates after use); resolution itself only fails
    /// closed on unknown/mismatched refs.
    public func resolveAuthority(sessionId: String, ref: ElementRef) throws -> Authority {
        lock.lock()
        defer { lock.unlock() }
        guard let token = authorities[ref.token], token.token == ref.token,
              let snapshotId = snapshotByToken[ref.token],
              let snapshot = snapshots[snapshotId],
              snapshot.sessionId == sessionId,
              snapshot.snapshotId == ref.snapshotId,
              let node = nodesByToken[ref.token] else {
            throw AXSnapshotStoreError.staleElementRef
        }
        guard ref.pid == snapshot.pid,
              ref.windowId == snapshot.windowId,
              ref.windowGeneration == snapshot.windowGeneration else {
            throw AXSnapshotStoreError.staleElementRef
        }
        return Authority(node: node, snapshot: snapshot)
    }

    /// Drops every retained authority for one exact target. Called after ANY successful mutation
    /// on that target — the app's own AX notification may still be in flight.
    public func invalidate(sessionId: String, pid: Int32, windowId: UInt32?) {
        lock.lock()
        defer { lock.unlock() }
        let deadTokens = authorities.values.filter { ref in
            ref.pid == pid && ref.windowId == windowId && snapshots[ref.snapshotId]?.sessionId == sessionId
        }.map(\.token)
        for token in deadTokens {
            authorities.removeValue(forKey: token)
            nodesByToken.removeValue(forKey: token)
            snapshotByToken.removeValue(forKey: token)
        }
    }

    /// Session teardown: nothing a session retained survives it.
    public func reset(sessionId: String) {
        lock.lock()
        defer { lock.unlock() }
        let sessionSnapshotIds = Set(snapshots.filter { $0.value.sessionId == sessionId }.map(\.key))
        for id in sessionSnapshotIds { snapshots.removeValue(forKey: id) }
        let deadTokens = snapshotByToken.filter { sessionSnapshotIds.contains($0.value) }.map(\.key)
        for token in deadTokens {
            snapshotByToken.removeValue(forKey: token)
            nodesByToken.removeValue(forKey: token)
            authorities.removeValue(forKey: token)
        }
    }

    public func retainedCount(sessionId: String) -> Int {
        lock.lock()
        defer { lock.unlock() }
        return authorities.values.filter { snapshots[$0.snapshotId]?.sessionId == sessionId }.count
    }
}
