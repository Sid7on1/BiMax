// God's Land stage 2: the shelf (docs/product-reset/gods-land/03_PLAN.md). The rules — by reference, temporary files
// copied, amber after a day, never deleted — live in app/src/main/shelf.ts; this file draws the cards, takes drops,
// gives drags, previews with Quick Look, and tells the app what happened.
//
// Protocol additions:
//   in   {"t":"shelf","items":[card],"archived":[card]}   card = {"id","kind":"file|url|text","title","path?","url?",
//                                                                "text?","missing":bool,"amber":bool}
//   out  {"t":"shelf-add","items":[{"kind","path?|url?|text?"}]}   {"t":"shelf-touch","id"}
//        {"t":"shelf-archive","ids":[…]} or {"t":"shelf-archive","amber":true}   {"t":"shelf-restore","id"}

import AppKit
import Quartz
import SwiftUI
import UniformTypeIdentifiers

struct ShelfCard: Identifiable, Equatable {
    let id: String
    let kind: String
    let title: String
    let path: String?
    let url: String?
    let text: String?
    let missing: Bool
    let amber: Bool
    /// Stage 3, the Hatchback: the task that put it here, and how that task's check went.
    let task: String?
    let check: String?
    /// Stage 7: what this card can become, most used first (transmute.ts).
    var actions: [TransmuteAction] = []

    init(id: String, kind: String, title: String, path: String? = nil, url: String? = nil, text: String? = nil, missing: Bool = false, amber: Bool = false,
         task: String? = nil, check: String? = nil) {
        self.id = id; self.kind = kind; self.title = title; self.path = path; self.url = url; self.text = text
        self.missing = missing; self.amber = amber; self.task = task; self.check = check
    }

    init?(json row: [String: Any]) {
        guard let id = row["id"] as? String, let kind = row["kind"] as? String, let title = row["title"] as? String else { return nil }
        self.init(id: id, kind: kind, title: title, path: row["path"] as? String, url: row["url"] as? String, text: row["text"] as? String,
                  missing: row["missing"] as? Bool ?? false, amber: row["amber"] as? Bool ?? false,
                  task: row["task"] as? String, check: row["check"] as? String)
        actions = (row["actions"] as? [[String: Any]] ?? []).compactMap(TransmuteAction.init(json:))
    }

    var fileURL: URL? { kind == "file" ? path.map { URL(fileURLWithPath: $0) } : nil }

    /// What a drag out of the notch carries; nil for a file that is gone.
    func itemProvider() -> NSItemProvider? {
        switch kind {
        case "file":
            guard !missing, let fileURL else { return nil }
            return NSItemProvider(contentsOf: fileURL)
        case "url":
            guard let string = url, let link = URL(string: string) else { return nil }
            return NSItemProvider(object: link as NSURL)
        default:
            guard let text else { return nil }
            return NSItemProvider(object: text as NSString)
        }
    }
}

// MARK: - Drops

/// Reads what was dropped, in order of preference per item: a file, an http(s) link, image data (written to a
/// temporary file the app then copies), plain text. Calls back once with everything it could read.
enum DropReader {
    static let types: [UTType] = [.fileURL, .url, .image, .utf8PlainText, .plainText]

    static func read(_ providers: [NSItemProvider], on queue: DispatchQueue = .main, done: @escaping ([[String: Any]]) -> Void) {
        let group = DispatchGroup()
        let lock = NSLock()
        var items: [(Int, [String: Any])] = []
        func keep(_ index: Int, _ item: [String: Any]) { lock.lock(); items.append((index, item)); lock.unlock() }

        for (index, provider) in providers.enumerated() {
            group.enter()
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier) { item, _ in
                    defer { group.leave() }
                    let url = (item as? URL) ?? (item as? Data).flatMap { URL(dataRepresentation: $0, relativeTo: nil) }
                    if let url, url.isFileURL { keep(index, ["kind": "file", "path": url.path]) }
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                _ = provider.loadObject(ofClass: NSURL.self) { object, _ in
                    defer { group.leave() }
                    if let url = object as? URL, let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" {
                        keep(index, ["kind": "url", "url": url.absoluteString])
                    }
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                provider.loadDataRepresentation(forTypeIdentifier: UTType.png.identifier) { data, _ in
                    defer { group.leave() }
                    guard let data else { return }
                    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("bimax-shelf-drops", isDirectory: true)
                    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                    let file = folder.appendingPathComponent("Image \(Self.stamp()).png")
                    if (try? data.write(to: file)) != nil { keep(index, ["kind": "file", "path": file.path]) }
                }
            } else if provider.canLoadObject(ofClass: NSString.self) {
                _ = provider.loadObject(ofClass: NSString.self) { object, _ in
                    defer { group.leave() }
                    if let text = object as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { keep(index, ["kind": "text", "text": text]) }
                }
            } else {
                group.leave()
            }
        }
        group.notify(queue: queue) { done(items.sorted { $0.0 < $1.0 }.map(\.1)) }
    }

    private static func stamp() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd 'at' HH.mm.ss"
        return formatter.string(from: Date())
    }
}

