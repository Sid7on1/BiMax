# Bimax Desktop

The Bimax agent as a native macOS desktop app. An Electron shell that hosts the engine itself
(`BIMAX_HEADLESS=1`, NDJSON) in an Electron `utilityProcess` — MessagePort in, piped stdout out.
`BIMAX_ENGINE_TRANSPORT=child` selects the older OS-child-process path instead; it needs an explicit
`BIMAX_ENGINE_CMD` and exists for bisecting against an older engine build.

The engine is **the app's own source**, not a downloaded release. `scripts/prepare-engine.sh` runs
`bun build src/index.ts` into `app/engine/index.js` (23 MB, architecture-independent), which
electron-builder copies to `<resources>/engine/`. There is no pinned binary, no `engine.lock.json`
and no download; both are in `~/Developer/bimax-archive`.

The wire contract is not mirrored either: `src/shared/protocol.compat.ts`,
`src/shared/evidence.schema.ts` and `src/renderer/src/protocol.ts` import
`src/protocol/protocol.ts` and `src/evidence/schema.ts` from the repository root directly. Those two
files have zero imports, so taking them does not drag the engine's module graph into the app build.
A contract change now breaks the typecheck rather than a drift gate.

## Layout

```
src/main/      Electron main — window + Engine host (ports tui/engine.go: spawn resolution,
               NDJSON framing, stderr → <userData>/engine.log)
src/preload/   contextBridge: the renderer's only door to the engine
src/renderer/  React chat UI — transcript, streaming, tool cards, approval/diff/ask modals,
               engine menus, slash/@ completions, ui_snapshot footer
scripts/       prepare-engine.sh — bundles the repo's src/index.ts into app/engine/index.js
               verify-engine.js  — forks that bundle with the real utilityProcess and speaks the
                                   real protocol to it (the packaged artifact is otherwise untested)
```

## Dev

```bash
npm install
npm run prepare:engine # bun-bundle the repo source into app/engine/index.js (requires bun)
npm run verify:engine  # run that bundle the way Bimax runs it and require it to answer
npm run dev            # Vite HMR renderer + Electron; engine runs from app/engine/index.js
```

Engine resolution uses `app/engine/index.js`. Contributors can deliberately override the launch
command with `BIMAX_ENGINE_CMD`. `npm run dev:source` runs the engine from `src/` through tsx
instead of the bundle, so an engine change does not need a rebundle.

## Package

```bash
npm run dist:mac       # DMG, Apple Silicon (arm64)
npm run dist:mac:x64   # DMG, Intel
```

Each dist script verifies the matching pinned engine artifact into `engine/` (bundled as an
extraResource at `<Resources>/engine/bimax-engine`), stages the Desktop-owned native components,
builds the renderer/main bundles, and invokes electron-builder. Output lands in `release/`.

Local builds are unsigned unless Developer ID credentials are available. They are suitable only for
the explicitly labeled manual-install alpha flow; a stable public release must pass the signing,
notarization, stapling, update, and fresh-Mac gates in `docs/product-reset/08_ACCEPTANCE_GATES.md`.
