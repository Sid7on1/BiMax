// BiMax UI protocol — the wire contract between the engine (Node) and the out-of-process
// front-end (the Go / Bubble Tea TUI in tui/). It exists so the engine's UI seam — the
// `cliEvents` emitter (src/cli/events.ts) + the GlobalPrompter approval round-trip — can be
// driven over a pipe instead of in-process, WITHOUT touching engine logic. This is the sole
// interactive path; it activates in headless mode, which the TUI always spawns.
//
// Transport is newline-delimited JSON (NDJSON): one JSON object per line, both directions. See
// codec.ts for framing and host.ts for the engine-side endpoint.

// v2 (2026-07-10): ui_snapshot gains optional sessions / checkpoints / git fields (all additive —
// a v1 front-end ignores them; a v2 front-end hides the matching UI when they're absent).
// v3 (2026-07-11): silent config round-trip — configGet/configSet inbound + configResult outbound,
// so graphical front-ends drive settings pages without printing menus into the transcript.
// v3 additive (2026-07-12): `boot` + `health` outbound (startup progress + liveness heartbeat for
// the desktop supervisor) and `resume` inbound (typed session-resume, so front-ends never have to
// synthesize a slash command). All additive — a front-end that doesn't know them ignores them, an
// engine that predates `resume` drops it — so the version stays 3.
// v3 additive (2026-08-10): `catalogGet` / `providerSet` inbound + `catalogResult` outbound — the
// model and provider catalogue, so a graphical front-end can offer a real picker (which provider,
// which key, which of the ids that provider ACTUALLY serves) instead of a free-text model field.
// Additive, so the major stays 3 and the `catalog` feature flag gates it.
export const PROTOCOL_VERSION = 3;
/** Semantic wire release. Major compatibility remains available to v2 clients. */
export const PROTOCOL_SEMVER = '3.2.0';
export const PROTOCOL_MIN_COMPATIBLE_MAJOR = 2;
export const PROTOCOL_MAX_COMPATIBLE_MAJOR = 3;

/** Negotiated features. Clients must hide/degrade features that are not advertised. */
export const PROTOCOL_FEATURES = [
  'approvals',
  'boot',
  'catalog',
  'config',
  'controls',
  'health',
  'interrupt',
  'resume',
  'review-snapshot',
  'outcome-snapshot',
] as const;

// A JSON-safe value. The codec guarantees only these cross the wire (sanitizeArgs strips the rest).
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

// --- Outbound: engine → front-end ----------------------------------------------------------

/** A forwarded `cliEvents` emit. `name` is the event, `args` its (sanitized) payload. */
export interface EventMsg {
  t: 'event';
  name: string;
  args: JsonValue[];
}

/**
 * An approval / ask-user request that needs an answer before the engine can continue. This is
 * the GlobalPrompter `veto_prompt` round-trip: its in-process `resolve` callback can't cross a
 * pipe, so it becomes a request `id` the front-end answers with a matching `reply`.
 */
export interface RequestMsg {
  t: 'request';
  id: number;
  kind: 'prompt' | 'diff' | 'input'; // option-select | diff-approval | free-form text
  question: string;
  options: string[];
  isAsk?: boolean; // true for the AskUser tool (free-form) vs a governor yes/no/always veto
  isMulti?: boolean; // true for multi-select checklists
  body?: string; // for kind:'diff', the unified diff to render before the choices
  masked?: boolean; // for kind:'input': the answer is a secret — render it as bullets, never echo
}

/** Handshake — sent once when the host attaches, so the front-end can version-check. */
export interface ReadyMsg {
  t: 'ready';
  protocol: number;
}

/**
 * Rich, additive handshake sent immediately before `ready`.
 *
 * Older v2/v3 clients ignore this unknown message and continue on `ready`; current clients use it
 * to negotiate an overlapping major range and feature vocabulary before enabling optional UI.
 */
export interface HelloMsg {
  t: 'hello';
  engine: { version: string; buildCommit: string };
  protocolVersion: string;
  protocolMajor: number;
  minCompatibleMajor: number;
  maxCompatibleMajor: number;
  features: string[];
}

/** A single autocomplete candidate (slash command, @symbol, or @path). */
export interface CompletionItem {
  value: string; // the text to insert (e.g. "/git", "@handlePayment", "@./src/")
  label: string; // display label
  desc: string; // short description / category
  kind: 'command' | 'symbol' | 'path';
  disabled?: boolean;
  disabledReason?: string;
}

