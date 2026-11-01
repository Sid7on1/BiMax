import AppKit

final class Fixture: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    let field = NSTextField(frame: NSRect(x: 30, y: 100, width: 380, height: 28))
    let status = NSTextField(labelWithString: "Not saved")
    var saves = 0
    let statePath = "/private/tmp/arc-proof/state.json"
    func writeState() {
        let data = try! JSONSerialization.data(withJSONObject: ["text": field.stringValue, "saves": saves], options: [.sortedKeys])
        try! data.write(to: URL(fileURLWithPath: statePath), options: .atomic)
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 220), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Arc Driver Verification"
        field.setAccessibilityLabel("Verification message")
        let save = NSButton(title: "Save verification", target: self, action: #selector(saveVerification))
        save.frame = NSRect(x: 30, y: 55, width: 180, height: 30)
        status.frame = NSRect(x: 30, y: 15, width: 410, height: 25)
        window.contentView!.addSubview(field)
        window.contentView!.addSubview(save)
        window.contentView!.addSubview(status)
        window.center()
        window.makeKeyAndOrderFront(nil)
        writeState()
    }
    @objc func saveVerification() {
        saves += 1
        status.stringValue = "Saved: " + field.stringValue
        writeState()
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
let app = NSApplication.shared
let fixture = Fixture()
app.delegate = fixture
app.setActivationPolicy(.regular)
app.run()
