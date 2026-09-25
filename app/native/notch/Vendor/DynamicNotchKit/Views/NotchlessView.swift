//
//  NotchlessView.swift
//  DynamicNotchKit
//
//  Created by Kai Azim on 2024-04-06.
//

import SwiftUI

struct NotchlessView<Expanded, CompactLeading, CompactTrailing>: View where Expanded: View, CompactLeading: View, CompactTrailing: View {
    @ObservedObject private var dynamicNotch: DynamicNotch<Expanded, CompactLeading, CompactTrailing>
    // Bimax: see NotchView — no `@State` macro under the Command Line Tools.
    @StateObject private var measured = NotchMeasurements()
    private var windowHeight: CGFloat {
        get { measured.first }
        nonmutating set { measured.first = newValue }
    }
    private let safeAreaInset: CGFloat = 15

    init(dynamicNotch: DynamicNotch<Expanded, CompactLeading, CompactTrailing>) {
        self.dynamicNotch = dynamicNotch
    }

    private var cornerRadius: CGFloat {
        if case let .floating(cornerRadius) = dynamicNotch.style {
            cornerRadius
        } else {
            20
        }
    }

    var body: some View {
        notchContent()
            // Bimax: the same glass as the notch, and no hairline border (BIMAX_CHANGES 8).
            .clipShape(.rect(cornerRadius: cornerRadius))
            .background {
                NotchGlassFill(style: dynamicNotch.expandedGlass ?? NotchGlassStyle(), shape: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            }
            .padding(20)
            .environment(\.colorScheme, .dark) // Bimax: one glass, the notch's (BIMAX_CHANGES 8)
            .onGeometryChange(for: CGFloat.self, of: \.size.height) { newHeight in
                // This makes sure that the floating window FULLY slides off before disappearing
                windowHeight = newHeight
            }
            .offset(y: dynamicNotch.state == .expanded ? dynamicNotch.notchSize.height : -windowHeight)
            // Bimax: no .onHover — the host tracks the cursor itself (BIMAX_CHANGES 7).
            .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .global) }) { dynamicNotch.contentFrame = $0 }
    }

    private func notchContent() -> some View {
        VStack(spacing: 0) {
            dynamicNotch.expandedContent
                .transition(.blur(intensity: 10).combined(with: .opacity))
                .safeAreaInset(edge: .top, spacing: 0) { Color.clear.frame(height: safeAreaInset) }
                .safeAreaInset(edge: .bottom, spacing: 0) { Color.clear.frame(height: safeAreaInset) }
                .safeAreaInset(edge: .leading, spacing: 0) { Color.clear.frame(width: safeAreaInset) }
                .safeAreaInset(edge: .trailing, spacing: 0) { Color.clear.frame(width: safeAreaInset) }
        }
        .fixedSize()
    }
}