// MARK: - Dragging in progress

/// Whether something is being dragged anywhere on the Mac, without Accessibility: the drag pasteboard's change count
/// moves when a drag starts (research 02 §1). Recorded at mouse-down, compared while the mouse is dragged.
final class DragWatch {
    private var countAtMouseDown = NSPasteboard(name: .drag).changeCount
    private var monitors: [Any] = []
    var changed: (Bool) -> Void = { _ in }
    private(set) var dragging = false

    func start() {
        let down = NSEvent.addGlobalMonitorForEvents(matching: .leftMouseDown) { [weak self] _ in self?.mouseDown() }
        let localDown = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] event in self?.mouseDown(); return event }
        let drag = NSEvent.addGlobalMonitorForEvents(matching: .leftMouseDragged) { [weak self] _ in self?.mouseDragged() }
        let localDrag = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDragged) { [weak self] event in self?.mouseDragged(); return event }
        let up = NSEvent.addGlobalMonitorForEvents(matching: .leftMouseUp) { [weak self] _ in self?.mouseUp() }
        let localUp = NSEvent.addLocalMonitorForEvents(matching: .leftMouseUp) { [weak self] event in self?.mouseUp(); return event }
        monitors = [down, localDown, drag, localDrag, up, localUp].compactMap { $0 }
    }

    private func mouseDown() {
        countAtMouseDown = NSPasteboard(name: .drag).changeCount
    }

    private func mouseDragged() {
        if debugging { FileHandle.standardError.write("drag-event count=\(NSPasteboard(name: .drag).changeCount) atDown=\(countAtMouseDown) dragging=\(dragging)\n".data(using: .utf8)!) }
        guard !dragging, NSPasteboard(name: .drag).changeCount != countAtMouseDown else { return }
        dragging = true
        changed(true)
    }

    private func mouseUp() {
        guard dragging else { return }
        // After the drop handler, which runs on this same mouse-up.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
            guard let self, self.dragging else { return }
            self.dragging = false
            self.changed(false)
        }
    }
}

// MARK: - Quick Look

final class Previewer: NSObject, QLPreviewPanelDataSource, QLPreviewPanelDelegate {
    static let shared = Previewer()
    private var url: URL?

    func show(_ url: URL) {
        self.url = url
        NSApp.activate(ignoringOtherApps: true)
        guard let panel = QLPreviewPanel.shared() else { return }
        panel.dataSource = self
        panel.delegate = self
        panel.reloadData()
        panel.makeKeyAndOrderFront(nil)
    }

    func numberOfPreviewItems(in panel: QLPreviewPanel!) -> Int { url == nil ? 0 : 1 }
    func previewPanel(_ panel: QLPreviewPanel!, previewItemAt index: Int) -> QLPreviewItem! { url as NSURL? }
}

// MARK: - Views

