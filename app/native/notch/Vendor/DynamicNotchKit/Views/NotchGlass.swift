//
//  NotchGlass.swift
//  Bimax addition to DynamicNotchKit (BIMAX_CHANGES 8).
//

import AppKit
import SwiftUI

/// The open notch's glass: a tint the state is infused with, and whether the glass is clear (crystal) or regular.
public struct NotchGlassStyle: Equatable {
    public var tint: Color?
    public var clear: Bool

    public init(tint: Color? = nil, clear: Bool = false) {
        self.tint = tint
        self.clear = clear
    }
}

/// The system's Liquid Glass in `shape`, with the state's colour laid inside it.
///
/// The colour is a translucent layer in the glass's own outline, over the glass and under the words — not the glass's
/// `tint` parameter. Measured on this Mac (macOS 27, 2026-09-26): with `Glass.tint(_:)` (and with AppKit's
/// `NSGlassEffectView.tintColor`) the same state came out tinted on some opens and plain grey on others — the calm state
/// was grey in every capture, and any state opened straight from hidden was grey 10 times in 10. The layer is drawn every
/// time. The glass still blurs and bends what is behind it; the colour sits in it.
///
/// Below macOS 26 there is no Liquid Glass: the declared fallback is the system's behind-window blur with the same
/// colour — still the system's material, never a painted slab.
struct NotchGlassFill<S: Shape>: View {
    let style: NotchGlassStyle
    let shape: S

    var body: some View {
        ZStack {
            if #available(macOS 26.0, *) {
                Color.clear.glassEffect(style.clear ? SwiftUI.Glass.clear : SwiftUI.Glass.regular, in: shape)
            } else {
                VisualEffectView(material: .hudWindow, blendingMode: .behindWindow).clipShape(shape)
            }
            if let tint = style.tint { shape.fill(tint).allowsHitTesting(false) }
        }
    }
}
