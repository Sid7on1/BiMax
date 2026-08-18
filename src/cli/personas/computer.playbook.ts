/**
 * Operational guidance for driving the desktop — injected only on turns that actually ask for it.
 *
 * This text used to live inside ComputerTool's schema description, which meant every request paid
 * for it. Measured: the tool's schema was 3,461 tokens of the ~12,000 spent on tool schemas per
 * turn, and ~19,150 tokens were sent to answer "say ok". None of this is needed to CHOOSE the tool
 * — only to use it well once chosen — so it moved behind the gate the persona already had
 * (`explicitlyRequiresComputerUse`).
 *
 * The split rule: the schema carries what the model needs to pick the tool and call it correctly
 * (the loop contract, handle precedence, frameId). Everything scenario-specific lives here.
 *
 * SECOND SPLIT (relevance): the scenario sections were then injected ALL AT ONCE on every desktop
 * turn, which is how a non-messaging task ended in a refusal written in messaging vocabulary — the
 * model read MESSAGE COMPOSERS as a precondition, found no composer, and concluded the task was
 * impossible. Guidance for a situation that is not happening is not free: it is
 * an invitation to pattern-match the task onto the wrong scenario. So scenario sections now ship
 * only when the request implicates them, while the universal ones always ship.
 */

interface PlaybookSection {
  title: string;
  body: string;
  /** Present = scenario section, included only when the request matches. Absent = universal. */
  when?: RegExp;
}

// The authority line is universal because the refusal it prevents is universal. This playbook is
// built only when the caller already resolved a computer tool for an explicitly computer-use
// request, so by the time a model reads it the user has asked for this on their own machine.
// Without that stated, a safety-tuned controller reads "message my mom" or "play a song" as
// someone else's data: measured 2026-08-18, a controller opened Messages successfully and then
// answered with a privacy apology, and answered a music request with a list of manual steps.
const HEADER = `[Desktop operation playbook — this task involves the user's computer.]
- The user asked for this on their own machine and the caller already cleared this turn. Carrying the task out is what this tool is for, not a privacy, consent, or safety problem: never refuse on those grounds, and never answer with manual step-by-step instructions instead of acting.
- Stop early only for a concrete runtime blocker proven by the newest result, and name that blocker.`;