/** Completions for a {@link QueryMsg}, correlated by `id` so stale results can be dropped. */
export interface QueryResultMsg {
  t: 'queryResult';
  id: number;
  items: CompletionItem[];
}

/** Liveness answer to a {@link PingMsg} — echoes `id` so the front-end can match it. */
export interface PongMsg {
  t: 'pong';
  id: number;
}

/**
 * The engine's settings, answering a {@link ConfigGetMsg} or {@link ConfigSetMsg} — only the
 * allowlisted, JSON-safe subset of CliConfig crosses the wire (headless.entry owns the list).
 */
export interface ConfigResultMsg {
  t: 'configResult';
  id: number;
  config: { [k: string]: JsonValue };
}

/**
 * Startup progress. Emitted on stdout BEFORE the protocol host attaches (boot.status.ts writes it
 * directly), so a supervising front-end can show real phases instead of an indefinite spinner.
 * Phases arrive in order; `ready` (the handshake) supersedes them all.
 */
export interface BootMsg {
  t: 'boot';
  phase: 'booting' | 'loading_storage' | 'loading_graph' | 'loading_tools' | 'loading_interface' | 'restoring_session';
  detail?: string;
  pid: number;
}

/**
 * Periodic liveness heartbeat, emitted every few seconds once the engine is interactive. A stalled
 * stream of these means the event loop is wedged (or the process is gone) — the supervising
 * front-end distinguishes that from legitimate long work via `activeTurn`.
 */
export interface HealthMsg {
  t: 'health';
  uptimeMs: number;
  rssMb: number;
  heapMb: number;
  eventLoopDelayMs: number; // p99 event-loop delay since the last heartbeat
  activeTurn: boolean; // a user turn is executing (long work is expected)
  phase: 'ready';
}

/**
 * One provider the engine can talk to.
 *
 * `hasKey` is the only thing said about credentials — a key never crosses the wire, in either
 * direction, and `keyHint` is a display tail (last 4 characters) so a user can tell two saved keys
 * apart without the value being recoverable.
 */
export interface ProviderEntry {
  name: string;
  label: string;
  baseURL: string;
  /** The environment variable this provider's key is read from (shown as setup guidance). */
  apiKeyEnv: string;
  hasKey: boolean;
  keyHint?: string;
  /** Number of keys in the rotation for this provider. */
  keyCount: number;
  /** True for the provider the engine is currently using. */
  active: boolean;
}

/**
 * One model the front-end may offer for a slot.
 *
 * `served` is the distinction that matters and the reason this crosses the wire at all: catalogue
 * membership is a curated recommendation, while `served` reports whether the ACTIVE provider's
 * `/models` endpoint actually lists the id right now. A picker that hides unserved models makes a
 * stale pin undiagnosable — the user's configured model simply vanishes from the list — so both
 * are sent and the front-end shows the gap.
 *
 * `avoidAutoSelect` mirrors the catalogue's own bar on choosing this model automatically; the
 * reason is in `desc`. The user may still pick it deliberately.
 */
export interface CatalogModelEntry {
  id: string;
  label: string;
  desc: string;
  /** 'coding' = Work, 'lite' = Quick, 'vision' = Vision, 'other' = needs its own key. */
  tier: 'coding' | 'vision' | 'lite' | 'other';
  /** Curated slot recommendations. A model may appear in more than one slot. */
  recommendedFor?: Array<'coding' | 'vision' | 'lite'>;
  tags?: string[];
  parameters?: string;
  /** ISO release date from a curated first-party model card. */
  releaseDate?: string;
  served: boolean;
  curated: boolean;
  avoidAutoSelect?: boolean;
  /** Resolved model capabilities, so the UI can disable knobs a model does not have. */
  capabilities?: {
    visionInput: boolean;
    reasoningEffortKnob: boolean;
    thinking: boolean;
    structuredOutputs: boolean;
    parallelToolCalls: boolean;
    contextWindow: number;
  };
}

/**
 * The provider + model catalogue, answering a {@link CatalogGetMsg} or {@link ProviderSetMsg}.
 * `error` is set when the live model list could not be fetched (offline, bad key, no `/models`
 * endpoint); `models` then carries the curated catalogue with `served` false throughout, which the
 * front-end must present as "unverified", never as "unavailable".
 */
