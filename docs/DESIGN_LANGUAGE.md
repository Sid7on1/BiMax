# The BiMAX Design Language — Starlight & Moonlight

## Current Mac app contract — 2026-10-01

The active product is the worker-only Mac app (product-reset records 55 and 64). The Terminal-specific sections
below are retained history; references to `tui/styles.go` are not the active Mac token authority.
`app/src/renderer/src/styles.css` owns Moonlight/Starlight ink, material, type and shared control feedback;
`components/ui/morph/tokens.ts` owns the spring ladder. The exact UI fix list and evidence are in
[`front inspo/15-ui-fix-list-applied.md`](../front%20inspo/15-ui-fix-list-applied.md).

- Large window/pane/raised-card surfaces may transmit light. Small floating controls use the 94% floating density.
  One surface gets one veil: no glass stacked on glass.
- Inter is the interface/prose face; code, commands, identifiers and file paths retain the code face. Lucide supplies
  action/status glyphs, with the established brand and file-type marks as exceptions. Shared spacing groups related
  controls; it does not add a border around each piece of information.
- Radius tiers express the object: small glyphs/chips (3–7px), rows/inputs (8–12px), large raised surfaces (16–22px),
  and circles/pills. Seeded morphs interpolate the measured origin and destination radius from that same hierarchy.
  A tier is a family with optical adjustments, not a rule that every object has identical curvature.
- Moonlight uses #1a1a1a canvas, #212121 raised and #141414 wells, with stepped silver semantic signals. Supporting
  text is #e9e9e4 / #e0e0dc; Starlight has its own darker ink ladder (#3d3d3a / #474743). Every readable label targets
  4.5:1 at baseline; Increase Contrast is an enhancement. The compiled, composited preview calibrates real content
  in both themes and zooms; native vibrancy and the full wallpaper range require separate installed measurement.
- Seeded morph is the signature. Working text stays still, shows actual reasoning/retry text and elapsed time,
  and never scrambles letters or rotates invented activities. Cards do not stage decorative entrances. Pointer/Space
  down gives every enabled control an immediate inset outline; established press releases ease out in 120ms.
- Goal, current step, this run's changed files and next action remain visible outside scrollback. “Checking changes”
  describes an actual running check after edits; only scoped evidence can say checks passed. No artificial delay.

This document describes the design system **as implemented** in `tui/styles.go`,
`app/src/renderer/src/styles.css`, and the copy conventions across the engine.
It is a contract, not a mood board: if a change violates a rule here, the change
is wrong or this document must be amended in the same commit.

BiMAX's identity: **a quiet instrument that is visibly alive.** Black, white,
pearl and silver carry every surface; stronger contrast marks what is live or focused.
State remains explicit in words and symbols, never hue alone. The product speaks briefly when
things are routine and precisely when evidence matters.

---

## 1. Principles

1. **Foreground only.** BiMAX paints text; the ground is the user's own
   terminal. No full-background repaints, no wall-to-wall fills.
2. **One light.** Silver (`#EDEDEB`) means *live / focused / active* — the
   user's own words, the running spinner, the selected row, the active tab.
   Nothing decorative may use it.
3. **Meaning survives monochrome.** Success, failure, caution and information
   use labels and symbols first; stepped silver values add hierarchy without hue.
4. **Hierarchy through ink, not boxes.** Four text tones (primary → secondary →
   tertiary → decorative) do the layout work. Borders are hairline, dim, and
   rounded — they group, they do not decorate.
5. **The best status message is none.** Confirmations are short footer
   one-liners that self-clear (~10 s). Only turn-relevant content enters the
   transcript.
6. **Degrade gracefully.** Truecolor hex degrades automatically (lipgloss) for
   256/16-colour terminals; layout must survive 60-column SSH sessions; every
   animation respects `--no-anim` / `BIMAX_REDUCED_MOTION=1`.

## 2. Colour tokens (single source of truth: `tui/styles.go`)

| Token | Hex | Meaning |
|---|---|---|
| `colAccent` (Silver) | `#EDEDEB` | live, focused, active, "yours" |
| `colShimmer` | `#FFFFFF` | animated live shimmer only |
| `colText` | `#F5F5F4` | primary ink |
| `colInactive` | `#B8B8B5` | secondary text, summaries |
| `colSubtle` | `#7C7C78` | tertiary — gutters, hints |
| `colDim` | `#303030` | decorative only (hairlines, empty meter track) — **never text** |
| `colOK` | `#D3D3CF` | success, additions, tool completion |
| `colErr` | `#E2E2DF` | failure, deletions |
| `colWarn` | `#B9B9B4` | caution, degraded, needs attention |
| `colInfo` | `#C4C4C1` | neutral information, links, hunks |
| `colInk` | `#1A1A1A` | dark text ON a coloured block (chips, search hit) |

