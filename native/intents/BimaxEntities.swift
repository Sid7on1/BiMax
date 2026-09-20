// Entity schemas — Bimax's own work, contributed to Siri, Shortcuts and Spotlight.
//
// Record 57, WP-9: "Bimax already keeps Threads, an evidence store and an undo journal.
// Contributed as entities, 'what did Bimax change in the parser yesterday?' becomes a Spotlight
// query. No coding IDE does this."
//
// Two entities, because they answer two different questions:
//
//   BimaxThreadEntity   what have I been working on, and where
//   BimaxChangeEntity   what did Bimax actually change, when, and to which files
//
// ## Availability, and why it degrades instead of dropping
//
// `AppEntity` and `EntityStringQuery` are macOS 13, which is the app's own floor
// (`minimumSystemVersion` in electron-builder.yml), so the entities and their queries work
// everywhere Bimax runs — that is what makes them usable from Shortcuts and Siri.
//
// `IndexedEntity`, which is what actually puts them in Spotlight's semantic index, is macOS 15.
// So the Spotlight half is gated behind `@available` and simply does not exist on 13 and 14. The
// rule from record 57 WP-10 is "degrade, do not drop": an older Mac keeps the Shortcuts actions and
// loses the Spotlight indexing, rather than losing the feature or raising the app's floor.

import AppIntents
import Foundation

// MARK: - Thread

struct BimaxThreadEntity: AppEntity {
    static var typeDisplayRepresentation: TypeDisplayRepresentation {
        TypeDisplayRepresentation(name: "Bimax Task", numericFormat: "\(placeholder: .int) tasks")
    }
    static var defaultQuery = BimaxThreadQuery()

    var id: String

    @Property(title: "Task")
    var title: String

    @Property(title: "Folder")
    var folder: String

    @Property(title: "Full path")
    var path: String

    @Property(title: "Last worked on")
    var lastWorkedOn: Date

    @Property(title: "Status")
    var status: String

    init(_ t: StoredThread) {
        id = t.id
        title = t.title
        folder = t.folderName
        path = t.root
        lastWorkedOn = t.updatedAt
        status = t.outcome ?? t.status
    }

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(
            title: "\(title)",
            // Spotlight shows this line under the title, so it carries the two things that tell
            // one task from another: where it ran and when it last moved.
            subtitle: "\(folder) · \(Self.relative(lastWorkedOn))"
        )
    }

    static func relative(_ date: Date) -> String {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .full
        return f.localizedString(for: date, relativeTo: Date())
    }
}

struct BimaxThreadQuery: EntityQuery, EntityStringQuery {
    func entities(for identifiers: [String]) async throws -> [BimaxThreadEntity] {
        let wanted = Set(identifiers)
        return BimaxStore.threads().filter { wanted.contains($0.id) }.map(BimaxThreadEntity.init)
    }

    /// Free-text search, which is what Siri and Spotlight actually send.
    func entities(matching string: String) async throws -> [BimaxThreadEntity] {
        BimaxStore.threads()
            .filter { BimaxStore.matches("\($0.title) \($0.root)", string) }
            .prefix(25)
            .map(BimaxThreadEntity.init)
    }

    /// What the Shortcuts picker shows before anything is typed: the most recent work.
    func suggestedEntities() async throws -> [BimaxThreadEntity] {
        BimaxStore.threads().prefix(12).map(BimaxThreadEntity.init)
    }
}

// MARK: - Change

struct BimaxChangeEntity: AppEntity {
    static var typeDisplayRepresentation: TypeDisplayRepresentation {
        TypeDisplayRepresentation(name: "Bimax Change", numericFormat: "\(placeholder: .int) changes")
    }
    static var defaultQuery = BimaxChangeQuery()

    var id: String

    @Property(title: "What changed")
    var summary: String

    @Property(title: "Tool")
    var tool: String

    @Property(title: "When")
    var when: Date

    @Property(title: "Files")
    var files: [String]

    init(_ c: StoredChange) {
        id = c.id
        summary = c.summary
        tool = c.tool
        when = c.at
        files = c.paths
    }

    var displayRepresentation: DisplayRepresentation {
        let names = files.map { ($0 as NSString).lastPathComponent }
        // Name the files, because "what did Bimax change" is a question about files. Three is what
        // fits a Spotlight subtitle without truncating mid-name.
        let shown = names.prefix(3).joined(separator: ", ")
        let rest = names.count > 3 ? " +\(names.count - 3) more" : ""
        return DisplayRepresentation(
            title: "\(summary)",
            subtitle: "\(shown)\(rest) · \(BimaxThreadEntity.relative(when))"
        )
    }
}

struct BimaxChangeQuery: EntityQuery, EntityStringQuery {
    func entities(for identifiers: [String]) async throws -> [BimaxChangeEntity] {
        let wanted = Set(identifiers)
        return BimaxStore.changes().filter { wanted.contains($0.id) }.map(BimaxChangeEntity.init)
    }

    func entities(matching string: String) async throws -> [BimaxChangeEntity] {
        // The file PATHS are searched, not just the summary. "what did Bimax change in the parser"
        // is a question about a file whose name the summary may never mention.
        BimaxStore.changes()
            .filter { BimaxStore.matches("\($0.summary) \($0.tool) \($0.paths.joined(separator: " "))", string) }
            .prefix(25)
            .map(BimaxChangeEntity.init)
    }

    func suggestedEntities() async throws -> [BimaxChangeEntity] {
        BimaxStore.changes().prefix(12).map(BimaxChangeEntity.init)
    }
}

// MARK: - Spotlight (macOS 15+)

// Conformance only. `IndexedEntity` uses the `@Property` titles and `displayRepresentation` above,
// so there is nothing to restate — which is the point: one definition feeds Shortcuts, Siri and
// Spotlight, and they cannot drift apart.
@available(macOS 15.0, *)
extension BimaxThreadEntity: IndexedEntity {}

@available(macOS 15.0, *)
extension BimaxChangeEntity: IndexedEntity {}
