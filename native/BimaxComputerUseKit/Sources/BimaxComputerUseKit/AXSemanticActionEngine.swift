import ApplicationServices
import Foundation
import BimaxCuProtocol

// Typed AX action/pattern behavior translated from MacOS-Use's MIT-licensed
// `macos_use/ax/core.py`, `controls.py`, and `patterns.py`. Bimax adds snapshot authorization,
// bounded live re-resolution, identity checks, event checkpoints, and background-only policy.
// See THIRD_PARTY_NOTICES.md.

public enum AXSemanticActionError: Error, Equatable {
    case permissionDenied
    case liveElementNotFound
    case liveIdentityMismatch
    case liveTraversalLimit
    case invalidPayload
    case sensitiveElement
    case actionUnsupported
    case valueNotSettable
    /// Carries the raw AXError so a refusal names the native cause instead of being opaque.
    case executionFailed(AXError)
    /// The application did not answer the action within the messaging timeout. `AXUIElement.h` is
    /// explicit that this is NOT a failure: applications "often need to perform some sort of modal
    /// processing inside their action callbacks and they may not return within the timeout value",
    /// and "this does not necessarily mean that the function has failed". The action may well have
    /// landed, so the only honest report is that the outcome is unknown — and no other rung may be
    /// tried, because a second delivery would perform an action that already happened.
    case executionIndeterminate(AXError)
    case selectionNotSettable
    case textUnavailable
    case textTooLarge
    case textNotFound
    case ambiguousTextMatch
    case textRangeOutOfBounds
    /// The focus write reported success and the element is not focused. Typing anyway would send
    /// the text to whichever control the application actually has focused.
    case focusNotHonored
}

public struct AXActionExecution: Equatable, Sendable {
    public var primitive: String
    public var outcome: SemanticActionOutcome
    public var textSelection: TextSelectionReceipt?
    public var scroll: ScrollReceipt?
    /// Which rung delivered.
    public var deliveryPath: DeliveryPath
    /// Every rung walked, in order, including the ones this element did not offer.
    public var attemptedPaths: [DeliveryAttempt]
    public var typedText: TypedTextReceipt?

    public init(
        primitive: String,
        outcome: SemanticActionOutcome = .performed,
        textSelection: TextSelectionReceipt? = nil,
        scroll: ScrollReceipt? = nil,
        deliveryPath: DeliveryPath = .axAction,
        attemptedPaths: [DeliveryAttempt] = [],
        typedText: TypedTextReceipt? = nil
    ) {
        self.primitive = primitive
        self.outcome = outcome
        self.textSelection = textSelection
        self.scroll = scroll
        self.deliveryPath = deliveryPath
        self.attemptedPaths = attemptedPaths
        self.typedText = typedText
    }
}

/// The rungs an action may be delivered through, and the record of walking them.
///
/// Two live defects came from a single-rung implementation: `expand` was press-only and could not
/// expand an `NSComboBox` (settable `AXExpanded`, no `AXPress`), and `select` was press-only and
/// could not select an `NSTableView` row (settable `AXSelected`, no `AXPress`). Both passed their
/// offline tests. Declaring the ladder rather than hand-writing a preference per action is what
/// stops the next control that answers to only one of the two from being a third instance.
public struct AXDeliveryLadder {
    public struct Rung {
        public var path: DeliveryPath
        public var primitive: String
        /// Returns nil when the element does not offer this rung at all, which is recorded as
        /// `unavailable` and is not a failure. Throwing means the application refused it.
        public var attempt: () throws -> AXActionExecution?

        public init(path: DeliveryPath, primitive: String, attempt: @escaping () throws -> AXActionExecution?) {
            self.path = path
            self.primitive = primitive
            self.attempt = attempt
        }
    }

