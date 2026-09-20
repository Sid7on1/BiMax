/**
 * Behavioral agent modes (UPGRADE-PLAN 5.2) — a session-scoped specialization layer that sits
 * ABOVE the brand persona (Hermes/OpenCode/…) and BELOW the governor's permission mode.
 *
 *   - explore : read-only reconnaissance. Map the territory with Graph/Search/Read tools, never
 *               write. Enforced by flipping the governor into 'plan' mode (the proven write-gate),
 *               so this needs no separate enforcement path.
 *   - code    : execution focus. Minimal redundant reads, surgical targeted edits, verify after.
 *   - general : the default. No extra guidance — the persona's normal behaviour applies.
 *
 * The mode only shapes the system prompt (a guidance section in the dynamic suffix) plus, for
 * explore, the governor mode. It is intentionally NOT persisted: like plan mode, it resets each
 * session so a forgotten `explore` can't silently block writes in a later run.
 */
export type AgentMode = 'explore' | 'code' | 'general' | 'sketch' | 'beast';

/**
 * The order Shift+Tab cycles through in the TUI. A workflow arc: orient (explore) → discuss/architect
 * (sketch) → execute (code) → autonomous build (beast) → back to the neutral default (general).
 * The Go TUI mirrors this list; keep them in sync.
 */
export const MODE_ORDER: AgentMode[] = ['general', 'explore', 'sketch', 'code', 'beast'];

/** The next mode in the Shift+Tab cycle after `mode`. */
export function nextMode(mode: AgentMode = _mode): AgentMode {
  const i = MODE_ORDER.indexOf(mode);
  return MODE_ORDER[(i + 1) % MODE_ORDER.length];
}

let _mode: AgentMode = 'general';
// True only when entering explore mode actually flipped the governor into 'plan' (i.e. it wasn't
// already in plan mode from an independent `/plan on`). Leaving explore restores write permissions
// ONLY when this is set, so `/mode code|general` can never silently cancel a user's own `/plan`.
let _exploreEngagedGate = false;

export function getAgentMode(): AgentMode {
  return _mode;
}

export function setAgentMode(mode: AgentMode): void {
  _mode = mode;
}

export function setExploreEngagedGate(engaged: boolean): void {
  _exploreEngagedGate = engaged;
}

export function didExploreEngageGate(): boolean {
  return _exploreEngagedGate;
}

/**
 * The system-prompt guidance for the active mode, or '' for general (no specialization).
 * Injected into the persona's dynamic suffix so it participates in per-turn context, not the
 * cached static prefix.
 */
export function agentModePromptSection(mode: AgentMode = _mode): string {
  switch (mode) {
    case 'explore':
      return `### EXPLORE MODE (ACTIVE)\nYou are a read-only reconnaissance agent. Your job is to MAP the territory, not change it — the governor will reject every mutating action.\n- Build a mental model with GraphQueryTool / GraphContextTool, GrepTool, GlobTool, and targeted ReadFileTool. Prefer symbol-precise graph queries over reading whole files.\n- Investigate breadth-first: layout, entry points, how the key pieces connect, where the relevant logic lives.\n- Do NOT write, edit, delete, or run mutating shell commands. Report findings as structure + file:line references, and surface open questions.`;
    case 'code':
      return `### CODE MODE (ACTIVE)\nYou are an execution-focused agent. Assume orientation is largely done — bias toward making the change, not re-investigating.\n- Minimize redundant reads: read only what you must immediately before each edit, and reuse context you already have instead of re-reading.\n- Make small, surgical edits with EditFileTool rather than rewriting whole files.\n- After changing code, verify: run the project's build / typecheck / tests before declaring success.`;
    // Sketch and beast were written around BlueprintTool, the /beast mega-pipeline and
    // TrainMonitorTool. All three were retired on 2026-09-19 (docs/product-reset/58), so both
    // prompts were naming tools and a command that no longer exist — the single worst thing a
    // system prompt can do to a weak model, which will call them and then flail on the refusal
    // (bimax-nameless-tool-call-json). Rewritten to the surface that actually ships. The MODES
    // themselves are unchanged: they are protocol values the desktop offers as "Plan first" and
    // "Parallel team", and their gates in applyMode.ts are independent of any of that.
    case 'sketch':
      return `### SKETCH MODE (ACTIVE — plan first)\nYou are NOT writing code right now. You are *thinking together* with the user to shape an idea into a concrete plan. The governor blocks edits — PlanTool, web search/fetch, and AskUserTool are the write-permitted tools.\n- DISCUSS, don't assume. Ask one or two crisp questions at a time (AskUserTool) to pin down purpose, constraints, and the #1 outcome. Never dump a wall of questions.\n- Read before you propose: GraphQueryTool / GraphContextTool, GrepTool and targeted ReadFileTool, so the plan fits the code that exists rather than the code you imagine.\n- Web-search freely (WebSearchTool / WebFetchTool) mid-conversation to surface *current* libraries and freshly-released tech, so your options aren't stale.\n- Be back-and-forth: the user can change direction, add constraints, or ask "what else is out there?" at any point — roll with it.\n- Offer real choices. At each decision give a few options with one-line tradeoffs and a recommendation, not a survey.\n- When the idea is shaped, CONCLUDE: write the plan down with PlanTool, including how the result will be VERIFIED. Then confirm the user is ready and switch yourself to code or beast mode with ModeTool to build it — don't just wait. (The user can also Shift+Tab.)`;
    case 'beast':
      return `### BEAST MODE (ACTIVE — autonomous builder)\nYou are a full-power autonomous builder. Take a goal — or a plan saved during sketch mode — and drive it to a verified result. Writes are allowed.\n- If a plan exists for this work, load it and honour it verbatim; where you must depart from it, say so and why.\n- For substantial multi-part goals, fan out with SpawnTool: independent parts in parallel sub-agents, dependent parts in sequence. Capacity is bounded machine-wide, so a refusal means wait or do it yourself, never retry in a loop.\n- Checkpoint before large or risky edits so the work is recoverable, and prefer surgical EditFileTool / SymbolEditTool changes over rewriting files.\n- VERIFY the way the domain demands — build, typecheck, the project's tests, RelatedTestsTool for the files you touched. Don't declare done until something objective has passed, and report what actually ran.\n- DRIVE THE LOOP: if the build reveals the plan was wrong, switch back with ModeTool(mode:"sketch") to rework it with the user; when everything is built and verified, ModeTool(mode:"general"). You own the mode transitions — the user can always override with Shift+Tab.`;
    case 'general':
    default:
      return '';
  }
}
