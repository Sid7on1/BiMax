# Target architecture

## Fresh project conversations and scoped replay — 2026-10-05

[Record 69](69_FRESH_CHAT_AND_REPLAY_ISOLATION.md) changes explicit repository opening to create a
fresh Bimax Thread. Credential renewal restarts the selected matching-root conversation; history
selection remains explicit. Harness evaluation uses asynchronous execution-local replay scope and
cannot publish recorded calls into live events, saved sessions or live-loop bookkeeping. Records
55/64's monolith and record 66's Computer Use retirement remain current.


## Computer Use retired — owner decision, 2026-10-04

The owner explicitly withdrew Computer Use: “roll off the bimax cu completely keep it in archive again i dont
want that feature at all”. [66_COMPUTER_USE_RETIREMENT_RECORD.md](66_COMPUTER_USE_RETIREMENT_RECORD.md) governs the
current boundary. The look/press/type/scroll tools, app services, preview switches, Accessibility request path,
native driver dependency and feature proof scripts are archived outside the repository. Saved flags cannot restore
them; stale host requests and governor COMPUTER_CONTROL requests refuse. Coding, Bimax Threads, Finder folder
selection and on-device dictation remain. Records 55/64 still govern engine workers in the monolith. Record 65 and
its measurements below are historical evidence, not an active rollout or authorization to reintroduce the feature.


> **Historical implementation, 2026-10-02 — superseded by record 66:** Bimax for Mac runs each Bimax Thread's
> engine in a worker over its MessagePort. Opted-in ⌘2 tasks may look, press, type, submit Return, pick a pop-up item
> and scroll in apps the person grants for that task; project windows receive none of these tools. The app owns the
> pinned in-process Cua Driver 0.31.0, grants, commit/overwrite cards, freshness and build binding, and verification.
> A foreground press or typing asks on every step and checks restoration. Stage 2 and 3 exits are Measured in the
> installed app; stage 4 was declined; stage 5 was set aside (X01 unmeasured). Stage 6 abilities are Implemented and
> locally Measured within record 65 §6h's limits; its fixture baseline, repetitions and distribution exit remain owed.
> Recovery suggestions are names from an observed window only, never fuzzy action authority. The admission gate is
> `08_ACCEPTANCE_GATES.md`. Legacy provider, XPC service and fallback ladder stay retired. The split topology below
> is historical; Terminal stays outside Computer Use and permission ownership.

## Repository and process ownership

```text
bimax-terminal repo                         bimax-desktop repo
┌─────────────────────────────┐            ┌──────────────────────────────┐
│ coding engine               │ release    │ Electron main (trusted host) │
│ model/tool/governor loop    ├───────────►│ engine supervisor            │
│ coding tools + MCP client   │ engine +   │ React renderer (sandboxed)   │
│ session/review/checkpoints  │ schema +   │ desktop capability broker    │
│ headless NDJSON protocol    │ manifest   │ Swift XPC service + bridge   │
│ Go Terminal frontend        │            │ AX / capture / input / tests │
└─────────────────────────────┘            └──────────────────────────────┘
```

Desktop pins an engine release by version and SHA-256. Development may use a local override, but a
release build cannot walk to `../src` or silently compile whichever engine happens to be beside it.

## Contract strategy

Do not change transport and repository topology in the same step. First publish the existing NDJSON
protocol as a real client contract:

- semantic protocol version plus minimum/maximum compatible versions;
- generated JSON Schema/TypeScript fixture package;
- `hello` capability negotiation instead of assuming every UI field exists;
- engine, protocol, build commit, and supported feature list in the handshake;
- unknown additive messages ignored; incompatible major versions fail visibly;
- golden transcript, approval, interrupt, resume, crash recovery, and malformed-frame fixtures.

ACP is useful for third-party agent compatibility and the engine already contains an ACP adapter,
but Bimax Desktop currently needs richer review, health, settings, and task snapshots. Keep the
Bimax client protocol for first-party Desktop and expose ACP separately; do not force the UI split
through an incomplete standardization rewrite.

## App-owned computer capability

The end state is a Desktop capability provider registered with the engine over a narrow local
interface (MCP is the preferred existing seam). Terminal ships the generic capability client but no
Mac provider and therefore exposes no computer tool or computer prompt.

Migration has an intentional temporary state: Desktop may bundle an engine that still contains the
current CU coordinator, but only Desktop supplies the native endpoints. Once behavior is stable,
move coordinator, prompts, policies, installed-app routing, posture, and benchmarks into Desktop;
leave only generic tool/capability plumbing in Terminal.

## The only supported fallback ladder

The current system has too many overlapping names and recovery paths. Desktop exposes one logical
`Mac` tool with four executor levels:

1. **Semantic native action** — AX press, set value, select, scroll, window operation. Preferred and
   often background-capable.
2. **Physical native input** — exact target is known but the control requires real pointer/keyboard
   input. Foreground lease is explicit and verified.
3. **Visual recovery** — screenshot plus OCR/vision only when semantic data is absent or stale. It
   must produce a new target bound to the current frame before acting.
4. **Stop and ask** — if fresh observation cannot prove a target or postcondition. Never resurrect
   an old element, silently jump to an unrelated legacy driver, or repeat the same refusal.

Compatibility driver and experimental legacy MCP paths may remain in a developer-only lab until
native parity is measured, but they are not production fallbacks and never appear in the user UI.