    /// Walks the rungs in order and returns the first that delivers.
    ///
    /// A rung the element does not offer is skipped and recorded. A rung that is offered and
    /// refused is recorded and the ladder continues, so one toolkit's refusal does not mask a rung
    /// that would have worked. If every rung was unavailable the action is genuinely unsupported;
    /// if some were offered and all refused, the last refusal is the honest error.
    public static func walk(_ rungs: [Rung]) throws -> AXActionExecution {
        var attempts: [DeliveryAttempt] = []
        var lastRefusal: AXSemanticActionError?
        for rung in rungs {
            do {
                guard var execution = try rung.attempt() else {
                    attempts.append(.init(path: rung.path, primitive: rung.primitive, outcome: .unavailable))
                    continue
                }
                attempts.append(.init(
                    path: rung.path,
                    primitive: execution.primitive,
                    outcome: execution.outcome == .alreadySatisfied ? .alreadySatisfied : .performed
                ))
                execution.deliveryPath = rung.path
                execution.attemptedPaths = attempts
                return execution
            } catch let error as AXSemanticActionError {
                // An indeterminate rung ends the walk. The application may already have performed
                // the action, so continuing to the next rung would deliver it a second time — the
                // failure mode is a message sent twice or a toggle returned to where it started.
                // Stop, and report the uncertainty rather than manufacturing a refusal.
                if case .executionIndeterminate(let ax) = error {
                    attempts.append(.init(
                        path: rung.path,
                        primitive: rung.primitive,
                        outcome: .indeterminate,
                        axError: ax.rawValue
                    ))
                    throw error
                }
                attempts.append(.init(
                    path: rung.path,
                    primitive: rung.primitive,
                    outcome: .refused,
                    axError: { if case .executionFailed(let ax) = error { return ax.rawValue } else { return nil } }()
                ))
                lastRefusal = error
            }
        }
        throw lastRefusal ?? .actionUnsupported
    }
}

public protocol AXSemanticActionExecuting: Sendable {
    func execute(
        request: SemanticActionRequest,
        expected: AXNode,
        validateBeforeMutation: () throws -> Void
    ) throws -> AXActionExecution

    /// Gives the engine one opportunity to deliver a transaction atomically. Returning nil means
    /// no atomic primitive exists and the service should run the already-preflighted steps in
    /// order. The default keeps test and alternate executors source-compatible.
    func executeBatch(
        requests: [SemanticActionRequest],
        expected: [AXNode],
        validateBeforeMutation: () throws -> Void
    ) throws -> [AXActionExecution]?
}

public extension AXSemanticActionExecuting {
    func executeBatch(
        requests: [SemanticActionRequest],
        expected: [AXNode],
        validateBeforeMutation: () throws -> Void
    ) throws -> [AXActionExecution]? { nil }
}

/// Semantic-only native delivery. This module never activates an app, raises a window, moves the
/// cursor, posts global input, or falls back to coordinates.
public final class AXSemanticActionEngine: AXSemanticActionExecuting, @unchecked Sendable {
    private let accessibility: AccessibilityEngine
    private let keyboard: TargetedKeyboardInput

    private static let valueRoles: Set<String> = [
        "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXSlider", "AXIncrementor",
    ]
    private static let toggleRoles: Set<String> = ["AXCheckBox", "AXToggle", "AXSwitch"]
    private static let selectionRoles: Set<String> = [
        "AXRadioButton", "AXMenuItem", "AXTab", "AXRow", "AXCell",
    ]
    /// Roles whose selection is addressed by `AXSelectedTextRange`. Web areas use text markers
    /// instead and are deliberately out of scope for this slice.
    private static let textRoles: Set<String> = [
        "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox",
    ]

    public init(
        accessibility: AccessibilityEngine = AccessibilityEngine(),
        keyboard: TargetedKeyboardInput = TargetedKeyboardInput()
    ) {
        self.accessibility = accessibility
        self.keyboard = keyboard
    }

    public func execute(
        request: SemanticActionRequest,
        expected: AXNode,
        validateBeforeMutation: () throws -> Void
    ) throws -> AXActionExecution {
        try Self.validateRequestShape(request, expected: expected)
        let element = try accessibility.resolveLiveElement(ref: request.element, expected: expected)
        let liveActions = Self.actionNames(element)
        // The ladder holds the validation closure in its rungs; it never outlives this call.
        return try withoutActuallyEscaping(validateBeforeMutation) { validate in
            try deliver(
                request: request, element: element, liveActions: liveActions,
                expectedRole: expected.role, validate: validate
            )
        }
    }

