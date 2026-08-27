import { inspectActionReceipt, type ActionReceiptView } from './receipt.inspector';
import { macToolIdentity } from '../../shared/mac.provider';

/**
 * Live Target view model.
 *
 * `04_FRONTEND_PLAN.md` requires the Live Target inspector to always show the app and exact window
 * being operated, whether Bimax is observing in background or holding the foreground, the last
 * verified state *and the age of that evidence*, Pause/Take Control/Resume, and a readable action
 * timeline. `examples/CURRENT_BIMAX_UI.md` lists every one of those as missing today.
 *
 * The data source is deliberately the one Bimax already has: the Desktop capability provider's own
 * tool results, which arrive in the renderer as ordinary `tool_call` / `tool_call_result` protocol
 * events. Adding a second Mac telemetry channel from the provider to the renderer would duplicate
 * the receipt model that `receipt.inspector.ts` already parses, so this module folds those same
 * results into a session instead.
 *
 * Nothing here infers a fact the payload did not state. An unknown window is "not reported", not
 * the last window we happened to see; evidence with no timestamp is `unknown` age, never "fresh".
 */

/**
 * Evidence freshness budget.
 *
 * This is NOT a new number. It mirrors `capabilities/mac/frame.ts` `DEFAULT_FRAME_MAX_AGE_MS`,
 * which is the budget the runtime itself refuses a stale frame against — the renderer must not
 * call evidence fresh that the runtime would already reject. `phase5.mac.session.test.ts` imports
 * both and fails if they ever drift apart. The renderer re-declares rather than imports so the
 * bundle does not pull the whole macOS runtime into the window.
 */
export const EVIDENCE_MAX_AGE_MS = 30_000;

export type EvidenceFreshness = 'fresh' | 'stale' | 'unknown';

export type MacControlState = 'idle' | 'observing' | 'acting' | 'paused' | 'blocked';

export interface MacTarget {
  app: string;
  pid: number | null;
  windowId: number | null;
}

export interface MacEvidence {
  /** Observation/frame id the last result was bound to. */
  observation: string;
  capturedAtMs: number | null;
  ageMs: number | null;
  freshness: EvidenceFreshness;
  /** Absolute path of the newest screenshot the provider wrote, when it reported one. */
  screenshot: string;
}

export interface MacTimelineEntry {
  id: string;
  /** Plain language: "Clicked Send", not "ax_action on AXButton". */
  label: string;
  action: string;
  outcome: string;
  executor: ActionReceiptView['executor'];
  focus: ActionReceiptView['focus'];
  postcondition: string;
  status: 'running' | 'success' | 'error';
  atMs: number | null;
  /** True when the provider refused because the user holds control. */
  refusedForTakeover: boolean;
}

export interface MacSession {
  /** True once this task has produced any Mac provider activity at all. */
  active: boolean;
  state: MacControlState;
  target: MacTarget | null;
  evidence: MacEvidence | null;
  timeline: MacTimelineEntry[];
  latest: MacTimelineEntry | null;
  /** Verbatim from the app-owned latch; never inferred from a refusal. */
  paused: boolean;
  pauseReason: string;
  /** Populated when the provider refused an action while the user held control. */
  refusedWhilePaused: number;
}

export interface MacToolCall {
  id: string;
  toolName: string;
  input: string;
  output: string;
  status: 'running' | 'success' | 'error';
  startTime: string;
  endTime?: string;
}

/**
 * Is this tool call one the Desktop macOS provider owns?
 *
 * Delegates to the single shared recognizer in `shared/mac.provider.ts`, which knows both shapes a
 * provider tool name can legitimately take — the fully qualified `mcp__bimax-mac__mac_control` the
 * engine emits in production, and the bare `mac_control` the provider and the conformance harness
 * use when they talk to it directly. There is no second recognizer anywhere in the renderer.
 */
export function isMacToolCall(call: { toolName: string }): boolean {
  return macToolIdentity(call.toolName).isMac;
}

const millis = (iso?: string): number | null => {
  if (!iso) return null;
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : null;
};