struct ShelfSection: View {
    @ObservedObject var model: NotchModel
    let act: (ShelfAction) -> Void
    let edit: ([NSItemProvider]) -> Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if model.dragging && !model.draggingOut {
                HStack(spacing: 8) {
                    DropZone(title: "Keep", symbol: "tray.and.arrow.down.fill", targeted: model.dropTargeted)
                        .accessibilityLabel("Drop here to keep it on the shelf")
                    DropZone(title: "Edit with Bimax", symbol: "drop.fill", targeted: model.editTargeted)
                        .onDrop(of: [.fileURL], isTargeted: Binding(get: { model.editTargeted }, set: { model.editTargeted = $0 })) { providers in
                            edit(providers)
                        }
                        .accessibilityLabel("Drop files here to start a Bimax task with them")
                }
            }
            if !model.shelf.isEmpty || !model.archived.isEmpty {
                HStack(spacing: 10) {
                    Text("Shelf").font(.system(size: 11, weight: .semibold)).foregroundStyle(.primary)
                    Spacer()
                    if model.shelf.contains(where: \.amber) {
                        Button("Sweep old") { act(.sweep) }.buttonStyle(ChipStyle())
                            .accessibilityHint("Moves cards untouched for a day to the archive. Nothing is deleted.")
                    }
                    if !model.archived.isEmpty {
                        Button(model.showArchive ? "Hide archive" : "Archive \(model.archived.count)") { model.showArchive.toggle() }.buttonStyle(ChipStyle())
                    }
                }
                if model.showArchive {
                    VStack(spacing: 2) {
                        ForEach(model.archived.prefix(6)) { card in
                            HStack {
                                Text(card.title).font(.system(size: 11)).foregroundStyle(Color.white.opacity(notchSecondary)).lineLimit(1)
                                Spacer()
                                Button("Put back") { act(.restore(card.id)) }.buttonStyle(ChipStyle())
                            }
                        }
                    }
                } else if !model.shelf.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(model.shelf) { card in
                                ShelfCardView(card: card, selected: model.selectedCard == card.id, act: act, dragStarted: { model.draggingOut = true })
                                    // Where each card is drawn, for the on-screen check's drag-out (BIMAX_NOTCH_DEBUG only).
                                    .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .global) }) { model.cardFrames[card.id] = $0 }
                            }
                        }
                    }
                    .frame(height: 80)
                    // Stage 7: the selected card's one-tap conversions.
                    if let card = model.shelf.first(where: { $0.id == model.selectedCard }) {
                        CardActions(card: card, working: model.working.contains(card.id), act: act)
                    }
                }
            }
        }
    }
}

enum ShelfAction {
    case open(ShelfCard), copy(ShelfCard), reveal(ShelfCard), archive(ShelfCard), sweep, restore(String), dragged(ShelfCard), edit(ShelfCard)
    case select(ShelfCard), transmute(ShelfCard, TransmuteAction)
    /// Stage 8: put a recall card on the shelf.
    case keep(ShelfCard)
}

struct DropZone: View {
    let title: String
    let symbol: String
    let targeted: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: symbol).font(.system(size: 13, weight: .semibold))
            Text(title).font(.system(size: 12, weight: .semibold))
        }
        .foregroundStyle(Color.white.opacity(targeted ? 1 : notchSecondary))
        .frame(maxWidth: .infinity, minHeight: 44)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color.primary.opacity(targeted ? 0.9 : 0.35), style: StrokeStyle(lineWidth: 1.5, dash: [5, 4]))
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.primary.opacity(targeted ? 0.12 : 0.04)))
        )
        .animation(.spring(response: 0.2, dampingFraction: 0.8), value: targeted)
    }
}

struct ShelfCardView: View {
    let card: ShelfCard
    var selected = false
    /// Stage 8: a recall card — a file used before, not on the shelf. Tapping looks at it; right-click keeps it.
    var memory = false
    let act: (ShelfAction) -> Void
    let dragStarted: () -> Void

    private var icon: NSImage? {
        guard card.kind == "file", let path = card.path, !card.missing else { return nil }
        return NSWorkspace.shared.icon(forFile: path)
    }

    private var symbol: String {
        switch card.kind {
        case "url": return "link"
        case "text": return "text.quote"
        default: return card.missing ? "questionmark.folder" : "doc"
        }
    }

