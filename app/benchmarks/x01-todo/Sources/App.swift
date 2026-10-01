import AppKit

// Bimax To-Do: the X01 fixture (record 65 stage 5). A plain list of to-dos read from the data file named in
// Info.plist (BimaxTodoData). Each to-do is a checkbox; the status line says how many there are and how many are done.

@MainActor
final class TodoController: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var store: TodoStore!
    private let list = NSStackView()
    private let status = NSTextField(labelWithString: "")

    func applicationDidFinishLaunching(_ notification: Notification) {
        let path = Bundle.main.object(forInfoDictionaryKey: "BimaxTodoData") as? String ?? "data/todos.json"
        do { store = try TodoStore.load(from: URL(fileURLWithPath: path)) } catch {
            store = TodoStore(file: TodoFile(items: [], settings: TodoSettings(sort: "manual", accent: "blue")))
        }
        window = NSWindow(contentRect: NSRect(x: 240, y: 240, width: 420, height: 320),
                          styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = "Bimax To-Do"
        list.orientation = .vertical
        list.alignment = .leading
        list.spacing = 8
        status.setAccessibilityIdentifier("todo-status")
        let root = NSStackView(views: [list, status])
        root.orientation = .vertical
        root.alignment = .leading
        root.spacing = 16
        root.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
        window.contentView = root
        render()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func render() {
        list.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for item in store.items {
            let box = NSButton(checkboxWithTitle: item.title, target: self, action: #selector(toggled(_:)))
            box.state = item.done ? .on : .off
            box.identifier = NSUserInterfaceItemIdentifier(item.id)
            list.addArrangedSubview(box)
        }
        status.stringValue = "items=\(store.items.count) done=\(store.doneCount)"
    }

    @objc private func toggled(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue else { return }
        store.toggle(id: id)
        try? store.save()
        render()
    }
}

@main
struct BimaxTodoApp {
    @MainActor static func main() {
        let app = NSApplication.shared
        let controller = TodoController()
        app.delegate = controller
        app.setActivationPolicy(.regular)
        app.run()
    }
}
