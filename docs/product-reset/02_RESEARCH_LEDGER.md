# Research ledger

Research date: 2026-08-08. Technical conclusions use primary documentation where available. A claim
is accepted only when it is supported by a platform source and consistent with the local code or a
second independent source.

## Verified conclusions

### 1. The Mac app is the correct XPC host

- Apple places macOS XPC services at `Contents/XPCServices/` and describes an XPC service as bundled
  inside an app or framework.
- Apple's XPC overview says launchd manages service launch, idle shutdown, and crash restart.
- Local `app/electron-builder.yml` already packages that exact layout, while the TUI embeds a bare
  executable.

Decision: Desktop owns the service bundle and bridge. Terminal must not ship a standalone service.

Sources:

- [Apple: Placing content in a bundle](https://developer.apple.com/documentation/bundleresources/placing-content-in-a-bundle)
- [Apple: XPC overview](https://developer.apple.com/documentation/xpc)
- [Apple: Creating XPC Services](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingXPCServices.html)

### 2. No Developer ID is workable for alpha, not for a frictionless product

- Xcode documents a macOS “Copy App” distribution that can be unsigned.
- Apple Support documents the user's explicit Privacy & Security → Open Anyway override.
- Electron says unsigned distribution is possible but requires advanced manual steps; its normal
  release guidance is sign, then notarize.
- Apple states notarization requires Developer ID signing and hardened runtime.

Decision: preserve a clearly labeled manual-install alpha with published SHA-256 and an exact binary
hash confirmation inside Bimax. Do not call it a normal consumer install. Public stable release has
a Developer ID/notarization gate even if the owner postpones that gate.

Sources:

- [Apple: Distributing for beta testing and releases](https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases/)
- [Apple Support: Open an app from an unknown developer](https://support.apple.com/en-ie/guide/mac-help/mh40616/mac)
- [Electron: Code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)
- [Apple: Notarizing macOS software](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)

### 3. Ad-hoc builds can repeatedly lose Screen Recording trust

- Apple's ScreenCaptureKit sample confirms the first run prompts for Screen Recording and the app
  must restart after permission is granted.
- In an Apple Developer Forums case, an Apple DTS engineer explicitly confirms that changing ad-hoc
  identity makes the system treat each build as a new app.
- This matches the architecture: computer use needs a stable, visible responsible application, not
  a changing terminal-extracted helper.

Decision: fresh-install and upgrade permission persistence are mandatory tests. The alpha may ask
for permission again after updates; the UI must say so honestly. Stable signing is the eventual fix,
not a custom permission database or hidden workaround.

2026-08-23 local-development revalidation: Apple documents that the designated requirement is how
macOS decides whether changed code is the same code previously granted a privacy permission. A
live two-binary probe with the existing `Bimax Local Code Signing` identity produced the same
certificate-root-and-identifier requirement for different binaries, while the installed ad-hoc
Bimax requirement was CDHash-only. The local build may therefore use that certificate to preserve
the host identity, without representing it as Developer ID, notarized, Gatekeeper-accepted, or a
public release. The separately approved native CU service remains ad-hoc and exact-hash gated.

Sources:

- [Apple: Capturing screen content in macOS](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos)
- [Apple Developer Forums: ad-hoc identity reset confirmed by DTS](https://developer.apple.com/forums/thread/819406)
- [Apple: Applying Code Requirements](https://developer.apple.com/documentation/security/applying-code-requirements)
- [Apple TN3127: Inside Code Signing Requirements](https://developer.apple.com/documentation/Technotes/tn3127-inside-code-signing-requirements)

#### Local SDK revalidation — 2026-08-09

The installed first-party Xcode 26.5 SDK header
`ScreenCaptureKit.framework/Headers/SCScreenshotManager.h` declares
`captureImage(contentFilter:configuration:completionHandler:)` from macOS 14. The Phase 2 capture
fallback uses that exact API behind an availability check while retaining `SCStream` on the macOS
13 floor. This source check supports the API contract only; the preserved live fixture run is the
evidence that the product path produced a real image.

- [Apple: SCScreenshotManager](https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager)

### 4. Electron remains a valid frontend; native privileges stay outside the renderer

- Electron's process model separates main and renderer processes and recommends a utility process
  for crash-prone/CPU-heavy work.
- Context isolation and sandboxing are defaults and recommendations; privileged APIs should be
  narrow methods on the context bridge.
- Electron's security checklist requires sender validation, restrictive navigation/window rules,
  local/secure content, current Electron, and no broad renderer API exposure.
- The local app already follows much of this and uses local packaged UI, a preload, a supervised
  engine child, and a separate native XPC service.

Decision: do not rewrite the app in SwiftUI during the product split. Keep React/Electron for the
complex agent, diff, terminal, and evidence UI. Keep Swift/AppKit/XPC for capture and control.

Sources:

- [Electron: Process model](https://www.electronjs.org/docs/latest/tutorial/process-model)
- [Electron: Context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)
- [Electron: Process sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox)
- [Electron: Security checklist](https://www.electronjs.org/docs/latest/tutorial/security)

### 5. Permission UX must be contextual and specific

- Apple recommends fast, optional onboarding and requesting a private resource either in a useful
  onboarding context or when the user first invokes the dependent feature.
- Apple says permission copy should state exactly how and why the resource is used.
- Apple advises one “Continue” style button on a custom pre-alert; it should not imitate or pressure
  the system Allow button.
- Raycast's documented behavior reinforces the responsible-process rule: permissions are granted to
  the app running the action, not Terminal.

Decision: Code mode works without CU permissions. “Control my Mac” starts a short Trust Center flow
that explains Screen Recording and Accessibility separately, opens the real system prompts, tests
the grant, and returns to the requested task.

Sources:

- [Apple HIG: Onboarding](https://developer.apple.com/design/human-interface-guidelines/onboarding)
- [Apple HIG: Privacy](https://developer.apple.com/design/human-interface-guidelines/privacy/)
- [Raycast: Script command permissions](https://manual.raycast.com/script-commands)

### 6. Separate repos can keep history and exchange verified artifacts

- GitHub's documented split process uses a fresh clone plus `git filter-repo`; this avoids damaging
  the source repository and preserves relevant history.
- GitHub release assets include a SHA-256 digest, and artifact attestations bind a build to its
  repository, commit, workflow, and triggering event.
- Reusable workflows can be called across repositories; pinning by commit SHA is GitHub's safest
  stability/security option.

Decision: create both products from fresh clones, never by deleting half of the current working
tree. Terminal releases macOS engine binaries, a manifest, and protocol schema. Desktop pins their
version and digest, tests compatibility, and bundles them.

Revalidated 2026-08-09 for Phase 3. Current GitHub documentation exposes SHA-256 on release assets
and supports immutable-release/local-asset verification. Artifact attestations now document
`actions/attest@v4`, but GitHub also states that private-repository availability depends on plan and
that an attestation only provides value when verified. Phase 3 therefore makes the portable
size/SHA-256 manifest mandatory and keeps attestation as an eligible release hardening step instead
of claiming it from this private local checkout. The client schema declares JSON Schema draft
2020-12 explicitly.

Sources:

- [GitHub: Splitting a subfolder into a new repository](https://docs.github.com/en/get-started/using-git/splitting-a-subfolder-out-into-a-new-repository)
- [GitHub: Release assets API](https://docs.github.com/en/rest/releases/assets)
- [GitHub: Artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations)
- [GitHub: Reusing workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)
- [GitHub: Verifying release integrity](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/verify-release-integrity)
- [JSON Schema: dialect declaration](https://json-schema.org/understanding-json-schema/reference/schema)

### 7. The current Electron runtime is already out of support

- The local app pinned Electron `33.2.0`.
- Electron's support policy covers only the latest three stable major versions; its schedule records
  Electron 33 end-of-life as 2025-04-29.
- In the August 2026 research window, 41–43 are the supported stable lines. Electron 44 is scheduled
  to require macOS 13 or later.

Decision: upgrade to the latest supported Electron patch before significant renderer work and set
the first serious Bimax for Mac support floor to macOS 13. Perform the runtime upgrade in its own
slice with app, native-module, PTY, packaging, and CU conformance tests; do not mix it with the visual
recomposition.

Executed, 2026-08-08 — **Implemented and locally Measured**. Registry evidence taken the same day
confirms the research window: `electron` dist-tag `latest` is `43.3.0` and no 44.x is published, so
41/42/43 remain the supported lines. The app now pins `electron ^43.3.0` (installed 43.3.0, Node
24.18.1, Chromium 150), with `electron-builder ^26.15.3`, `electron-vite ^5.0.0`, `vite ^6.4.3` and
`@types/node ^24.10.1`. Vite moved to 6 because electron-vite 5's public config types are declared in
terms of Vite 6's `BuildEnvironmentOptions`, which Vite 5.4 does not export; React and Tailwind
plugins were left on their existing majors. `@lydell/node-pty` was unchanged and still resolves — its
N-API prebuilds need no Electron rebuild.

The macOS 13 floor is now declared in two enforcing places rather than prose: `mac.minimumSystemVersion`
in `app/electron-builder.yml` (electron-builder writes `LSMinimumSystemVersion`, so the OS refuses to
launch below it) and `platforms: [.macOS(.v13)]` in `native/BimaxComputerUseKit/Package.swift`. The
independent reason to pick 13 rather than inherit Electron 43's lower floor is the security model
already documented in `docs/BIMAX_CU_SECURITY_MODEL.md`: `NSXPCConnection` code-signing requirements
evaluated against the immutable audit token exist from macOS 13, and below that the service falls
back to the weaker PID-based Security check.

Not yet qualified: fresh-Mac launch on the macOS 13 floor itself, and any signed/notarized run.
This machine can only prove the build and the declaration.

Sources:

- [Electron: Release timeline and support policy](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)
- [Electron: Release schedule](https://releases.electronjs.org/schedule)
- [Electron: Security, native capabilities, and your responsibility](https://www.electronjs.org/docs/latest/tutorial/security)
- [electron-builder: macOS options (`minimumSystemVersion`)](https://www.electron.build/mac)

### 8. Contextual macOS security must begin with Bimax-owned causality

- Endpoint Security is Apple's supported system-event monitor/authorization API, but its client
  entitlement requires Apple approval. Authorization messages block kernel operations and carry
  deadlines; Apple emphasizes prompt responses, muting/caching and sequence-gap handling.
- FSEvents is an efficient hierarchy-change notification mechanism, not an actor-attributed security
  audit log. Network Extension providers have distinct intended use cases and consent/deployment
  requirements.
- macOS already supplies Gatekeeper/notarization, XProtect, SIP, SSV and TCC. Bimax should complement
  them with active task/project context, not claim the operating system is static or replaceable.
- Provenance-based intrusion-detection research shows contextual causal graphs can detect unusual
  behavior, while practical false positives, graph volume and usability remain core challenges.

Decision: ship Bimax-owned intent/receipt comparison and project drift first. Keep deterministic
bounded rules on any authorization path; keep learned/model reasoning in explain/rank paths. Treat
Endpoint Security and network filtering as optional Desktop-only entitlement gates.

Sources:

- [Apple: Endpoint Security](https://developer.apple.com/documentation/endpointsecurity)
- [Apple: Build an Endpoint Security app](https://developer.apple.com/videos/play/wwdc2020/10159/)
- [Apple: Endpoint Security entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.endpoint-security.client)
- [Apple: FSEvents programming guide](https://developer.apple.com/library/archive/documentation/Darwin/Conceptual/FSEvents_ProgGuide/)
- [Apple: Network Extension](https://developer.apple.com/documentation/networkextension)
- [Apple Platform Security: XProtect](https://support.apple.com/guide/security-pdf/protecting-against-malware-sec469d47bd8/web)
- [USENIX: Practical and usable provenance-based IDS](https://www.usenix.org/publications/loginonline/toward-practical-and-usable-provenance-based-intrusion-detection-systems)

### 9. A modular ecosystem needs package kinds, a broker and trusted update metadata

- Apple's extension model runs extensions in separate processes behind host-defined extension
  points and XPC-style communication. This supports isolation, not arbitrary in-process plugins.
- TUF metadata separates root, targets, snapshot and timestamp roles to address key rotation,
  rollback/freeze and repository consistency. Sigstore bundles and SLSA provenance can add publisher
  and build evidence; OSV supplies structured vulnerability data.
- Agent Skills are inspectable directory packages, but scripts remain executable code. MCP tool
  descriptions/annotations are untrusted, and clients retain per-call approval responsibility.
- Background Assets is not a general executable-plugin distribution mechanism and its newer managed
  features cannot define the macOS 13 baseline.

Decision: define distinct skill, MCP/tool, app extension, native capability, environment recipe,
simulator adapter and ML worker kinds. All executable kinds run out of renderer process, declare
authority, use signed/fresh metadata, stage and verify, health-check, activate atomically and retain
rollback/revocation.

Sources:

- [Apple: ExtensionFoundation](https://developer.apple.com/documentation/ExtensionFoundation)
- [Apple: XPC](https://developer.apple.com/documentation/Foundation/xpc)
- [TUF metadata](https://theupdateframework.io/docs/metadata/)
- [Sigstore bundle format](https://docs.sigstore.dev/about/bundle/)
- [SLSA build track](https://slsa.dev/spec/v1.2/build-track-basics)
- [OSV](https://google.github.io/osv.dev/)
- [Agent Skills specification](https://github.com/agentskills/agentskills/blob/main/docs/specification.mdx)
- [MCP security best practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)

### 10. Simulator and ML capabilities should adapt official toolchains, not repackage them

- Apple documents Xcode-managed download/install of simulator and platform components.
- Android documents the Emulator as an official SDK tool with architecture, virtualization, RAM and
  disk constraints; Apple-silicon hosts should use supported acceleration and arm64 images.
- MLX is designed for Apple silicon and unified memory. Core ML exposes compute-unit choices, while
  coremltools provides conversion and optimization workflows. PyTorch MPS remains a separate Metal
  backend with its own support and fallback behavior.
- Smaller/quantized/pruned artifacts still require task-specific quality and target-device
  performance proof.

Decision: Bimax inventories and orchestrates official simulator components. ML Alchemist begins with
one bounded MLX research and one Core ML deployment journey, isolates model artifacts, preserves
source checkpoints and compares quality, latency, memory, artifact size and fallback behavior.

Sources:

- [Apple: Xcode additional components](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components)
- [Android: Emulator](https://developer.android.com/studio/run/emulator)
- [MLX](https://ml-explore.github.io/mlx/build/html/)
- [Core ML compute units](https://developer.apple.com/documentation/coreml/mlcomputeunits)
- [coremltools optimization](https://apple.github.io/coremltools/docs-guides/source/opt-overview.html)
- [PyTorch MPS](https://docs.pytorch.org/docs/stable/notes/mps.html)

### 11. Chipset-native adaptation is a measured control system

- macOS exposes Low Power Mode/thermal state, memory-pressure events, network path conditions,
  quality-of-service, compute-unit preferences, frame-rate preferences and Reduce Motion.
- These are signals and preferences, not proof that a strategy is faster, cooler or more efficient.
- Applying every small signal creates oscillation. Hysteresis, cooldowns, minimum effect thresholds,
  accessibility constraints and user override are required.

Decision: collect only signals with declared consumers/retention/effect thresholds. Instrument and
replay first; canary one policy class at a time; publish a chipset-native claim only for a named
operation/device/workload with correctness, interaction, latency, memory and energy/thermal evidence.

Sources:

- [Apple: ProcessInfo](https://developer.apple.com/documentation/foundation/processinfo)
- [Apple: dispatch memory pressure](https://developer.apple.com/documentation/dispatch/dispatchsourcememorypressure)
- [Apple: NWPathMonitor](https://developer.apple.com/documentation/network/nwpathmonitor)
- [Apple: Core ML compute units](https://developer.apple.com/documentation/coreml/mlcomputeunits)
- [Apple: MTKView preferred FPS](https://developer.apple.com/documentation/metalkit/mtkview/preferredframespersecond)
- [Apple HIG: Motion](https://developer.apple.com/design/human-interface-guidelines/motion)

### 12. Every owner-vision chapter now has a falsifiable research packet

- The owner source has 37 distinct chapters: original sections 1–34 plus later additions that reuse
  27, 28 and 29. Treating it as only 29 ideas would silently omit eight original/later chapters.
- Primary documentation and research leads are now mapped across hardware/runtime policy, macOS,
  networking, environment discovery, editing, Computer Use, security, adaptive execution and
  product identity.
- A research lead is not measurement. Each packet names candidate algorithms, a concrete Bimax
  example, mutations/experiments, search prompts and the remaining evidence required.
- Cross-cutting algorithms are deliberately portfolios: capability filtering and static policy
  first, then measured crossover tables or safely bounded adaptive selection. No algorithm is chosen
  because it sounds sophisticated.

Decision: use stable IDs V01–V34/V27B/V28B/V29B from
`12_ALL_VISION_SECTIONS_RESEARCH_PLAYBOOK.md` in future issues and evidence. A feature may move from
Target only through its research card, applicable acceptance gate and preserved end-state run.

Sources: the primary lead index in `12_ALL_VISION_SECTIONS_RESEARCH_PLAYBOOK.md`, with detailed
section 28/29 evidence in `11_SECTIONS_28_29_RESEARCH_AND_DELIVERY_PLAN.md`.

## Explicit non-conclusions

- Bundling the XPC service does not prove physical mouse/keyboard control works.
- A manual Gatekeeper override does not prove origin; the user is trusting the distributor and must
  separately verify the published digest.
- Semantic Accessibility actions are sometimes background-capable. Physical input generally needs
  the target foreground. “Runs in background” must be reported per action, not as one product flag.
- The 15/15 benchmark is evidence for the exact benchmark grammar and compatibility backend only.
- Product screenshots and marketing pages are examples of interaction patterns, not proof of their
  internal architecture or quality.
