// God's Land stage 1 exit check (docs/product-reset/gods-land/03_PLAN.md), run by scripts/check-notch.sh.
// It MOVES THE CURSOR AND CLICKS on the real screen (a small pink window of its own beside the notch), so it is never
// part of the automatic suite. Needs Accessibility for the terminal that runs it (to post events). It restores the
// cursor at the end. Measured 2026-09-25: 22 consecutive runs 4/4; with click-through removed from the helper, both
// click checks fail (0 clicks reach the window under it).
import AppKit

final class Probe: NSView {
    var clicks = 0
    override func mouseDown(with event: NSEvent) { clicks += 1 }
}

let helperPath = CommandLine.arguments[1]
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let screen = NSScreen.screens.first(where: { $0.safeAreaInsets.top > 0 }) ?? NSScreen.main!
let f = screen.frame
let original = NSEvent.mouseLocation
var lines: [String] = []
let helper = Process()
helper.executableURL = URL(fileURLWithPath: helperPath)
helper.arguments = ["--demo"]
let out = Pipe()
helper.standardOutput = out
var partial = ""
out.fileHandleForReading.readabilityHandler = { handle in
    guard let text = String(data: handle.availableData, encoding: .utf8) else { return }
    // A message can arrive split across two reads: keep the unfinished tail until its newline comes.
    DispatchQueue.main.async {
        partial += text
        while let newline = partial.firstIndex(of: "\n") {
            lines.append(String(partial[..<newline]))
            partial = String(partial[partial.index(after: newline)...])
        }
    }
}
try! helper.run()

// A target under the panel's area (the panel spans the middle half of the screen, top half), beside the notch.
let target = NSRect(x: f.midX + 290, y: f.maxY - 140, width: 50, height: 40)
let window = NSWindow(contentRect: target, styleMask: .borderless, backing: .buffered, defer: false)
let probe = Probe(frame: NSRect(origin: .zero, size: target.size))
window.contentView = probe
window.level = .floating
window.backgroundColor = .systemPink
window.collectionBehavior = [.canJoinAllSpaces]
window.orderFrontRegardless()

func quartz(_ p: NSPoint) -> CGPoint { CGPoint(x: p.x, y: f.maxY - p.y) }
func post(_ type: CGEventType, _ p: NSPoint) {
    CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: quartz(p), mouseButton: .left)?.post(tap: .cghidEventTap)
}
func move(_ p: NSPoint) { post(.mouseMoved, p) }
func after(_ seconds: Double, _ block: @escaping () -> Void) { DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: block) }
/// A hand reaches a spot before it clicks: move, then press 0.1 s later (inside the notch's 0.22 s close grace).
func click(_ p: NSPoint, then: @escaping () -> Void) {
    move(p)
    after(0.1) { post(.leftMouseDown, p); post(.leftMouseUp, p); then() }
}
func lastHover() -> String { lines.last(where: { $0.contains("\"hover\"") }) ?? "" }

let spot = NSPoint(x: target.midX, y: target.midY)
var results: [String] = []
func finish() {
    move(original)
    helper.terminate()
    print(results.joined(separator: "\n"))
    if !results.allSatisfy({ $0.contains("PASS") }) { print("helper said:\n" + lines.joined(separator: "\n")) }
    exit(results.allSatisfy { $0.contains("PASS") } ? 0 : 1)
}

after(7.0) { // the demo's "say" is over; two tasks run, so the notch rests in its compact glow
    click(spot) {
        after(0.5) {
            results.append("resting: a click beside the notch reached the window under the panel: \(probe.clicks == 1 ? "PASS" : "FAIL (\(probe.clicks) clicks)")")
            move(NSPoint(x: f.midX, y: f.maxY - 10)) // onto the notch
            after(0.8) {
                results.append("hover on the notch opens it: \(lastHover().contains("\"open\":true") ? "PASS" : "FAIL")")
                click(spot) {
                    after(0.5) {
                        results.append("open: a click beside the panel reached the window under it: \(probe.clicks == 2 ? "PASS" : "FAIL (\(probe.clicks) clicks)")")
                        move(NSPoint(x: f.midX, y: f.midY)) // well away
                        after(1.0) {
                            results.append("leaving closes it: \(lastHover().contains("\"open\":false") ? "PASS" : "FAIL")")
                            finish()
                        }
                    }
                }
            }
        }
    }
}
app.run()
