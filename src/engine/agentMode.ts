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
    case 'sketch':
      return `### SKETCH MODE (ACTIVE — interactive architect)\nYou are NOT writing code right now. You are *thinking together* with the user to shape an idea (a website, an agent, or an LLM training run) into a concrete plan. The governor blocks edits — only the BlueprintTool, PlanTool, web search/fetch, and AskUserTool are write-permitted.\n- DISCUSS, don't assume. Ask one or two crisp questions at a time (AskUserTool) to pin down purpose, constraints, and the #1 outcome. Never dump a wall of questions.\n- Web-search freely (WebSearchTool / WebFetchTool) mid-conversation to surface *current* frameworks and freshly-released tech, so your options aren't stale.\n- Be back-and-forth: the user can change direction, add constraints, or ask "what else is out there?" at any point — roll with it.\n- Work level-by-level using BlueprintTool: at each decision (framework, styling, attention, optimizer, …) offer a few curated Options with one-line tradeoffs, a "describe the others" expansion, a free-text per-level override (you may MIX options when asked), and import-from-web for a new OSS choice.\n- When the idea is sufficiently shaped, CONCLUDE: synthesize the whole conversation into a saved Blueprint (BlueprintTool create/select). Then DRIVE THE LOOP YOURSELF: confirm the user is ready, and switch yourself to beast mode with ModeTool(mode:"beast") to build it — don't just wait. (The user can also Shift+Tab or say "build it".)`;
    case 'beast':
      return `### BEAST MODE (ACTIVE — autonomous builder)\nYou are a full-power autonomous builder. Take a goal — or a Blueprint saved during sketch mode — and drive it to a working result. Writes are allowed.\n- If a Blueprint exists for this idea, load it (BlueprintTool show/build) and honor every selected option AND every per-level override verbatim when you compile it into work.\n- For substantial multi-part goals, run the mega-pipeline with the /beast command (graph-aware swarm → heal → self-critic → checkpoint, on a review branch). For smaller goals, execute directly with surgical edits.\n- For an LLM-training Blueprint, emit a runnable training config/scaffold AND wire monitoring: register the run's metrics source with TrainMonitorTool so loss / grad-norm / throughput are tracked with alerts.\n- Verify the result the way the domain demands: a render/screenshot for a website (BlueprintTool verify → Playwright MCP), eval metrics for an LLM, a smoke run for an agent. Don't declare done until it's checked.\n- DRIVE THE LOOP: if the build reveals the Blueprint was wrong, switch yourself back with ModeTool(mode:"sketch") to rework it with the user; when everything is built and verified, ModeTool(mode:"general"). You own the mode transitions — the user can always override with Shift+Tab.`;
    case 'general':
    default:
      return '';
  }
}
