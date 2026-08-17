import AppKit
import ApplicationServices
import Foundation
import BimaxCuProtocol
import BimaxComputerUseKit

/// Drives every advertised semantic action against a real Accessibility server and reports which
/// ones actually work.
///
/// The service must not advertise a capability it has never performed. Offline tests use synthetic
/// nodes and have twice passed while the real path was inert — once because scroll containers were
/// never emitted, once because a toolkit returned success and ignored the write. This harness is
/// the check that catches that class of defect.
///
/// It is intended for `BimaxCuFixture.app`, whose controls are inert by construction. Pointing it
/// at an arbitrary application would press that application's real buttons.
enum CatalogConformance {
    struct Result: Codable {
        var action: String
        var status: String
        var targetRole: String?
        var targetIdentifier: String?
        var primitive: String?
        /// Which ladder rung delivered, and every rung walked to get there. An action that reaches
        /// its second rung is telling you the first is unavailable on that control — the signal
        /// that press-only `expand` and `select` were missing before conformance existed.
        var deliveryPath: String?
        var attemptedPaths: [String]?
        var outcome: String?
        var honored: Bool?
        var effectObserved: Bool?
        var errorCode: String?
        var errorMessage: String?
    }

    struct Report: Codable {
        var status: String
        var reason: String?
        var bundleId: String?
        var observedNodes: Int?
        /// Fixture-only proof for Phase 12.4: a control whose visible sibling owns its name.
        var titleUIElementLabel: String?
        var titleUIElementLabelsVerified: Bool?
        var results: [Result] = []
        var verified: [String] = []
        var unverified: [String] = []
        /// What the handshake currently tells clients it has verified.
        var declaredVerified: [String] = []
        /// Declared verified but not reproduced by this run. The reason this harness exists.
        var overclaimed: [String] = []
        var transactionResults: [TransactionResult] = []
        /// True when the handshake advertises semantic transactions but this run could not
        /// reproduce both the multi-edit and additive multi-select templates.
        var transactionsOverclaimed = false
    }

    struct TransactionResult: Codable {
        var kind: String
        var status: String
        var completedSteps: [String] = []
        var effectsObserved: Bool?
        var errorCode: String?
        var errorMessage: String?
    }

    private struct Probe {
        var action: SemanticActionKind
        var identifier: String
        var role: String
        /// Which occurrence of `role` to target when no identifier matches. Rows carry no usable
        /// AX identifier, so they are addressed positionally.
        var occurrence: Int = 0
        var value: SemanticValue?
        var payload: SemanticActionPayload?
        var deliveryPolicy: SemanticDeliveryPolicy = .backgroundNative
        /// Reads a field of the live node that must change for the action to have had an effect.
        var effect: ((AXNode) -> String)?
    }

