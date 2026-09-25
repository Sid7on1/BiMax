// bimax-notch — God's Land, stage 1: the notch itself (docs/product-reset/gods-land/03_PLAN.md).
//
// The notch talks; it never listens. It shows what Bimax has to say, the ⌘2 tasks and (later) files and suggestions,
// and anything that needs the person's words drops down into a ⌘2 thread. So this helper takes no text input, has no
// shortcut and never calls a model: it opens when the cursor reaches the notch, closes when it leaves, and speaks up
// by itself when the app tells it something happened.
//
// Protocol: one JSON object per line.
//   in  (stdin, from Electron main):  {"t":"content","active":n,"waiting":n,"tasks":[{"id","title","state","detail"}]}
//                                     {"t":"say","text":"…","tone":"done|waiting|failed|info","seconds":n}
//                                     {"t":"quit"}
//   out (stdout):                     {"t":"ready","hasNotch":bool,"notchWidth":n,"notchHeight":n}
//                                     {"t":"open-task","id":"…"}   {"t":"hover","open":bool}
// When stdin closes (the app quit or crashed) the helper exits: it must never outlive Bimax.
//
// Built by app/scripts/build-notch.sh with the vendored DynamicNotchKit (Vendor/DynamicNotchKit, MIT, see
// BIMAX_CHANGES.md there). Flags: --selftest prints the geometry and checks the protocol parser, then exits;
// --demo shows sample content without Electron, for measuring and looking.

import AppKit
import SwiftUI
import PDFKit
import ImageIO
import UniformTypeIdentifiers

// MARK: - Model

enum Tone: String {
    case done, waiting, failed, info

    var symbol: String {
        switch self {
        case .done: return "checkmark.circle.fill"
        case .waiting: return "hand.raised.fill"
        case .failed: return "xmark.octagon.fill"
        case .info: return "sparkle"
        }
    }

    var color: Color {
        switch self {
        case .done: return Color(red: 0.19, green: 0.82, blue: 0.35)
        case .waiting: return Color(red: 1.0, green: 0.84, blue: 0.04)
        case .failed: return Color(red: 1.0, green: 0.27, blue: 0.23)
        case .info: return Color(red: 0.35, green: 0.78, blue: 0.98)
        }
    }
}

struct TaskRow: Identifiable, Equatable {
    let id: String
    let title: String
    /// working | waiting | done | failed | idle
    let state: String
    let detail: String

    var tone: Tone? {
        switch state {
        case "working": return .info
        case "waiting": return .waiting
        case "done": return .done
        case "failed": return .failed
        default: return nil
        }
    }

    var stateWord: String {
        switch state {
        case "working": return "working"
        case "waiting": return "needs you"
        case "done": return "done"
        case "failed": return "failed"
        default: return "idle"
        }
    }
}

struct Say: Equatable {
    let id = UUID()
    let text: String
    let tone: Tone
}

final class NotchModel: ObservableObject {
    @Published var tasks: [TaskRow] = []
    @Published var active = 0
    @Published var waiting = 0
    @Published var say: Say?
    /// Stage 4: the notch's material (Glass.swift), decided by the app (glass.ts).
    @Published var glass = Glass()
    // Stage 5: tabs and the clipboard (Clipboard.swift).
    @Published var tab: NotchTab = .now
    @Published var clips: [ClipCard] = []
    @Published var clipEnabled = false
    @Published var clipAccess = ClipboardWatch.accessBehavior
    // Stage 6: secrets, masked; at most one revealed at a time, and only while pressed (Secrets.swift).
    @Published var secrets: [SecretItem] = []
    @Published var revealed: Revealed?
    // Stage 7: the selected shelf card, and the cards whose conversion is running.
    @Published var selectedCard: String?
    // Stage 8: recall (Recall.swift) — "Probably next" on Now, and files by the cues people remember.
    @Published var recallEnabled = true
    @Published var recallLabel = "Recent"
    @Published var recallNext: [ShelfCard] = []
    @Published var recallGroups: [RecallGroup] = []
    @Published var working: Set<String> = []
    // The shelf (Shelf.swift, stage 2).
    @Published var shelf: [ShelfCard] = []
    @Published var archived: [ShelfCard] = []
    @Published var dragging = false
    @Published var draggingOut = false
    @Published var dropTargeted = false
    @Published var editTargeted = false
    @Published var showArchive = false
    /// Card frames in the panel's SwiftUI space, reported for the on-screen check (not published: no redraws).
    var cardFrames: [String: CGRect] = [:]

    var summary: String {
        if active == 0 { return "All quiet" }
        let running = "\(active) task\(active == 1 ? "" : "s") running"
        return waiting > 0 ? "\(running) · \(waiting) need\(waiting == 1 ? "s" : "") you" : running
    }
}

// MARK: - Protocol

enum Inbound: Equatable {
    case content(active: Int, waiting: Int, tasks: [TaskRow], glass: Glass)
    case say(text: String, tone: Tone, seconds: Double)
    case shelf(items: [ShelfCard], archived: [ShelfCard])
    /// Play the Droplet to where the ⌘2 bar opens: Electron screen coordinates (top-left origin of the main display).
    case droplet(to: CGRect, icon: String?)
    case clipConfig(enabled: Bool)
    case clips(enabled: Bool, items: [ClipCard])
    case secrets(items: [SecretItem])
    case secret(id: String, purpose: String, value: String?)
    case transmuteRun(id: String, action: String, source: String, out: String, label: String)
    case recall(enabled: Bool, label: String, next: [ShelfCard], groups: [RecallGroup])
    case quit
}

/// Parses one line from the app. Unknown or malformed lines are ignored rather than fatal: a newer app may send
/// messages an older helper does not know.
func parseInbound(_ line: String) -> Inbound? {
    guard let data = line.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let type = object["t"] as? String else { return nil }
    switch type {
    case "content":
        let rows = (object["tasks"] as? [[String: Any]] ?? []).compactMap { row -> TaskRow? in
            guard let id = row["id"] as? String, let title = row["title"] as? String else { return nil }
            return TaskRow(id: id, title: title, state: row["state"] as? String ?? "idle", detail: row["detail"] as? String ?? "")
        }
        let glassObject = object["glass"] as? [String: Any]
        let glass = Glass(state: GlassState(rawValue: glassObject?["state"] as? String ?? "") ?? .water,
                          label: glassObject?["label"] as? String ?? "All quiet")
        return .content(active: object["active"] as? Int ?? 0, waiting: object["waiting"] as? Int ?? 0, tasks: rows, glass: glass)
    case "say":
        guard let text = object["text"] as? String, !text.isEmpty else { return nil }
        let seconds = (object["seconds"] as? Double) ?? Double(object["seconds"] as? Int ?? 4)
        return .say(text: text, tone: Tone(rawValue: object["tone"] as? String ?? "info") ?? .info, seconds: min(max(seconds, 1), 30))
    case "shelf":
        let items = (object["items"] as? [[String: Any]] ?? []).compactMap(ShelfCard.init(json:))
        let archived = (object["archived"] as? [[String: Any]] ?? []).compactMap(ShelfCard.init(json:))
        return .shelf(items: items, archived: archived)
    case "droplet":
        guard let to = object["to"] as? [String: Any], let x = to["x"] as? Double, let y = to["y"] as? Double,
              let width = to["width"] as? Double, let height = to["height"] as? Double, width > 0, height > 0 else { return nil }
        return .droplet(to: CGRect(x: x, y: y, width: width, height: height), icon: object["icon"] as? String)
    case "clip-config":
        return .clipConfig(enabled: object["enabled"] as? Bool ?? false)
    case "clips":
        return .clips(enabled: object["enabled"] as? Bool ?? false, items: (object["items"] as? [[String: Any]] ?? []).compactMap(ClipCard.init(json:)))
    case "secrets":
        return .secrets(items: (object["items"] as? [[String: Any]] ?? []).compactMap(SecretItem.init(json:)))
    case "secret":
        guard let id = object["id"] as? String else { return nil }
        return .secret(id: id, purpose: object["purpose"] as? String == "copy" ? "copy" : "reveal", value: object["value"] as? String)
    case "transmute-run":
        guard let id = object["id"] as? String, let action = object["action"] as? String, let source = object["source"] as? String,
              let out = object["out"] as? String else { return nil }
        return .transmuteRun(id: id, action: action, source: source, out: out, label: object["label"] as? String ?? action)
    case "recall":
        let next = object["next"] as? [String: Any]
        return .recall(enabled: object["enabled"] as? Bool ?? false, label: next?["label"] as? String ?? "Recent",
                       next: (next?["items"] as? [[String: Any]] ?? []).compactMap(ShelfCard.init(json:)),
                       groups: (object["groups"] as? [[String: Any]] ?? []).compactMap(RecallGroup.init(json:)))
    case "quit":
        return .quit
    default:
        return nil
    }
}

