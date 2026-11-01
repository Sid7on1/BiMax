import AppKit
final class ExposedContent: NSView {
    var exposed: [NSView] = []
    override func accessibilityChildren() -> [Any]? { exposed }
}
final class Proof: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    let draft = NSTextField(frame: NSRect(x: 25, y: 80, width: 380, height: 28))
    let conversation = NSTextField(labelWithString: "Mom demo")
    let stack = NSStackView()
    var selected = "Mom demo"
    var sends = 0
    var messages: [[String: Any]] = [
        ["id": "old-mom", "recipient": "Mom demo", "text": "hi"],
        ["id": "old-other", "recipient": "Other demo", "text": "do not change"]
    ]
    let statePath = "/private/tmp/bimax-message-proof/state.json"
    func persist() {
        let data = try! JSONSerialization.data(withJSONObject: ["recipient": selected, "draft": draft.stringValue, "sends": sends, "messages": messages], options: [.sortedKeys])
        try! data.write(to: URL(fileURLWithPath: statePath), options: .atomic)
    }
    func refresh() {
        conversation.stringValue = selected
        for view in stack.arrangedSubviews { stack.removeArrangedSubview(view); view.removeFromSuperview() }
        for message in messages where message["recipient"] as? String == selected {
            let row = NSTextField(labelWithString: message["text"] as! String)
            row.setAccessibilityLabel("Outgoing message")
            stack.addArrangedSubview(row)
            row.setAccessibilityElement(true)
        }
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 330), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Safe Messaging Proof"
        let content = ExposedContent(frame: window.contentView!.bounds)
        window.contentView = content
        conversation.frame = NSRect(x: 25, y: 280, width: 380, height: 25)
        conversation.setAccessibilityLabel("Conversation")
        draft.setAccessibilityLabel("Message")
        let send = NSButton(title: "Send", target: self, action: #selector(sendMessage))
        send.frame = NSRect(x: 25, y: 35, width: 100, height: 30)
        let other = NSButton(title: "Other demo", target: self, action: #selector(selectOther))
        other.frame = NSRect(x: 270, y: 35, width: 130, height: 30)
        stack.frame = NSRect(x: 25, y: 125, width: 380, height: 140)
        stack.orientation = .vertical
        stack.alignment = .leading
        for view in [conversation, stack, draft, send, other] as [NSView] { window.contentView!.addSubview(view) }
        content.exposed = [conversation, stack, draft, send, other]
        refresh(); persist(); window.center(); window.makeKeyAndOrderFront(nil)
    }
    @objc func sendMessage() {
        guard !draft.stringValue.isEmpty else { return }
        sends += 1
        messages.append(["id": "new-\(sends)", "recipient": selected, "text": draft.stringValue])
        draft.stringValue = ""
        refresh(); persist()
    }
    @objc func selectOther() { selected = "Other demo"; draft.stringValue = ""; refresh(); persist() }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
let app = NSApplication.shared
let proof = Proof()
app.delegate = proof
app.setActivationPolicy(.regular)
app.run()
