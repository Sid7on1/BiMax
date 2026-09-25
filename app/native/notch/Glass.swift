// God's Land stage 4: the glass (docs/product-reset/gods-land/00 §"The Palette of Glass States", 01 §1). The app decides
// the state (app/src/main/glass.ts); this draws it — a material inside the notch while it is open, and a still symbol
// beside it at rest. Every state has a symbol and words, never colour alone (01 §1 rule).
//
// Cost: the materials animate only while the notch is open (the person is looking); at rest the symbol is still, so
// an idle Mac pays nothing. Reduce Motion stops the animation; Reduce Transparency or Increase Contrast replace the
// material with one solid line in the state's colour.

import AppKit
import SwiftUI

enum GlassState: String, CaseIterable {
    case water, molten, frost, ink, prism, fissure, bubbles, night

    /// The state's colour for its symbol and line. Each is at least 3:1 against the notch's black (checked in --selftest).
    var color: Color {
        let (r, g, b) = rgb
        return Color(red: r, green: g, blue: b)
    }

    var rgb: (Double, Double, Double) {
        switch self {
        case .water: return (0.62, 0.66, 0.72)
        case .molten: return (1.0, 0.62, 0.10)
        case .frost: return (0.74, 0.90, 1.0)
        case .ink: return (0.52, 0.56, 1.0)
        case .prism: return (0.92, 0.94, 1.0)
        case .fissure: return (1.0, 0.33, 0.29)
        case .bubbles: return (0.35, 0.78, 0.98)
        case .night: return (0.64, 0.58, 1.0)
        }
    }

    var symbol: String {
        switch self {
        case .water: return "drop"
        case .molten: return "flame.fill"
        case .frost: return "snowflake"
        case .ink: return "hand.raised.fill"
        case .prism: return "sparkles"
        case .fissure: return "bolt.horizontal.fill"
        case .bubbles: return "circle.grid.2x1.fill"
        case .night: return "moon.stars.fill"
        }
    }

    /// The strongest the material gets behind the words (see contrast in --selftest).
    static let materialPeak = 0.34
}

struct Glass: Equatable {
    var state: GlassState = .water
    var label: String = "All quiet"
}

/// The still symbol beside the notch at rest.
struct GlassGlyph: View {
    let glass: Glass

    var body: some View {
        Image(systemName: glass.state.symbol)
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(glass.state.color)
            .accessibilityLabel(glass.label)
    }
}

/// The material inside the open notch, behind its words. Fades toward the bottom so the words stay on near-black.
struct GlassMaterial: View {
    let state: GlassState

    private var plain: Bool {
        NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency || NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast
    }