// Universal sections describe the tool's own mechanics (target lock, evidence, how typing and
// capture work) and are true of every desktop turn. Scenario sections describe a SITUATION; each
// carries the matcher that decides whether this request is in that situation.
const SECTIONS: PlaybookSection[] = [
  {
    // Universal despite being about "multiple" apps: the focus-vs-open rule prevents launching a
    // second instance of an app that is ALREADY open, which applies to single-app tasks too.
    title: 'MULTIPLE APPS',
    body: `open launches an app, registers it, and makes it active. Every app opened this session STAYS registered, but only the active one receives input, because coordinates and element handles are grounded in the active app's newest frame. To switch between apps already open, use focus (app or pid) — it activates the app and returns a fresh frame, without the re-launch that open would cause. Re-opening a running app risks a second instance and discards its current state, so reach for focus whenever the app is already open. A cross-app task is therefore: open A → work → open/focus B → work → focus A → continue. Naming a non-active app on an acting verb is refused and the error tells you which verb to use.`,
  },
  {
    title: 'TARGET LOCK',
    body: `The PiP preview, newest screenshot/frameId, active surface, and physical mouse/keyboard target must always name the same pid+windowId. During focus/open the old PiP is intentionally hidden before the new target is released for input. If any result reports a target-lock or preview mismatch, do not compensate with coordinates: focus or observe the intended app again and use only that returned frame.`,
  },
  {
    title: 'WINDOW PREPARATION',
    body: `Prepare the surface when precision requires it; do not wait for the user to dictate window geometry. If the screenshot is cramped, important controls are clipped, or several icon-only targets are too close to distinguish, first use arrange layout=maximize and inspect the returned resized frame. Use layout=fullscreen when the task benefits from an isolated Space or the user asks for fullscreen; prefer maximize for cross-app work because fullscreen hides the other windows. This rule is geometric and universal, not app-specific.`,
  },
  {
    title: 'THE DESKTOP',
    when: /\b(desktop|wallpaper|stacks?|icons?\s+on\s+(?:the\s+)?screen|file\s+it\s+into)\b/i,
    body: `The desktop is not an app window — it has no window id and window-scoped observation cannot see it. Use desktop: with no arguments it lists every item on it by name with its on-screen rectangle. To move one, pass query="<item name>" plus either toQuery="<name of a folder on the desktop>" to file it into that folder, or toX/toY screen points to reposition it. The move is verified by re-reading the desktop: an item that filed away disappears, a repositioned one has a new rectangle, and one that did not move at all is reported as a failure (usually the desktop is using Stacks or Sort By, which snaps items back).`,
  },
  {
    title: 'ARRANGING WINDOWS',
    when: /\b(arrange|resiz|maximi[sz]|minimi[sz]|full ?screen|side by side|tile|split|window (?:size|position)|move the window|left half|right half|quadrant|centre|center the)\b/i,
    body: `arrange places the ACTIVE window: layout=left/right/top/bottom or a quadrant tiles it within the screen's usable area (below the menu bar, clear of the Dock), maximize fills that area, center restores a floating size, and bounds sets an exact rectangle. layout=fullscreen is the native macOS fullscreen Space, which is NOT the same as maximize — only fullscreen windows can be switched between with the Space shortcuts. To put two apps side by side: focus A → arrange left → focus B → arrange right. Apps enforce their own minimum sizes and size increments, so the result reports the ACHIEVED frame; when it differs from what was asked, the window is placed but may still overlap its neighbour — read windowFrame rather than assuming the request was honored. Fullscreen is only accepted for the frontmost app, and panels/utility windows cannot go fullscreen at all.`,
  },
  {
    title: 'DRAGGING BETWEEN APPS',
    when: /\b(drag|drop|move .*\b(?:into|onto|to)\b .*\b(?:app|window|folder)|reorder)\b/i,
    body: `drag with toApp drops into another open app: the source point is read in the active window, the destination in toApp's window. Both windows must be visible SIMULTANEOUSLY, so arrange them first (focus A → arrange left, focus B → arrange right) — if the source window covers the drop point the drag is refused rather than dropped back onto the source. After the drop, toApp becomes the active target and its frame is attached. Delivery is not acceptance: an app silently ignores content types it does not handle, so confirm from the frame that the content actually arrived. For files specifically, the clipboard route (clipboard paths=[…] then paste) is more reliable than dragging and needs no window arrangement.`,
  },
  {
    title: 'SPACES (fullscreen apps and extra desktops)',
    when: /\b(space|spaces|mission control|expos[eé]|another desktop|virtual desktop|full ?screen)\b/i,
    body: `Ctrl+Left / Ctrl+Right / Ctrl+1..9 are handled by macOS itself, not by the focused app: they change which Space — and therefore which windows — exist on screen. Send them with key. Afterwards the app you were working on may be on a Space that is no longer visible, so the runtime re-checks what is actually in front: if that app is already open in this session it becomes the active target and you get a fresh frame of it; otherwise there is NO active target and you must open or focus something before acting. Only fullscreen windows and additional desktops are switchable, so arrange layout=fullscreen first if you want an app to have its own Space. Ctrl+Up (Mission Control) and Ctrl+Down (App Exposé) cover the screen with an overlay — nothing is capturable until you press escape.`,
  },
  {
    title: 'MOVING CONTENT BETWEEN APPS',
    when: /\b(copy|paste|clipboard|attach|upload|import|export|transfer|move .*\btext\b|send .*\b(?:file|photo|image|document)\b)\b/i,
    body: `The clipboard is the OS bridge and works the same for every application. copy presses the copy shortcut on the active app and VERIFIES it: the OS write counter must advance, so "nothing was selected" is reported as a failure instead of a silent no-op — select the content first, then copy. paste presses paste on the active app and checks the fresh frame for the pasted text. clipboard reads the clipboard, or writes it: value=text, or paths=[absolute file paths] to place the FILES themselves on it, which is how you hand an app a photo or document — a path written as text would only paste the filename. So moving text app-to-app is: focus source → select → copy → focus destination → click the field → paste. Sending a file is: clipboard paths=[…] → focus destination → click the field → paste (or use the app's own attach control and file picker when it does not accept a paste).`,
  },
  {
    title: 'TEXT ENTRY',
    body: `When an editable search, address, filename, message, comment, or document field is visible, use type with query="<field label>" and the text. That operation resolves, focuses, verifies, and types into the field atomically. Do not first click a nearby icon, menu, privacy card, attachment button, emoji button, or guessed element index just to establish focus. If the named field is absent, observe or maximize to acquire it; do not substitute the nearest control. Typing a newline character does NOT press Return or submit a search/form. Submit as a separate key action with combo="return", then inspect the returned frame. Text merely visible inside a search/address field is not a loaded results page and must not complete a search Todo item.`,
  },
  {
    title: 'MESSAGE COMPOSERS',
    when: /\b(message|messages|chat|reply|repl(?:y|ies)|comment|compose|composer|send|dm|post|thread|conversation|note to)\b/i,
    body: `Any surface with a composer and a transcript above it (chat, mail, comments, notes with an entry field) works the same way: open the app → PROVE the requested recipient from a visible/native contact label or exact search result → select that conversation or record → type the user's EXACT requested content with query="<composer label>" so the runtime atomically focuses and proves the editable field → COMMIT. Never assume the currently selected conversation is the requested person: an unnamed phone number, unrelated name, or old transcript is not recipient proof. If the exact recipient is not visible, type the requested recipient into the app's Search field and select only an exact matching result; ask the user if the results remain ambiguous. Commit with key combo "return" in the composer; commit buttons are frequently unlabeled icons that a raw click misses. Selecting the conversation is NOT committing. Pre-existing transcript content is context only and can never prove a send in this turn; never set expect to text already visible before the action. Success is proven ONLY by a post-commit frame showing the newly entered exact content in the proven recipient's transcript AND the composer cleared — different old content, text still in the composer, or nothing new in the transcript means it was not sent; do not report success.`,
  },
  {
    title: 'UNLABELED AND ICON-ONLY CONTROLS',
    body: `An entry such as "unlabeled Button right of Type a message #4" is an honest positional identity synthesized from the fresh accessibility geometry, not a semantic name supplied by the app. Match it against the screenshot and use its elementIndex/token so the runtime clicks its center. Never infer that an unlabeled icon is Send, Attach, More, or Back merely from convention. If two candidates remain plausible: maximize and re-observe; use one hover to reveal a tooltip when appropriate; then choose only if the newest frame distinguishes it. Do not issue exploratory clicks—an unproven click is not discovery.`,
  },
  {
    title: 'CAPTURE SCOPE',
    body: `Ordinary observe/screenshot evidence and record_start with captureScope=window use the particular owned app window whenever one exists, which avoids leaking unrelated windows and keeps coordinates exact. Use record_start captureScope=display only when the requested recording must match the whole screen a human sees, including overlapping windows; whole-display video requires explicit approval. OS-owned overlays that cannot appear in a window capture may also produce display context. PiP is presentation only and is never a coordinate surface.`,
  },
  {
    title: 'EVIDENCE',
    body: `Success requires visible or semantic postcondition evidence, not driver delivery, and the evidence must match the value type the user asked for. Read actionReceipt on physical input: its preflight proves the live window/element or editable focus before commit, and its postcondition records what was actually observed. When the intended next state has native text, attach expect="text" to the acting call; use expectMode=absent when disappearance proves success. This combines action and verification in one round and returns confidence=proven only when the postcondition actually matches. For sliders use set_value with a fresh query/element handle: maximum/full/100% = 1, minimum/mute/0% = 0 — never click or drag a slider to approximate an exact value. A right-click returns a full-display frame because the menu is its own OS window, and old window handles are invalid until the next observe. Dialogs and popovers block the controls behind them. Finish the whole workflow, including cleanup, before replying.`,
  },
];

