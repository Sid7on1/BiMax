// Bimax App Intents — what Siri, Spotlight and the Shortcuts app can ask Bimax to do.
//
// Record 57, WP-9. This is an App Extension, not part of the app target, because Bimax's principal
// executable is Electron's: a Swift AppIntent compiled into the app bundle would have no module for
// the system to instantiate it from. An `.appex` is a real Swift binary macOS can launch, so the
// intents live here and are discovered from Contents/PlugIns.
//
// ## Every intent performs by opening `bimax://task`
//
// That is deliberate and is the whole security design. The URL is parsed, validated and shown in a
// confirmation whose default is Cancel by `app/src/main/bimax.link.ts`, which has been the tested
// path since backlog N2. An intent therefore CANNOT do anything a pasted link could not, and Siri
// cannot approve a file change — it can only fill in a task and hand it to the same dialog.
//
// If a future intent needs to do something the URL cannot express, it gets a new verb in the link
// parser with its own refusal rules, never a private channel into the app.

import AppIntents
import AppKit
import ExtensionFoundation
import Foundation

/// The extension's principal type.
///
/// `AppIntentsExtension` refines `ExtensionFoundation.AppExtension`, which supplies the `main`
/// entry point — an `.appex` is an executable bundle, and without this the link fails with an
/// undefined `_main`. It carries no members: its only job is to exist so macOS has something to
/// launch, and so the AppIntents runtime is loaded in that process.
@main
struct BimaxIntentsExtension: AppIntentsExtension {}

/// Long enough for a real instruction, and the same ceiling the link parser enforces
/// (`MAX_LINK_PROMPT` in bimax.link.ts). Kept in step so a prompt that Siri accepts is never
/// refused by the dialog it opens.
let maxPromptLength = 2000

/// Shared by every intent in this module — see BimaxQueryIntents.swift.
enum BimaxLink {
    /// Build `bimax://task?folder=…&prompt=…`.
    ///
    /// `URLComponents` percent-encodes the query for us. Building the string by hand is how a
    /// prompt containing `&` silently truncates, so it is not done by hand.
    static func taskURL(folder: String, prompt: String?) -> URL? {
        var components = URLComponents()
        components.scheme = "bimax"
        components.host = "task"
        var items = [URLQueryItem(name: "folder", value: folder)]
        if let prompt, !prompt.isEmpty { items.append(URLQueryItem(name: "prompt", value: prompt)) }
        components.queryItems = items
        return components.url
    }

    /// Hand the link to macOS, which routes it to Bimax by its registered scheme.
    ///
    /// Returns false when nothing handles `bimax://` — which means Bimax is not installed, or the
    /// build dropped the URL-type registration. `check-app-actions.mjs` is the gate for the second
    /// case; this is what the user sees if it ever gets past it.
    static func open(_ url: URL) -> Bool {
        NSWorkspace.shared.open(url)
    }
}

/// Resolve and check a folder before it ever reaches the link.
///
/// The app refuses these cases too, after resolving symlinks. Refusing here as well means the
/// person is told by the thing they are talking to, rather than watching a dialog appear and
/// immediately cancel itself.
func validatedFolder(_ folder: String) throws -> String {
    let trimmed = folder.trimmingCharacters(in: .whitespacesAndNewlines)
    let expanded = (trimmed as NSString).expandingTildeInPath
    guard !expanded.isEmpty, expanded.hasPrefix("/") else {
        throw IntentError.badFolder("Which folder should Bimax work in? Give a full path, like ~/Downloads.")
    }
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    guard expanded != "/", expanded != home else {
        throw IntentError.badFolder("Choose a specific folder rather than your whole home folder.")
    }
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: expanded, isDirectory: &isDirectory), isDirectory.boolValue else {
        throw IntentError.badFolder("There is no folder at \(expanded).")
    }
    return expanded
}

// MARK: - Start a task

/// "Start a Bimax task in ~/Downloads that sorts the PDFs by month."
struct StartBimaxTask: AppIntent {
    static var title: LocalizedStringResource = "Start a Task"
    static var description = IntentDescription(
        "Opens a Bimax task in a folder with a prompt ready to run. Bimax asks you to confirm before it starts, and still asks before it changes any file.",
        categoryName: "Tasks",
        searchKeywords: ["bimax", "agent", "code", "task", "automate"]
    )