enum Outbox {
    private static let lock = NSLock()

    static func send(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object), var line = String(data: data, encoding: .utf8) else { return }
        line += "\n"
        lock.lock()
        FileHandle.standardOutput.write(line.data(using: .utf8)!)
        lock.unlock()
    }
}

// MARK: - Geometry

struct NotchGeometry {
    let screen: NSScreen
    let hasNotch: Bool
    /// Where the cursor opens the notch.
    let trigger: NSRect
    /// Where a cursor carrying a drag opens it: wider and deeper, so a drop does not need precision.
    var dragTrigger: NSRect { trigger.insetBy(dx: -90, dy: 0).offsetBy(dx: 0, dy: -60).union(trigger.insetBy(dx: -90, dy: 0)) }

    /// The built-in notched display if there is one, else the main display.
    static func current() -> NotchGeometry? {
        guard let screen = NSScreen.screens.first(where: { $0.hasNotch }) ?? NSScreen.main ?? NSScreen.screens.first else { return nil }
        return NotchGeometry(screen: screen)
    }

    init(screen: NSScreen) {
        self.screen = screen
        if let notch = screen.notchFrame, screen.hasNotch {
            hasNotch = true
            // A little wider than the hardware and a little lower, so the notch is easy to reach (research 02 §2: the
            // cursor cannot be slowed near it, so the target grows instead).
            trigger = NSRect(x: notch.minX - 12, y: notch.minY - 6, width: notch.width + 24, height: notch.height + 6)
        } else {
            hasNotch = false
            // No notch: the top edge's middle 300 points, the height of a few pixels, like a hot corner.
            trigger = NSRect(x: screen.frame.midX - 150, y: screen.frame.maxY - 4, width: 300, height: 4)
        }
    }
}

/// The drawn content in screen coordinates, from its frame in the panel's SwiftUI space (top-left origin) and the
/// panel's frame, with a small margin so the cursor can cross the notch's soft edge without the panel going deaf.
func contentRectOnScreen(content: CGRect, window: NSRect, margin: CGFloat = 10) -> NSRect? {
    guard content.width > 0, content.height > 0 else { return nil }
    return NSRect(x: window.minX + content.minX - margin, y: window.maxY - content.maxY - margin,
                  width: content.width + margin * 2, height: content.height + margin)
}

/// BIMAX_NOTCH_DEBUG=1 traces every mouse decision to stderr (how the click-through test was debugged).
let debugging = ProcessInfo.processInfo.environment["BIMAX_NOTCH_DEBUG"] != nil

// MARK: - Controller

@MainActor
final class NotchController {
    let model = NotchModel()
    private var notch: DynamicNotch<ExpandedView, CompactLeadingView, CompactTrailingView>!
    private var geometry: NotchGeometry?
    private var monitors: [Any] = []
    private var isOpen = false
    private var closeTask: Task<Void, Never>?
    private var sayTask: Task<Void, Never>?
    private var resting: DynamicNotchState = .hidden
    private let dragWatch = DragWatch()
    private let clipboardWatch = ClipboardWatch()
    private let secretGuard = SecretGuard()
    private let frontAppWatch = FrontAppWatch()
    /// The secret being pressed, whether Force Touch pressure has been seen, and the pressure so far.
    private var pressing: (id: String, sawPressure: Bool, amount: Double)?
    /// --demo keeps dropped things itself, since there is no app to keep them.
    var demo = false

