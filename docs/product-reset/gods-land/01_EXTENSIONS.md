# God's Land — extensions

**Status: Target (design proposals). Date: 2026-09-25.** Written on top of the owner's brainstorm
([00_OWNER_BRAINSTORM.md](00_OWNER_BRAINSTORM.md)) at the owner's request, before any research. The feasibility
column in §5 was written from general platform knowledge; [02_RESEARCH.md](02_RESEARCH.md) checks it against sources
and supersedes it where they disagree.

## 1. More glass states

| Shade | Looks like | Means |
|---|---|---|
| 🔥➜💧 **Annealing** | Amber cools into clear glass in bands, top to bottom | Checks or tests are running; the last band clearing means they passed |
| 🫧 **Rising bubbles** | Small bubbles drift up inside the notch | Queued tasks; the number of bubbles is the queue length |
| 🖋️ **Ink in water** | Dark ink swirling slowly in the glass | Bimax is waiting for your approval |
| 🏺 **Crackle glaze** | A fine crackle pattern, like old pottery | Working in a weaker mode: a fallback model, search without a key, offline |
| 🌅 **Sunset tint** | Glass warms toward orange at its edges | Close to the daily spending limit |
| 🌙 **Night indigo** | Deep blue glass with one slow star glint | Night Shift is working |
| 🪨 **Etched** | A frosted engraving | Pinned: never ambered, never cleaned up |
| 🔴🔵 **Stained glass** | A thin coloured rim per card | Cards from the same task share a colour |
| 🧊 **Wax seal** | A small seal in the card's corner | An undo point exists; tapping it rolls back to here |
| ☁️ **Fog breath** | The glass fogs as if breathed on | Bimax is listening (talk mode) |

Rule: every shade also has a text label and a shape cue, never colour alone. Under Reduce Transparency or Increase
Contrast each shade has a solid, high-contrast form.

## 2. More motion

| Motion | Trigger | Physics | Meaning |
|---|---|---|---|
| 🫗 **Pour** | Drag a card onto another | The top card tilts and pours; the lower one's level rises | Combine: this CSV into that report, two notes into one |
| 🌉 **Surface bridge** | Link two tasks | A liquid bridge between the two ⌘2 bars while linked | Linked work is visible |
| ⏳ **Evaporation** | A secret is copied | The card's level falls over 60 s; empty clears the clipboard | How long the secret stays copied |
| 🧪 **Capillary climb** | A long task runs | Liquid climbs the card's edge with progress | Progress without a bar |
| ❄️➜💎 **Crystallize** | Draft becomes final | Liquid locks into facets with a small "tink" | Done |
| ⏪ **Ripple rewind** | Undo | Rings play backwards into the card | Undo as a physical event |
| 🔮 **Snow globe** | Shake the cursor over the notch | Cards swirl and settle re-sorted by current relevance | Re-sort on demand |
| 🪨 **Skipping stone** | Ghost Paste | Each ⌘V makes the next bead skip forward | The queue as a toy |
| 👣 **Wet footprint** | Drag a card out | A wet outline dries in 400 ms where it was | Where it came from; dropping it back undoes |
| 🧲 **Ferrofluid spikes** | Hover a card with actions | One small spike per action rises toward the cursor | Actions without buttons |

Rules: every motion can be grabbed mid-flight; none blocks input for more than a frame; Reduce Motion makes each a
150 ms fade.

## 3. Connections to what Bimax already has

| Moment | What happens | Existing piece |
|---|---|---|
| Drop on a falling drop | A file dropped while a task runs joins that task | Steering a running task (F7) |
| Approval pearl | A pearl hangs from the notch; press-and-hold approves, flick up denies | Allow/Deny from a notification (N1), "Allow for this task" (N13) |
| The notch talks | Talk mode's state shows in the notch, not only the menu bar | FL11 |
| Morning tide | First lid-open: the Night Shift briefing rises as one card | Night Shift (FL5) |
| "Where was I?" wave | After a break, hovering shows what changed | FL7 |
| Folder fountain | Arrivals in a watched folder drip in | Folder triggers (FL1) |
| Seal ripple undo | A Bimax-made card carries a seal; tapping undoes that change | Change history and undo (FL4) |
| Teach from the notch | A "keep this" leaf saves a successful task as a skill | Muscle memory (FL6) |
| Seed Bloom | Reuses the existing button-to-window morph, not a second system | Seed Morph v2 |

Quick pills are learned from the owner's own past tasks on that file type, not a fixed list.

## 4. Micro-details

1. The notch is the light source: shadows fall away from the camera.
2. The droplet carries the file's colour (first page, dominant image colour, language colour).
3. Card corner radii are derived from the notch's own curve.
4. A long hover leaves a fingerprint smudge that fades in 2 s.
5. Liquid level shows size; a large file wobbles more when dragged.
6. The ⌘2 bar breathes one line taller as you type, never jumps.
7. More than five things waiting: fine rain streaks the notch glass until cleared.
8. Lid close or lock: every secret smokes over until Touch ID.
9. A known meeting app sharing the screen: everything smokes, with a small "private" etching.
10. No sounds at all while the microphone or camera is in use.
11. The archive drawer shows a dust pile that grows with its contents.
12. The first drop ever gets a one-time longer droplet with a sparkle.

## 5. First feasibility guesses (superseded by 02_RESEARCH.md)

| Idea | Guess |
|---|---|
| Notch geometry | Available from the system |
| Pressure-to-reveal | Available inside Bimax's own window |
| Weighted trackpad haptics | Only a few built-in patterns |
| Slowing the cursor near the notch | Not available to apps; enlarge the hover zone instead |
| Ambient light sensor | No public API; use appearance and time of day |
| Seeing a web page's upload field | Needs Accessibility (Computer Use) — phase 2 |
| Scanning every .env | Risky; limit to folders opened in Bimax, keep secrets in Keychain |
| Detecting any screen share | No reliable general signal; known meeting apps plus a manual toggle |

## 6. First build order (superseded by 03_PLAN.md)

1. The shelf: hover to open, drop to stash, drag out, Quick Look.
2. Drop → ⌘2 with the file attached, and the Droplet (with its Reduce Motion fade).
3. Task glass states: Water, Molten, Frost, Prism, Fissure, Ink.
4. Smart Clipboard and Ghost Paste.
5. Secrets: Smoke, pressure reveal, Evaporation.
6. With Computer Use: upload-field prediction, drop into any app.