    var body: some View {
        let content = VStack(spacing: 4) {
            Group {
                if let icon { Image(nsImage: icon).resizable().interpolation(.high) }
                else { Image(systemName: symbol).font(.system(size: 20)).foregroundStyle(Color.white.opacity(notchSecondary)) }
            }
            .frame(width: 32, height: 32)
            .opacity(card.missing ? 0.4 : 1)
            Text(card.missing ? "missing" : card.title)
                .font(.system(size: 9.5, weight: card.missing ? .semibold : .regular))
                .foregroundStyle(card.missing ? AnyShapeStyle(Tone.failed.color) : AnyShapeStyle(.primary))
                .lineLimit(2).multilineTextAlignment(.center)
                .frame(width: 60)
        }
        .padding(.vertical, 6)
        .frame(width: 68, height: 76)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(card.amber ? Color(red: 1.0, green: 0.62, blue: 0.1).opacity(0.18) : Color.primary.opacity(0.07))
        )
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(selected ? Color.primary.opacity(0.7) : (card.amber ? Color(red: 1.0, green: 0.62, blue: 0.1).opacity(0.5) : .clear), lineWidth: selected ? 1.5 : 1))
        .overlay(alignment: .topTrailing) { CheckBadge(check: card.check).padding(4) }
        .scaleEffect(card.amber ? 0.9 : 1)
        .contentShape(Rectangle())
        // A file card is selected, to show what it can become (stage 7); a link opens and text copies, as before.
        .onTapGesture { act(card.kind == "file" && !card.missing && !memory ? .select(card) : .open(card)) }
        .contextMenu {
            if memory {
                Button("Quick Look") { act(.open(card)) }
                Button("Keep on Shelf") { act(.keep(card)) }
                Button("Edit with Bimax") { act(.edit(card)) }
                Button("Show in Finder") { act(.reveal(card)) }
                Button("Copy") { act(.copy(card)) }
            } else if card.kind == "file", !card.missing {
                Button("Quick Look") { act(.open(card)) }
                Button("Edit with Bimax") { act(.edit(card)) }
                ForEach(card.actions, id: \.self) { action in
                    Button(action.kind == "task" ? "\(action.label) with Bimax" : action.label) { act(.transmute(card, action)) }
                }
                Button("Show in Finder") { act(.reveal(card)) }
            }
            if !memory {
                if !card.missing { Button("Copy") { act(.copy(card)) } }
                Button("Move to Archive") { act(.archive(card)) }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(card.title)\(card.missing ? ", missing" : "")\(card.amber ? ", not used for a day" : "")\(card.task.map { ", from \($0)" } ?? "")\(CheckBadge.words(card.check).map { ", \($0)" } ?? "")")
        .accessibilityAddTraits(.isButton)

        if let provider = card.itemProvider() {
            content.onDrag {
                dragStarted()
                act(.dragged(card))
                return provider
            }
        } else {
            content
        }
    }
}

struct ChipStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 10.5, weight: .medium))
            .foregroundStyle(.primary)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(Capsule().fill(Color.primary.opacity(configuration.isPressed ? 0.22 : 0.1)))
    }
}

/// A task's result on its card (stage 3): a jewel when its check passed, a crack when it failed (00 §glass shades,
/// Prism and Fissure), a caution when it passed only after changing test files, nothing when there was no check.
struct CheckBadge: View {
    let check: String?

    static func words(_ check: String?) -> String? {
        switch check {
        case "passed": return "check passed"
        case "failed": return "check failed"
        case "tests-edited": return "check passed after test files changed"
        case "unchecked": return "not checked"
        default: return nil
        }
    }

    var body: some View {
        switch check {
        case "passed":
            Image(systemName: "checkmark.seal.fill").font(.system(size: 11)).foregroundStyle(Tone.done.color)
        case "failed":
            Image(systemName: "bolt.horizontal.fill").font(.system(size: 10)).foregroundStyle(Tone.failed.color)
        case "tests-edited":
            Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 10)).foregroundStyle(Tone.waiting.color)
        default:
            EmptyView()
        }
    }
}

/// The selected card's conversions (stage 7): Quick Look first, then the actions, most used first. A task action is
/// marked with a spark: it becomes a ⌘2 task with the request written, not an instant change.
struct CardActions: View {
    let card: ShelfCard
    let working: Bool
    let act: (ShelfAction) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                Button("Quick Look") { act(.open(card)) }.buttonStyle(ChipStyle())
                if working {
                    HStack(spacing: 4) {
                        ProgressView().controlSize(.mini)
                        Text("Working…").font(.system(size: 10.5)).foregroundStyle(Color.white.opacity(notchSecondary))
                    }
                    .padding(.horizontal, 6)
                }
                ForEach(card.actions, id: \.self) { action in
                    Button { act(.transmute(card, action)) } label: {
                        HStack(spacing: 3) {
                            if action.kind == "task" { Image(systemName: "sparkle").font(.system(size: 8)) }
                            Text(action.label)
                        }
                    }
                    .buttonStyle(ChipStyle())
                    .disabled(working && action.kind != "task")
                    .accessibilityLabel(action.kind == "task" ? "\(action.label): starts a Bimax task with this file" : action.label)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Actions for \(card.title)")
    }
}