    /// Atomic additive/removal selection through the collection's selected-elements attribute.
    /// Row-level `AXSelected=true` replaces selection in AppKit even when the table allows multiple
    /// selection; writing the final selected-row array is the primitive that actually composes.
    public func executeBatch(
        requests: [SemanticActionRequest],
        expected: [AXNode],
        validateBeforeMutation: () throws -> Void
    ) throws -> [AXActionExecution]? {
        guard requests.count > 1, requests.count == expected.count,
              requests.allSatisfy({ $0.action == .setSelected }) else { return nil }
        let desired: [Bool] = try requests.map {
            guard case .boolean(let selected)? = $0.value else {
                throw AXSemanticActionError.invalidPayload
            }
            return selected
        }
        for (request, node) in zip(requests, expected) {
            try Self.validateRequestShape(request, expected: node)
        }
        let elements = try zip(requests, expected).map {
            try accessibility.resolveLiveElement(ref: $0.0.element, expected: $0.1)
        }
        func parent(of element: AXUIElement) -> AXUIElement? {
            var raw: CFTypeRef?
            guard AXUIElementCopyAttributeValue(element, kAXParentAttribute as CFString, &raw) == .success,
                  raw != nil else { return nil }
            return (raw as! AXUIElement)
        }
        guard let container = parent(of: elements[0]),
              elements.dropFirst().allSatisfy({ element in
                  parent(of: element).map { CFEqual(container, $0) } == true
              }) else { throw AXSemanticActionError.actionUnsupported }

        let attributes = ["AXSelectedRows", kAXSelectedChildrenAttribute as String]
        var attempts: [DeliveryAttempt] = []
        var lastRefusal: AXError?
        for attribute in attributes {
            var settable = DarwinBoolean(false)
            guard AXUIElementIsAttributeSettable(container, attribute as CFString, &settable) == .success,
                  settable.boolValue else {
                attempts.append(.init(
                    path: .axAttribute, primitive: "AXSetAttribute:\(attribute)", outcome: .unavailable
                ))
                continue
            }
            var rawCurrent: CFTypeRef?
            let current = AXUIElementCopyAttributeValue(
                container, attribute as CFString, &rawCurrent
            ) == .success ? (rawCurrent as? [AXUIElement] ?? []) : []
            func same(_ lhs: AXUIElement, _ rhs: AXUIElement) -> Bool { CFEqual(lhs, rhs) }
            var final = current.filter { selected in
                !elements.contains(where: { same(selected, $0) })
            }
            for (index, element) in elements.enumerated() where desired[index] {
                if !final.contains(where: { same(element, $0) }) { final.append(element) }
            }

            try validateBeforeMutation()
            let result = AXUIElementSetAttributeValue(
                container, attribute as CFString, final as CFArray
            )
            guard result == .success else {
                lastRefusal = result
                attempts.append(.init(
                    path: .axAttribute, primitive: "AXSetAttribute:\(attribute)",
                    outcome: .refused, axError: result.rawValue
                ))
                continue
            }
            guard zip(elements, desired).allSatisfy({ pair in
                Self.booleanAttribute(pair.0, kAXSelectedAttribute) == pair.1
            }) else {
                // A successful AX write that did not produce the requested selection is a refusal,
                // not a receipt. This is the exact false-success class conformance guards.
                lastRefusal = .failure
                attempts.append(.init(
                    path: .axAttribute, primitive: "AXSetAttribute:\(attribute)",
                    outcome: .refused, axError: AXError.failure.rawValue
                ))
                continue
            }
            let primitive = "AXSetAttribute:\(attribute)"
            attempts.append(.init(path: .axAttribute, primitive: primitive, outcome: .performed))
            return requests.map { _ in
                AXActionExecution(
                    primitive: primitive,
                    deliveryPath: .axAttribute,
                    attemptedPaths: attempts
                )
            }
        }
        if let lastRefusal { throw AXSemanticActionError.executionFailed(lastRefusal) }
        throw AXSemanticActionError.actionUnsupported
    }

    /// A rung that mutates an AX attribute. Reports `unavailable` rather than failing when the
    /// attribute is not settable, so the ladder can continue to the next rung.
    private static func attributeRung(
        _ element: AXUIElement,
        attribute: String,
        value: @escaping @autoclosure () -> CFTypeRef,
        satisfied: (() -> Bool)? = nil,
        validate: @escaping () throws -> Void
    ) -> AXDeliveryLadder.Rung {
        AXDeliveryLadder.Rung(path: .axAttribute, primitive: "AXSetAttribute:\(attribute)") {
            var settable = DarwinBoolean(false)
            guard AXUIElementIsAttributeSettable(element, attribute as CFString, &settable) == .success,
                  settable.boolValue else { return nil }
            try validate()
            if satisfied?() == true {
                return AXActionExecution(primitive: "\(attribute):satisfied", outcome: .alreadySatisfied)
            }
            let result = AXUIElementSetAttributeValue(element, attribute as CFString, value())
            guard result == .success else { throw AXSemanticActionError.executionFailed(result) }
            return AXActionExecution(primitive: "AXSetAttribute:\(attribute)")
        }
    }

