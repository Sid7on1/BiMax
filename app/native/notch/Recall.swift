// God's Land stage 8: find by vague memory, and predictive cards (docs/product-reset/gods-land/03_PLAN.md). The app
// keeps the log and decides what to show (app/src/main/recall.ts); this draws it. The notch takes no input (owner
// decision 3), so recall is browsing by the cues people remember, not a search box.
//
// Protocol additions:
//   in   {"t":"recall","enabled":bool,"next":{"label","items":[card]},"groups":[{"cue","items":[card]}]}
//   out  {"t":"front","app"}  the app now in front (the notch never activates, so it is the person's)
//        {"t":"recall-keep","path"}  put a recall card on the shelf
//        recall cards use the shelf's own messages ({"t":"shelf-touch","id":"recall:<path>"}) when used

import AppKit
import SwiftUI

struct RecallGroup: Identifiable, Equatable {
    let cue: String
    let items: [ShelfCard]
    var id: String { cue }

    init(cue: String, items: [ShelfCard]) {
        self.cue = cue
        self.items = items
    }

    init?(json row: [String: Any]) {
        guard let cue = row["cue"] as? String else { return nil }
        let items = (row["items"] as? [[String: Any]] ?? []).compactMap(ShelfCard.init(json:))
        guard !items.isEmpty else { return nil }
        self.init(cue: cue, items: items)
    }
}

/// Tells the app which app is in front, each time it changes. Event-driven: nothing runs while nothing changes.
final class FrontAppWatch {
    private var observer: Any?

    static var current: String? {
        guard let app = NSWorkspace.shared.frontmostApplication, app.processIdentifier != ProcessInfo.processInfo.processIdentifier else { return nil }
        return app.localizedName
    }

    func start(_ changed: @escaping (String) -> Void) {
        observer = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                  app.processIdentifier != ProcessInfo.processInfo.processIdentifier, let name = app.localizedName else { return }
            changed(name)
        }
    }
}

/// A row of recall cards: the same cards as the shelf, marked as memories (tap looks, right-click keeps).
struct RecallRow: View {
    let items: [ShelfCard]
    let act: (ShelfAction) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(items) { card in
                    ShelfCardView(card: card, memory: true, act: act, dragStarted: {})
                }
            }
        }
        .frame(height: 80)
    }
}

/// Under the tasks on Now: what is probably wanted next (or plainly the most recent, until the ranker has earned it).
struct NextSection: View {
    @ObservedObject var model: NotchModel
    let act: (ShelfAction) -> Void

    var body: some View {
        if model.recallEnabled && !model.recallNext.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text(model.recallLabel).font(.system(size: 11, weight: .semibold)).foregroundStyle(.white.opacity(0.85))
                RecallRow(items: model.recallNext, act: act)
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel(model.recallLabel)
        }
    }
}

/// The Recall tab: the files used through Bimax, grouped by when, the app in front, and the task they came from.
struct RecallSection: View {
    @ObservedObject var model: NotchModel
    let act: (ShelfAction) -> Void

    var body: some View {
        if !model.recallEnabled {
            Text("Recall is off. Turn on “Remember Files Used in the Notch” in the Bimax menu.")
                .font(.system(size: 12)).foregroundStyle(.white.opacity(0.55)).fixedSize(horizontal: false, vertical: true)
        } else if model.recallGroups.isEmpty {
            Text("Files you drop, use or get back from tasks show up here, by when and where you used them.")
                .font(.system(size: 12)).foregroundStyle(.white.opacity(0.55)).fixedSize(horizontal: false, vertical: true)
        } else {
            ScrollView(.vertical, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(model.recallGroups) { group in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(group.cue).font(.system(size: 11, weight: .semibold)).foregroundStyle(.white.opacity(0.85)).lineLimit(1)
                            RecallRow(items: group.items, act: act)
                        }
                        .accessibilityElement(children: .contain)
                        .accessibilityLabel(group.cue)
                    }
                }
            }
            .frame(maxHeight: 300)
        }
    }
}
