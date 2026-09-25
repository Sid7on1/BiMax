//
// DynamicNotchPanel.swift
// DynamicNotchKit
//
// Created by <Huy D.> on 2024-11-01.
//

import AppKit

final class DynamicNotchPanel: NSPanel {
    override init(
        contentRect: NSRect,
        styleMask style: NSWindow.StyleMask,
        backing backingStoreType: NSWindow.BackingStoreType,
        defer flag: Bool
    ) {
        super.init(
            contentRect: contentRect,
            styleMask: style,
            backing: backingStoreType,
            defer: flag
        )
        self.hasShadow = false
        self.backgroundColor = .clear
        self.level = .screenSaver
        // Bimax: click-through until the host sees the cursor over drawn content (DynamicNotch.contentFrame).
        self.ignoresMouseEvents = true
        // Bimax: also over full-screen apps, and never in the window cycle — the notch is part of the screen, not a window.
        // `.transient`, not upstream's `.stationary`: a stationary window stays drawn through Mission Control, and the
        // open notch covered its Spaces bar (reported by the owner 2026-09-25, reproduced, fixed). Transient windows are
        // hidden by Mission Control.
        self.collectionBehavior = [.canJoinAllSpaces, .transient, .fullScreenAuxiliary, .ignoresCycle]
    }

    override var canBecomeKey: Bool {
        true
    }
}
