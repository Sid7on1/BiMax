// Asking Bimax what it did.
//
// These are the READ half of the App Intents surface. The two in BimaxIntents.swift start work;
// these three answer questions about work already done, and none of them can change anything —
// they open no link, launch nothing, and touch no file. `openAppWhenRun` is deliberately absent:
// being told what changed should not steal focus.

import AppIntents
import Foundation

/// How far back a question reaches when it does not say.
///
/// A week, because "what did Bimax change" is nearly always about the current piece of work, and a
/// longer default buries today's answer under a fortnight of it. `FindBimaxChanges` takes an
/// explicit `days` for everything else.
private let defaultLookbackDays = 7

// MARK: - What changed

/// "What did Bimax change in the parser yesterday?"
struct FindBimaxChanges: AppIntent {
    static var title: LocalizedStringResource = "Find Changes"
    static var description = IntentDescription(
        "Finds the file changes Bimax made, by file name, tool or what the change was. Read-only — it answers, and changes nothing.",
        categoryName: "History",
        searchKeywords: ["bimax", "changed", "edited", "history", "undo", "files"]
    )

    @Parameter(title: "About", description: "A file name, a folder, or words from the change. Leave empty for everything recent.")
    var about: String?

    @Parameter(title: "Within days", description: "How far back to look. Defaults to a week.", default: 7, inclusiveRange: (1, 365))
    var days: Int?

    static var parameterSummary: some ParameterSummary {
        Summary("Find Bimax changes about \(\.$about) in the last \(\.$days) days")
    }

    func perform() async throws -> some IntentResult & ReturnsValue<[BimaxChangeEntity]> & ProvidesDialog {
        let window = Double(days ?? defaultLookbackDays) * 86_400
        let since = Date().addingTimeInterval(-window)
        let term = (about ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

        let found = BimaxStore.changes()
            .filter { $0.at >= since }
            .filter { term.isEmpty || BimaxStore.matches("\($0.summary) \($0.tool) \($0.paths.joined(separator: " "))", term) }
            .prefix(50)
            .map(BimaxChangeEntity.init)

        // Say which of the two things is true when nothing comes back. "No changes" and "no changes
        // MATCHING THAT" send a person to different next steps, and the second is the common one
        // (bimax-error-must-name-real-cause).
        guard !found.isEmpty else {
            let nothingAtAll = BimaxStore.changes().filter { $0.at >= since }.isEmpty
            return .result(
                value: [],
                dialog: nothingAtAll
                    ? "Bimax has not changed any files in the last \(days ?? defaultLookbackDays) days."
                    : "Bimax changed files in that period, but none matching “\(term)”."
            )
        }

        let files = Set(found.flatMap { $0.files.map { ($0 as NSString).lastPathComponent } })
        return .result(
            value: Array(found),
            dialog: "\(found.count) change\(found.count == 1 ? "" : "s") across \(files.count) file\(files.count == 1 ? "" : "s")."
        )
    }
}

// MARK: - What was I working on

/// "What was I working on in Bimax?"
struct FindBimaxTasks: AppIntent {
    static var title: LocalizedStringResource = "Find Tasks"
    static var description = IntentDescription(
        "Finds Bimax tasks by name or folder, most recent first. Read-only.",
        categoryName: "History",
        searchKeywords: ["bimax", "task", "thread", "recent", "working on"]
    )

    @Parameter(title: "About", description: "Words from the task, or the folder it ran in. Leave empty for the most recent.")
    var about: String?

    static var parameterSummary: some ParameterSummary {
        Summary("Find Bimax tasks about \(\.$about)")
    }

    func perform() async throws -> some IntentResult & ReturnsValue<[BimaxThreadEntity]> & ProvidesDialog {
        let term = (about ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let found = BimaxStore.threads()
            .filter { term.isEmpty || BimaxStore.matches("\($0.title) \($0.root)", term) }
            .prefix(25)
            .map(BimaxThreadEntity.init)

        guard let newest = found.first else {
            return .result(value: [], dialog: term.isEmpty
                ? "Bimax has no saved tasks yet."
                : "No Bimax task matches “\(term)”.")
        }
        return .result(
            value: Array(found),
            dialog: found.count == 1
                ? "One task: \(newest.title), in \(newest.folder)."
                : "\(found.count) tasks. Most recent: \(newest.title), in \(newest.folder)."
        )
    }
}

// MARK: - Reopen

/// "Open the task I was working on in the parser."
///
/// The one write-adjacent intent here, and it still goes through `bimax://task` — so it opens the
/// task's FOLDER through the same confirmation as everything else. It cannot resume a conversation
/// silently, and it is listed here rather than with the start intents because the thing being
/// chosen is a past task, not a folder.
struct OpenBimaxTaskFolder: AppIntent {
    static var title: LocalizedStringResource = "Open a Past Task's Folder"
    static var description = IntentDescription(
        "Opens a new Bimax task in the folder a past task ran in. Bimax asks you to confirm.",
        categoryName: "History"
    )

    static var openAppWhenRun: Bool = true

    @Parameter(title: "Task")
    var task: BimaxThreadEntity

    static var parameterSummary: some ParameterSummary {
        Summary("Open the folder of \(\.$task)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard !task.path.isEmpty else {
            throw IntentError.badFolder("That task did not record a folder.")
        }
        let root = try validatedFolder(task.path)
        guard let url = BimaxLink.taskURL(folder: root, prompt: nil), BimaxLink.open(url) else {
            throw IntentError.unavailable
        }
        return .result(dialog: "Opening a Bimax task in \(task.folder).")
    }
}
