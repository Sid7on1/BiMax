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

    var summary: String {
        if active == 0 { return "All quiet" }
        let running = "\(active) task\(active == 1 ? "" : "s") running"
        return waiting > 0 ? "\(running) · \(waiting) need\(waiting == 1 ? "s" : "") you" : running
    }
}

// MARK: - Protocol

enum Inbound: Equatable {
    case content(active: Int, waiting: Int, tasks: [TaskRow])
    case say(text: String, tone: Tone, seconds: Double)
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
        return .content(active: object["active"] as? Int ?? 0, waiting: object["waiting"] as? Int ?? 0, tasks: rows)
    case "say":
        guard let text = object["text"] as? String, !text.isEmpty else { return nil }
        let seconds = (object["seconds"] as? Double) ?? Double(object["seconds"] as? Int ?? 4)
        return .say(text: text, tone: Tone(rawValue: object["tone"] as? String ?? "info") ?? .info, seconds: min(max(seconds, 1), 30))
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
private let debugging = ProcessInfo.processInfo.environment["BIMAX_NOTCH_DEBUG"] != nil

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

    init() {
        let model = self.model
        notch = DynamicNotch(
            hoverBehavior: [.keepVisible],
            style: .auto,
            expanded: { [weak self] in ExpandedView(model: model, open: { id in self?.openTask(id) }) },
            compactLeading: { CompactLeadingView(model: model) },
            compactTrailing: { CompactTrailingView(model: model) }
        )
        applyMotionPreference()
        geometry = NotchGeometry.current()
        startMonitoring()
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
        let inTrigger = geometry.trigger.contains(point)
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
        guard isOpen, !overNotch(NSEvent.mouseLocation), model.say == nil else { return }
        await rest()
    }

    private func open() {
        guard let geometry, !isOpen else { return }
        isOpen = true
        Outbox.send(["t": "hover", "open": true])
        Task { await notch.expand(on: geometry.screen) }
    }

    /// Back to rest: a quiet glow beside the notch while tasks run, nothing at all otherwise.
    private func rest() async {
        guard let geometry else { return }
        if isOpen { Outbox.send(["t": "hover", "open": false]) }
        isOpen = false
        if model.active > 0 && geometry.hasNotch {
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

    private func screensChanged() {
        geometry = NotchGeometry.current()
        Task {
            if isOpen, let geometry { await notch.expand(on: geometry.screen) } else { await rest() }
        }
    }

    func handle(_ message: Inbound) {
        switch message {
        case let .content(active, waiting, tasks):
            model.active = active
            model.waiting = waiting
            model.tasks = tasks
            if !isOpen {
                let wanted: DynamicNotchState = active > 0 && (geometry?.hasNotch ?? false) ? .compact : .hidden
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
        case .quit:
            NSApp.terminate(nil)
        }
    }

    func announceReady() {
        let notchSize = geometry?.screen.notchSize ?? .zero
        Outbox.send(["t": "ready", "hasNotch": geometry?.hasNotch ?? false, "notchWidth": notchSize.width, "notchHeight": notchSize.height])
    }
}

// MARK: - Views

private let dim = Color.white.opacity(0.55)

struct ExpandedView: View {
    @ObservedObject var model: NotchModel
    let open: (String) -> Void

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
            HStack {
                Text("Bimax").font(.system(size: 11, weight: .semibold)).foregroundStyle(.white.opacity(0.85))
                Spacer()
                Text(model.summary).font(.system(size: 11)).foregroundStyle(dim)
            }
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
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(width: 380, alignment: .leading)
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

/// Beside the notch while tasks run: one dot, yellow when something needs you.
struct CompactLeadingView: View {
    @ObservedObject var model: NotchModel

    var body: some View {
        Circle()
            .fill(model.waiting > 0 ? Tone.waiting.color : Tone.info.color)
            .frame(width: 7, height: 7)
            .accessibilityLabel(model.summary)
    }
}

struct CompactTrailingView: View {
    @ObservedObject var model: NotchModel

    var body: some View {
        Text("\(model.active)").font(.system(size: 11, weight: .semibold, design: .rounded)).foregroundStyle(.white.opacity(0.8))
            .accessibilityHidden(true)
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
                controller.handle(.content(active: 2, waiting: 1, tasks: [
                    TaskRow(id: "a", title: "Rename the holiday photos", state: "working", detail: "Renaming 48 of 212"),
                    TaskRow(id: "b", title: "Tidy Downloads", state: "waiting", detail: "Wants to move 31 files"),
                    TaskRow(id: "c", title: "Summarise the Q3 report", state: "done", detail: "Check passed"),
                ]))
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
        check(parseInbound(#"{"t":"content","active":2,"waiting":1,"tasks":[{"id":"a","title":"T","state":"working","detail":"d"}]}"#)
              == .content(active: 2, waiting: 1, tasks: [TaskRow(id: "a", title: "T", state: "working", detail: "d")]), "content")
        check(parseInbound(#"{"t":"say","text":"Done","tone":"done","seconds":3}"#) == .say(text: "Done", tone: .done, seconds: 3), "say")
        check(parseInbound(#"{"t":"say","text":"x","tone":"nonsense","seconds":999}"#) == .say(text: "x", tone: .info, seconds: 30), "say clamps")
        check(parseInbound(#"{"t":"say","text":""}"#) == nil, "empty say ignored")
        check(parseInbound("not json") == nil, "garbage ignored")
        check(parseInbound(#"{"t":"future-message"}"#) == nil, "unknown ignored")
        check(parseInbound(#"{"t":"quit"}"#) == .quit, "quit")
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