    static func run(bundleId: String) -> Report {
        var report = Report(status: "skipped", bundleId: bundleId)
        guard AXIsProcessTrusted() else {
            report.reason = "accessibility_not_granted"
            return report
        }
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else {
            report.reason = "target_not_running"
            return report
        }
        let pid = app.processIdentifier
        let core = BimaxCuServiceCore()
        guard case .session(let session) = core.handle(RequestEnvelope(
            requestId: "conf-create", sessionId: "bootstrap", deadlineMs: 10_000,
            body: .sessionCreate(requestedId: "catalog-conformance")
        )).body else {
            report.reason = "session_create_failed"
            return report
        }
        guard case .workspace(let workspace) = core.handle(RequestEnvelope(
            requestId: "conf-workspace", sessionId: session.sessionId, deadlineMs: 10_000,
            body: .workspaceSnapshot(.init(pid: pid, includeOffscreenWindows: true))
        )).body else {
            report.reason = "workspace_snapshot_failed"
            return report
        }
        let windows = workspace.windows.filter {
            $0.window.pid == pid && $0.bounds.width > 64 && $0.bounds.height > 64
        }
        guard let window = windows.first(where: { $0.onScreen }) ?? windows.first else {
            report.reason = "no_target_window"
            return report
        }

        // Read this before any action mutates the fixture. The catalog already depends on the real
        // accessibility server; carrying the names here makes the title-reference port live-proven
        // instead of relying only on a pure precedence test.
        if bundleId == "ai.bimax.cu.fixture" {
            do {
                let snapshot = try AccessibilityEngine().observe(
                    sessionId: "catalog-title-ui-element",
                    request: .init(
                        pid: pid, windowId: window.window.windowId,
                        windowGeneration: window.window.generation, scope: .window,
                        profile: "balanced", maxElements: 500
                    )
                )
                let linked = snapshot.nodes.first { $0.identifier == "fixture-linked-button" }
                report.titleUIElementLabel = linked?.label
                report.titleUIElementLabelsVerified = linked?.role == "AXButton"
                    && linked?.label == "Linked Fixture Control"
            } catch {
                report.titleUIElementLabelsVerified = false
            }
        }

        let probes: [Probe] = [
            .init(action: .invoke, identifier: "fixture-button", role: "AXButton",
                  effect: nil),
            // NSPopUpButton advertises AXShowMenu. This is the semantic secondary action; the
            // harness deliberately does not synthesize a coordinate right-click.
            .init(action: .showMenu, identifier: "fixture-popup", role: "AXPopUpButton"),
            .init(action: .toggle, identifier: "fixture-checkbox", role: "AXCheckBox",
                  effect: { $0.value ?? "" }),
            .init(action: .setValue, identifier: "fixture-textfield", role: "AXTextField",
                  value: .string("conformance"), effect: { $0.value ?? "" }),
            .init(action: .setValue, identifier: "fixture-slider", role: "AXSlider",
                  value: .number(75), effect: { $0.value ?? "" }),
            .init(action: .increment, identifier: "fixture-stepper", role: "AXIncrementor",
                  effect: { $0.value ?? "" }),
            .init(action: .decrement, identifier: "fixture-stepper", role: "AXIncrementor",
                  effect: { $0.value ?? "" }),
            .init(action: .setCaret, identifier: "fixture-textview", role: "AXTextArea",
                  payload: .caret(.init(anchor: .start))),
            .init(action: .selectTextRange, identifier: "fixture-textview", role: "AXTextArea",
                  payload: .textRange(.init(location: 0, length: 5))),
            .init(action: .selectText, identifier: "fixture-textview", role: "AXTextArea",
                  payload: .textMatch(.init(text: "beta"))),
            .init(action: .setSelected, identifier: "", role: "AXRow", occurrence: 3,
                  value: .boolean(true), effect: { $0.selected ? "selected" : "unselected" }),
            .init(action: .scrollToVisible, identifier: "", role: "AXRow", occurrence: 1),
            .init(action: .scrollToFraction, identifier: "fixture-scroll", role: "AXScrollArea",
                  payload: .scrollFraction(.init(axis: .vertical, fraction: 0.5))),
            .init(action: .scrollPage, identifier: "fixture-scroll", role: "AXScrollArea",
                  payload: .scroll(.init(direction: .down))),
            .init(action: .expand, identifier: "fixture-combo", role: "AXComboBox"),
            .init(action: .collapse, identifier: "fixture-combo", role: "AXComboBox"),
            .init(action: .select, identifier: "", role: "AXRow", occurrence: 5),
            // Ladder fallthrough. A row answers `select` on rung one; a radio button is expected to
            // refuse the settable-attribute rung and answer AXPress, which is the only live proof
            // that the ladder walks instead of always succeeding on its first rung.
            .init(action: .select, identifier: "fixture-radio-two", role: "AXRadioButton",
                  effect: { $0.value ?? "" }),
            // Real keystrokes, delivered to the fixture process by name rather than by focus.
            .init(action: .typeText, identifier: "fixture-textview", role: "AXTextArea",
                  value: .string("Bimax é→ 型"), deliveryPolicy: .foregroundOnce,
                  effect: { $0.value ?? "" }),
        ]

        report.status = "ran"
        for probe in probes {
            let result = attempt(probe, core: core, sessionId: session.sessionId, pid: pid, window: window)
            report.observedNodes = report.observedNodes ?? result.observedNodes
            report.results.append(result.result)
        }
        report.transactionResults = [
            attemptTransaction(
                kind: "multi_edit", core: core, sessionId: session.sessionId,
                pid: pid, window: window
            ),
            attemptTransaction(
                kind: "multi_select", core: core, sessionId: session.sessionId,
                pid: pid, window: window
            ),
        ]
        // A delivery receipt is necessary, not sufficient. Some platform APIs report success while
        // the target ignores the operation (notably targeted keyboard events on newer macOS
        // releases). Never turn that transport-level acknowledgement into a verified capability
        // when either the receipt read-back or this harness's independent postcondition is false.
        let performed = Set(report.results.filter {
            $0.status == "performed" && $0.honored != false && $0.effectObserved != false
        }.map(\.action))
        report.verified = SemanticActionKind.allCases.map(\.rawValue).filter { performed.contains($0) }
        report.unverified = SemanticActionKind.allCases.map(\.rawValue).filter { !performed.contains($0) }
        // An action the platform will not honor is reported unverified and stops being claimed,
        // exactly as `scroll_page` is. Claiming one this run could not reproduce is the failure.
        let declared = core.handshakeResponse().capabilities.delivery
        report.declaredVerified = declared.verifiedSemanticActions
        report.overclaimed = report.declaredVerified.filter { !report.verified.contains($0) }
        report.transactionsOverclaimed = declared.semanticTransactions
            && report.transactionResults.contains { $0.status != "performed" || $0.effectsObserved != true }
        _ = core.handle(RequestEnvelope(
            requestId: "conf-close", sessionId: session.sessionId, deadlineMs: 10_000, body: .sessionClose
        ))
        return report
    }