const render = (sections: PlaybookSection[]): string =>
  [HEADER, ...sections.map(s => `${s.title}\n${s.body}`)].join('\n\n');

/**
 * The complete corpus — every section, universal and scenario alike. This is the knowledge base;
 * it is what guarantees nothing was DROPPED when guidance moved out of the tool schema. Prefer
 * {@link computerUsePlaybookFor} for anything that actually goes on the wire.
 */
export const COMPUTER_USE_PLAYBOOK = render(SECTIONS);

/** Scenario section titles, for tests and diagnostics. */
export const SCENARIO_SECTION_TITLES = SECTIONS.filter(s => s.when).map(s => s.title);

/**
 * The playbook this specific request should actually receive: every universal section, plus only
 * the scenario sections the request implicates.
 *
 * Matching is deliberately generous — a scenario section that is present but unused costs tokens,
 * while one that is missing costs a capability. When in doubt the matcher should fire.
 */
export function computerUsePlaybookFor(prompt: string): string {
  const text = String(prompt || '');
  return render(SECTIONS.filter(s => !s.when || s.when.test(text)));
}

/**
 * Small GUI models lose the task inside the full operating manual. This deliberately compact
 * variant follows the same pattern as MacOS-Use's flash prompt: a short observe → one action →
 * verify loop, with only the high-value action choices spelled out. It does not weaken evidence or
 * safety rules; it removes background material that is useful to large planners but distracting to
 * a 11–14B controller.
 */
