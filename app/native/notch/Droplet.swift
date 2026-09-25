// God's Land stage 3: the Droplet (docs/product-reset/gods-land/00_OWNER_BRAINSTORM.md, "The Liquid Glass Drop
// Transition"). When a file is handed to "Edit with Bimax", the notch retracts, a drop forms at its lip, stretches on a
// liquid neck, snaps and falls to where the ⌘2 bar is about to open, and splats into it.
//
// The liquid is the gooey technique from the research (02 §2): shapes drawn on one layer, blurred together, then an
// alpha threshold snaps the blur back into one crisp edge — so the drop and the notch share a neck while they are
// close and part by themselves as the drop falls. It is black, the notch's own material, so it reads as a piece of
// the notch leaving it.
//
// Timeline, after the owner's spec (00 §"Millisecond Choreography"): retract 0–120 ms, meniscus 120–260 ms, snap and
// fall 260–400 ms, bloom 400–520 ms. The app is told "landed" when the bloom starts, so the ⌘2 bar opens under the
// splat. Reduce Motion skips it: "landed" at once, nothing drawn.

import AppKit
import SwiftUI

enum DropletTiming {
    static let meniscus = 0.12
    static let snap = 0.26
    static let land = 0.40
    static let end = 0.52
}

/// Where everything is at time `t` (seconds since the start), in the panel's SwiftUI space (top-left origin).
struct DropletFrame {
    var blobs: [CGRect] = []
    var drop: CGRect = .zero
    var opacity: Double = 1
    var iconOpacity: Double = 0

    static func ease(_ x: Double) -> Double { let c = min(max(x, 0), 1); return c * c * (3 - 2 * c) }

    init(t: Double, lip: CGPoint, notchWidth: CGFloat, target: CGRect) {
        let lipBlob = { (radius: CGFloat) in CGRect(x: lip.x - radius * 1.6, y: lip.y - radius, width: radius * 3.2, height: radius * 2) }
        if t < DropletTiming.meniscus {
            // The shelf is retracting; the lip starts to swell.
            let p = Self.ease(t / DropletTiming.meniscus)
            blobs = [lipBlob(4 + 8 * p)]
            return
        }
        if t < DropletTiming.snap {
            // Meniscus: the drop grows under the lip and stretches down on a thinning neck.
            let p = Self.ease((t - DropletTiming.meniscus) / (DropletTiming.snap - DropletTiming.meniscus))
            let r = 5 + 11 * p
            let center = CGPoint(x: lip.x, y: lip.y + 6 + 22 * p)
            drop = CGRect(x: center.x - r, y: center.y - r * (1 + 0.25 * p), width: r * 2, height: r * 2 * (1 + 0.25 * p))
            blobs = [lipBlob(12), drop]
            iconOpacity = p
            return
        }
        let start = CGPoint(x: lip.x, y: lip.y + 28)
        let landing = CGPoint(x: target.midX, y: target.midY)
        if t < DropletTiming.land {
            // The neck snaps (the lip shrinks back) and the drop falls, accelerating like a real one.
            let q = (t - DropletTiming.snap) / (DropletTiming.land - DropletTiming.snap)
            let y = start.y + (landing.y - start.y) * q * q
            let x = start.x + (landing.x - start.x) * Self.ease(q)
            let stretch = 1.3 - 0.2 * q
            drop = CGRect(x: x - 16, y: y - 16 * stretch, width: 32, height: 32 * stretch)
            blobs = [lipBlob(12 * max(0, 1 - q * 2.5)), drop]
            iconOpacity = 1
            return
        }
        // Bloom: surface tension lets go and the drop spreads into the bar's shape, fading as the bar takes its place.
        let e = Self.ease((t - DropletTiming.land) / (DropletTiming.end - DropletTiming.land))
        let width = 32 + (target.width * 0.7 - 32) * e
        let height = 36 + (target.height * 0.9 - 36) * e
        drop = CGRect(x: landing.x - width / 2, y: landing.y - height / 2, width: width, height: height)
        blobs = [drop]
        opacity = 1 - e
        iconOpacity = max(0, 1 - e * 2)
    }
}

struct DropletView: View {
    let start: Date
    let lip: CGPoint
    let notchWidth: CGFloat
    let target: CGRect
    let icon: NSImage?

    var body: some View {
        TimelineView(.animation) { timeline in
            let frame = DropletFrame(t: timeline.date.timeIntervalSince(start), lip: lip, notchWidth: notchWidth, target: target)
            ZStack {
                // The glass edge: the same liquid a little larger, in light, behind the black — without it a black drop
                // vanishes on a dark screen (recorded 2026-09-25: the bloom was invisible on a dark window).
                liquid(frame.blobs.map { $0.insetBy(dx: -1.6, dy: -1.6) }, color: Color.white.opacity(0.32))
                    .opacity(frame.opacity)
                liquid(frame.blobs, color: .black)
                    .opacity(frame.opacity)
                if frame.drop.width > 0 {
                    // The camera's light on the drop's top edge.
                    Capsule().fill(Color.white.opacity(0.5 * frame.opacity))
                        .frame(width: frame.drop.width * 0.34, height: 2)
                        .position(x: frame.drop.midX, y: frame.drop.minY + frame.drop.height * 0.2)
                    if let icon {
                        Image(nsImage: icon).resizable().interpolation(.high)
                            .frame(width: 18, height: 18)
                            .position(x: frame.drop.midX, y: frame.drop.midY)
                            .opacity(frame.iconOpacity)
                    }
                }
            }
        }
        .allowsHitTesting(false)
    }

    /// Shapes blurred together and snapped back to one crisp edge by an alpha threshold: the liquid neck.
    private func liquid(_ blobs: [CGRect], color: Color) -> some View {
        Canvas { context, _ in
            context.addFilter(.alphaThreshold(min: 0.5, color: color))
            context.addFilter(.blur(radius: 7))
            context.drawLayer { layer in
                for blob in blobs where blob.width > 0.5 { layer.fill(Path(ellipseIn: blob), with: .color(.black)) }
            }
        }
    }
}

@MainActor
enum Droplet {
    private static var panel: NSPanel?

    /// Plays the Droplet from the notch to `target` (screen coordinates, Cocoa). `landed` is called when the bloom
    /// starts (or at once under Reduce Motion); the panel removes itself when it is over.
    static func play(on screen: NSScreen, notch: NSRect, to target: NSRect, icon: NSImage?, landed: @escaping () -> Void) {
        panel?.close()
        panel = nil
        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            landed()
            return
        }
        let area = notch.union(target).insetBy(dx: -90, dy: -90).intersection(screen.frame)
        let window = NSPanel(contentRect: area, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.ignoresMouseEvents = true
        window.level = .screenSaver
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        let local = { (point: CGPoint) in CGPoint(x: point.x - area.minX, y: area.maxY - point.y) }
        let lip = local(CGPoint(x: notch.midX, y: notch.minY))
        let targetLocal = CGRect(origin: local(CGPoint(x: target.minX, y: target.maxY)), size: target.size)
        window.contentView = NSHostingView(rootView: DropletView(start: Date(), lip: lip, notchWidth: notch.width, target: targetLocal, icon: icon))
        window.orderFrontRegardless()
        panel = window
        DispatchQueue.main.asyncAfter(deadline: .now() + DropletTiming.land) { landed() }
        DispatchQueue.main.asyncAfter(deadline: .now() + DropletTiming.end + 0.05) {
            MainActor.assumeIsolated {
                if panel === window { panel = nil }
                window.close()
            }
        }
    }
}
