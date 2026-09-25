// God's Land stage 6: secrets (docs/product-reset/gods-land/03_PLAN.md, 00 §"Smoked Obsidian", §"Force-Sensitive Smoke
// Cleave"). The app finds them and keeps their values (app/src/main/secrets.ts); the notch shows them masked and asks
// for one value only when the person presses to reveal it or authenticates to copy it.
//
// - Reveal: press and hold. On a Force Touch trackpad the smoke clears with the pressure and a force click shows it all;
//   on anything else holding for 0.3 s shows it. Letting go masks it again and drops the value.
// - Copy: Touch ID (or the Mac's password) first. The copy is marked Concealed (nspasteboard.org), so clipboard managers
//   leave it alone, and it evaporates after 60 s — only if it is still what is on the clipboard.
// - Locking the screen, sleeping or switching user drops any revealed value.
// - Hiding a window from a screen share is not possible since macOS 15 (research 02 §2): masked is the default instead.
//
// Protocol additions:
//   in   {"t":"secrets","items":[{"id","label","key","masked","where"}]}
//        {"t":"secret","id","purpose":"reveal|copy","value?","missing?"}
//   out  {"t":"secret-value","id","purpose":"reveal|copy"}

import AppKit
import LocalAuthentication
import SwiftUI

struct SecretItem: Identifiable, Equatable {
    let id: String
    let label: String
    let key: String
    let masked: String
    let where_: String

    init?(json row: [String: Any]) {
        guard let id = row["id"] as? String, let masked = row["masked"] as? String else { return nil }
        self.id = id
        self.label = row["label"] as? String ?? "Secret"
        self.key = row["key"] as? String ?? ""
        self.masked = masked
        self.where_ = row["where"] as? String ?? ""
    }

    init(id: String, label: String, key: String, masked: String, where_: String) {
        self.id = id; self.label = label; self.key = key; self.masked = masked; self.where_ = where_
    }
}

/// A revealed value: which secret, the value, and how far the smoke has cleared (0…1).
struct Revealed: Equatable {
    let id: String
    let value: String
    var amount: Double
}

enum SecretCopy {
    static let concealed = NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")
    static let seconds: Double = 60

    /// Puts a secret on `board` marked Concealed, and clears it after `after` seconds if it is still the clipboard's
    /// content. Returns the change count the copy made (for the caller to tell the watcher it was ours).
    @discardableResult
    static func copy(_ value: String, to board: NSPasteboard = .general, after: Double = seconds, cleared: @escaping (Bool) -> Void = { _ in }) -> Int {
        board.clearContents()
        board.declareTypes([.string, concealed], owner: nil)
        board.setString(value, forType: .string)
        board.setData(Data(), forType: concealed)
        let count = board.changeCount
        DispatchQueue.main.asyncAfter(deadline: .now() + after) {
            // Only our copy evaporates: something copied since is the person's, and stays.
            let ours = board.changeCount == count
            if ours { board.clearContents() }
            cleared(ours)
        }
        return count
    }
}

enum SecretAuth {
    /// Touch ID, or the Mac's password where there is no Touch ID. Calls back on the main thread.
    static func confirm(_ reason: String, done: @escaping (Bool) -> Void) {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else { done(false); return }
        NSApp.activate(ignoringOtherApps: true)
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, _ in
            DispatchQueue.main.async { done(ok) }
        }
    }
}

/// Mouse down, mouse up and Force Touch pressure, which SwiftUI does not expose.
struct PressSurface: NSViewRepresentable {
    let pressed: (Bool) -> Void
    let pressure: (Double) -> Void

    final class Surface: NSView {
        var pressed: (Bool) -> Void = { _ in }
        var pressure: (Double) -> Void = { _ in }
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
        override func mouseDown(with event: NSEvent) { pressed(true) }
        override func mouseUp(with event: NSEvent) { pressed(false) }
        override func pressureChange(with event: NSEvent) {
            // Stage 1 is a click: the smoke thins with pressure; stage 2 is a force click: fully clear (owner's 30 % / 80 %).
            pressure(event.stage >= 2 ? 1 : min(0.8, 0.2 + Double(event.pressure) * 0.6))
        }
    }

    func makeNSView(context: Context) -> Surface {
        let view = Surface()
        view.pressed = pressed
        view.pressure = pressure
        return view
    }