export interface CatalogResultMsg {
  t: 'catalogResult';
  id: number;
  providers: ProviderEntry[];
  models: CatalogModelEntry[];
  error?: string;
}

export type Outbound =
  | EventMsg
  | RequestMsg
  | ReadyMsg
  | HelloMsg
  | QueryResultMsg
  | PongMsg
  | ConfigResultMsg
  | CatalogResultMsg
  | BootMsg
  | HealthMsg;

// --- Inbound: front-end → engine -----------------------------------------------------------

/** The answer to a {@link RequestMsg}, correlated by `id`. */
export interface ReplyMsg {
  t: 'reply';
  id: number;
  value: string;
}

/** A submitted prompt line — a user turn OR a slash command (engine decides, as handleSubmit does). */
export interface InputMsg {
  t: 'input';
  text: string;
}

/** Cancel the in-flight turn (Ctrl-C / Esc in the front-end). */
export interface InterruptMsg {
  t: 'interrupt';
}

/** Ask the engine for autocomplete candidates for the current input `text`. */
export interface QueryMsg {
  t: 'query';
  id: number;
  text: string;
}

/**
 * The user picked an option in an interactive menu. `id` correlates to the menu the engine emitted;
 * `value` is the chosen option's value. The engine runs that menu's `onSelect` (which can't cross the
 * wire as a callback) — falling back to dispatching `value` as a command for menus that have none.
 */
export interface MenuSelectMsg {
  t: 'menuSelect';
  id: string;
  value: string;
}

/**
 * Liveness probe from the front-end. Answered immediately with a {@link PongMsg} — if the answer
 * doesn't come back, the engine's event loop is wedged (or the process is a zombie) and the
 * front-end can tell the user instead of showing a spinner forever.
 */
export interface PingMsg {
  t: 'ping';
  id: number;
}

/** Read the engine's settings (allowlisted subset) — answered with a {@link ConfigResultMsg}. */
export interface ConfigGetMsg {
  t: 'configGet';
  id: number;
}

/**
 * Write settings: `patch` merges into the engine config (allowlisted keys only; unknown keys are
 * dropped, never errors). Answered with the post-write {@link ConfigResultMsg} and followed by a
 * `config_changed` event so every attached front-end (and ui_snapshot) refreshes.
 */
export interface ConfigSetMsg {
  t: 'configSet';
  id: number;
  patch: { [k: string]: JsonValue };
}

/**
 * Resume a saved session by id — the typed equivalent of the user running /resume. Lets a
 * graphical front-end's recovery flow restore a thread without synthesizing slash-command text.
 * Ignored (never an error) when the id doesn't resolve to a saved session.
 */
export interface ResumeMsg {
  t: 'resume';
  id: string;
}

/**
 * Atomically apply shell controls. A graphical front-end must not synthesize several independent
 * slash-command messages for one autonomy preset: those dispatch concurrently and can leave the
 * governor, plan mode, and diff gate disagreeing. The headless session serializes this one request.
 */
export interface ControlsMsg {
  t: 'controls';
  mode?: 'general' | 'explore' | 'sketch' | 'code' | 'beast';
  tier?: 'auto' | 'lite' | 'heavy';
  autonomy?: 'ask' | 'auto' | 'plan' | 'full';
}

/**
 * Read the provider + model catalogue — answered with a {@link CatalogResultMsg}.
 *
 * `refresh` re-fetches the active provider's live `/models` list instead of answering from the
 * session cache. Costs a request, so the front-end should only set it on an explicit user action
 * (opening the picker, pressing refresh, after saving a key).
 */
export interface CatalogGetMsg {
  t: 'catalogGet';
  id: number;
  refresh?: boolean;
}

/**
 * Switch the active provider, optionally saving a key for it first.
 *
 * `apiKey` is write-only and one-way: it is stored in the engine's secrets file (never in
 * config.json, never echoed back) and applied to the live key rotation, so a key added here takes
 * effect without a restart. Answered with a {@link CatalogResultMsg} for the newly active
 * provider — which is how the front-end confirms the key works: the model list either populates or
 * comes back with `error`.
 *
 * `baseURL` registers/overrides an OpenAI-compatible endpoint, covering local models and proxies.
 */