const asObject = (value: unknown): Record<string, any> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;

function parse(output: string): Record<string, any> | null {
  try { return asObject(JSON.parse(output)); } catch { return null; }
}

/** Native receipts carry a structured application identity; never coerce that object into UI text. */
function macAppLabel(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  const candidate = asObject(value);
  if (!candidate) return '';
  for (const key of ['displayName', 'name', 'label', 'bundleId']) {
    if (typeof candidate[key] === 'string' && candidate[key].trim()) return candidate[key].trim();
  }
  return '';
}

/** Plain-language label for a Mac action, with no AX/OCR/mechanism vocabulary. */
export function describeMacAction(action: string, payload: Record<string, any> | null): string {
  const target = String(payload?.targeting?.label || payload?.query || '').trim();
  const verb: Record<string, string> = {
    click: 'Clicked', type: 'Typed', key: 'Pressed', set_value: 'Set',
    open: 'Opened', focus: 'Switched to', scroll: 'Scrolled', drag: 'Dragged',
    hover: 'Hovered over', observe: 'Looked at', screenshot: 'Captured',
    close: 'Closed', quit_app: 'Quit', copy: 'Copied', paste: 'Pasted',
    move: 'Moved', arrange: 'Arranged', wait: 'Waited', status: 'Checked permissions',
    apps: 'Listed apps', windows: 'Listed windows', frontmost: 'Checked the front app',
  };
  const word = verb[action];
  if (!word) return action.replace(/_/g, ' ');
  const app = macAppLabel(payload?.app || payload?.application);
  if (target) return `${word} ${target}`;
  if ((action === 'open' || action === 'focus' || action === 'quit_app') && app) return `${word} ${app}`;
  if (action === 'observe' && app) return `Looked at ${app}`;
  return word;
}

/** Describe an attempted action without claiming it happened. */
export function describeMacActionIntent(action: string, payload: Record<string, any> | null): string {
  const target = String(payload?.targeting?.label || payload?.query || '').trim();
  const verb: Record<string, string> = {
    click: 'click', type: 'type', key: 'press', set_value: 'set', open: 'open',
    focus: 'switch to', scroll: 'scroll', drag: 'drag', hover: 'hover over',
    observe: 'look at', screenshot: 'capture', close: 'close', quit_app: 'quit',
    copy: 'copy', paste: 'paste', move: 'move', arrange: 'arrange', wait: 'wait',
    status: 'check permissions', apps: 'list apps', windows: 'list windows',
    frontmost: 'check the front app',
  };
  const word = verb[action] || action.replace(/_/g, ' ');
  const app = macAppLabel(payload?.app || payload?.application);
  if (target) return `${word} ${target}`;
  if ((action === 'open' || action === 'focus' || action === 'quit_app') && app) return `${word} ${app}`;
  if (action === 'observe' && app) return `look at ${app}`;
  return word;
}

/**
 * Fold this task's Mac provider tool calls into one live session.
 *
 * `takeover` is the app-owned latch state and is used verbatim. A refusal in the transcript is
 * evidence that the latch *worked*, never the thing that decides the latch is on — inferring the
 * pause from a refusal would make the UI claim "paused" after any unrelated failure.
 */
