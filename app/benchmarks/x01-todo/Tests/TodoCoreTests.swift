import Foundation

// Tests for TodoCore, run by ./run-tests.sh (no Xcode needed). Each check prints PASS or FAIL; any FAIL exits 1.

var failures = 0
func check(_ name: String, _ condition: Bool) {
    print("\(condition ? "PASS" : "FAIL")  \(name)")
    if !condition { failures += 1 }
}

func sample() -> TodoStore {
    TodoStore(file: TodoFile(items: [
        TodoItem(id: "a", title: "One", done: true),
        TodoItem(id: "b", title: "Two", done: false),
    ], settings: TodoSettings(sort: "manual", accent: "blue")))
}

@main
struct TodoCoreTests {
    static func main() {
        let store = sample()
        check("counts done items", store.doneCount == 1)
        store.toggle(id: "b")
        check("toggle marks an item done", store.items[1].done)
        store.toggle(id: "missing")
        check("toggling an unknown id changes nothing", store.items.count == 2 && store.doneCount == 2)
        exit(failures == 0 ? 0 : 1)
    }
}
