// God's Land stage 4, redrawn in stage 9: the glass (docs/product-reset/gods-land/00 §"The Palette of Glass States",
// 01 §1). The app decides the state (app/src/main/glass.ts); this says what it looks like — the tint and clarity of the
// open notch's Liquid Glass (DynamicNotchKit's `expandedGlass`, BIMAX_CHANGES 8), and a still symbol beside the notch
// at rest. Every state has a symbol and words, never colour alone (01 §1 rule).
//
// Nothing animates: the glass is the system's, so Reduce Transparency and Increase Contrast are the system's forms of
// it, and an idle Mac pays nothing.

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

    /// Stage 9: the state infused in the notch's glass (the owner's review: "it must look like real life infused in
    /// glass"). The glass is the system's Liquid Glass; a state is the colour laid in it and its clarity — Prism (a check
    /// passed) is the clear, crystal variant, which shows what is behind it sharply; every other state is regular glass.
    var style: NotchGlassStyle {
        let (r, g, b) = smoke
        return NotchGlassStyle(tint: Color(red: r, green: g, blue: b).opacity(self == .prism ? 0.7 : 0.62), clear: self == .prism)
    }

    /// The colour each state's glass is smoked with: its own hue, dark enough that light words stay ≥ 4.5:1 over a white
    /// window as well as a dark one (measured on captures over black, white and a photo: 5.8:1 at worst). Even the calm
    /// states carry a hue — steel blue for Water, teal for Prism.
    var smoke: (Double, Double, Double) {
        switch self {
        case .water: return (0.16, 0.24, 0.36)
        case .molten: return (0.45, 0.20, 0.02)
        case .frost: return (0.24, 0.29, 0.34)
        case .ink: return (0.12, 0.22, 0.55)
        case .prism: return (0.06, 0.20, 0.22)
        case .fissure: return (0.50, 0.10, 0.10)
        case .bubbles: return (0.05, 0.30, 0.45)
        case .night: return (0.20, 0.13, 0.50)
        }
    }
}

/// Secondary words in the open notch: white at this strength measured ≥ 5.8:1 on every state's glass over black, white
/// and a photo (stage 9). The notch is always dark glass, so its words are always light.
let notchSecondary = 0.78

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

/// WCAG contrast of two sRGB colours (for --selftest).
func contrastRatio(_ a: (Double, Double, Double), _ b: (Double, Double, Double)) -> Double {
    func channel(_ c: Double) -> Double { c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
    func luminance(_ c: (Double, Double, Double)) -> Double { 0.2126 * channel(c.0) + 0.7152 * channel(c.1) + 0.0722 * channel(c.2) }
    let (la, lb) = (luminance(a), luminance(b))
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
}