export function deriveMacSession(
  calls: MacToolCall[],
  takeover: { paused: boolean; reason: string },
  nowMs: number,
): MacSession {
  const macCalls = calls.filter(isMacToolCall);
  const timeline: MacTimelineEntry[] = [];
  let target: MacTarget | null = null as MacTarget | null;
  let evidence: MacEvidence | null = null as MacEvidence | null;
  let refusedWhilePaused = 0;
  let sawBlocked = false;

  for (const call of macCalls) {
    const payload = call.status === 'running' ? null : parse(call.output);
    const input = parse(call.input);
    const displayPayload = payload ? { ...input, ...payload } : input;
    const receipt = payload ? inspectActionReceipt(call.output) : null;
    const action = String(payload?.action || actionFromInput(call.input) || 'action');
    const atMs = millis(call.endTime) ?? millis(call.startTime);
    const refusedForTakeover = payload?.code === 'computer_use_paused'
      || payload?.code === 'computer_use_takeover_intervened';
    if (refusedForTakeover) refusedWhilePaused++;
    if (payload && payload.ok === false && !refusedForTakeover) sawBlocked = true;
    if (payload && payload.ok !== false) sawBlocked = false;

    // Target identity only advances on a result that actually named one.
    const app = macAppLabel(payload?.app ?? payload?.application ?? payload?.target?.app);
    const pid = Number.isFinite(Number(payload?.pid ?? payload?.target?.pid))
      ? Number(payload?.pid ?? payload?.target?.pid) : null;
    const windowId = Number.isFinite(Number(payload?.windowId ?? payload?.target?.windowId))
      ? Number(payload?.windowId ?? payload?.target?.windowId) : null;
    if (app || pid !== null) {
      target = { app: app || target?.app || '', pid: pid ?? target?.pid ?? null, windowId: windowId ?? null };
    }

    const observation = String(payload?.frameId || receipt?.observation || '').trim();
    const screenshot = typeof payload?.screenshot === 'string' ? payload.screenshot : '';
    if (observation && observation !== 'not recorded') {
      evidence = {
        observation,
        capturedAtMs: atMs,
        ageMs: null,
        freshness: 'unknown',
        screenshot: screenshot || (evidence?.observation === observation ? evidence.screenshot : ''),
      };
    } else if (screenshot) {
      evidence = {
        observation: evidence?.observation || 'not reported',
        capturedAtMs: atMs,
        ageMs: null,
        freshness: 'unknown',
        screenshot,
      };
    }

    timeline.push({
      id: call.id,
      label: refusedForTakeover
        ? `Refused ${describeMacActionIntent(action, displayPayload)} — you have control`
        : payload?.ok === false
          ? `Blocked: ${describeMacActionIntent(action, displayPayload)}`
          : describeMacAction(action, displayPayload),
      action,
      outcome: receipt?.outcome || (call.status === 'running' ? 'running' : payload?.ok === false ? 'blocked' : 'completed'),
      executor: receipt?.executor ?? 'unattributed',
      focus: receipt?.focus ?? 'unknown',
      postcondition: receipt?.postcondition
        ?? String(payload?.verification?.reason || payload?.reason || payload?.error || 'not requested'),
      status: call.status === 'running' ? 'running' : payload?.ok === false ? 'error' : call.status,
      atMs,
      refusedForTakeover,
    });
  }

  if (evidence) {
    const ageMs = evidence.capturedAtMs === null ? null : Math.max(0, nowMs - evidence.capturedAtMs);
    evidence = {
      ...evidence,
      ageMs,
      freshness: ageMs === null ? 'unknown' : ageMs <= EVIDENCE_MAX_AGE_MS ? 'fresh' : 'stale',
    };
  }

  const latest = timeline.length ? timeline[timeline.length - 1] : null;
  const state: MacControlState = takeover.paused ? 'paused'
    : latest?.status === 'running' ? (latest.action === 'observe' || latest.action === 'screenshot' ? 'observing' : 'acting')
      : sawBlocked ? 'blocked'
        : timeline.length ? 'idle' : 'idle';

  return {
    active: macCalls.length > 0,
    state,
    target,
    evidence,
    timeline,
    latest,
    paused: takeover.paused,
    pauseReason: takeover.reason,
    refusedWhilePaused,
  };
}

/** A running call has no output yet; its action is still visible in the tool input. */
function actionFromInput(input: string): string {
  const match = (input || '').match(/"action"\s*:\s*"([a-z_]+)"/i) || (input || '').match(/\b(action|verb)[=:]\s*([a-z_]+)/i);
  return match ? (match[2] ?? match[1]) : '';
}

/** Human phrasing for evidence age. Never rounds an unknown into a number. */
export function describeEvidenceAge(evidence: MacEvidence | null): string {
  if (!evidence) return 'no observation yet';
  if (evidence.ageMs === null) return 'age not recorded';
  const seconds = Math.round(evidence.ageMs / 1000);
  if (seconds < 1) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}