## Action state machine

Every Mac action emits one typed state sequence:

```text
requested → observed → planned → approved? → acted → observed → verified
                                                └──────────────→ failed/blocked
```

Each action binds target app, target window, observation/frame ID, executor level, start/end time,
and postcondition. Retry is a new action linked to the prior failure, not an invisible loop. The UI
can therefore show exactly what happened while diagnostics retain raw evidence.

## Security boundaries

- Renderer: local packaged content, sandboxed, no Node, strict CSP, narrow typed preload API.
- Electron main: validates renderer origin/sender and all payloads; owns project file/PTY access and
  engine lifecycle.
- Engine: project-scoped coding sandbox and approvals; no direct Accessibility/Screen Recording.
- Desktop broker: short-lived authenticated local capability; no listening public interface.
- XPC service: minimal native privileges, validates client identity, data-only protocol, crash
  isolated and restartable.
- Credentials: move provider secrets to macOS Keychain; never put them on the NDJSON stream, in
  renderer storage, diagnostic exports, or repository state.

## Data ownership

- per-project durable task/checkpoint data: `.bimax/`, format owned by the engine;
- shared account/model preferences: `~/Library/Application Support/Bimax/` with a versioned schema;
- Desktop window/CU/grant state: `~/Library/Application Support/Bimax/Desktop/`;
- Terminal presentation state: `~/Library/Application Support/Bimax/Terminal/`;
- secrets: macOS Keychain;
- caches/logs: `~/Library/Caches/Bimax/<product>/`, bounded and user-clearable.

Desktop and Terminal can open the same engine session format. Only one writer may own a session at a
time; opening an active session elsewhere is read-only or requires an explicit takeover.

## Optional contextual intelligence plane — owner section 28

The post-reset architecture may add a Desktop-owned intelligence plane, but the base products do
not depend on privileged observation. The first slice consumes typed Bimax task, tool, package,
project and Mac-action receipts. Broader sensors are separately consented capabilities.

```text
engine and capability intents/receipts
            ↓
Desktop policy and evidence broker
            ↓ authenticated data-only XPC
native intelligence service + bounded event store
       ↙ optional                  optional ↘
Endpoint Security system ext       Network content filter ext
```

- Endpoint Security authorization callbacks contain only bounded deterministic policy. No LLM,
  remote request, graph traversal, disk scan, or UI prompt may occupy the kernel deadline.
- Event loss, stale data, sensor revocation, and unavailable entitlement are explicit evidence
  states, never silently interpreted as safe.
- The renderer receives typed findings and approvals, not raw native handles, unrestricted paths,
  audit tokens, secrets, or network payloads.
- Corrections use preview → snapshot → approval → fresh precondition → bounded mutation → independent
  postcondition → rollback. System-wide/destructive remediation is never model-autonomous.
- Core Code continues to work with no Endpoint Security, Network Extension, Full Disk Access,
  Screen Recording, Accessibility, or Computer Use permission.
- Terminal may submit its own action intent to generic policy, but ships and registers no Mac sensor.

Detailed research, event contracts, delivery slices and gates are in
`11_SECTIONS_28_29_RESEARCH_AND_DELIVERY_PLAN.md`.

## Verified capability ecosystem — owner section 29

Desktop presents one capability graph, while different package kinds retain different execution and
trust boundaries:

- knowledge skills and declarative assets are parsed as data;
- MCP/local tools execute out of process behind the capability broker;
- executable extensions use a signed, versioned, resource-bounded extension host;
- native capabilities remain app-associated XPC/system-extension components;
- environment recipes are resolved to a visible transaction before a package manager runs;
- Xcode and Android own their official simulator runtimes; Bimax supplies adapters, not repackaged
  platform images;
- ML Alchemist workers isolate model parsing, conversion, training and optimization artifacts.

Every capability has immutable digest, publisher/provenance, platform and architecture constraints,
declared filesystem/network/process authority, dependency graph, health state, and rollback target.
Executable code never loads into the renderer. Installation uses trusted fresh metadata, staging,
signature/digest/provenance validation, isolated health check, atomic activation, revocation and
rollback.

The integrated IDE is composed from the existing editor, terminal, diff, git, task and evidence
surfaces; ACP/editor handoff remains supported. The adaptive runtime consumes declared signals only
when a measured policy has thresholds, hysteresis, bounds, accessibility constraints, an override,
and an acceptance journey. “Chipset-native” is therefore an operation-specific measured claim, not
a blanket promise that every workload uses GPU or Neural Engine.

## Release flow

Terminal release:

1. test engine/TUI/protocol on macOS arm64 and x64;
2. publish engine binary, Terminal binary, protocol schema/fixtures, license manifest, SHA-256 file,
   build provenance, and release notes;
3. never include CU driver/service/helper.

Desktop release:

1. resolve a pinned Terminal engine manifest and verify digest;
2. build/test Swift package, XPC bundle, bridge, Electron main/preload/renderer;
3. run protocol contract and app-owned CU conformance;
4. sign every nested executable consistently when credentials exist;
5. run the signed packaged app's no-window topology probe and require Electron → bridge → the exact
   intact app-bundled XPC service; a standalone service self-test is not a substitute;
6. package arm64/x64 DMGs, notarize/staple for stable release, and verify on a clean Mac;
7. manual alpha may skip Developer ID but must publish checksums, show the override instructions,
   and test permission behavior honestly.
