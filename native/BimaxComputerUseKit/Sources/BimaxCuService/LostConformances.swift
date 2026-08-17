import Foundation

// RECONSTRUCTED 2026-08-17 — DECLARATIONS ONLY, DELIBERATELY.
//
// These four harnesses were lost with the rest of the evicted native tree. Unlike the service code
// they sit beside, their VALUE IS THEIR BEHAVIOUR: each one drives real applications and reports
// which advertised capabilities this machine could actually reproduce (`overclaimed` is the list of
// things the build claims and the run could not show). Reimplementing that from the call sites
// alone would produce a harness that runs, prints a report, and verifies nothing — the exact
// "advertised vs verified" failure these harnesses exist to catch, wearing their name.
//
// So they are restored as honest non-runs. Every one reports `status: "skipped"` with a reason, and
// `main.swift`'s existing exit logic — "a skipped run is not a pass" — turns that into EXIT_FAILURE.
// A gate that invokes them therefore FAILS and says why, which is the only safe state for a
// verification tool whose implementation is missing. Restoring real behaviour means writing these
// against live applications again; until then nothing may cite them as evidence.

/// The subset of `AppWorkspaceConformance` checks that are invariants rather than capabilities: a
/// capability the platform refuses is reported unverified, but one of these failing is a defect.
/// Empty because the real list is unknown — and an empty list must not be read as "all invariants
/// held", which is why the harness never reports `ran`.
enum AppWorkspaceConformanceInvariants {
    static let names: Set<String> = []
}

struct ConformanceCheck: Codable, Sendable {
    var name: String
    var passed: Bool
    var detail: String?
}

/// Shared shape for the lost harnesses, matching the surviving ones (`status` + `reason`, with the
/// fields each call site reads).
struct LostConformanceReport: Codable, Sendable {
    var status: String
    var reason: String
    var harness: String
    var bundleId: String?
    var checks: [ConformanceCheck]
    var overclaimed: [String]
    var foregroundPreserved: Bool

    init(harness: String, bundleId: String? = nil) {
        self.status = "skipped"
        self.reason = "harness_source_lost"
        self.harness = harness
        self.bundleId = bundleId
        self.checks = []
        // Empty because nothing was checked. It is NOT the claim that nothing is overclaimed —
        // the exit logic never treats a skipped run as a pass, so this cannot be read as one.
        self.overclaimed = []
        // False, not true: this run preserved nothing because it did nothing.
        self.foregroundPreserved = false
    }
}

enum AppWorkspaceConformance {
    static func run(bundleId: String) -> LostConformanceReport {
        LostConformanceReport(harness: "app_workspace", bundleId: bundleId)
    }
}

enum LiveTextScrollSmoke {
    static func run(bundleId: String) -> LostConformanceReport {
        LostConformanceReport(harness: "live_text_scroll", bundleId: bundleId)
    }
}

enum FocusLeaseConformance {
    static func run(bundleId: String) -> LostConformanceReport {
        LostConformanceReport(harness: "focus_lease", bundleId: bundleId)
    }
}

enum RealAppMatrixConformance {
    static func run(
        limit: Int,
        minimumPassing: Int,
        launchStandardApps: Bool
    ) -> LostConformanceReport {
        LostConformanceReport(harness: "real_app_matrix")
    }
}
