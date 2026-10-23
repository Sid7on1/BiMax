# Bimax

**An agentic coding IDE for project work — the two-minded machine.**

Most AI coding tools show you one stream of consciousness. Bimax shows you a machine that thinks in
two registers and is accountable for both: a fast intuition and a deep reasoner it routes between,
and an epistemic ledger that verifies what it did and tells you *how sure it is*.

Bimax ships as a **macOS desktop app**. It is code-only: it reads and writes your project, runs your
tools, and explains itself. It does not drive your Mac.

---

## Layout

Two pieces, one product.

| Path | What it is | Build output |
|---|---|---|
| `app/` | The Electron desktop app — main process, preload, React renderer | `app/release/` |
| `src/` | The **engine**: the headless agent core the app spawns and drives over an NDJSON stdio protocol | `.engine-local/bimax-engine` |

The engine is an **input** to the app's build, never a step of it — `app/scripts/prepare-engine.sh`
takes a path to a compiled executable and stages it into the bundle. It does not care how that
binary was produced.

Removed code — Computer Use, the terminal TUI (`tui/`, `bin/bimax.js`) and the marketing website
(`site/`) — was lifted out on 2026-09-06. A working copy lives outside this tree at
`~/Developer/bimax-archive` (deliberately outside iCloud), and every file remains recoverable from
git history at its original path:

```sh
git log --diff-filter=D --  src/computer      # find the removing commit
git checkout <commit>^ --   src/computer tui site
```

## Development

```sh
npm ci                     # engine deps
npm run build              # typecheck + build the engine (tsc)
npm run build:engine       # compile the standalone engine binary (bun --compile)
npm run test:ci            # jest, no coverage — engine + app pure-logic suites

npm --prefix app ci        # app deps
npm run app:dev            # electron-vite dev server
```

To build a runnable `Bimax.app` on this machine:

```sh
npm run build:engine
bash app/scripts/build-local-mac.sh arm64
```

It resolves the engine in this order: `BIMAX_ENGINE_LOCAL_OVERRIDE` → `.engine-local/bimax-engine` →
the release pinned in `engine.lock.json`. It builds unhardened and outside the synced Desktop tree,
both deliberately — see the comments at the top of that script.

CI (`.github/workflows/ci.yml`) runs the engine typecheck/lint/test and the app
typecheck/build/protocol-mirror check on every PR to `main`.

## What makes it different

- **Confidence in the margin** — the epistemic ledger surfaces per-turn verification, so an edit
  reads as backed-by-tests or unverified, inline.
- **Two-tier routing, made visible** — you see which mind (fast vs. deep) answered a turn.
- **Real sandboxing** — Bash runs under an OS sandbox (macOS seatbelt) with write and network floors.
- **Sovereign mode** — external egress fails closed at the process perimeter, not at sixteen call
  sites.

## More

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — every subsystem, tool, and command.
- [docs/FEATURES.md](docs/FEATURES.md) — the highlight reel.
- [docs/ACCESSIBILITY.md](docs/ACCESSIBILITY.md) — reduced motion, contrast, screen readers.
- [docs/CHANGELOG.md](docs/CHANGELOG.md) — notable changes.
- [PRIVACY.md](PRIVACY.md) — what data Bimax collects (short answer: it stays on your machine).
- `~/Developer/bimax-archive/README.md` — what was removed, what was measured, and how to restore it.
