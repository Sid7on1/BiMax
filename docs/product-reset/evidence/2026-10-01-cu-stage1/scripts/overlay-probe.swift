// A floating, non-activating panel shaped like Bimax's ⌘2 bar: .accessory app, level .floating,
// becomesKeyOnlyIfNeeded. Driver 0.18 refused bring_to_front whenever one of these was on screen.
import AppKit
final class Delegate: NSObject, NSApplicationDelegate {
    var panel: NSPanel!
    func applicationDidFinishLaunching(_ n: Notification) {
        panel = NSPanel(contentRect: NSRect(x: 40, y: 40, width: 260, height: 44),
                        styleMask: [.nonactivatingPanel, .titled, .fullSizeContentView], backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = true
        panel.level = .floating
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        let label = NSTextField(labelWithString: "Bimax stage-1 overlay probe")
        label.frame = NSRect(x: 12, y: 12, width: 236, height: 20)
        panel.contentView?.addSubview(label)
        panel.orderFrontRegardless()
    }
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = Delegate()
app.delegate = delegate
app.run()