    private static func attemptTransaction(
        kind: String,
        core: BimaxCuServiceCore,
        sessionId: String,
        pid: Int32,
        window: WindowInfo
    ) -> TransactionResult {
        var result = TransactionResult(kind: kind, status: "skipped")
        func observe() -> AXSnapshot? {
            guard case .workspace(let workspace) = core.handle(RequestEnvelope(
                requestId: "conf-transaction-window-\(kind)", sessionId: sessionId, deadlineMs: 10_000,
                body: .workspaceSnapshot(.init(pid: pid, includeOffscreenWindows: true))
            )).body else { return nil }
            let windows = workspace.windows.filter {
                $0.window.pid == pid && $0.bounds.width > 64 && $0.bounds.height > 64
            }
            guard let live = windows.first(where: { $0.window.windowId == window.window.windowId })
                    ?? windows.first(where: \.onScreen) ?? windows.first else { return nil }
            let response = core.handle(RequestEnvelope(
                requestId: "conf-transaction-observe-\(kind)", sessionId: sessionId, deadlineMs: 10_000,
                body: .axObserve(.init(
                    pid: pid, windowId: live.window.windowId,
                    windowGeneration: live.window.generation, scope: .window,
                    profile: "balanced", maxElements: 500
                ))
            ))
            guard case .axSnapshot(let snapshot) = response.body else {
                result.errorCode = response.error?.code ?? "observe_failed"
                result.errorMessage = response.error?.message
                return nil
            }
            return snapshot
        }
        guard let before = observe() else { return result }

        let targets: [AXNode]
        let steps: [SemanticTransactionStep]
        switch kind {
        case "multi_edit":
            guard let field = before.nodes.first(where: {
                $0.role == "AXTextField" && ($0.identifier == "fixture-textfield" || $0.label == "fixture-textfield")
            }), let area = before.nodes.first(where: {
                $0.role == "AXTextArea" && ($0.identifier == "fixture-textview" || $0.label == "fixture-textview")
            }), let fieldRef = field.elementRef, let areaRef = area.elementRef else {
                result.errorCode = "transaction_targets_not_found"
                return result
            }
            targets = [field, area]
            steps = [
                .init(stepId: "edit-field", element: fieldRef, action: .setValue,
                      value: .string("transaction field"),
                      precondition: .init(expectedRole: "AXTextField", expectedValue: field.value)),
                .init(stepId: "edit-area", element: areaRef, action: .setValue,
                      value: .string("transaction area"),
                      precondition: .init(expectedRole: "AXTextArea", expectedValue: area.value)),
            ]
        case "multi_select":
            let rows = before.nodes.filter { $0.role == "AXRow" && $0.elementRef != nil && !$0.selected }
            guard rows.count >= 2, let firstRef = rows[0].elementRef, let secondRef = rows[1].elementRef else {
                result.errorCode = "transaction_targets_not_found"
                return result
            }
            targets = [rows[0], rows[1]]
            steps = [
                .init(stepId: "select-one", element: firstRef, action: .setSelected,
                      value: .boolean(true), precondition: .init(expectedSelected: false)),
                .init(stepId: "select-two", element: secondRef, action: .setSelected,
                      value: .boolean(true), precondition: .init(expectedSelected: false)),
            ]
        default:
            result.errorCode = "unknown_transaction_kind"
            return result
        }

        var transaction = SemanticTransactionRequest(
            basedOnSnapshotId: before.snapshotId,
            steps: steps,
            deliveryPolicy: .backgroundOnly,
            approvalManifestHash: ""
        )
        do {
            transaction.approvalManifestHash = try transaction.computedManifestHash()
        } catch {
            result.errorCode = "manifest_failed"
            result.errorMessage = String(describing: error)
            return result
        }
        let response = core.handle(RequestEnvelope(
            requestId: "conf-transaction-run-\(kind)", sessionId: sessionId, deadlineMs: 10_000,
            body: .semanticTransaction(transaction)
        ))
        guard case .semanticTransactionReceipt(let receipt) = response.body else {
            result.status = "refused"
            result.errorCode = response.error?.code
            result.errorMessage = response.error?.message
            return result
        }
        result.completedSteps = receipt.steps.map(\.stepId)
        guard receipt.outcome == .completed else {
            result.status = "stopped"
            result.errorCode = receipt.failure?.code
            result.errorMessage = receipt.failure?.message
            return result
        }
        result.status = "performed"
        Thread.sleep(forTimeInterval: 0.25)
        guard let after = observe() else { return result }
        let beforeStates = Dictionary(uniqueKeysWithValues: targets.map {
            ($0.stablePathHash, kind == "multi_select" ? String($0.selected) : ($0.value ?? ""))
        })
        let afterStates = Dictionary(uniqueKeysWithValues: after.nodes.map {
            ($0.stablePathHash, kind == "multi_select" ? String($0.selected) : ($0.value ?? ""))
        })
        result.effectsObserved = beforeStates.allSatisfy { entry in
            afterStates[entry.key].map { $0 != entry.value } == true
        }
        return result
    }