export const COMPUTER_USE_FLASH_PLAYBOOK = `[Compact desktop playbook]

- The user asked for this on their own machine and the caller already cleared this turn. Doing it is the job, not a privacy or safety problem: never refuse on those grounds.
- Use ComputerTool. Never replace the requested action with manual instructions, and never tell the user to perform the task themselves.
- Open the app with the exact app name the user gave. Do not invent a bundleId. The open result is already a fresh observation.
- Act only on controls present in the newest result. Use exactly one selector: elementToken, query, or elementIndex. Never guess coordinates when a semantic selector exists.
- Make one ComputerTool call per step, then read its returned state before deciding the next step.
- Text field replacement: use set_value with the exact text and one fresh field selector. Use type only when appending is intended.
- Checkbox or radio: if its fresh value is already 1/true, stop. Otherwise click it exactly once. Never click a selected toggle again.
- Pop-up/select: use set_value with the exact requested choice and one fresh selector. The runtime completes any required native menu gesture without another model round.
- Finish only when the newest tool result shows every requested value. Driver delivery or your own claim is not proof.
- If an action fails, change strategy from the new state. Do not repeat an identical failed call.`;

/** Models measured to benefit from the compact controller prompt. Explicit env choice wins. */
export function shouldUseFlashComputerPlaybook(model: string): boolean {
  const override = String(process.env.BIMAX_COMPUTER_PROMPT || '').trim().toLowerCase();
  if (override === 'flash') return true;
  if (override === 'full') return false;
  const id = String(model || '').toLowerCase();
  // Live Desktop probe (2026-08-13): this 30B NIM controller opened Calculator correctly, then
  // lost the task inside the full operating manual and narrated prospective mac_control JSON for
  // more than a minute instead of issuing the next call. It is fast and tool-capable, so keep it
  // available, but give it the compact one-action/fresh-frame contract used by smaller GUI
  // controllers. This is model-specific rather than a blanket 30B cutoff: larger measured
  // planners still benefit from the full scenario guidance.
  if (id === 'nvidia/nemotron-3-nano-30b-a3b') return true;
  const size = id.match(/(?:^|[-_/])(\d+(?:\.\d+)?)b(?:[-_/]|$)/)?.[1];
  return size !== undefined && Number(size) <= 14;
}

/**
 * Single owner for the model-facing desktop task text. Production and the live benchmark both use
 * this helper so the benchmark cannot silently drift back to a stripped-down prompt route.
 */
export function buildComputerUseModelPrompt(
  prompt: string,
  options: { native?: boolean; model?: string; toolName?: string } = {},
): string {
  const rawPlaybook = shouldUseFlashComputerPlaybook(options.model || '')
    ? COMPUTER_USE_FLASH_PLAYBOOK
    : computerUsePlaybookFor(prompt);
  // Name the tool the model ACTUALLY has. The playbook is written against the generic
  // "ComputerTool", but Desktop exposes the app-owned tool as `mac_control` (or its MCP-qualified
  // name). Instructing a model to use a tool that is not in its tool list is what produced narrated
  // tool JSON instead of a real call, so substitute the resolved name when the caller supplies one.
  const playbook = options.toolName
    ? rawPlaybook.replace(/ComputerTool/g, options.toolName)
    : rawPlaybook;
  const evidence = options.native
    ? '[Fresh computer-use constraint: Complete this turn only from native snapshots, receipts, and captures produced after this request. Prior shell, browser, assistant, memory, and tool values are not evidence. Re-observe after mutation; otherwise report that verification failed.]'
    : `[Fresh computer-use constraint: Complete this turn only from ${options.toolName || 'ComputerTool'} results produced after this request. Prior shell, browser, assistant, memory, and tool values are not evidence. Continue until the newest result proves every requested value; otherwise report the concrete runtime blocker.]`;
  return `${prompt}\n\n${playbook}\n\n${evidence}`;
}
