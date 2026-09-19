# front inspo

Front-end research for the Bimax desktop redesign. Measured 2026-09-12 on macOS 26.5.2.

| file | what's in it |
|---|---|
| `00-METHOD.md` | how everything was captured; the two traps that invalidate this kind of work |
| `01-claude-app/NOTES.md` | Claude Desktop teardown — opaque, warm, **animates nothing** |
| `02-codex-app/NOTES.md` | Codex teardown — opaque, cool sidebar, one 367ms animation |
| `03-bimax-current/NOTES.md` | our baseline — ~5% vibrancy, mixed temperature, 433ms menu |
| `04-comparison.md` | the three side by side |
| `05-apple/REF-01…03`, `SOURCES.md` | macOS 27 Golden Gate, Liquid Glass rules, what Electron can do |
| `06-gaps.md` | first-pass gap list — **partly superseded**, G1/G3 wrong, G4 overstated |
| `07-evaluation.md` | evaluation against the docs; required vs beneficial changes |
| `08-changes-applied.md` | **START HERE** — round 1 fixes, then round 2 (B1/B2/B4/B5 all taken) |
| `13-right-panel-applied.md` | **what the merge changed** — three rows, what was deliberately not built, and the three defects it uncovered |
| `12-right-panel-plan.md` | the plan it came from — merge the editor and inspector into one tabbed workbench, the way Cursor's right panel works |
| `11-round3-applied.md` | **what round 3 changed** — the black-glass shell, the three rules, and what each reported "border" turned out to be |
| `10-cursor/NOTES.md` | **Cursor teardown, measured 2026-09-19** — sidebar is the glass, canvas is the tinted one, no top strip |
| `09-black-glass-plan.md` | round 3 plan — match the reference's dark-glass shell; a **layout** change, not a colour one |
| `tools/measure.py` | the pixel-measurement harness |

Screenshots are gitignored (`*.png`); the notes are the deliverable.

**Skills produced:** `~/.claude/skills/macos-native-feel` (global) and
`.claude/skills/bimax-frontend-review` (this repo).
