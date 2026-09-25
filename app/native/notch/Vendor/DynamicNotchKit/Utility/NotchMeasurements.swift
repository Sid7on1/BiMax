//
//  NotchMeasurements.swift
//  Added by Bimax (not in upstream DynamicNotchKit).
//

import SwiftUI

/// Measured view sizes, held in an observable object instead of `@State`: in the macOS 27 SDK `@State` is a macro that
/// only Xcode's SwiftUIMacros plugin can expand, and Bimax builds its helpers with the Command Line Tools.
final class NotchMeasurements: ObservableObject {
    @Published var first: CGFloat = 0
    @Published var second: CGFloat = 0
}