    /// Bimax is brought forward because the confirmation is the point: the person has to see what
    /// they are about to start. An intent that ran a task invisibly would be a different product.
    static var openAppWhenRun: Bool = true

    @Parameter(title: "Folder", description: "The folder the task works in. A task only changes files inside it.")
    var folder: String

    @Parameter(title: "Prompt", description: "What you want Bimax to do.")
    var prompt: String

    static var parameterSummary: some ParameterSummary {
        Summary("Start a Bimax task in \(\.$folder) that does \(\.$prompt)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let root = try validatedFolder(folder)
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            throw IntentError.badPrompt("What should Bimax do in that folder?")
        }
        guard text.count <= maxPromptLength else {
            throw IntentError.badPrompt("That prompt is longer than \(maxPromptLength) characters. Shorten it so the confirmation can show all of it.")
        }
        guard let url = BimaxLink.taskURL(folder: root, prompt: text), BimaxLink.open(url) else {
            throw IntentError.unavailable
        }
        return .result(dialog: "Opening a Bimax task in \((root as NSString).lastPathComponent). Confirm it to start.")
    }
}

// MARK: - Open a task

/// "Open a Bimax task in ~/code/api" — no prompt, just put me there.
struct OpenBimaxTask: AppIntent {
    static var title: LocalizedStringResource = "Open a Task in a Folder"
    static var description = IntentDescription(
        "Opens an empty Bimax task bound to a folder, ready for you to type in. Nothing runs until you send a message.",
        categoryName: "Tasks",
        searchKeywords: ["bimax", "open", "folder", "project"]
    )

    static var openAppWhenRun: Bool = true

    @Parameter(title: "Folder", description: "The folder the task works in.")
    var folder: String

    static var parameterSummary: some ParameterSummary {
        Summary("Open a Bimax task in \(\.$folder)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let root = try validatedFolder(folder)
        guard let url = BimaxLink.taskURL(folder: root, prompt: nil), BimaxLink.open(url) else {
            throw IntentError.unavailable
        }
        return .result(dialog: "Opening a Bimax task in \((root as NSString).lastPathComponent).")
    }
}

// MARK: - Errors

enum IntentError: Swift.Error, CustomLocalizedStringResourceConvertible {
    case unavailable
    case badFolder(String)
    case badPrompt(String)

    var localizedStringResource: LocalizedStringResource {
        switch self {
        // Name the real cause rather than the leftover symptom (bimax-error-must-name-real-cause):
        // the link was well-formed and macOS still had nowhere to send it.
        case .unavailable:
            return "macOS could not open a bimax:// link. Check that Bimax is installed."
        case .badFolder(let why):
            return "\(why)"
        case .badPrompt(let why):
            return "\(why)"
        }
    }
}

// MARK: - Siri phrases

/// The phrases Siri recognises with no setup. Each must contain `\(.applicationName)`, which is why
/// every one of them names Bimax.
struct BimaxShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: StartBimaxTask(),
            phrases: [
                "Start a \(.applicationName) task",
                "Run a task in \(.applicationName)",
                "Ask \(.applicationName) to do something"
            ],
            shortTitle: "Start a Task",
            systemImageName: "play.circle"
        )
        AppShortcut(
            intent: OpenBimaxTask(),
            phrases: [
                "Open a \(.applicationName) task",
                "Open a folder in \(.applicationName)"
            ],
            shortTitle: "Open a Task",
            systemImageName: "folder"
        )
        // The read half. These answer rather than act, which is why they are worth having as
        // spoken phrases at all: you can ask them without deciding to start anything.
        AppShortcut(
            intent: FindBimaxChanges(),
            phrases: [
                "What did \(.applicationName) change",
                "What has \(.applicationName) changed",
                "Find \(.applicationName) changes"
            ],
            shortTitle: "Find Changes",
            systemImageName: "clock.arrow.circlepath"
        )
        AppShortcut(
            intent: FindBimaxTasks(),
            phrases: [
                "What was I working on in \(.applicationName)",
                "Find a \(.applicationName) task",
                "My \(.applicationName) tasks"
            ],
            shortTitle: "Find Tasks",
            systemImageName: "list.bullet.rectangle"
        )
    }
}