Rules:
- No raw hex outside the token block (the chroma syntax theme in `markdown.go`
  is a separate, deliberate exception; gradient math in `views.go`/`welcome.go`
  decomposes these same tokens and says so inline).
- `colDim` fails WCAG on purpose and is therefore banned for text.
- Mode chips are the one place a solid light block is allowed (dark ink on
  silver), because the active mode must be unmissable.

## 3. Symbols

| Symbol | Use |
|---|---|
| `⏺` | a tool call (label and silver intensity distinguish done · running · failed) |
| `⎿` | the tool's one-line result, indented under its call |
| `●` | "current" marker in pickers |
| `◉` | slot rows in the model hub |
| `⌕` `✎` `⊘` `↩` | browse · custom entry · none/off · inherit |
| `⌂` | workspace / repo chip |
| `◍` | live browser session (host only; warn-tinted when tainted) |
| `🤖` | live sub-agent |
| `🧠` | mind layer chip |
| braille spinner | the only spinner; silver-tinted; frozen under reduced motion |

No decorative ASCII, no box-drawing walls, no emoji outside this table.

## 4. Layout & density

- **Transcript is immutable scrollback.** Live state pins to the bottom region
  (task panel, sub-agent panel, token meter, footer) — never injected inline.
- **Footer is one line**: mode chip · model pointer · routing chip (`· work` /
  `· quick`) · workspace chip · hints. Ephemeral confirmations ride here and
  self-clear; they do not enter the transcript.
- **Panels** (todos, sub-agents, map, logs) are rounded hairline boxes,
  `Padding(0,1)`, pinned above the prompt.
- **Narrow terminals**: chips collapse to counts (`⌂ 4 repos`), panels clip
  before the transcript does, nothing wraps into corruption.
- Diffs: stepped neutral backgrounds with explicit `+`/`-` markers and a bold
  bright line-number gutter; word-level intensity inside edit previews.

## 5. Vocabulary

**One vocabulary everywhere: Work · Quick · Vision.**

- *Work* — the model that does the real coding/agentic work.
- *Quick* — the plain, non-reasoning model for instant small replies.
- *Vision* — where screenshots/images go; never displaces Work.

`coding` / `lite` / `heavy` are wire keys and accepted command aliases only —
they must never appear in rendered UI text. The live routing chip says
`· work` / `· quick`. New surfaces must reuse these three words or none.

## 6. Voice

BiMAX is direct without being robotic, confident without pretending certainty,
calm during failures, brief during routine.

**Rules:**
1. Lead with what happened, then what happens next. Never blame without
   evidence — latency attribution comes from measurement (`/perf`), and a stall
   is "no response within Ns", not "provider is slow".
2. Failures state the reset honestly and hand the user (or the model) the next
   move: *"Browser disconnected mid-action. The runtime was reset — your next
   action relaunches with the same profile."*
3. Unconfigured ≠ default: *"model not chosen yet — run /setup"* — never
   pretend a choice was made.
4. Repetition gets called out: *"This exact action has now failed 3 times in a
   row — take a fresh snapshot and try a different route."*
5. Waiting is a single neutral gerund on the shimmer line ("Thinking",
   "Connecting", "Measuring" — see `tui/model.go`) plus elapsed time — never
   a claim about *why* it is slow. Attribution lives in `/perf`, backed by
   the DNS→TCP→TLS probe evidence, and nowhere else.
6. No exclamation marks in status copy. No apologies. No "please wait".
7. Permission prompts state the action, the blast radius, and the escape:
   what runs, what it touches, how to decline.

## 7. Motion

- One braille spinner, silver-tinted, for "working"; a shimmer phrase for
  "thinking". Nothing else animates.
- `--no-anim` / `BIMAX_REDUCED_MOTION=1` freezes both; state is still legible
  because colour and text carry the meaning, not the motion.

## 8. Anti-patterns (rejected deliberately)

Graphic logos · gradients beyond the text-only wordmark · neon/cyberpunk hues · glowing borders ·
badge/pill proliferation · decorative separators · spinners for instant
operations · loud success banners · provider jargon in primary surfaces ·
copying Claude Code / Codex / Gemini CLI surface language verbatim.