    init() {
        let model = self.model
        notch = DynamicNotch(
            // No SwiftUI hover: this controller decides open and closed itself from `contentFrame` (overNotch). Hover
            // tracking made the half-screen panel handle every mouse move over it even while ignoring clicks — 1.8% of a
            // core with the mouse moving there, 0.0% elsewhere (measured 2026-09-26) — and `.keepVisible` could leave
            // hide() retrying on a hover-exit lost while the panel ignored the mouse.
            hoverBehavior: [],
            style: .auto,
            expanded: { [weak self] in
                ExpandedView(model: model, open: { id in self?.openTask(id) },
                             act: { action in self?.shelfAction(action) },
                             dropped: { providers in self?.dropped(providers) ?? false },
                             edit: { providers in self?.editDropped(providers) ?? false },
                             clip: { command in self?.clipCommand(command) },
                             secret: { command in self?.secretCommand(command) })
            },
            compactLeading: { CompactLeadingView(model: model) },
            compactTrailing: { CompactTrailingView(model: model) }
        )
        applyMotionPreference()
        geometry = NotchGeometry.current()
        startMonitoring()
        dragWatch.changed = { [weak self] dragging in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.model.dragging = dragging
                if dragging { self.model.tab = .shelf } // the drop zones live on the Shelf tab
                if !dragging {
                    self.model.draggingOut = false
                    self.model.dropTargeted = false
                    Task { await self.closeIfLeft() }
                }
            }
        }
        dragWatch.start()
        secretGuard.start { [weak self] in
            MainActor.assumeIsolated {
                self?.pressing = nil
                self?.model.revealed = nil
            }
        }
        frontAppWatch.start { app in Outbox.send(["t": "front", "app": app]) }
        clipboardWatch.copied = { text, source in
            var message: [String: Any] = ["t": "clip", "text": text]
            if let source { message["source"] = source }
            Outbox.send(message)
        }
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.screensChanged() }
        }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.applyMotionPreference() }
        }
    }

    /// Reduce Motion: every movement becomes a short fade-like ease (gods-land 01, motion rules).
    private func applyMotionPreference() {
        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            notch.transitionConfiguration = DynamicNotchTransitionConfiguration(
                openingAnimation: .easeOut(duration: 0.15), closingAnimation: .easeIn(duration: 0.15),
                conversionAnimation: .easeInOut(duration: 0.15), skipIntermediateHides: true)
        } else {
            // The owner's hover glide: a quick spring that settles in about 160 ms, not a slow bounce.
            notch.transitionConfiguration = DynamicNotchTransitionConfiguration(
                openingAnimation: .spring(response: 0.26, dampingFraction: 0.8), closingAnimation: .spring(response: 0.22, dampingFraction: 1.0),
                conversionAnimation: .spring(response: 0.26, dampingFraction: 0.86), skipIntermediateHides: true)
        }
    }

    private func startMonitoring() {
        // Mouse movement is observable without any permission; keys would need Accessibility, and the notch takes none.
        let mask: NSEvent.EventTypeMask = [.mouseMoved, .leftMouseDragged]
        // Monitors are called on the main thread: handle the move right there. A hop through a Task delayed the
        // click-through switch by a run-loop turn, and while the panel animated open a click that soon after the
        // cursor left could land in that gap (the on-screen check caught it: 1 run in 2 lost the click).
        if let global = NSEvent.addGlobalMonitorForEvents(matching: mask, handler: { [weak self] _ in
            let point = NSEvent.mouseLocation
            MainActor.assumeIsolated { self?.mouseMoved(to: point) }
        }) { monitors.append(global) }
        if let local = NSEvent.addLocalMonitorForEvents(matching: mask, handler: { [weak self] event in
            let point = NSEvent.mouseLocation
            MainActor.assumeIsolated { self?.mouseMoved(to: point) }
            return event
        }) { monitors.append(local) }
    }

    /// Whether the point is over what the notch has drawn right now (or the notch itself).
    private func overNotch(_ point: NSPoint) -> Bool {
        guard let geometry else { return false }
        if geometry.trigger.contains(point) { return true }
        guard let window = notch.windowController?.window, window.isVisible,
              let drawn = contentRectOnScreen(content: notch.contentFrame, window: window.frame) else { return false }
        return drawn.contains(point)
    }

    /// Mouse events reach the panel only over drawn content; everywhere else it is click-through (BIMAX_CHANGES 6).
    private func updateClickThrough(_ point: NSPoint) {
        guard let window = notch.windowController?.window else { return }
        if debugging {
            FileHandle.standardError.write("content=\(notch.contentFrame) window=\(window.frame) state=\(notch.state)\n".data(using: .utf8)!)
        }
        let ignore = !overNotch(point)
        if window.ignoresMouseEvents != ignore { window.ignoresMouseEvents = ignore }
    }

    private func mouseMoved(to point: NSPoint) {
        guard let geometry else { return }
        updateClickThrough(point)
        if debugging {
            FileHandle.standardError.write("move \(point) open=\(isOpen) over=\(overNotch(point)) ignore=\(notch.windowController?.window?.ignoresMouseEvents as Any)\n".data(using: .utf8)!)
        }
        let inTrigger = geometry.trigger.contains(point) || (model.dragging && !model.draggingOut && geometry.dragTrigger.contains(point))
        if !isOpen {
            if inTrigger { open() }
            return
        }
        if overNotch(point) {
            closeTask?.cancel()
            closeTask = nil
        } else if closeTask == nil, model.say == nil {
            // A short grace, so crossing the gap between the notch and the panel does not snap it shut.
            closeTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 220_000_000)
                guard !Task.isCancelled else { return }
                await self?.closeIfLeft()
            }
        }
    }

    private func closeIfLeft() async {
        closeTask = nil
        guard isOpen, !overNotch(NSEvent.mouseLocation), model.say == nil, !(model.dragging && !model.draggingOut) else { return }
        await rest()
    }

    private func open() {
        guard let geometry, !isOpen else { return }
        isOpen = true
        // In a terminal or an API client, the secret is the likeliest thing wanted (00 §2B).
        if let app = NSWorkspace.shared.frontmostApplication?.bundleIdentifier, secretFriendlyApps.contains(app), !model.secrets.isEmpty, !model.dragging {
            model.tab = .secrets
        }
        Outbox.send(["t": "hover", "open": true])
        Task { await notch.expand(on: geometry.screen) }
    }

    /// Back to rest: a quiet glow beside the notch while tasks run, nothing at all otherwise.
    private func rest() async {
        guard let geometry else { return }
        if isOpen { Outbox.send(["t": "hover", "open": false]) }
        isOpen = false
        if model.glass.state != .water && geometry.hasNotch {
            resting = .compact
            await notch.compact(on: geometry.screen)
        } else {
            resting = .hidden
            await notch.hide()
        }
    }

    private func openTask(_ id: String) {
        Outbox.send(["t": "open-task", "id": id])
        model.say = nil
        Task { await rest() }
    }

    private func dropped(_ providers: [NSItemProvider]) -> Bool {
        DropReader.read(providers) { [weak self] items in
            guard let self, !items.isEmpty else { return }
            Outbox.send(["t": "shelf-add", "items": items])
            if self.demo { self.demoKeep(items) }
        }
        model.dragging = false
        model.dropTargeted = false
        return true
    }

    /// "Edit with Bimax": files go to the app, which plays the Droplet and opens the ⌘2 bar with them. Anything that
    /// is not a file is kept on the shelf instead, and the notch says why.
    private func editDropped(_ providers: [NSItemProvider]) -> Bool {
        DropReader.read(providers) { [weak self] items in
            guard let self else { return }
            let files = items.filter { $0["kind"] as? String == "file" }
            let others = items.filter { $0["kind"] as? String != "file" }
            if !files.isEmpty { Outbox.send(["t": "edit", "items": files]) }
            if !others.isEmpty {
                Outbox.send(["t": "shelf-add", "items": others])
                self.handle(.say(text: "Only files can be edited for now — kept the rest on the shelf", tone: .info, seconds: 3))
            }
            if self.demo, let first = files.first?["path"] as? String {
                // No app in --demo: play the Droplet to where the bar would open.
                let screen = self.geometry?.screen.frame ?? .zero
                self.handle(.droplet(to: CGRect(x: screen.midX - 340, y: screen.height * 0.24, width: 680, height: 64), icon: first))
            }
        }
        model.dragging = false
        model.editTargeted = false
        model.dropTargeted = false
        return true
    }

    private func demoKeep(_ items: [[String: Any]]) {
        let cards = items.map { item -> ShelfCard in
            let kind = item["kind"] as? String ?? "text"
            let path = item["path"] as? String
            let title = path.map { ($0 as NSString).lastPathComponent } ?? (item["url"] as? String) ?? (item["text"] as? String) ?? "Item"
            return ShelfCard(id: UUID().uuidString, kind: kind, title: title, path: path, url: item["url"] as? String, text: item["text"] as? String)
        }
        model.shelf = cards + model.shelf
        if debugging {
            // Tell the on-screen check where the cards are, once they are laid out.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
                MainActor.assumeIsolated { self?.reportCardFrames() }
            }
        }
    }

    private func reportCardFrames() {
        guard let window = notch.windowController?.window else { return }
        let frames = model.shelf.compactMap { card -> [Double]? in
            guard let frame = model.cardFrames[card.id], let rect = contentRectOnScreen(content: frame, window: window.frame, margin: 0) else { return nil }
            return [rect.minX, rect.minY, rect.width, rect.height]
        }
        Outbox.send(["t": "debug-cards", "frames": frames])
    }

    func shelfAction(_ action: ShelfAction) {
        func touch(_ card: ShelfCard) { Outbox.send(["t": "shelf-touch", "id": card.id]) }
        switch action {
        case let .open(card):
            touch(card)
            if card.kind == "file", !card.missing, let url = card.fileURL { Previewer.shared.show(url) }
            else if card.kind == "url", let link = card.url.flatMap(URL.init(string:)) { NSWorkspace.shared.open(link) }
            else if card.kind == "text" { shelfAction(.copy(card)) }
        case let .copy(card):
            touch(card)
            let board = NSPasteboard.general
            board.clearContents()
            if let url = card.fileURL { board.writeObjects([url as NSURL]) }
            else { board.setString(card.url ?? card.text ?? card.title, forType: .string) }
            clipboardWatch.markOwnWrite()
            handle(.say(text: "Copied \(card.title)", tone: .info, seconds: 1.5))
        case let .reveal(card):
            touch(card)
            if let url = card.fileURL { NSWorkspace.shared.activateFileViewerSelecting([url]) }
        case let .archive(card):
            Outbox.send(["t": "shelf-archive", "ids": [card.id]])
        case .sweep:
            Outbox.send(["t": "shelf-archive", "amber": true])
        case let .restore(id):
            Outbox.send(["t": "shelf-restore", "id": id])
        case let .dragged(card):
            touch(card)
        case let .select(card):
            model.selectedCard = model.selectedCard == card.id ? nil : card.id
        case let .transmute(card, action):
            touch(card)
            if action.kind != "task" { model.working.insert(card.id) }
            Outbox.send(["t": "transmute", "id": card.id, "action": action.id])
        case let .edit(card):
            touch(card)
            if let path = card.path { Outbox.send(["t": "edit", "items": [["kind": "file", "path": path]]]) }
        case let .keep(card):
            if let path = card.path {
                Outbox.send(["t": "recall-keep", "path": path])
                handle(.say(text: "Kept \(card.title) on the shelf", tone: .info, seconds: 1.5))
            }
        }
    }

    private func screensChanged() {
        geometry = NotchGeometry.current()
        Task {
            if isOpen, let geometry { await notch.expand(on: geometry.screen) } else { await rest() }
        }
    }

    func handle(_ message: Inbound) {
        switch message {
        case let .content(active, waiting, tasks, glass):
            model.active = active
            model.waiting = waiting
            model.tasks = tasks
            model.glass = glass
            if !isOpen {
                let wanted: DynamicNotchState = glass.state != .water && (geometry?.hasNotch ?? false) ? .compact : .hidden
                if wanted != resting { Task { await rest() } }
            }
        case let .say(text, tone, seconds):
            model.say = Say(text: text, tone: tone)
            let current = model.say
            if !isOpen { open() }
            sayTask?.cancel()
            sayTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                guard !Task.isCancelled, let self, self.model.say == current else { return }
                self.model.say = nil
                await self.closeIfLeft()
            }
        case let .shelf(items, archived):
            model.shelf = items
            model.archived = archived
            if archived.isEmpty { model.showArchive = false }
        case let .droplet(to, icon):
            playDroplet(to: to, icon: icon)
        case let .clipConfig(enabled):
            model.clipEnabled = enabled
            model.clipAccess = ClipboardWatch.accessBehavior
            if enabled { clipboardWatch.start() } else { clipboardWatch.stop() }
        case let .clips(enabled, items):
            model.clipEnabled = enabled
            model.clips = items
        case let .transmuteRun(id, action, source, out, label):
            runTransmutation(id: id, action: action, source: source, out: out, label: label)
        case let .secrets(items):
            model.secrets = items
            if let shown = model.revealed, !items.contains(where: { $0.id == shown.id }), !model.clips.contains(where: { $0.id == shown.id }) { model.revealed = nil }
        case let .secret(id, purpose, value):
            guard let value else {
                handle(.say(text: "That secret is no longer where it was", tone: .info, seconds: 2))
                return
            }
            if purpose == "reveal" {
                // Only if the person is still pressing that secret: a late answer after letting go shows nothing.
                if let pressing, pressing.id == id { model.revealed = Revealed(id: id, value: value, amount: pressing.amount) }
            } else {
                let name = model.secrets.first(where: { $0.id == id })?.key ?? "The secret"
                SecretCopy.copy(value) { [weak self] ours in
                    MainActor.assumeIsolated { if ours { self?.handle(.say(text: "\(name) cleared from the clipboard", tone: .info, seconds: 2)) } }
                }
                clipboardWatch.markOwnWrite()
                handle(.say(text: "Copied \(name) · clears in 60 s", tone: .info, seconds: 2.5))
            }
        case let .recall(enabled, label, next, groups):
            model.recallEnabled = enabled
            model.recallLabel = label
            model.recallNext = next
            model.recallGroups = groups
        case .quit:
            NSApp.terminate(nil)
        }
    }

    func clipCommand(_ command: ClipCommand) {
        switch command {
        case let .copy(text):
            clipboardWatch.copy(text)
            handle(.say(text: "Copied", tone: .info, seconds: 1.2))
        case let .pin(clip):
            Outbox.send(["t": "clip-pin", "id": clip.id, "pinned": !clip.pinned])
        case let .remove(clip):
            Outbox.send(["t": "clip-remove", "id": clip.id])
        case .enable:
            Outbox.send(["t": "clip-enable"])
        }
    }

    /// Stage 7: a local conversion, off the main thread; the result is reported and lands on the shelf as a new card.
    private func runTransmutation(id: String, action: String, source: String, out: String, label: String) {
        DispatchQueue.global(qos: .userInitiated).async {
            // Clipboard writes go back to the main thread, through the watcher, so they are not recorded as copies.
            let copy: (String) -> Void = { text in DispatchQueue.main.async { MainActor.assumeIsolated { self.clipboardWatch.copy(text) } } }
            let result: Result<Made, Error> = Result { try Transmute.run(action, source: URL(fileURLWithPath: source), out: URL(fileURLWithPath: out), copy: copy) }
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    self.model.working.remove(id)
                    switch result {
                    case let .success(made):
                        var message: [String: Any] = ["t": "made", "source": source, "note": made.note]
                        if let path = made.path { message["path"] = path }
                        if made.copied { message["copied"] = true }
                        Outbox.send(message)
                        self.handle(.say(text: made.note, tone: .done, seconds: 2.5))
                    case let .failure(error):
                        Outbox.send(["t": "made", "source": source, "error": String(describing: error)])
                        self.handle(.say(text: "\(label): \(error)", tone: .failed, seconds: 3))
                    }
                }
            }
        }
    }

    func secretCommand(_ command: SecretCommand) {
        switch command {
        case let .press(id, down):
            if down {
                pressing = (id, false, 0.2)
                Outbox.send(["t": "secret-value", "id": id, "purpose": "reveal"])
                // No Force Touch pressure within 0.3 s (a mouse, or a light hold): holding reveals it fully.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                    MainActor.assumeIsolated {
                        guard let self, let current = self.pressing, current.id == id, !current.sawPressure else { return }
                        self.pressing?.amount = 1
                        if self.model.revealed?.id == id { self.model.revealed?.amount = 1 }
                    }
                }
            } else {
                pressing = nil
                model.revealed = nil
            }
        case let .pressure(id, amount):
            guard pressing?.id == id else { return }
            pressing?.sawPressure = true
            pressing?.amount = amount
            if model.revealed?.id == id { model.revealed?.amount = amount }
        case let .copy(item):
            SecretAuth.confirm("copy \(item.key.isEmpty ? item.label : item.key)") { ok in
                guard ok else { return }
                Outbox.send(["t": "secret-value", "id": item.id, "purpose": "copy"])
            }
        }
    }

    /// The shelf retracts into the notch and the Droplet falls to the ⌘2 bar's rect (Droplet.swift).
    private func playDroplet(to electronRect: CGRect, icon: String?) {
        guard let geometry else { Outbox.send(["t": "droplet-landed"]); return }
        model.say = nil
        Task { await rest() }
        // Electron's coordinates start at the top-left of the main display; Cocoa's at its bottom-left.
        let primaryTop = NSScreen.screens.first?.frame.maxY ?? geometry.screen.frame.maxY
        let target = NSRect(x: electronRect.minX, y: primaryTop - electronRect.maxY, width: electronRect.width, height: electronRect.height)
        let notch = geometry.screen.notchFrame ?? NSRect(x: geometry.screen.frame.midX - 90, y: geometry.screen.frame.maxY - 4, width: 180, height: 4)
        let image = icon.map { NSWorkspace.shared.icon(forFile: $0) }
        Droplet.play(on: geometry.screen, notch: notch, to: target, icon: image) {
            Outbox.send(["t": "droplet-landed"])
        }
    }

    func announceReady() {
        let notchSize = geometry?.screen.notchSize ?? .zero
        var ready: [String: Any] = ["t": "ready", "hasNotch": geometry?.hasNotch ?? false, "notchWidth": notchSize.width, "notchHeight": notchSize.height,
                                    "pasteboard": ClipboardWatch.accessBehavior]
        if let app = FrontAppWatch.current { ready["app"] = app } // stage 8: the app in front from the start
        Outbox.send(ready)
    }
}

