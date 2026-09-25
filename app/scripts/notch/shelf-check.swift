// God's Land stage 2 exit check (docs/product-reset/gods-land/03_PLAN.md), run by scripts/check-notch.sh.
// NOT YET PASSED: the first run was invalid (the owner was using the mouse at the same time). Run it hands-off.
// It MOVES THE CURSOR AND DRAGS on the real screen, so it is never part of the automatic suite. It uses two small
// windows of its own: a SOURCE that starts a real drag of a temporary file, and a TARGET that accepts file drops.
//   1. drag the file from SOURCE onto the notch: the notch opens and the helper reports shelf-add with that path;
//   2. drag the new card out of the notch onto TARGET: TARGET receives the same file.
// Needs Accessibility for the terminal that runs it (to post events). Restores the cursor at the end.
import AppKit

let helperPath = CommandLine.arguments[1]
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let screen = NSScreen.screens.first(where: { $0.safeAreaInsets.top > 0 }) ?? NSScreen.main!
let f = screen.frame
let original = NSEvent.mouseLocation

let file = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("bimax-shelf-check-\(ProcessInfo.processInfo.processIdentifier).txt")
try! "the shelf check".write(to: file, atomically: true, encoding: .utf8)

final class Source: NSView, NSDraggingSource {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) {}
    private var started = false
    override func mouseDragged(with event: NSEvent) {
        guard !started else { return }
        started = true
        let item = NSDraggingItem(pasteboardWriter: file as NSURL)
        item.setDraggingFrame(bounds, contents: NSImage(systemSymbolName: "doc", accessibilityDescription: nil))
        beginDraggingSession(with: [item], event: event, source: self)
    }
    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation { .copy }
}

final class Target: NSView {
    var received: [URL] = []
    override init(frame: NSRect) { super.init(frame: frame); registerForDraggedTypes([.fileURL]) }
    required init?(coder: NSCoder) { fatalError() }
    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation { .copy }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        received += (sender.draggingPasteboard.readObjects(forClasses: [NSURL.self]) as? [URL]) ?? []
        return true
    }
}

func makeWindow(_ rect: NSRect, _ view: NSView, _ color: NSColor) -> NSWindow {
    let window = NSWindow(contentRect: rect, styleMask: .borderless, backing: .buffered, defer: false)
    view.frame = NSRect(origin: .zero, size: rect.size)
    window.contentView = view
    window.level = .floating
    window.backgroundColor = color
    window.orderFrontRegardless()
    return window
}
let sourceRect = NSRect(x: f.midX - 260, y: f.midY, width: 80, height: 80)
let targetRect = NSRect(x: f.midX + 180, y: f.midY, width: 80, height: 80)
let target = Target(frame: .zero)
let sourceWindow = makeWindow(sourceRect, Source(frame: .zero), .systemBlue)
let targetWindow = makeWindow(targetRect, target, .systemGreen)

var lines: [String] = []
var partial = ""
let helper = Process()
helper.executableURL = URL(fileURLWithPath: helperPath)
helper.arguments = ["--demo"]
helper.environment = ProcessInfo.processInfo.environment.merging(["BIMAX_NOTCH_DEBUG": "1"]) { $1 }
let out = Pipe()
helper.standardOutput = out
helper.standardError = ProcessInfo.processInfo.environment["SHELF_CHECK_STDERR"].flatMap { FileHandle(forWritingAtPath: $0) } ?? FileHandle.nullDevice
out.fileHandleForReading.readabilityHandler = { handle in
    guard let text = String(data: handle.availableData, encoding: .utf8) else { return }
    DispatchQueue.main.async {
        partial += text
        while let newline = partial.firstIndex(of: "\n") {
            lines.append(String(partial[..<newline]))
            partial = String(partial[partial.index(after: newline)...])
        }
    }
}
try! helper.run()

func quartz(_ p: NSPoint) -> CGPoint { CGPoint(x: p.x, y: f.maxY - p.y) }
func post(_ type: CGEventType, _ p: NSPoint) {
    CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: quartz(p), mouseButton: .left)?.post(tap: .cghidEventTap)
}
func after(_ seconds: Double, _ block: @escaping () -> Void) { DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: block) }

/// Press at `from`, drag through `via` in small steps like a hand, pause where told, release at the last point.
func drag(from: NSPoint, via points: [(NSPoint, Double)], then: @escaping () -> Void) {
    post(.mouseMoved, from)
    after(0.15) {
        post(.leftMouseDown, from)
        var current = from
        var schedule = 0.2
        for (point, pause) in points {
            let steps = 18
            for step in 1...steps {
                let t = Double(step) / Double(steps)
                let p = NSPoint(x: current.x + (point.x - current.x) * t, y: current.y + (point.y - current.y) * t)
                after(schedule) { post(.leftMouseDragged, p) }
                schedule += 0.025
            }
            current = point
            schedule += pause
        }
        let end = current
        after(schedule + 0.1) { post(.leftMouseUp, end); then() }
    }
}

var results: [String] = []
func finish() {
    post(.mouseMoved, original)
    helper.terminate()
    try? FileManager.default.removeItem(at: file)
    print(results.joined(separator: "\n"))
    if !results.allSatisfy({ $0.contains("PASS") }) { print("helper said:\n" + lines.joined(separator: "\n")) }
    exit(results.allSatisfy { $0.contains("PASS") } ? 0 : 1)
}

let notch = NSPoint(x: f.midX, y: f.maxY - 12)
let dropSpot = NSPoint(x: f.midX, y: f.maxY - 90)   // inside the opened notch, on its drop zone
after(7.0) {
    drag(from: NSPoint(x: sourceRect.midX, y: sourceRect.midY), via: [(notch, 0.6), (dropSpot, 0.4)]) {
        after(1.2) {
            let added = lines.first(where: { $0.contains("\"shelf-add\"") }) ?? ""
            results.append("drag a file onto the notch: it is added to the shelf: \(added.contains(file.lastPathComponent) ? "PASS" : "FAIL")")
            guard let cards = lines.last(where: { $0.contains("\"debug-cards\"") }),
                  let data = cards.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let first = (object["frames"] as? [[Double]])?.first, first.count == 4 else {
                results.append("drag the card back out: FAIL (no card on the shelf)")
                return finish()
            }
            let card = NSPoint(x: first[0] + first[2] / 2, y: first[1] + first[3] / 2)
            drag(from: card, via: [(NSPoint(x: targetRect.midX, y: targetRect.midY), 0.4)]) {
                after(1.0) {
                    let got = target.received.map { $0.resolvingSymlinksInPath().path }
                    results.append("drag the card out onto another window: it arrives as the same file: \(got.contains(file.resolvingSymlinksInPath().path) ? "PASS" : "FAIL (\(got))")")
                    finish()
                }
            }
        }
    }
}
app.run()
