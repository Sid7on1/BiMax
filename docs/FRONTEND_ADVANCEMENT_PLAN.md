# Bimax Frontend Advancement Plan

Date: 2026-07-15

## Outcome

Make the TUI feel like a stable professional instrument and make the website the authoritative front
door for Bimax: understand it, see real proof, trust it, install it, and recover when something goes
wrong.

This is not a cosmetic pass. The frontend contract is:

- no ghost frames or duplicated scrollback;
- visible token streaming;
- honest state and timing labels;
- one coherent Bimax visual language across terminal and web;
- real product proof before marketing claims;
- the public website owns install, docs, trust, changelog, and support entry points.

## Ownership split

| Area | Codex frontend track | Claude backend track |
|---|---|---|
| TUI layout, viewport, scroll, resize | Own | Do not edit |
| TUI styling, hierarchy, copy, interactions | Own | Do not edit |
| TUI presentation-side stream pacing | Own | Engine produces ordered deltas |
| Provider streaming/filtering | Consume | Own |
| Model routing and latency | Display honest phases | Own |
| Website UI, copy, motion, responsive behavior | Own | Do not edit |
| Installer endpoint logic | Present and document | Own canonical logic/security |
| Signing, notarization, release | Show verified state | Own |
| Protocol | Implement accepted consumer | Propose producer change first |

## Design direction: The Build Ledger

Bimax should not look like another cinematic AI page or another rainbow terminal dashboard. Its
signature is the **Build Ledger**: the user's intent, the work performed, and the proof that the work
holds together are one continuous readable record.

The visual metaphor comes from instruments and receipts, not chat bubbles:

- intent enters at the top;
- work advances down a precise rail;
- evidence closes the rail;
- the next prompt stays quiet and ready.

The deliberate aesthetic risk is to make the real execution transcript the hero of the brand. The
website and TUI use the same rail, glyphs, phase names, proof language, and color semantics.

### Shared tokens

| Role | Web | Terminal approximation |
|---|---|---|
| Canvas | `#E7E9E5` silver paper | terminal default background |
| Surface | `#F7F8F5` | no fill; whitespace |
| Ink | `#17191C` | `#ECEDE8` on dark terminals |
| Muted | `#686D73` | `#929791` |
| Hairline | `#C9CDC8` | `#454A47` |
| Signal | `#2B59FF` cobalt | `#73A7FF` |
| Verified | `#0D8065` | `#72C6A8` |
| Attention | `#B86418` | `#E4A462` |
| Danger | `#B83B43` | `#E47E84` |
| Execution well | `#0F1217` | terminal default background |

Typography for the website:

- display: Sora, restrained to hero and section theses;
- body: Inter;
- evidence/data: IBM Plex Mono;
- no more than these three roles, all self-hosted and subsetted.

Terminal typography is the user's font; hierarchy comes from weight, spacing, rails, and restrained
color rather than boxes or background fills.

## TUI plan

### Current failure

`tui/main.go` explicitly disables the alternate screen and `model.Update` commits content with
`tea.Println`. Resize recovery intentionally reprints a screenful. This architecture guarantees that
old frames and refreshed clones can remain in native scrollback. It is working as coded but does not
match the desired product.

The current chrome also competes with the answer: rotating verbs, a `fast/deep` tag, elapsed time,
mode chip, model, goals, memory, map, task boxes, sub-agent boxes, and footer shortcuts can all appear
at once. The result reads like diagnostics rather than a calm coding tool.

### New screen model

Use Bubble Tea's alternate screen and a real internal viewport.

```text
 Bimax   ~/Project                                     CODE · Step 3.7
──────────────────────────────────────────────────────────────────────

❯ Add retry with backoff to the fetch client
│
├ Read       src/api/client.ts
├ Changed    3 files
├ Verified   18 tests passed
└ Ready      review changes

  Here is what changed…
  streamed progressively, with stable markdown reflow

──────────────────────────────────────────────────────────────────────
❯ Ask Bimax…
  / commands   ⌘K actions                     22k / 128k context
```

Only approvals, menus, full diffs, help, and focused sub-agent inspection become overlays. Ambient
state does not get a box.

### Interaction contract

1. `tea.WithAltScreen()` owns the session screen and restores the shell on exit.
2. Transcript lives in `viewport.Model`; native terminal scrollback is never used for frames.
3. Mouse wheel, PgUp/PgDn, Home/End, and keyboard selection work inside the transcript.
4. At the bottom, streaming follows the tail. Scrolling upward suspends follow mode and shows a quiet
   `↓ new output` indicator; End resumes it.
5. Resize reflows from structured transcript state exactly once. Never reprint old frames.
6. `/clear` clears the internal transcript, not the user's terminal history.
7. Exiting, crashing, SIGTERM, and Ctrl+C always restore cursor, input mode, and the original screen.

### Streaming presentation

- Buffer engine deltas only to the next render frame (target 30 fps), never until the response ends.
- Append plain text immediately; re-render the active Markdown block only, then freeze completed
  blocks into the transcript.
- Keep tool/event updates keyed and update them in place without changing row order.
- Preserve user scroll position while new output arrives above the composer.
- Show phase labels based on facts:
  - `Connecting to Step 3.7`
  - `Waiting for first response · 4.2s`
  - `Receiving · 28 tok/s`
  - `Reading 4 files`
  - `Running tests`
- Remove rotating verbs such as `Focusing` and the misleading `fast` label.
- Do not show `Thought for 0s`; suppress sub-second values and round meaningful durations honestly.

### Visual hierarchy