// MARK: - Views

private let dim = Color.white.opacity(0.55)

struct ExpandedView: View {
    @ObservedObject var model: NotchModel
    let open: (String) -> Void
    let act: (ShelfAction) -> Void
    let dropped: ([NSItemProvider]) -> Bool
    let edit: ([NSItemProvider]) -> Bool
    let clip: (ClipCommand) -> Void
    let secret: (SecretCommand) -> Void

    private var dropTargeted: Binding<Bool> {
        Binding(get: { model.dropTargeted }, set: { model.dropTargeted = $0 })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let say = model.say {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: say.tone.symbol).foregroundStyle(say.tone.color).font(.system(size: 13, weight: .semibold))
                    Text(say.text).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(.white).lineLimit(2)
                    Spacer(minLength: 0)
                }
                .accessibilityElement(children: .combine)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
            HStack(spacing: 6) {
                Text("Bimax").font(.system(size: 11, weight: .semibold)).foregroundStyle(.white.opacity(0.85))
                Spacer()
                GlassGlyph(glass: model.glass).accessibilityHidden(true)
                Text(model.glass.state == .water ? model.summary : model.glass.label)
                    .font(.system(size: 11)).foregroundStyle(.white.opacity(0.85)).lineLimit(1)
            }
            .accessibilityElement(children: .combine)
            TabChips(model: model)
            switch model.tab {
            case .now:
                if model.tasks.isEmpty {
                    Text("Nothing running right now.").font(.system(size: 12)).foregroundStyle(dim)
                } else {
                    VStack(spacing: 2) {
                        ForEach(model.tasks.prefix(4)) { task in
                            Button { open(task.id) } label: { TaskRowView(task: task) }
                                .buttonStyle(RowButtonStyle())
                        }
                    }
                }
                NextSection(model: model, act: act)
            case .shelf:
                if model.shelf.isEmpty && model.archived.isEmpty && !model.dragging {
                    Text("Drag files, links or text onto the notch to keep them here.").font(.system(size: 12)).foregroundStyle(dim)
                }
                ShelfSection(model: model, act: act, edit: edit)
            case .recall:
                RecallSection(model: model, act: act)
            case .clipboard:
                ClipboardSection(model: model, run: clip)
            case .secrets:
                SecretsSection(model: model, run: secret)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(width: 380, alignment: .leading)
        .background(alignment: .top) { GlassMaterial(state: model.glass.state) }
        .onDrop(of: DropReader.types, isTargeted: dropTargeted) { providers in dropped(providers) }
        .animation(.spring(response: 0.26, dampingFraction: 0.85), value: model.say)
    }
}