    private static func attempt(
        _ probe: Probe,
        core: BimaxCuServiceCore,
        sessionId: String,
        pid: Int32,
        window: WindowInfo
    ) -> (result: Result, observedNodes: Int?) {
        var result = Result(action: probe.action.rawValue, status: "skipped")
        // Re-resolve the window each time. A generation-bound ref is meant to go stale, and a run
        // that pins one for its whole duration is testing the harness rather than the service.
        func liveWindow() -> WindowInfo? {
            guard case .workspace(let workspace) = core.handle(RequestEnvelope(
                requestId: "conf-window-\(probe.action.rawValue)", sessionId: sessionId, deadlineMs: 10_000,
                body: .workspaceSnapshot(.init(pid: pid, includeOffscreenWindows: true))
            )).body else { return nil }
            let candidates = workspace.windows.filter {
                $0.window.pid == pid && $0.bounds.width > 64 && $0.bounds.height > 64
            }
            return candidates.first(where: { $0.window.windowId == window.window.windowId })
                ?? candidates.first(where: \.onScreen) ?? candidates.first
        }
        var observeError: String?
        func observe() -> AXSnapshot? {
            guard let live = liveWindow() else { observeError = "window_not_found"; return nil }
            let response = core.handle(RequestEnvelope(
                requestId: "conf-observe-\(probe.action.rawValue)", sessionId: sessionId, deadlineMs: 10_000,
                body: .axObserve(.init(
                    pid: pid, windowId: live.window.windowId,
                    windowGeneration: live.window.generation, scope: .window,
                    profile: "balanced", maxElements: 500
                ))
            ))
            guard case .axSnapshot(let snapshot) = response.body else {
                // Surface the service's reason. A harness that reports its own generic code cannot
                // tell a broken probe from a broken service.
                observeError = response.error?.code ?? "observe_failed"
                return nil
            }
            return snapshot
        }
        guard let snapshot = observe() else {
            result.errorCode = observeError ?? "observe_failed"
            result.errorMessage = "the fixture window could not be observed"
            return (result, nil)
        }
        let byRole = snapshot.nodes.filter { $0.role == probe.role }
        let identified = snapshot.nodes.first {
            $0.role == probe.role && ($0.identifier == probe.identifier || $0.label == probe.identifier)
        }
        let positional = byRole.count > probe.occurrence ? byRole[probe.occurrence] : nil
        guard let node = identified ?? positional, let ref = node.elementRef else {
            result.errorCode = "no_\(probe.role)_in_fixture"
            return (result, snapshot.nodes.count)
        }
        result.targetRole = node.role
        result.targetIdentifier = node.identifier
        let before = probe.effect?(node)
        // A probe that promises an observable postcondition starts failed and is promoted only by
        // the independent read-back below. If re-observation itself fails, nil must not accidentally
        // count as proof.
        if probe.effect != nil {
            result.effectObserved = false
        }

        let approval: ForegroundApproval?
        if probe.deliveryPolicy.requiresApproval {
            // Establish the approved foreground target before starting the quiet interval. If the
            // service has to activate after this wait, macOS may count that transition as fresh
            // session activity and the human-input gate will correctly refuse it. The service's
            // lease then observes the fixture already in front and performs no redundant mutation.
            if let target = NSRunningApplication(processIdentifier: pid) {
                if #available(macOS 14.0, *) { target.activate() }
                else { target.activate(options: [.activateIgnoringOtherApps]) }
            }
            let focusDeadline = Date().addingTimeInterval(3)
            while WorkspaceInventory.frontmostPid() != pid, Date() < focusDeadline {
                Thread.sleep(forTimeInterval: 0.02)
            }
            // Do not bypass the real quiet gate: this only makes the fixture's explicit foreground
            // transition precede the period that gate measures.
            Thread.sleep(forTimeInterval: 1.25)
            let now = Int64(Date().timeIntervalSince1970 * 1_000)
            approval = ForegroundApproval(
                approvalId: UUID().uuidString.lowercased(), policy: probe.deliveryPolicy,
                targetPid: pid, targetWindowId: window.window.windowId,
                grantedAtMs: now, expiresAtMs: now + 30_000
            )
        } else {
            approval = nil
        }
        let response = core.handle(RequestEnvelope(
            requestId: "conf-act-\(probe.action.rawValue)", sessionId: sessionId, deadlineMs: 10_000,
            body: .semanticAction(.init(
                element: ref, action: probe.action, value: probe.value, payload: probe.payload,
                expectedEventRevision: snapshot.eventRevision,
                deliveryPolicy: probe.deliveryPolicy, approval: approval
            ))
        ))
        guard case .semanticActionReceipt(let receipt) = response.body else {
            result.status = "refused"
            result.errorCode = response.error?.code
            result.errorMessage = response.error?.message
            return (result, snapshot.nodes.count)
        }
        result.status = "performed"
        result.primitive = receipt.primitive
        result.deliveryPath = receipt.deliveryPath?.rawValue
        result.attemptedPaths = receipt.attemptedPaths.map { "\($0.path.rawValue):\($0.outcome.rawValue)" }
        result.outcome = receipt.outcome.rawValue
        result.honored = receipt.textSelection?.honored ?? receipt.scroll?.honored ?? receipt.typedText?.honored

        // Confirm a real effect where one is observable, rather than trusting the receipt.
        if let effect = probe.effect, let before {
            Thread.sleep(forTimeInterval: 0.25)
            if let after = observe()?.nodes.first(where: { $0.stablePathHash == ref.stablePathHash }) {
                result.effectObserved = effect(after) != before
            }
        }
        return (result, snapshot.nodes.count)
    }
}