- User prompts: signal color and bold `❯`.
- Assistant prose: primary text, no bubble.
- Activity rail: muted; only the active node uses signal color.
- Successful proof: verified color only on the closing receipt.
- Warnings/errors: semantic colors, never brand decoration.
- One hairline above header/composer; no rounded boxes for ordinary content.
- Tool details collapse into one line by default and expand in place.
- Footer shows only contextual shortcuts. Global help owns the full shortcut list.

### TUI implementation phases

1. **Screen foundation** — alternate screen, transcript viewport, scroll/follow state, terminal restore.
2. **Stream renderer** — frame-paced deltas, active-block Markdown, stable tool rows.
3. **Ledger components** — turn rail, proof receipt, approvals, tasks, sub-agent summary.
4. **Chrome reduction** — header/composer/footer, honest phase names, contextual shortcuts.
5. **Themes/accessibility** — truecolor/256/16-color snapshots, `NO_COLOR`, reduced motion.
6. **Dogfood** — narrow/wide terminals, long streams, resize storms, large diffs, background agents.

### TUI acceptance gates

- No duplicated line after 500 streamed updates and 50 resize events.
- Scrolling upward never snaps to bottom until the user requests it.
- First engine-visible text appears in the TUI within 100ms p95.
- 30 fps render cap under token floods; idle CPU remains near zero.
- Clean render at 80x24, 120x35, 160x50, and minimum supported size.
- Exact golden snapshots for idle, streaming, tools, approval, diff, error, and sub-agent states.
- No ANSI bleed, last-column autowrap, secret echo, or corrupted shell after forced termination.

## Website plan

The current website art direction and media manifest live in `docs/BIMAX_LIVING_SITE_BRIEF.md`.
That brief supersedes website visual choices below where they conflict; the product-truth,
accessibility, performance, and release-integrity requirements remain mandatory.

### Current critique

The live site is technically healthy, but its product story is split:

- the hero uses an abstract generated pipeline film while the strongest proof is the real TUI;
- the copy targets non-technical vibe coders, but the primary available product is a terminal command;
- desktop screenshots dominate even though desktop is early access;
- repeated large marketing sections explain similar ideas without adding new proof;
- install, release trust, documentation, changelog, support, and status are not first-class pages;
- the current all-dark cinematic palette and floating product cards resemble the broader AI-site
  category more than a specific Bimax instrument.

### Single job

The site must let a visitor answer, in order:

1. What does Bimax actually do?
2. Can I see it doing real work?
3. Is today's release safe and supported on my machine?
4. How do I install it and recover if installation fails?
5. Where do I learn more, see changes, or get help?

### Information architecture

```text
/
├─ Hero: real Build Ledger demo + Download the macOS app
├─ Proof: current version · supported OS · signed/notarized state · checksum
├─ Real session: prompt → files → verification → result
├─ Capabilities: four real tasks with evidence
├─ Trust: permissions, local files, model providers, data flow
├─ Quickstart: install → provider → first project
├─ Desktop: clearly secondary early-access preview
└─ FAQ + docs/changelog/status/footer

/docs        installation, providers, permissions, commands, troubleshooting
/download    current release, platforms, checksums/signatures, uninstall
/changelog   versioned public release notes
/trust       data flow, credential storage, sandbox, signing/notarization
/status      website/installer/provider-independent status information
```

### Homepage direction

Hero copy should be concrete and product-true:

> Give Bimax a job. Get the change and the proof.

The right side is not a decorative video. It is a deterministic playback captured from a real,
passing session. Visitors can scrub three states: `Ask`, `Build`, `Verify`. The final state links to
the exact files/checks represented in the demo fixture.

Primary CTA: `Install Bimax`.

Secondary CTA: `Watch a real run`.

Desktop early access remains visible but never competes with the shipped CLI CTA.

### Generated media workflow

Use the global `$google-flow-web-media` skill and the user's required Google Flow project for all
generated website images and videos:

`https://labs.google/fx/tools/flow/project/55f0ad0e-bb4f-4a16-ba3d-e9071b0ac2c9`

Flow media may establish atmosphere, explain an abstract transition, or support launch/social
creative. It must not replace the real deterministic product session in the hero or depict invented
features. Export assets locally under `site/public/media/`, provide responsive crops and video
posters, and preserve a static reduced-motion fallback derived from the same Flow output.

### Website implementation phases

1. **Truth pass** — remove stale/ambiguous claims; source version, platform, signing, and checks from
   release metadata.
2. **Design-system pass** — silver instrument canvas, cobalt signal, dark execution well, new type
   roles, shared ledger components.
3. **Hero/demo pass** — deterministic real session playback with reduced-motion static sequence.
4. **Product front door** — docs, download, changelog, trust, status, troubleshooting.
5. **Conversion pass** — install copy, provider setup preview, desktop waitlist as secondary journey.
6. **QA pass** — performance, accessibility, SEO/social, analytics consent, broken-link/install tests.

### Website acceptance gates

- LCP <= 2.5s on a mid-tier mobile profile; no autoplay asset blocks first paint.
- CLS <= 0.1; responsive from 320px to 1600px with no horizontal page scroll.
- One `h1`, logical headings, keyboard-complete navigation, visible focus, WCAG AA text contrast.
- Reduced motion disables autoplay/smooth scrolling and presents the full story statically.
- Every install command and download URL is tested against the public release in CI.
- Release version, checksum, signing/notarization, and platform support cannot drift from reality.
- No product screenshot represents an unavailable feature without an explicit early-access label.
- Waitlist success/error, duplicate signup, offline failure, and honeypot paths are tested.
- Zero console errors and zero broken assets on homepage, docs, download, changelog, and trust pages.

## Definition of done for today's frontend track

The plan is complete when the full-screen TUI foundation and new website shell can be implemented
without backend ambiguity, the shared Build Ledger language is fixed, and Claude's backend branch can
merge without touching visual files.