    var body: some View {
        if state == .water {
            EmptyView()
        } else if plain {
            VStack(spacing: 0) {
                Rectangle().fill(state.color).frame(height: 2)
                Spacer(minLength: 0)
            }
        } else {
            TimelineView(.animation(minimumInterval: 1.0 / 30, paused: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion)) { timeline in
                let t = timeline.date.timeIntervalSinceReferenceDate
                material(at: t)
                    .mask(LinearGradient(colors: [.white, .white.opacity(0.35), .clear], startPoint: .top, endPoint: .bottom))
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }

    @ViewBuilder
    private func material(at t: Double) -> some View {
        let peak = GlassState.materialPeak
        let tint = state.color
        switch state {
        case .molten:
            // Heat: amber warmth with a shimmer that drifts like air over a hot surface.
            let x = 0.5 + 0.35 * sin(t * 1.3)
            LinearGradient(colors: [tint.opacity(0), tint.opacity(peak), Color(red: 1, green: 0.4, blue: 0.05).opacity(peak * 0.6), tint.opacity(0)],
                           startPoint: UnitPoint(x: x - 0.6, y: 0), endPoint: UnitPoint(x: x + 0.6, y: 0.4))
        case .frost:
            // Ice creeping in from the edges, with a few crystal lines at the corners.
            ZStack {
                RadialGradient(colors: [Color.white.opacity(peak * 0.8), .clear], center: .topLeading, startRadius: 0, endRadius: 110)
                RadialGradient(colors: [Color.white.opacity(peak * 0.8), .clear], center: .topTrailing, startRadius: 0, endRadius: 110)
                Canvas { context, size in
                    var path = Path()
                    for (corner, dir) in [(CGPoint(x: 0, y: 0), 1.0), (CGPoint(x: size.width, y: 0), -1.0)] {
                        for i in 0..<5 {
                            let angle = Double(i) * 0.3 + 0.15
                            let length = 26.0 + Double(i % 3) * 12
                            path.move(to: corner)
                            path.addLine(to: CGPoint(x: corner.x + dir * cos(angle) * length, y: corner.y + sin(angle) * length))
                        }
                    }
                    context.stroke(path, with: .color(.white.opacity(0.28)), lineWidth: 0.7)
                }
            }
        case .ink:
            // Ink turning slowly in water: waiting, never urgent.
            AngularGradient(colors: [tint.opacity(peak), Color(red: 0.5, green: 0.3, blue: 0.9).opacity(peak * 0.4), .clear, tint.opacity(peak * 0.7), tint.opacity(peak)],
                            center: .top, angle: .degrees(t * 24))
        case .prism:
            // Cut glass: a faint spectrum turning, and a glint along the top.
            ZStack(alignment: .top) {
                AngularGradient(colors: ([.red, .orange, .yellow, .green, .blue, .purple, .red] as [Color]).map { $0.opacity(peak * 0.45) }, center: .top, angle: .degrees(t * 12))
                Rectangle().fill(LinearGradient(colors: [.clear, .white.opacity(0.7), .clear], startPoint: .leading, endPoint: .trailing)).frame(height: 1)
            }
        case .fissure:
            // Tempered glass with a hairline crack.
            ZStack {
                RadialGradient(colors: [tint.opacity(peak * 0.8), .clear], center: .top, startRadius: 0, endRadius: 160)
                Canvas { context, size in
                    var crack = Path()
                    let start = CGPoint(x: size.width * 0.72, y: 0)
                    crack.move(to: start)
                    for (i, point) in [(10.0, 9.0), (-6, 18), (8, 27), (-3, 37), (6, 46)].enumerated() {
                        crack.addLine(to: CGPoint(x: start.x + point.0, y: point.1))
                        if i == 2 { crack.move(to: CGPoint(x: start.x + point.0, y: point.1)); crack.addLine(to: CGPoint(x: start.x + 22, y: 34)); crack.move(to: CGPoint(x: start.x + point.0, y: point.1)) }
                    }
                    context.stroke(crack, with: .color(tint.opacity(0.75)), lineWidth: 0.9)
                }
            }
        case .bubbles:
            // Queued work: small bubbles rising.
            Canvas { context, size in
                for i in 0..<7 {
                    let seed = Double(i) * 0.137
                    let x = size.width * (0.1 + (seed * 7).truncatingRemainder(dividingBy: 0.8))
                    let y = size.height - (t * (14 + Double(i) * 3) + seed * 400).truncatingRemainder(dividingBy: size.height + 10)
                    let r = 2.0 + Double(i % 3)
                    context.stroke(Path(ellipseIn: CGRect(x: x, y: y, width: r * 2, height: r * 2)), with: .color(tint.opacity(0.4)), lineWidth: 0.8)
                }
            }
        case .night:
            // Night Shift: deep indigo and one star that twinkles.
            ZStack(alignment: .topTrailing) {
                LinearGradient(colors: [tint.opacity(peak), .clear], startPoint: .top, endPoint: .bottom)
                Image(systemName: "sparkle").font(.system(size: 8)).foregroundStyle(.white.opacity(0.35 + 0.35 * (0.5 + 0.5 * sin(t * 2.2))))
                    .padding(.top, 8).padding(.trailing, 26)
            }
        case .water:
            EmptyView()
        }
    }
}

/// WCAG contrast of two sRGB colours (for --selftest).
func contrastRatio(_ a: (Double, Double, Double), _ b: (Double, Double, Double)) -> Double {
    func channel(_ c: Double) -> Double { c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
    func luminance(_ c: (Double, Double, Double)) -> Double { 0.2126 * channel(c.0) + 0.7152 * channel(c.1) + 0.0722 * channel(c.2) }
    let (la, lb) = (luminance(a), luminance(b))
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
}