struct TaskRowView: View {
    let task: TaskRow

    var body: some View {
        HStack(spacing: 9) {
            Circle().fill(task.tone?.color ?? Color.white.opacity(0.35)).frame(width: 7, height: 7)
            VStack(alignment: .leading, spacing: 1) {
                Text(task.title).font(.system(size: 12, weight: .medium)).foregroundStyle(.white).lineLimit(1)
                if !task.detail.isEmpty {
                    Text(task.detail).font(.system(size: 10.5)).foregroundStyle(dim).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 5)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(task.title), \(task.stateWord)\(task.detail.isEmpty ? "" : ", \(task.detail)")")
        .accessibilityAddTraits(.isButton)
    }
}

struct RowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.white.opacity(configuration.isPressed ? 0.14 : 0.0)))
    }
}

/// Beside the notch at rest: the glass's still symbol (stage 4). Nothing moves here, so an idle Mac pays nothing.
struct CompactLeadingView: View {
    @ObservedObject var model: NotchModel

    var body: some View {
        GlassGlyph(glass: model.glass)
    }
}

struct CompactTrailingView: View {
    @ObservedObject var model: NotchModel

    var body: some View {
        if model.active > 0 {
            Text("\(model.active)").font(.system(size: 11, weight: .semibold, design: .rounded)).foregroundStyle(.white.opacity(0.8))
                .accessibilityHidden(true)
        }
    }
}

// MARK: - Entry

