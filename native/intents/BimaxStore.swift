// Reading what Bimax actually did, from the files it actually writes.
//
// The extension runs in its own process and shares nothing with the app at runtime, so everything
// here is a READ of state the app has already committed to disk. Nothing is cached across a call:
// the app is usually running while Siri or Spotlight asks, and a stale answer about what changed
// on someone's machine is worse than a slow one.
//
// Three sources, all owned by the app and none invented here:
//
//   threads/<uuid>.json                                 app/src/main/thread.storage.ts
//   thread-state/<folder-id>/.bimax/undo/journal.jsonl  app/src/main/thread.undo.ts  (⌘2 tasks)
//   <project root>/.bimax/undo/journal.jsonl            app/src/main/thread.undo.ts  (project windows)
//
// The split in the last two is not incidental: `threadStateRoot()` keeps a ⌘2 task's state under
// the app's data directory and a project window's inside the repository, because that is where each
// belongs. Reading only the first would silently miss every change made from a project window.

import Foundation

/// Bimax's data directory. `Application Support/Bimax` is Electron's `app.getPath('userData')` for
/// an app whose productName is Bimax; it is resolved rather than hardcoded so a sandboxed or
/// relocated container still points at the right place.
enum BimaxPaths {
    static var userData: URL? {
        guard let support = try? FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: false
        ) else { return nil }
        let dir = support.appendingPathComponent("Bimax", isDirectory: true)
        return FileManager.default.fileExists(atPath: dir.path) ? dir : nil
    }
}

/// One Bimax Thread, as the app saved it.
struct StoredThread {
    let id: String
    let title: String
    let root: String
    let updatedAt: Date
    let status: String
    let outcome: String?
    let origin: String?

    var folderName: String { (root as NSString).lastPathComponent }
}

/// One change Bimax made to files, as its undo journal recorded it.
///
/// This is the record that answers "what did Bimax change in the parser yesterday?" — it carries
/// the summary the tool wrote, when, which tool, and every path it touched.
struct StoredChange {
    let id: String
    let summary: String
    let tool: String
    let at: Date
    let paths: [String]
    /// The folder whose journal this came from, so a change can be traced back to its Thread.
    let root: String

    var fileNames: [String] { paths.map { ($0 as NSString).lastPathComponent } }
}

enum BimaxStore {

    // MARK: - Threads

    static func threads(limit: Int = 500) -> [StoredThread] {
        guard let dir = BimaxPaths.userData?.appendingPathComponent("threads", isDirectory: true),
              let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path)
        else { return [] }

        var out: [StoredThread] = []
        for name in names where name.hasSuffix(".json") {
            guard out.count < limit,
                  let data = try? Data(contentsOf: dir.appendingPathComponent(name)),
                  let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let summary = root["summary"] as? [String: Any],
                  let id = summary["id"] as? String
            else { continue }
            // `updatedAt` is milliseconds since epoch — it is written by JavaScript's Date.now().
            let millis = (summary["updatedAt"] as? Double) ?? 0
            out.append(StoredThread(
                id: id,
                title: (summary["title"] as? String) ?? "Untitled task",
                root: (summary["root"] as? String) ?? "",
                updatedAt: Date(timeIntervalSince1970: millis / 1000),
                status: (summary["status"] as? String) ?? "unknown",
                outcome: summary["outcome"] as? String,
                origin: summary["origin"] as? String
            ))
        }
        return out.sorted { $0.updatedAt > $1.updatedAt }
    }

    // MARK: - Changes

    /// Every change in every journal this Mac has, newest first.
    ///
    /// Both journal locations are read. A project window writes into its repository, so its Thread's
    /// `root` is consulted for the second location — which means a change made in a project is only
    /// visible while that folder still exists, exactly as the undo feature itself behaves.
    static func changes(limit: Int = 1000) -> [StoredChange] {
        var out: [StoredChange] = []

        if let userData = BimaxPaths.userData {
            let stateDir = userData.appendingPathComponent("thread-state", isDirectory: true)
            for folderId in (try? FileManager.default.contentsOfDirectory(atPath: stateDir.path)) ?? [] {
                let journal = stateDir
                    .appendingPathComponent(folderId, isDirectory: true)
                    .appendingPathComponent(".bimax/undo/journal.jsonl")
                out.append(contentsOf: read(journal: journal, root: ""))
            }
        }

        // Project windows keep their journal in the repository itself.
        for thread in threads() where thread.origin == "project" && !thread.root.isEmpty {
            let journal = URL(fileURLWithPath: thread.root).appendingPathComponent(".bimax/undo/journal.jsonl")
            out.append(contentsOf: read(journal: journal, root: thread.root))
        }

        return Array(out.sorted { $0.at > $1.at }.prefix(limit))
    }

    /// Parse one JSONL journal. A malformed line is skipped, never fatal: the journal is appended to
    /// live and the last line can be a partial write.
    private static func read(journal: URL, root: String) -> [StoredChange] {
        guard let text = try? String(contentsOf: journal, encoding: .utf8) else { return [] }
        var out: [StoredChange] = []
        for line in text.split(separator: "\n") {
            guard let data = line.data(using: .utf8),
                  let record = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  (record["type"] as? String) == "change",
                  let id = record["id"] as? String
            else { continue }
            let ops = (record["ops"] as? [[String: Any]]) ?? []
            // Each op names its paths under different keys depending on what it did.
            let paths = ops.flatMap { op -> [String] in
                ["path", "from", "to"].compactMap { op[$0] as? String }
            }
            out.append(StoredChange(
                id: id,
                summary: (record["title"] as? String) ?? "File change",
                tool: (record["tool"] as? String) ?? "Bimax",
                at: Date(timeIntervalSince1970: ((record["at"] as? Double) ?? 0) / 1000),
                paths: paths,
                root: root
            ))
        }
        return out
    }

    // MARK: - Matching

    /// Does `haystack` match every whitespace-separated term in `needle`, case- and diacritic-
    /// insensitively?
    ///
    /// ALL terms, not any: "parser tests" should not return every change that mentions tests.
    /// `bimax-query-hints-must-check-names` records a ranking bug caused by a rewrite that deleted
    /// the distinguishing token, so nothing here rewrites the query — it only splits it.
    static func matches(_ haystack: String, _ needle: String) -> Bool {
        let terms = needle.split(whereSeparator: \.isWhitespace).filter { !$0.isEmpty }
        guard !terms.isEmpty else { return true }
        return terms.allSatisfy { term in
            haystack.range(of: String(term), options: [.caseInsensitive, .diacriticInsensitive]) != nil
        }
    }
}