    /// A rung that performs an action the element advertises. Unlike an attribute write, this runs
    /// the control's own handler, so it is preferred wherever conformance has shown both work.
    private static func actionRung(
        _ element: AXUIElement,
        action: String,
        advertised: Set<String>,
        satisfied: (() -> Bool)? = nil,
        validate: @escaping () throws -> Void
    ) -> AXDeliveryLadder.Rung {
        AXDeliveryLadder.Rung(path: .axAction, primitive: action) {
            guard advertised.contains(action) else { return nil }
            try validate()
            if satisfied?() == true {
                return AXActionExecution(primitive: "\(action):satisfied", outcome: .alreadySatisfied)
            }
            let result = Self.performAction(element, action)
            guard result == .success else { throw Self.actionError(result) }
            return AXActionExecution(primitive: action)
        }
    }

    /// How long to wait for an application to answer an *action*.
    ///
    /// Deliberately larger than the 0.5s used for reads. That budget is sized for a bounded tree
    /// walk, where a slow element should be abandoned; an action is different, because
    /// `AXUIElement.h` says applications "often need to perform some sort of modal processing
    /// inside their action callbacks". Waiting longer here is what converts an unknowable outcome
    /// into a known one, so the number is a floor on certainty, not a latency tax: the common case
    /// returns immediately and never observes it. Kept well inside the service's request deadline
    /// (`deadlineMs`, minimum 1ms and validated to 120s) so a slow application cannot outlive the
    /// transport that is waiting on it.
    static let actionMessagingTimeoutSeconds: Float = 2.0

    /// Performs an AX action under the action timeout rather than whatever the element inherited.
    ///
    /// Apple's documented remedy for `kAXErrorCannotComplete` is exactly this — "you may be able to
    /// increase the timeout value (see AXUIElementSetMessagingTimeout)". The timeout is set on the
    /// element itself, which per the header scopes it to that object alone and leaves the read
    /// budget on the application element untouched.
    private static func performAction(_ element: AXUIElement, _ action: String) -> AXError {
        AXUIElementSetMessagingTimeout(element, actionMessagingTimeoutSeconds)
        return AXUIElementPerformAction(element, action as CFString)
    }

    /// Maps a failed action to an error that distinguishes "refused" from "did not answer".
    ///
    /// `kAXErrorCannotComplete` is the one code the header explicitly tells callers not to read as
    /// failure. Everything else is a genuine refusal.
    private static func actionError(_ result: AXError) -> AXSemanticActionError {
        result == .cannotComplete
            ? .executionIndeterminate(result)
            : .executionFailed(result)
    }

    /// Labels a single-rung delivery so every receipt reports a path, not just the ladder-driven ones.
    private static func single(_ execution: AXActionExecution, _ path: DeliveryPath) -> AXActionExecution {
        var execution = execution
        execution.deliveryPath = path
        execution.attemptedPaths = [.init(
            path: path,
            primitive: execution.primitive,
            outcome: execution.outcome == .alreadySatisfied ? .alreadySatisfied : .performed
        )]
        return execution
    }

