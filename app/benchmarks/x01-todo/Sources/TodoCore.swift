import Foundation

// The to-do list's data, kept apart from the window so it can be tested without one.

struct TodoItem: Codable, Equatable {
    var id: String
    var title: String
    var done: Bool
}

struct TodoSettings: Codable, Equatable {
    var sort: String
    var accent: String
}

struct TodoFile: Codable, Equatable {
    var items: [TodoItem]
    var settings: TodoSettings
}

final class TodoStore {
    private(set) var file: TodoFile
    let url: URL?

    init(file: TodoFile, url: URL? = nil) {
        self.file = file
        self.url = url
    }

    static func load(from url: URL) throws -> TodoStore {
        let data = try Data(contentsOf: url)
        return TodoStore(file: try JSONDecoder().decode(TodoFile.self, from: data), url: url)
    }

    func save() throws {
        guard let url else { return }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(file).write(to: url, options: .atomic)
    }

    var items: [TodoItem] { file.items }
    var doneCount: Int { file.items.filter { $0.done }.count }

    func toggle(id: String) {
        guard let i = file.items.firstIndex(where: { $0.id == id }) else { return }
        file.items[i].done.toggle()
    }
}
