import Cocoa
final class Fixture: NSObject, NSApplicationDelegate {
  var window: NSWindow!
  let field = NSTextField(string: "")
  let label = NSTextField(labelWithString: "Not saved")
  var count = 0
  let file = URL(fileURLWithPath: CommandLine.arguments[1])
  func applicationDidFinishLaunching(_ n: Notification) {
    let menu = NSMenu(); let item = NSMenuItem(); menu.addItem(item)
    let submenu = NSMenu(); submenu.addItem(withTitle: "Quit Arc Fixture", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"); item.submenu = submenu; NSApp.mainMenu = menu
    window = NSWindow(contentRect: NSRect(x: 240, y: 280, width: 420, height: 210), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
    window.title = "Arc Driver Verification"
    window.collectionBehavior.insert(.canJoinAllSpaces)
    field.frame = NSRect(x: 25, y: 115, width: 350, height: 28); field.setAccessibilityLabel("Verification message")
    let button = NSButton(title: "Save verification", target: self, action: #selector(save)); button.frame = NSRect(x: 25, y: 65, width: 160, height: 32)
    label.frame = NSRect(x: 25, y: 25, width: 350, height: 24)
    window.contentView!.addSubview(field); window.contentView!.addSubview(button); window.contentView!.addSubview(label)
    write(); window.makeKeyAndOrderFront(nil); window.orderFrontRegardless(); NSApp.activate(ignoringOtherApps: true)
  }
  @objc func save() { count += 1; label.stringValue = "Saved: \(field.stringValue)"; write() }
  func write() {
    let data = try! JSONSerialization.data(withJSONObject: ["text": field.stringValue, "saves": count], options: [.sortedKeys]); try! data.write(to: file, options: .atomic)
  }
}
let delegate = Fixture(); NSApplication.shared.delegate = delegate; NSApplication.shared.setActivationPolicy(.regular); NSApplication.shared.run()