export interface ProviderSetMsg {
  t: 'providerSet';
  id: number;
  name: string;
  baseURL?: string;
  apiKey?: string;
}

export type Inbound =
  | ReplyMsg
  | InputMsg
  | InterruptMsg
  | QueryMsg
  | MenuSelectMsg
  | PingMsg
  | ConfigGetMsg
  | ConfigSetMsg
  | CatalogGetMsg
  | ProviderSetMsg
  | ResumeMsg
  | ControlsMsg;

// --- Event vocabulary ----------------------------------------------------------------------

// The serializable engine→UI signals forwarded verbatim (kept in sync with the contract block at
// the bottom of src/cli/events.ts). `veto_prompt` is intentionally absent — it carries a callback
// and is translated to a RequestMsg by the host instead.
export const FORWARDED_EVENTS: readonly string[] = [
  'log',
  'message',
  'tool_call',
  'tool_call_result',
  'spinner_state',
  'status',
  'mode_change',
  'model_tier',
  'set_tier',
  'cost_update',
  'todo_update',
  'subagent_update',
  'thinking',
  'thinking_clear',
  'config_changed',
  'graph_changed',
  'cwd_changed',
  'mcp_changed',
  'rerun_onboarding',
  'shutdown',
  'loop_detected',
  'goals_changed',
  // /clear wipes the front-end transcript (the engine has no in-process UI to intercept it).
  'clear',
  // True resume: `{ id, entries }` — the saved thread's transcript (messages + tool lines) so a
  // graphical front-end can rebuild its scrollback, not just inject invisible context.
  'session_restore',
  // A resume that could not happen: `{ id, reason }`, so a front-end waiting on that id says so instead of waiting forever.
  'session_restore_failed',
  // Review domain: the current thread's derived review snapshot (plan, approvals, attributed
  // changes, verification runs, checkpoint state). Always a FULL snapshot — a reconnecting
  // front-end is correct again on the next emit.
  'review_update',
  // Outcome domain: compact full snapshot of the active contract, acceptance gate, task/gap counts,
  // iteration and blocker. Null means this thread has no substantial outcome contract yet.
  'outcome_update',
  // The driver re-emits each reply token here so the out-of-process front-end can render the stream.
  'stream_token',
  // Footer state read from engine singletons; snapshotted for the out-of-process front-end.
  'ui_snapshot',
];

/** Events the host special-cases into a {@link RequestMsg} (they carry a resolve callback). */
export const PROMPT_EVENT = 'veto_prompt';
export const DIFF_PROMPT_EVENT = 'diff_prompt';
export const INPUT_PROMPT_EVENT = 'input_prompt';

// React element brand — so a `message` event carrying a JSX `content`/`payload` doesn't blow up
// JSON.stringify; we replace it with a placeholder the front-end can render generically.
const REACT_ELEMENT = Symbol.for('react.element');

/**
 * Make an event's args safe to serialize: drop functions, replace React elements with a marker,
 * and let JSON handle the rest (Dates become ISO strings). Never throws — a value that can't be
 * cloned (e.g. a cycle) collapses to null rather than killing the stream.
 */
export function sanitizeArgs(args: any[]): JsonValue[] {
  const replacer = (_key: string, value: any): any => {
    if (typeof value === 'function') return undefined;
    if (typeof value === 'bigint') return value.toString();
    if (value && typeof value === 'object' && (value as any).$$typeof === REACT_ELEMENT) {
      return { __ui: (value as any).type?.name || 'component' };
    }
    return value;
  };
  return args.map((a) => {
    // Fast path: primitives are already JSON-safe, so skip the stringify→parse clone. This runs
    // once per streamed token (the hottest event on the wire) — avoiding two JSON passes per token
    // is the cheapest real win here; the final encode() stringifies the whole message exactly once.
    if (a == null) return null;
    const t = typeof a;
    if (t === 'string' || t === 'number' || t === 'boolean') return a;
    if (t === 'bigint') return (a as bigint).toString();
    if (t === 'function') return null;
    // Objects/arrays: clone through JSON to drop functions, mark React elements, ISO-ify Dates.
    try {
      return JSON.parse(JSON.stringify(a, replacer));
    } catch {
      return null;
    }
  });
}