    private func deliver(
        request: SemanticActionRequest,
        element: AXUIElement,
        liveActions: Set<String>,
        expectedRole: String,
        validate: @escaping () throws -> Void
    ) throws -> AXActionExecution {
        switch request.action {
        case .setValue:
            // Single-rung by design. A control whose AXValue is not settable cannot be *set* to a
            // value by any other rung: AXIncrement steps by an amount the caller did not ask for,
            // and AXPress is a different semantic entirely. Reporting `ax_value_not_settable` is
            // the honest answer, and it is one of the refusals a foreground retry may fix.
            guard let value = request.value else { throw AXSemanticActionError.invalidPayload }
            let encodedValue = try Self.attributeValue(value)
            var settable = DarwinBoolean(false)
            guard AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success,
                  settable.boolValue else { throw AXSemanticActionError.valueNotSettable }
            try validate()
            guard AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, encodedValue) == .success else {
                throw AXSemanticActionError.executionFailed(.failure)
            }
            return Self.single(AXActionExecution(primitive: "AXSetAttribute:AXValue"), .axAttribute)

        case .invoke:
            return try AXDeliveryLadder.walk([
                Self.actionRung(element, action: kAXPressAction as String, advertised: liveActions, validate: validate),
            ])

        case .showMenu:
            // The Accessibility action is the semantic secondary action. Falling back to a
            // coordinate right-click would move global input and would violate background delivery.
            return try AXDeliveryLadder.walk([
                Self.actionRung(element, action: kAXShowMenuAction as String, advertised: liveActions, validate: validate),
            ])

        case .increment:
            return try AXDeliveryLadder.walk([
                Self.actionRung(element, action: kAXIncrementAction as String, advertised: liveActions, validate: validate),
            ])

        case .decrement:
            return try AXDeliveryLadder.walk([
                Self.actionRung(element, action: kAXDecrementAction as String, advertised: liveActions, validate: validate),
            ])

        case .toggle:
            // Press first: it runs the control's own handler, so the application learns about the
            // change. The attribute write is a fallback for controls that expose a settable
            // AXValue and advertise no AXPress, which is the shape that broke `expand` and
            // `select` before conformance caught them.
            let current = Self.booleanAttribute(element, kAXValueAttribute)
            return try AXDeliveryLadder.walk([
                Self.actionRung(element, action: kAXPressAction as String, advertised: liveActions, validate: validate),
                Self.attributeRung(
                    element, attribute: kAXValueAttribute,
                    value: ((current == true ? kCFBooleanFalse : kCFBooleanTrue) as CFTypeRef),
                    validate: validate
                ),
            ])

        case .select:
            // Attribute first, in this order because conformance proved it: an AppKit table row
            // exposes a settable AXSelected and no AXPress, and pressing a row that does advertise
            // AXPress activates it rather than selecting it.
            return try AXDeliveryLadder.walk([
                Self.attributeRung(
                    element, attribute: kAXSelectedAttribute, value: kCFBooleanTrue as CFTypeRef,
                    satisfied: { Self.booleanAttribute(element, kAXSelectedAttribute) == true },
                    validate: validate
                ),
                Self.actionRung(element, action: kAXPressAction as String, advertised: liveActions, validate: validate),
            ])

        case .expand, .collapse:
            let desired = request.action == .expand
            guard let expanded = Self.booleanAttribute(element, kAXExpandedAttribute) else {
                throw AXSemanticActionError.actionUnsupported
            }
            if expanded == desired {
                try validate()
                return Self.single(AXActionExecution(
                    primitive: desired ? "AXExpanded:true" : "AXExpanded:false",
                    outcome: .alreadySatisfied
                ), .axAttribute)
            }
            // Attribute first: NSComboBox exposes AXExpanded and advertises no AXPress, so a
            // press-only implementation could collapse a combo box and never expand one.
            return try AXDeliveryLadder.walk([
                Self.attributeRung(
                    element, attribute: kAXExpandedAttribute,
                    value: ((desired ? kCFBooleanTrue : kCFBooleanFalse) as CFTypeRef),
                    validate: validate
                ),
                Self.actionRung(element, action: kAXPressAction as String, advertised: liveActions, validate: validate),
            ])

        case .setSelected:
            guard case .boolean(let desired)? = request.value else {
                throw AXSemanticActionError.invalidPayload
            }
            var rungs = [Self.attributeRung(
                element, attribute: kAXSelectedAttribute,
                value: ((desired ? kCFBooleanTrue : kCFBooleanFalse) as CFTypeRef),
                satisfied: { Self.booleanAttribute(element, kAXSelectedAttribute) == desired },
                validate: validate
            )]
            // Pressing can only ever select. There is no press that deselects, so the fallback
            // exists for `true` alone rather than pretending to be symmetric.
            if desired {
                rungs.append(Self.actionRung(
                    element, action: kAXPressAction as String, advertised: liveActions,
                    satisfied: { Self.booleanAttribute(element, kAXSelectedAttribute) == true },
                    validate: validate
                ))
            }
            do {
                return try AXDeliveryLadder.walk(rungs)
            } catch AXSemanticActionError.actionUnsupported {
                // Every rung was unavailable. For an explicit set the honest cause is that the
                // attribute is not settable, not that the action does not exist.
                throw AXSemanticActionError.valueNotSettable
            }

        case .scrollToVisible:
            return try AXDeliveryLadder.walk([
                Self.actionRung(element, action: "AXScrollToVisible", advertised: liveActions, validate: validate),
            ])

        case .scrollToFraction:
            guard case .scrollFraction(let fraction)? = request.payload else {
                throw AXSemanticActionError.invalidPayload
            }
            return Self.single(try scrollToFraction(fraction, on: element, validate: validate), .axAttribute)

        case .selectTextRange, .selectText, .setCaret:
            return Self.single(try selectText(request, on: element, validate: validate), .axAttribute)

        case .scrollPage:
            guard case .scroll(let scroll)? = request.payload else { throw AXSemanticActionError.invalidPayload }
            return Self.single(
                try scrollByPage(scroll, on: element, actions: liveActions, validate: validate),
                .axAction
            )

        case .typeText:
            guard case .string(let text)? = request.value else { throw AXSemanticActionError.invalidPayload }
            guard Self.textRoles.contains(expectedRole) else { throw AXSemanticActionError.actionUnsupported }
            return try keyboard.type(
                text, into: element, pid: request.element.pid,
                mechanism: request.deliveryPolicy.requiresApproval ? .globalStream : .targetedProcess,
                validateBeforeMutation: validate
            )
        }
    }

    // MARK: - Text selection

    private func selectText(
        _ request: SemanticActionRequest,
        on element: AXUIElement,
        validate: () throws -> Void
    ) throws -> AXActionExecution {
        guard AXTextPattern.isSelectionSettable(element) else {
            throw AXSemanticActionError.selectionNotSettable
        }
        guard let characterCount = AXTextPattern.characterCount(element) else {
            throw AXSemanticActionError.textUnavailable
        }
        let desired: TextRangeSelection
        switch request.payload {
        case .textRange(let range)?:
            desired = try AXTextPattern.validatedRange(
                location: range.location,
                length: range.length,
                characterCount: characterCount
            )
        case .caret(let placement)?:
            desired = try AXTextPattern.caretRange(placement: placement, characterCount: characterCount)
        case .textMatch(let match)?:
            guard let text = AXTextPattern.stringValue(element) else {
                throw AXSemanticActionError.textUnavailable
            }
            let resolved = try AXTextPattern.resolveMatch(in: text, match: match)
            // `AXNumberOfCharacters` and `AXValue` can disagree in composite controls. Require the
            // resolved offsets to fit both, so a selection is never sent past the live document.
            desired = try AXTextPattern.validatedRange(
                location: resolved.location,
                length: resolved.length,
                characterCount: min(characterCount, (text as NSString).length)
            )
        default:
            throw AXSemanticActionError.invalidPayload
        }

        let current = AXTextPattern.selectedRange(element)
        // Final checkpoint immediately before mutation, after every live read this action needed.
        try validate()
        if current == desired {
            return AXActionExecution(
                primitive: "AXSetAttribute:AXSelectedTextRange",
                outcome: .alreadySatisfied,
                textSelection: TextSelectionReceipt(
                    location: desired.location,
                    length: desired.length,
                    characterCount: characterCount,
                    requested: desired,
                    honored: true
                )
            )
        }
        guard AXTextPattern.setSelectedRange(element, desired) else {
            throw AXSemanticActionError.executionFailed(.failure)
        }
        // Re-read rather than trusting the write. A successful AX call is not evidence that the
        // control moved its selection; when it cannot be re-read, honored stays unknown.
        let applied = AXTextPattern.selectedRange(element)
        return AXActionExecution(
            primitive: "AXSetAttribute:AXSelectedTextRange",
            outcome: .performed,
            textSelection: TextSelectionReceipt(
                location: (applied ?? desired).location,
                length: (applied ?? desired).length,
                characterCount: AXTextPattern.characterCount(element) ?? characterCount,
                requested: desired,
                honored: applied.map { $0 == desired }
            )
        )
    }

    // MARK: - Page scrolling

    private func scrollByPage(
        _ request: ScrollPageSelection,
        on element: AXUIElement,
        actions: Set<String>,
        validate: () throws -> Void
    ) throws -> AXActionExecution {
        let action = AXScrollPattern.action(for: request.direction)
        guard actions.contains(action) else { throw AXSemanticActionError.actionUnsupported }
        let horizontalBefore = AXScrollPattern.horizontalPercent(element)
        let verticalBefore = AXScrollPattern.verticalPercent(element)
        try validate()
        // Was `executionFailed(.failure)`, which threw away the code the application actually
        // returned and reported a generic failure for every cause, including the timeout that is
        // not a failure at all.
        let scrolled = Self.performAction(element, action)
        guard scrolled == .success else { throw Self.actionError(scrolled) }
        let horizontalAfter = AXScrollPattern.horizontalPercent(element)
        let verticalAfter = AXScrollPattern.verticalPercent(element)
        return AXActionExecution(
            primitive: action,
            outcome: .performed,
            scroll: ScrollReceipt(
                direction: request.direction,
                horizontalPercentBefore: horizontalBefore,
                horizontalPercentAfter: horizontalAfter,
                verticalPercentBefore: verticalBefore,
                verticalPercentAfter: verticalAfter,
                changed: Self.scrollChanged(
                    horizontal: (horizontalBefore, horizontalAfter),
                    vertical: (verticalBefore, verticalAfter)
                )
            )
        )
    }

    /// Absolute scroll position through the container's own scroll bar `AXValue`.
    ///
    /// This is the scrolling primitive macOS actually implements. `AXScroll*ByPage` is advertised by
    /// AppKit, SwiftUI, and Electron scroll areas and then returns `kAXErrorFailure` without moving
    /// anything, so `scroll_page` cannot be the default path.
    private func scrollToFraction(
        _ request: ScrollFractionSelection,
        on element: AXUIElement,
        validate: () throws -> Void
    ) throws -> AXActionExecution {
        guard let bar = AXScrollPattern.scrollBar(element, axis: request.axis) else {
            throw AXSemanticActionError.actionUnsupported
        }
        guard AXScrollPattern.isValueSettable(bar) else { throw AXSemanticActionError.valueNotSettable }
        let horizontalBefore = AXScrollPattern.horizontalPercent(element)
        let verticalBefore = AXScrollPattern.verticalPercent(element)
        let before = AXScrollPattern.fraction(bar)
        try validate()
        if let before, before == request.fraction {
            return AXActionExecution(
                primitive: "AXSetAttribute:AXValue(\(AXScrollPattern.attributeName(for: request.axis)))",
                outcome: .alreadySatisfied,
                scroll: ScrollReceipt(
                    axis: request.axis,
                    horizontalPercentBefore: horizontalBefore, horizontalPercentAfter: horizontalBefore,
                    verticalPercentBefore: verticalBefore, verticalPercentAfter: verticalBefore,
                    changed: false, requestedPercent: request.fraction * 100, honored: true
                )
            )
        }
        guard AXScrollPattern.setFraction(bar, request.fraction) else {
            throw AXSemanticActionError.executionFailed(.failure)
        }
        // Re-read: a scroll bar can clamp, and a container can accept the write without moving.
        let applied = AXScrollPattern.fraction(bar)
        let horizontalAfter = AXScrollPattern.horizontalPercent(element)
        let verticalAfter = AXScrollPattern.verticalPercent(element)
        return AXActionExecution(
            primitive: "AXSetAttribute:AXValue(\(AXScrollPattern.attributeName(for: request.axis)))",
            outcome: .performed,
            scroll: ScrollReceipt(
                axis: request.axis,
                horizontalPercentBefore: horizontalBefore, horizontalPercentAfter: horizontalAfter,
                verticalPercentBefore: verticalBefore, verticalPercentAfter: verticalAfter,
                changed: Self.scrollChanged(
                    horizontal: (horizontalBefore, horizontalAfter),
                    vertical: (verticalBefore, verticalAfter)
                ),
                requestedPercent: request.fraction * 100,
                honored: applied.map { abs($0 - request.fraction) < 0.001 }
            )
        )
    }

    /// Nil means "no scrollbar position was comparable", which stays unknown instead of being
    /// reported as a successful movement.
    public static func scrollChanged(
        horizontal: (Double?, Double?),
        vertical: (Double?, Double?)
    ) -> Bool? {
        var comparable = false
        var changed = false
        for (before, after) in [horizontal, vertical] {
            guard let before, let after else { continue }
            comparable = true
            if before != after { changed = true }
        }
        return comparable ? changed : nil
    }

    // MARK: - Pure request policy

    /// Role, secrecy, and payload policy that needs no live Accessibility tree. Running it first
    /// means a malformed or out-of-catalog request never reaches a real element.
    ///
    /// Delivery policy is not checked here. Every policy delivers through the same AX call; what
    /// differs is whether the coordinator was allowed to put the application in front first, which
    /// `BimaxCuServiceCore` authorizes before any of this runs. This engine's contract is the same
    /// under all of them: it posts no event and moves no cursor.
    public static func validateRequestShape(_ request: SemanticActionRequest, expected: AXNode) throws {
        guard request.element == expected.elementRef, expected.enabled else {
            throw AXSemanticActionError.liveIdentityMismatch
        }
        switch request.action {
        case .setValue:
            guard Self.valueRoles.contains(expected.role), let value = request.value else {
                throw AXSemanticActionError.invalidPayload
            }
            try requireNoPayload(request)
            try requireNotSecure(expected)
            try validateValue(value, forRole: expected.role)
        case .invoke, .showMenu, .increment, .decrement:
            try requireNoValue(request)
            try requireNoPayload(request)
        case .toggle:
            try requireNoValue(request)
            try requireNoPayload(request)
            guard Self.toggleRoles.contains(expected.role) else { throw AXSemanticActionError.actionUnsupported }
        case .select:
            try requireNoValue(request)
            try requireNoPayload(request)
            guard Self.selectionRoles.contains(expected.role) else { throw AXSemanticActionError.actionUnsupported }
        case .expand, .collapse:
            try requireNoValue(request)
            try requireNoPayload(request)
        case .selectTextRange, .selectText, .setCaret:
            try requireNoValue(request)
            try requireNotSecure(expected)
            guard Self.textRoles.contains(expected.role) else { throw AXSemanticActionError.actionUnsupported }
            switch (request.action, request.payload) {
            case (.selectTextRange, .textRange(let range)?):
                guard range.location >= 0, range.length >= 0 else {
                    throw AXSemanticActionError.textRangeOutOfBounds
                }
            case (.selectText, .textMatch(let match)?):
                try validateNeedleShape(match)
            case (.setCaret, .caret(let placement)?):
                switch placement.anchor {
                case .index:
                    guard let index = placement.index else { throw AXSemanticActionError.invalidPayload }
                    guard index >= 0 else { throw AXSemanticActionError.textRangeOutOfBounds }
                case .start, .end:
                    guard placement.index == nil else { throw AXSemanticActionError.invalidPayload }
                }
            default:
                throw AXSemanticActionError.invalidPayload
            }
        case .scrollPage:
            try requireNoValue(request)
            guard case .scroll? = request.payload else { throw AXSemanticActionError.invalidPayload }
            try requireNotSecure(expected)
        case .setSelected:
            try requireNoPayload(request)
            try requireNotSecure(expected)
            guard case .boolean? = request.value else { throw AXSemanticActionError.invalidPayload }
        case .scrollToVisible:
            try requireNoValue(request)
            try requireNoPayload(request)
            try requireNotSecure(expected)
        case .scrollToFraction:
            try requireNoValue(request)
            try requireNotSecure(expected)
            guard case .scrollFraction(let scroll)? = request.payload else {
                throw AXSemanticActionError.invalidPayload
            }
            guard scroll.fraction.isFinite, (0...1).contains(scroll.fraction) else {
                throw AXSemanticActionError.invalidPayload
            }
        case .typeText:
            try requireNoPayload(request)
            // Typing into a secure field is the one path that would put a real secret into a real
            // keystroke stream. It stays behind the same refusal as every other secret write.
            try requireNotSecure(expected)
            guard Self.textRoles.contains(expected.role) else {
                throw AXSemanticActionError.actionUnsupported
            }
            guard case .string(let text)? = request.value, !text.isEmpty, !text.contains("\0"),
                  (text as NSString).length <= 4_096 else {
                throw AXSemanticActionError.invalidPayload
            }
        }
    }

    private static func validateNeedleShape(_ match: TextMatchSelection) throws {
        for needle in [match.text, match.prefix, match.suffix].compactMap({ $0 }) {
            guard !needle.isEmpty, !needle.contains("\0") else { throw AXSemanticActionError.invalidPayload }
            guard (needle as NSString).length <= AXTextLimits.maxNeedleCharacters else {
                throw AXSemanticActionError.textTooLarge
            }
        }
    }

    private static func requireNotSecure(_ expected: AXNode) throws {
        let secure = expected.role.localizedCaseInsensitiveContains("secure")
            || expected.subrole?.localizedCaseInsensitiveContains("secure") == true
        guard !secure else { throw AXSemanticActionError.sensitiveElement }
    }


    private static func requireNoValue(_ request: SemanticActionRequest) throws {
        guard request.value == nil else { throw AXSemanticActionError.invalidPayload }
    }

    private static func requireNoPayload(_ request: SemanticActionRequest) throws {
        guard request.payload == nil else { throw AXSemanticActionError.invalidPayload }
    }

    private static func actionNames(_ element: AXUIElement) -> Set<String> {
        var raw: CFArray?
        guard AXUIElementCopyActionNames(element, &raw) == .success else { return [] }
        return Set(raw as? [String] ?? [])
    }

    private static func booleanAttribute(_ element: AXUIElement, _ attribute: String) -> Bool? {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success,
              let number = raw as? NSNumber else { return nil }
        return number.boolValue
    }

    private static func attributeValue(_ value: SemanticValue) throws -> CFTypeRef {
        switch value {
        case .string(let value):
            guard value.count <= 16_384, !value.contains("\0") else {
                throw AXSemanticActionError.invalidPayload
            }
            return value as CFString
        case .number(let value):
            guard value.isFinite else { throw AXSemanticActionError.invalidPayload }
            return NSNumber(value: value)
        case .boolean(let value):
            return value ? kCFBooleanTrue : kCFBooleanFalse
        }
    }

    private static func validateValue(_ value: SemanticValue, forRole role: String) throws {
        switch (role, value) {
        case ("AXSlider", .number), ("AXIncrementor", .number): return
        case ("AXTextField", .string), ("AXTextArea", .string),
             ("AXSearchField", .string), ("AXComboBox", .string): return
        default: throw AXSemanticActionError.invalidPayload
        }
    }
}