    func updateNSView(_ view: Surface, context: Context) {
        view.pressed = pressed
        view.pressure = pressure
    }
}

enum SecretCommand {
    case press(String, Bool), pressure(String, Double), copy(SecretItem)
}

struct SecretsSection: View {
    @ObservedObject var model: NotchModel
    let run: (SecretCommand) -> Void

    var body: some View {
        if model.secrets.isEmpty && !model.clips.contains(where: { $0.kind == "secret" }) {
            Text("No secrets found. Bimax looks only in .env files of folders you opened in it, and keeps secrets you copy sealed.")
                .font(.system(size: 11)).foregroundStyle(Color.white.opacity(notchSecondary)).fixedSize(horizontal: false, vertical: true)
        } else {
            VStack(spacing: 3) {
                ForEach(model.secrets.prefix(6)) { item in SecretRow(item: item, revealed: model.revealed, run: run) }
                ForEach(model.clips.filter { $0.kind == "secret" }.prefix(3)) { clip in
                    SecretRow(item: SecretItem(id: clip.id, label: clip.detail ?? "Secret", key: "Copied", masked: clip.preview, where_: "clipboard history"),
                              revealed: model.revealed, run: run)
                }
            }
            Text("Press and hold to reveal · Copy asks for Touch ID and clears in 60 s")
                .font(.system(size: 9.5)).foregroundStyle(Color.white.opacity(notchSecondary))
        }
    }
}

struct SecretRow: View {
    let item: SecretItem
    let revealed: Revealed?
    let run: (SecretCommand) -> Void

    private var shown: Revealed? { revealed?.id == item.id ? revealed : nil }

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "key.fill").font(.system(size: 10)).foregroundStyle(Color.white.opacity(notchSecondary)).frame(width: 16)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(item.key).font(.system(size: 11, weight: .semibold)).foregroundStyle(.primary).lineLimit(1)
                    Text(item.where_).font(.system(size: 9.5)).foregroundStyle(Color.white.opacity(notchSecondary)).lineLimit(1)
                }
                ZStack(alignment: .leading) {
                    // Smoked obsidian: the masked form until pressed; the value comes through as the smoke clears.
                    Text(shown?.value ?? item.masked)
                        .font(.system(size: 11, design: .monospaced)).foregroundStyle(.primary).lineLimit(1)
                        .blur(radius: shown.map { (1 - $0.amount) * 5 } ?? 0)
                    if let shown {
                        Rectangle().fill(Color.black.opacity((1 - shown.amount) * 0.8)).allowsHitTesting(false)
                    }
                }
                .overlay(PressSurface(pressed: { run(.press(item.id, $0)) }, pressure: { run(.pressure(item.id, $0)) }))
                .animation(.easeOut(duration: 0.12), value: shown)
                .accessibilityLabel("\(item.label) \(item.key), hidden")
                .accessibilityHint("Press and hold to reveal")
            }
            Spacer(minLength: 0)
            Button("Copy") { run(.copy(item)) }.buttonStyle(ChipStyle())
                .accessibilityLabel("Copy \(item.key). Asks for Touch ID; clears from the clipboard after 60 seconds.")
        }
        .padding(.vertical, 3)
    }
}

/// Screen locked, Mac asleep, user switched: whatever was revealed goes.
final class SecretGuard {
    private var tokens: [NSObjectProtocol] = []

    func start(_ drop: @escaping () -> Void) {
        let workspace = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.screensDidSleepNotification, NSWorkspace.willSleepNotification, NSWorkspace.sessionDidResignActiveNotification] {
            tokens.append(workspace.addObserver(forName: name, object: nil, queue: .main) { _ in drop() })
        }
        tokens.append(DistributedNotificationCenter.default().addObserver(forName: NSNotification.Name("com.apple.screenIsLocked"), object: nil, queue: .main) { _ in drop() })
    }
}

/// Apps where secrets are what the person is most likely reaching for (00 §2B): terminals and API clients.
let secretFriendlyApps: Set<String> = [
    "com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.Warp-Stable", "com.mitchellh.ghostty", "net.kovidgoyal.kitty",
    "io.alacritty", "co.zeit.hyper", "com.github.wez.wezterm", "com.postmanlabs.mac", "com.insomnia.app", "com.usebruno.app", "com.luckymarmot.Paw",
]