@main
struct BimaxNotch {
    static func main() {
        let arguments = CommandLine.arguments
        if arguments.contains("--selftest") { exit(selfTest() ? 0 : 1) }

        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let controller = MainActor.assumeIsolated { NotchController() }
        MainActor.assumeIsolated { controller.announceReady() }

        if arguments.contains("--demo") {
            MainActor.assumeIsolated {
                controller.demo = true
                // BIMAX_NOTCH_GLASS=molten|frost|… shows that material in the demo.
                let demoGlass = Glass(state: GlassState(rawValue: ProcessInfo.processInfo.environment["BIMAX_NOTCH_GLASS"] ?? "") ?? .ink, label: "Tidy Downloads needs you")
                controller.handle(.content(active: 2, waiting: 1, tasks: [
                    TaskRow(id: "a", title: "Rename the holiday photos", state: "working", detail: "Renaming 48 of 212"),
                    TaskRow(id: "b", title: "Tidy Downloads", state: "waiting", detail: "Wants to move 31 files"),
                    TaskRow(id: "c", title: "Summarise the Q3 report", state: "done", detail: "Check passed"),
                ], glass: demoGlass))
            }
            if ProcessInfo.processInfo.environment["BIMAX_NOTCH_TAB"] == "shelf" {
                if let message = parseInbound(##"{"t": "shelf", "archived": [], "items": [{"id": "a", "kind": "file", "title": "hero.png", "path": "/System/Library/Desktop Pictures/.thumbnails/Sequoia.heic", "missing": false, "amber": false, "actions": [{"id": "compress", "label": "Compress", "kind": "local"}, {"id": "avif", "label": "To AVIF", "kind": "local"}, {"id": "remove-background", "label": "Remove Background", "kind": "local"}, {"id": "ocr", "label": "Copy Text", "kind": "local"}]}, {"id": "b", "kind": "file", "title": "parser.ts", "path": "/etc/hosts", "missing": false, "amber": false, "actions": [{"id": "task:tests", "label": "Add Tests", "kind": "task"}, {"id": "task:document", "label": "Document", "kind": "task"}]}, {"id": "c", "kind": "file", "title": "report (compressed).jpg", "path": "/etc/hosts", "missing": false, "amber": false, "task": "Compressed −68%", "check": "passed"}]}"##) { MainActor.assumeIsolated { controller.handle(message); controller.model.tab = .shelf; controller.model.selectedCard = "a" } }
            }
            if ProcessInfo.processInfo.environment["BIMAX_NOTCH_TAB"] == "secrets" {
                // Sample masked secrets (as secrets.ts sends them — never values), for looking at the tab.
                if let message = parseInbound(##"{"t": "secrets", "items": [{"id": "s1", "label": "Stripe key", "key": "STRIPE_KEY", "masked": "sk_live_••••Yc7D", "where": "shop/.env.local"}, {"id": "s2", "label": "Password in a URL", "key": "DATABASE_URL", "masked": "postgres://app:••••@localhost:5432/shop", "where": "shop/.env"}, {"id": "s3", "label": "Secret", "key": "SESSION_SECRET", "masked": "9f8••••d015", "where": "shop/api/.env"}]}"##) { MainActor.assumeIsolated { controller.handle(message); controller.model.tab = .secrets } }
            }
            // Stage 8: sample recall (as recall.ts sends it) — "Probably next" on Now, and the Recall tab.
            if let message = parseInbound(#"{"t": "recall", "enabled": true, "next": {"label": "Probably next", "items": [{"id": "recall:/System/Library/Desktop Pictures/.thumbnails/Sequoia.heic", "kind": "file", "title": "hero.png", "path": "/System/Library/Desktop Pictures/.thumbnails/Sequoia.heic", "missing": false, "amber": false}, {"id": "recall:/etc/hosts", "kind": "file", "title": "parser.ts", "path": "/etc/hosts", "missing": false, "amber": false}, {"id": "recall:/etc/shells", "kind": "file", "title": "invoice.pdf", "path": "/etc/shells", "missing": false, "amber": false}]}, "groups": [{"cue": "This morning, in Mail", "items": [{"id": "recall:/etc/shells", "kind": "file", "title": "invoice.pdf", "path": "/etc/shells", "missing": false, "amber": false}, {"id": "recall:/etc/hosts", "kind": "file", "title": "contract.pdf", "path": "/etc/hosts", "missing": false, "amber": false}]}, {"cue": "From “Add tests”", "items": [{"id": "recall:/etc/hosts", "kind": "file", "title": "parser.test.ts", "path": "/etc/hosts", "missing": false, "amber": false}]}, {"cue": "Yesterday afternoon, in Figma", "items": [{"id": "recall:/etc/paths", "kind": "file", "title": "hero.png", "path": "/etc/paths", "missing": false, "amber": false}, {"id": "recall:/etc/zshrc", "kind": "file", "title": "logo.png", "path": "/etc/zshrc", "missing": false, "amber": false}, {"id": "recall:/etc/bashrc", "kind": "file", "title": "grid.png", "path": "/etc/bashrc", "missing": false, "amber": false}]}]}"#) {
                MainActor.assumeIsolated { controller.handle(message); if ProcessInfo.processInfo.environment["BIMAX_NOTCH_TAB"] == "recall" { controller.model.tab = .recall } }
            } else { FileHandle.standardError.write("demo recall sample did not parse\n".data(using: .utf8)!) }
            if ProcessInfo.processInfo.environment["BIMAX_NOTCH_TAB"] == "clipboard" {
                // Sample copies, as the app would classify them (clipboard.ts), for looking at the tab.
                let sample = ##"{"t": "clips", "enabled": true, "items": [{"id": "1", "kind": "color", "preview": "#3B82F6", "text": "#3B82F6", "swatch": "#3b82f6", "detail": "blue-500", "actions": [{"label": "HEX", "value": "#3b82f6"}, {"label": "RGB", "value": "rgb(59, 130, 246)"}, {"label": "HSL", "value": "hsl(217 91% 60%)"}, {"label": "Swift", "value": "Color(red: 0.231, green: 0.51, blue: 0.965)"}, {"label": "Tailwind", "value": "bg-blue-500"}], "pinned": true}, {"id": "2", "kind": "json", "preview": "{ \"id\": 7, \"name\": \"Ana\", \"orders\": [ … ] }", "text": "{}", "detail": "JSON · 3 keys", "actions": [{"label": "Minify", "value": "{}"}, {"label": "Pretty", "value": "{}"}, {"label": "TS type", "value": "x"}], "pinned": false}, {"id": "3", "kind": "url", "preview": "https://shop.example/p/42?utm_source=news&color=red", "text": "u", "detail": "shop.example · tracking removed", "actions": [{"label": "Clean link", "value": "https://shop.example/p/42?color=red"}], "pinned": false}, {"id": "4", "kind": "code", "preview": "npm install …", "text": "c", "detail": "Shell", "actions": [{"label": "One line", "value": "npm install && npm test"}], "pinned": false}]}"##
                if let message = parseInbound(sample) { MainActor.assumeIsolated { controller.handle(message); controller.model.tab = .clipboard } }
                else { FileHandle.standardError.write("demo clipboard sample did not parse\n".data(using: .utf8)!) }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                MainActor.assumeIsolated { controller.handle(.say(text: "Summarise the Q3 report is done", tone: .done, seconds: 4)) }
            }
        } else {
            // One reader thread; each line is handled on the main thread. EOF means the app is gone: exit with it.
            Thread.detachNewThread {
                while let line = readLine(strippingNewline: true) {
                    guard let message = parseInbound(line) else { continue }
                    DispatchQueue.main.async { MainActor.assumeIsolated { controller.handle(message) } }
                }
                DispatchQueue.main.async { NSApp.terminate(nil) }
            }
        }
        app.run()
    }

    /// Geometry and the parser, without showing anything. Used by the build.
    static func selfTest() -> Bool {
        var ok = true
        func check(_ condition: Bool, _ what: String) { if !condition { ok = false; FileHandle.standardError.write("selftest failed: \(what)\n".data(using: .utf8)!) } }
        check(parseInbound(#"{"t":"content","active":2,"waiting":1,"tasks":[{"id":"a","title":"T","state":"working","detail":"d"}],"glass":{"state":"frost","label":"T · no progress for 30 s"}}"#)
              == .content(active: 2, waiting: 1, tasks: [TaskRow(id: "a", title: "T", state: "working", detail: "d")], glass: Glass(state: .frost, label: "T · no progress for 30 s")), "content")
        check(parseInbound(#"{"t":"content","active":0,"waiting":0,"tasks":[],"glass":{"state":"lava"}}"#)
              == .content(active: 0, waiting: 0, tasks: [], glass: Glass()), "an unknown glass is water")
        // Glass contrast: each symbol at least 3:1 on the notch's black (WCAG non-text), and the words — white at 85% —
        // at least 4.5:1 over the strongest material each state draws behind them.
        for state in GlassState.allCases {
            let black = (0.0, 0.0, 0.0)
            check(contrastRatio(state.rgb, black) >= 3, "\(state) symbol contrast \(contrastRatio(state.rgb, black))")
            let peak = GlassState.materialPeak
            let behind = (state.rgb.0 * peak, state.rgb.1 * peak, state.rgb.2 * peak)
            let words = (0.85 + 0.15 * behind.0, 0.85 + 0.15 * behind.1, 0.85 + 0.15 * behind.2)
            check(contrastRatio(words, behind) >= 4.5, "\(state) words contrast \(contrastRatio(words, behind))")
        }
        check(parseInbound(#"{"t":"say","text":"Done","tone":"done","seconds":3}"#) == .say(text: "Done", tone: .done, seconds: 3), "say")
        check(parseInbound(#"{"t":"say","text":"x","tone":"nonsense","seconds":999}"#) == .say(text: "x", tone: .info, seconds: 30), "say clamps")
        check(parseInbound(#"{"t":"say","text":""}"#) == nil, "empty say ignored")
        check(parseInbound("not json") == nil, "garbage ignored")
        check(parseInbound(#"{"t":"future-message"}"#) == nil, "unknown ignored")
        check(parseInbound(#"{"t":"quit"}"#) == .quit, "quit")
        check(parseInbound(#"{"t":"shelf","items":[{"id":"1","kind":"file","title":"a.pdf","path":"/x/a.pdf","missing":true,"amber":false}],"archived":[]}"#)
              == .shelf(items: [ShelfCard(id: "1", kind: "file", title: "a.pdf", path: "/x/a.pdf", missing: true)], archived: []), "shelf")
        check(ShelfCard(id: "1", kind: "file", title: "a", path: "/nope", missing: true).itemProvider() == nil, "a missing file cannot be dragged out")
        check(parseInbound(#"{"t":"droplet","to":{"x":395,"y":229,"width":680,"height":64},"icon":"/a.md"}"#)
              == .droplet(to: CGRect(x: 395, y: 229, width: 680, height: 64), icon: "/a.md"), "droplet")
        check(parseInbound(#"{"t":"droplet","to":{"x":1,"y":2,"width":0,"height":64}}"#) == nil, "an empty droplet target is refused")
        check(ClipboardWatch.shouldSkip(types: ["public.utf8-plain-text", "org.nspasteboard.ConcealedType"]), "a password manager's copy is skipped")
        check(ClipboardWatch.shouldSkip(types: ["org.nspasteboard.TransientType"]) && ClipboardWatch.shouldSkip(types: ["org.nspasteboard.AutoGeneratedType"]), "transient and generated copies are skipped")
        check(!ClipboardWatch.shouldSkip(types: ["public.utf8-plain-text"]), "an ordinary copy is kept")
        if case let .clips(enabled, items)? = parseInbound(##"{"t":"clips","enabled":true,"items":[{"id":"c","kind":"color","preview":"#3b82f6","text":"#3b82f6","swatch":"#3b82f6","actions":[{"label":"HEX","value":"#3b82f6"},{"bad":1}],"pinned":true}]}"##) {
            check(enabled && items.count == 1 && items[0].actions == [ClipAction(label: "HEX", value: "#3b82f6")] && items[0].pinned, "clips")
        } else { check(false, "clips parse") }
        // Stage 8: recall — cards reuse the shelf's; a group without cards and a malformed card are dropped.
        check(parseInbound(#"{"t":"recall","enabled":true,"next":{"label":"Probably next","items":[{"id":"recall:/a.md","kind":"file","title":"a.md","path":"/a.md"},{"bad":1}]},"groups":[{"cue":"Yesterday afternoon, in Figma","items":[{"id":"recall:/b.png","kind":"file","title":"b.png","path":"/b.png"}]},{"cue":"empty","items":[]}]}"#)
              == .recall(enabled: true, label: "Probably next", next: [ShelfCard(id: "recall:/a.md", kind: "file", title: "a.md", path: "/a.md")],
                         groups: [RecallGroup(cue: "Yesterday afternoon, in Figma", items: [ShelfCard(id: "recall:/b.png", kind: "file", title: "b.png", path: "/b.png")])]), "recall")
        check(parseInbound(#"{"t":"recall"}"#) == .recall(enabled: false, label: "Recent", next: [], groups: []), "recall defaults to off")
        check(parseInbound(#"{"t":"clip-config","enabled":true}"#) == .clipConfig(enabled: true), "clip-config")
        check(parseInbound(#"{"t":"secrets","items":[{"id":"s1","label":"Stripe key","key":"STRIPE_KEY","masked":"sk_live_••••Yc7D","where":"shop/.env"},{"bad":1}]}"#)
              == .secrets(items: [SecretItem(id: "s1", label: "Stripe key", key: "STRIPE_KEY", masked: "sk_live_••••Yc7D", where_: "shop/.env")]), "secrets")
        check(parseInbound(#"{"t":"secret","id":"s1","purpose":"copy","value":"v"}"#) == .secret(id: "s1", purpose: "copy", value: "v"), "secret")
        check(parseInbound(#"{"t":"secret","id":"s1","missing":true}"#) == .secret(id: "s1", purpose: "reveal", value: nil), "missing secret")
        // Evaporation, end state read back, on a private clipboard: our copy is cleared at the deadline and is marked
        // Concealed meanwhile; a copy the person made after ours is never cleared.
        let secretBoard = NSPasteboard.withUniqueName()
        var outcomes: [Bool] = []
        SecretCopy.copy("sk_live_example", to: secretBoard, after: 0.4) { outcomes.append($0) }
        check(secretBoard.string(forType: .string) == "sk_live_example" && secretBoard.types?.contains(SecretCopy.concealed) == true, "a secret copy is marked Concealed")
        let evaporate = Date().addingTimeInterval(0.7); while Date() < evaporate { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
        check(secretBoard.string(forType: .string) == nil && outcomes == [true], "the secret evaporated from the clipboard")
        SecretCopy.copy("sk_live_example", to: secretBoard, after: 0.4) { outcomes.append($0) }
        secretBoard.clearContents(); secretBoard.setString("the person's own copy", forType: .string)
        let keep = Date().addingTimeInterval(0.7); while Date() < keep { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
        check(secretBoard.string(forType: .string) == "the person's own copy" && outcomes == [true, false], "a later copy by the person is never cleared")
        secretBoard.releaseGlobally()
        // Stage 7: every local conversion run for real on generated files, and each output opened and checked.
        let work = FileManager.default.temporaryDirectory.appendingPathComponent("bimax-notch-selftest-\(ProcessInfo.processInfo.processIdentifier)")
        try? FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: work) }
        func props(_ url: URL) -> (w: Int, h: Int, type: String) {
            guard let src = CGImageSourceCreateWithURL(url as CFURL, nil), let p = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any] else { return (0, 0, "") }
            return (p[kCGImagePropertyPixelWidth] as? Int ?? 0, p[kCGImagePropertyPixelHeight] as? Int ?? 0, CGImageSourceGetType(src) as String? ?? "")
        }
        // A 1200×800 photo-like PNG — smooth gradients with per-pixel grain, which PNG stores badly and JPEG well — with a
        // transparent top-left corner. (A first version drew 4-pixel blocks: graphics, which PNG stores better than
        // JPEG, so compress rightly refused it. That case is checked separately below.)
        let photo = work.appendingPathComponent("photo.png")
        var pixels = [UInt8](repeating: 0, count: 1200 * 800 * 4)
        var seed: UInt32 = 7
        for y in 0..<800 { for x in 0..<1200 {
            seed = seed &* 1664525 &+ 1013904223
            let grain = Int(seed >> 28) - 8
            let o = (y * 1200 + x) * 4
            let clear = x < 100 && y < 100
            pixels[o] = clear ? 0 : UInt8(max(0, min(255, x * 255 / 1200 + grain)))
            pixels[o + 1] = clear ? 0 : UInt8(max(0, min(255, y * 255 / 800 + grain)))
            pixels[o + 2] = clear ? 0 : UInt8(max(0, min(255, 128 + grain * 3)))
            pixels[o + 3] = clear ? 0 : 255
        } }
        if let provider = CGDataProvider(data: Data(pixels) as CFData),
           let image = CGImage(width: 1200, height: 800, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: 1200 * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                               bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue), provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent) {
            try? Transmute.write(image, to: photo, type: .png, quality: nil)
        }
        let compressed = work.appendingPathComponent("photo.jpg")
        let compressResult = try? Transmute.run("compress", source: photo, out: compressed, copy: { _ in })
        let cp = props(compressed)
        let sizes = [photo, compressed].map { ((try? FileManager.default.attributesOfItem(atPath: $0.path))?[.size] as? Int) ?? 0 }
        check(cp.w == 1200 && cp.h == 800 && cp.type == "public.jpeg" && sizes[1] < sizes[0] && compressResult?.note.hasPrefix("Compressed −") == true,
              "compress: a smaller JPEG of the same size (\(cp) \(sizes))")
        // Refusal: when the result would not be smaller, no card is made and nothing is left behind. A 32×32 PNG is
        // certain to be smaller than any JPEG of it — the JPEG header alone is bigger. (A first version used an 800×600
        // solid colour and assumed JPEG loses; it measured 9,787 B PNG vs 8,631 B JPEG, and ImageIO's output sizes vary
        // between runs, so that premise was wrong and flaky, not the product.)
        let tiny = work.appendingPathComponent("tiny.png")
        if let ctx = CGContext(data: nil, width: 32, height: 32, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) {
            ctx.setFillColor(CGColor(red: 0.2, green: 0.5, blue: 0.9, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: 32, height: 32))
            if let image = ctx.makeImage() { try? Transmute.write(image, to: tiny, type: .png, quality: nil) }
        }
        let tinyOut = work.appendingPathComponent("tiny.jpg")
        let tinySizes = { [tiny, tinyOut].map { ((try? FileManager.default.attributesOfItem(atPath: $0.path))?[.size] as? Int) ?? 0 } }
        switch Result(catching: { try Transmute.run("compress", source: tiny, out: tinyOut, copy: { _ in }) }) {
        case let .failure(error): check("\(error)" == "already as small as it gets" && !FileManager.default.fileExists(atPath: tinyOut.path), "compress refuses a result that is not smaller (\(error), \(tinySizes()))")
        case let .success(made): check(false, "compress refuses a result that is not smaller (made \(made.note), sizes \(tinySizes()))")
        }
        if let src = CGImageSourceCreateWithURL(compressed as CFURL, nil), let image = CGImageSourceCreateImageAtIndex(src, 0, nil),
           let ctx = CGContext(data: nil, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) {
            ctx.draw(image, in: CGRect(x: -10, y: -(800 - 11), width: 1200, height: 800)) // image pixel (10, 10) from the top-left
            let pixel = ctx.data!.assumingMemoryBound(to: UInt8.self)
            check(pixel[0] > 240 && pixel[1] > 240 && pixel[2] > 240, "transparent areas become white in a JPEG, not black (\(pixel[0]),\(pixel[1]),\(pixel[2]))")
        }
        for (action, type) in [("avif", "public.avif"), ("heic", "public.heic"), ("png", "public.png")] {
            let out = work.appendingPathComponent("photo-out.\(action)")
            _ = try? Transmute.run(action, source: compressed, out: out, copy: { _ in })
            let p = props(out)
            check(p.type == type && p.w == 1200 && p.h == 800, "\(action): \(p)")
        }
        // Text in an image comes back as text.
        let words = work.appendingPathComponent("words.png")
        if let ctx = CGContext(data: nil, width: 900, height: 200, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) {
            ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: 900, height: 200))
            let text = NSAttributedString(string: "BIMAX NOTCH 2026", attributes: [.font: NSFont.systemFont(ofSize: 72, weight: .bold), .foregroundColor: NSColor.black])
            let line = CTLineCreateWithAttributedString(text)
            ctx.textPosition = CGPoint(x: 30, y: 70); CTLineDraw(line, ctx)
            if let image = ctx.makeImage() { try? Transmute.write(image, to: words, type: .png, quality: nil) }
        }
        var copied = ""
        _ = try? Transmute.run("ocr", source: words, out: work.appendingPathComponent("unused"), copy: { copied = $0 })
        check(copied.uppercased().contains("BIMAX") && copied.contains("2026"), "OCR reads the words (\(copied))")
        _ = try? Transmute.run("base64", source: words, out: work.appendingPathComponent("unused"), copy: { copied = $0 })
        let payload = copied.components(separatedBy: "base64,").last ?? ""
        check(copied.hasPrefix("data:image/png;base64,") && Data(base64Encoded: payload) == (try? Data(contentsOf: words)), "Base64 decodes back to the same bytes")
        // A 3-page PDF with an image on each page.
        let pdfURL = work.appendingPathComponent("report.pdf")
        if let consumer = CGDataConsumer(url: pdfURL as CFURL), let ctx = CGContext(consumer: consumer, mediaBox: nil, nil),
           let src = CGImageSourceCreateWithURL(photo as CFURL, nil), let image = CGImageSourceCreateImageAtIndex(src, 0, nil) {
            for _ in 0..<3 { var box = CGRect(x: 0, y: 0, width: 612, height: 792); ctx.beginPage(mediaBox: &box); ctx.draw(image, in: CGRect(x: 36, y: 200, width: 540, height: 360)); ctx.endPage() }
            ctx.closePDF()
        }
        let page1 = work.appendingPathComponent("page1.pdf"), flat = work.appendingPathComponent("flat.pdf"), small = work.appendingPathComponent("small.pdf")
        _ = try? Transmute.run("pdf-page1", source: pdfURL, out: page1, copy: { _ in })
        _ = try? Transmute.run("pdf-flatten", source: pdfURL, out: flat, copy: { _ in })
        let pdfCompress = Result { try Transmute.run("pdf-compress", source: pdfURL, out: small, copy: { _ in }) }
        check(PDFDocument(url: page1)?.pageCount == 1, "Extract Page 1: one page")
        check(PDFDocument(url: flat)?.pageCount == 3, "Flatten: every page")
        switch pdfCompress {
        case .success: check(PDFDocument(url: small)?.pageCount == 3, "Compress for Email: a smaller, readable PDF")
        case let .failure(error): check("\(error)" == "already as small as it gets", "Compress for Email: \(error)")
        }
        check((try? Transmute.run("webp", source: photo, out: work.appendingPathComponent("x.webp"), copy: { _ in })) == nil, "WebP is refused, not faked")
        // The watcher end to end, on a private clipboard (never the person's): an ordinary copy is seen, a password
        // manager's is not, the notch's own copy is not, and nothing is seen while it is stopped.
        let privateBoard = NSPasteboard.withUniqueName()
        let watch = ClipboardWatch(board: privateBoard)
        var seen: [String] = []
        watch.copied = { text, _ in seen.append(text) }
        func settle() { let until = Date().addingTimeInterval(1.1); while Date() < until { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) } }
        watch.start()
        privateBoard.clearContents(); privateBoard.setString("hello from a copy", forType: .string); settle()
        privateBoard.clearContents()
        privateBoard.setString("hunter2", forType: .string)
        privateBoard.setString("", forType: NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")); settle()
        watch.copy("the notch's own copy"); settle()
        watch.stop()
        privateBoard.clearContents(); privateBoard.setString("after stopping", forType: .string); settle()
        check(seen == ["hello from a copy"], "the watcher sees ordinary copies only (\(seen))")
        privateBoard.releaseGlobally()
        // The Droplet's path: it starts at the notch's lip, falls, and ends spread over the bar and invisible.
        let lip = CGPoint(x: 100, y: 32), bar = CGRect(x: 20, y: 230, width: 680, height: 64)
        let early = DropletFrame(t: 0.05, lip: lip, notchWidth: 180, target: bar)
        let falling = DropletFrame(t: 0.33, lip: lip, notchWidth: 180, target: bar)
        let done = DropletFrame(t: DropletTiming.end, lip: lip, notchWidth: 180, target: bar)
        check(early.drop == .zero && early.blobs.count == 1, "the lip swells before any drop forms")
        check(falling.drop.midY > lip.y + 28 && falling.drop.midY < bar.midY, "the drop is between the notch and the bar while falling")
        check(abs(done.drop.midY - bar.midY) < 0.5 && done.opacity < 0.01, "the drop ends on the bar, faded out")
        // What a drop reads, per kind of thing dropped (the same NSItemProviders a drag from Finder or a browser gives).
        let dropped = FileManager.default.temporaryDirectory.appendingPathComponent("bimax-notch-selftest.txt")
        try? "x".write(to: dropped, atomically: true, encoding: .utf8)
        let providers = [NSItemProvider(contentsOf: dropped)!, NSItemProvider(object: NSURL(string: "https://bimax.app/x")!),
                         NSItemProvider(object: NSURL(string: "javascript:alert(1)")!), NSItemProvider(object: "hello" as NSString)]
        // Keep the main run loop turning while waiting: loading a file drop can need it.
        var read: [[String: Any]]?
        DropReader.read(providers) { read = $0 }
        let deadline = Date().addingTimeInterval(5)
        while read == nil, Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
        check(read != nil, "drops are read")
        let kinds = (read ?? []).map { "\($0["kind"] ?? "")=\($0["path"] ?? $0["url"] ?? $0["text"] ?? "")" }
        check(kinds == ["file=\(dropped.path)", "url=https://bimax.app/x", "text=hello"], "a file, an http link and text are read; a javascript: link is refused (\(kinds))")
        try? FileManager.default.removeItem(at: dropped)
        // What a drag out carries: the file itself, the link, the text.
        let card = ShelfCard(id: "2", kind: "file", title: "f", path: "/etc/hosts")
        check(card.itemProvider()?.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) == true, "a file card drags out as a file")
        check(ShelfCard(id: "3", kind: "url", title: "u", url: "https://bimax.app").itemProvider()?.canLoadObject(ofClass: NSURL.self) == true, "a link card drags out as a link")
        check(ShelfCard(id: "4", kind: "text", title: "t", text: "hi").itemProvider()?.canLoadObject(ofClass: NSString.self) == true, "a text card drags out as text")
        let window = NSRect(x: 367, y: 478, width: 735, height: 478)
        let drawn = contentRectOnScreen(content: CGRect(x: 170, y: 0, width: 400, height: 120), window: window, margin: 0)
        check(drawn == NSRect(x: 537, y: 836, width: 400, height: 120), "content rect converts to screen space")
        check(contentRectOnScreen(content: .zero, window: window) == nil, "nothing drawn means nothing clickable")
        let screens = NSScreen.screens.map { screen -> [String: Any] in
            let g = NotchGeometry(screen: screen)
            if g.hasNotch, let notch = screen.notchFrame { check(g.trigger.contains(NSPoint(x: notch.midX, y: notch.midY)), "trigger covers the notch") }
            check(g.trigger.maxY <= screen.frame.maxY + 0.5, "trigger stays on its screen")
            return ["hasNotch": g.hasNotch, "trigger": NSStringFromRect(g.trigger), "frame": NSStringFromRect(screen.frame)]
        }
        if let data = try? JSONSerialization.data(withJSONObject: ["ok": ok, "screens": screens]), let text = String(data: data, encoding: .utf8) { print(text) }
        return ok
    }
}
