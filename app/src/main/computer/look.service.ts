import { createHash, randomUUID } from 'node:crypto';
import type { Outbound, Inbound } from '../../renderer/src/protocol';
import { LookGrants } from './look.grants';
import { NEVER_LOOK, isNeverUsed, validBundleId } from './look.manifest';
import { renderLook } from './look.observation';
import { commitReasonForPress, isSearchBox, reasonText, type CommitReason } from './look.commit';
import type { ProcessIdentity } from './look.identity';

/**
 * The app's answer to a Bimax Thread asking to look at another app's window (record 65, stage 2), and to use it — press a
 * control or type into a box (stage 3, widened to every app the person allows by stage 6, §6h).
 *
 * Look, in order, each before the next costs anything: the person turned looking on (the menu bar item) → the request is
 * one this capability has → the app exists and is not one a task never looks at → the person allowed it for this Thread
 * on a card this app raised → the driver, in a look-only session for that one app. The engine only ever gets text: the
 * window, with the menu bar cut out and password fields blank.
 *
 * Use (press or type), checked in this order and again after every wait: using is on (its own menu bar item) → the app
 * is not one a task never uses → the person let this Thread use it (asked once per app per task) → a read of its window
 * is fresh (PRESS_FRESH_MS) and has not been acted on yet → exactly one matching control or box in it → if this step
 * commits (look.commit.ts: it sends, pays, deletes or confirms, answers a dialog, follows typing, or cannot be read),
 * or replaces text Bimax did not type, or the task has gone KEEP_GOING_EVERY steps unasked, the person's answer on a
 * card that shows exactly what → no Stop and no switch turned off since → the same running build as the read → the
 * driver, in a use session, finds it again and acts once, never retrying → the window is read again; that read is what
 * the next step is bound to, and the result says what changed. "Nothing changed" is a failure; typing counts only if the
 * box reads back exactly the text.
 */

type HostCallMsg = Extract<Outbound, { t: 'host_call' }>;
type HostResultMsg = Extract<Inbound, { t: 'host_result' }>;

export interface RunningApp { name: string; bundleId: string; pid: number }

/**
 * A control a read showed: enough to bind a later step to it — never the driver's token. `value` is a text box's text;
 * `at` is where it starts on screen, which finds a box again after typing renames it; `inDialog`, inside a sheet.
 */
export interface LookElement { role: string; label: string; pressable: boolean; editable?: boolean; value?: string; inDialog?: boolean; at?: string }

/** What a step is bound to: the window a read saw, and one control in it by role and name. */
export interface PressTarget { windowId: number; role: string; label: string }

/** One press. Anything that fails before the click throws (nothing was pressed); from the click on, it is returned. */
export type PressOutcome =
  | { kind: 'pressed'; title: string; before: string; after: string; elements?: LookElement[] }
  | { kind: 'not_pressed'; reason: 'changed' | 'ambiguous' | 'refused'; detail?: string }
  | { kind: 'uncertain'; detail: string };

/** One typing: the box's whole text set once. `value` is what the box reads afterwards (null: not found again). */
export type TypeOutcome =
  | { kind: 'typed'; title: string; before: string; after: string; value: string | null; elements?: LookElement[] }
  | { kind: 'not_typed'; reason: 'changed' | 'ambiguous' | 'refused'; detail?: string }
  | { kind: 'uncertain'; detail: string };

/** The driver as this service needs it. The real one is look.driver.ts; tests give a fake. */
export interface LookDriver {
  runningApps(): Promise<RunningApp[]>;
  /** The app's front window, read only, in a session scoped to that app for this Thread. */
  look(threadId: string, app: RunningApp, query?: string): Promise<{ title: string; markdown: string; windowId?: number; elements?: LookElement[] }>;
  /** One press of one control, in a use session for that app. */
  press?(threadId: string, app: RunningApp, target: PressTarget): Promise<PressOutcome>;
  /** One typing into one box, in a use session for that app. */
  type?(threadId: string, app: RunningApp, target: PressTarget, text: string): Promise<TypeOutcome>;
  end(threadId: string): Promise<void>;
}

export interface LookServiceDeps {
  /** The person turned looking on (menu bar item, off by default). Read on every call: turning it off stops looks at once. */
  enabled(): boolean;
  driver(): Promise<LookDriver>;
  /** Raise a card in this Thread and wait for the person's answer ('' if the Thread stopped first). */
  ask(threadId: string, question: string, options: string[], body: string): Promise<string>;
  /** One content-free line per host call — never window text. Optional: tests and hosts without a log omit it. */
  audit?(entry: LookAuditEntry): void;
  /** Stage 6: the person also turned using on (its own menu bar item, off by default). Read at every step. */
  useEnabled?(): boolean;
  /** The clock a read's freshness is measured by. Tests set it. */
  now?(): number;
  /** Stage 5: which build a process runs — its executable and that file's SHA-256 (look.identity.ts). Optional. */
  identify?(pid: number): Promise<ProcessIdentity | null>;
}

/** What the audit log keeps of one host call: who asked, for what, the outcome, and the running counts. */
export interface LookAuditEntry {
  at: string;
  threadId: string;
  op: string;
  bundleId?: string;
  ok: boolean;
  code?: string;
  counts: LookCounts;
  /** A step's receipt, content-free: the control's name and any typed text only as hashes. */
  receipt?: PressReceipt;
}

/** What the app did for each Thread, counted by the app itself — never taken from the model's account of it. */
export interface LookCounts {
  lists: number; looks: number; refused: number; asked: number;
  /** Presses the driver accepted. */
  presses: number;
  /** Typings the box read back exactly. */
  typings: number;
  /** Input calls the app sent to the driver at all — accepted or with an unknown outcome. Zero for a look-only Thread. */
  inputCalls: number;
}

/** One step, as the audit keeps it: which action, bound to which read, whether the person was asked, and the outcome. */
export interface PressReceipt {
  actionId: string;
  action: 'press' | 'type';
  role: string;
  labelHash: string;
  windowId: number;
  lookAgeMs: number;
  /** Why the person was asked first, or null for an ordinary step that ran without a card. */
  asked: CommitReason['kind'] | 'overwrite' | 'keep_going' | null;
  /** Typing: the text's hash and length, never the text. */
  textHash?: string;
  textLength?: number;
  /** Stage 5: the build that was acted on — the SHA-256 of the running executable, and its process. */
  exeSha256?: string;
  pid?: number;
  outcome: 'pressed' | 'typed' | 'no_effect' | 'mismatch' | 'not_pressed' | 'uncertain' | 'cancelled' | 'denied';
}

const ALLOW = (name: string) => `Allow looking at ${name}`;
const USE = (name: string) => `Allow using ${name}`;
const ONLY_LOOK = 'Only look';
const DENY = 'Not now';
const PRESS = (label: string) => `Press “${label}”`;
const DONT_PRESS = 'Don’t press';
const REPLACE = 'Replace it';
const DONT_TYPE = 'Don’t type';
const KEEP_GOING = 'Keep going';
const STOP_HERE = 'Stop here';
/** How old the read a step is bound to may be when the step is asked for. */
export const PRESS_FRESH_MS = 2 * 60 * 1000;
/** Steps a task may take in other apps without a card before it is asked whether to keep going. */
export const KEEP_GOING_EVERY = 40;
/** The longest text one typing may set. */
export const MAX_TYPE_CHARS = 2000;
const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);
/** Two control names are the same when they differ only in their spaces (no-break, thin, doubled). Nothing else. */
const sameName = (a: string, b: string) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
/** Text shown on a card: one line, bounded. */
const quote = (text: string, max = 300) => { const flat = text.replace(/\s+/g, ' ').trim(); return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat; };

/** What a step changed, as the model will read it: lines gone and lines new, from the same rendering a look uses. */
function changedLines(before: string, after: string): string[] {
  const a = renderLook(before).text.split('\n').map((l) => l.trim()).filter(Boolean);
  const b = renderLook(after).text.split('\n').map((l) => l.trim()).filter(Boolean);
  return [...a.filter((l) => !b.includes(l)).map((l) => `- ${l}`), ...b.filter((l) => !a.includes(l)).map((l) => `+ ${l}`)].slice(0, 40);
}

const fail = (id: number, code: string, error: string): HostResultMsg => ({ t: 'host_result', id, ok: false, error, value: { code } });

const NEXT_STEP = 'Bimax read the window again just now; your next step can use that read without looking again.';

interface Observation { at: number; windowId: number; title: string; elements: LookElement[]; exe?: ProcessIdentity | null }
/**
 * What Bimax itself did in one app in this Thread: the box it last typed into that is not a search box (the next press
 * asks, showing it), the text it last put in any box (typing over Bimax's own text never asks), what it last opened.
 */
interface AppState {
  typed?: { field: string; role: string; at?: string; value: string | null };
  ownText?: { role: string; at?: string; value: string | null };
  lastOpened?: string;
}

export function createLookService(deps: LookServiceDeps) {
  const grants = new LookGrants();
  const counts = new Map<string, LookCounts>();
  // A stopped Thread or an off/on cycle invalidates requests already waiting on discovery, a card or a read.
  const generations = new Map<string, number>();
  let previewGeneration = 0;
  const count = (threadId: string): LookCounts => {
    let c = counts.get(threadId);
    if (!c) { c = { lists: 0, looks: 0, refused: 0, asked: 0, presses: 0, typings: 0, inputCalls: 0 }; counts.set(threadId, c); }
    return c;
  };
  const now = () => (deps.now ? deps.now() : Date.now());
  const useOn = () => deps.useEnabled?.() === true;
  // The last read of each app per Thread, which at most one step may use; a step's own re-read replaces it.
  const observations = new Map<string, Observation>();
  const appStates = new Map<string, AppState>();
  // Apps the person let this Thread only look at: a step there is refused without asking again.
  const lookOnly = new Set<string>();
  const stepsSinceCard = new Map<string, number>();
  const identify = async (pid: number): Promise<ProcessIdentity | null> => {
    if (!deps.identify) return null;
    try { return await deps.identify(pid); } catch { return null; }
  };
  const handledSteps = new Set<string>();
  const lastReceipt = new Map<string, PressReceipt>();
  const lastTarget = new Map<string, string>();

  async function find(want: string): Promise<RunningApp | null> {
    const apps = await (await deps.driver()).runningApps();
    const key = want.trim().toLowerCase();
    return apps.find((a) => a.bundleId.toLowerCase() === key)
      ?? apps.find((a) => a.name.toLowerCase() === key)
      ?? apps.find((a) => a.name.toLowerCase().startsWith(key))
      ?? null;
  }

  /** Never looked at or used, whatever the person answers: Bimax, password and security surfaces, wallets, banks. */
  const neverTouched = (app: RunningApp) => NEVER_LOOK.has(app.bundleId) || !validBundleId(app.bundleId) || isNeverUsed(app.name) || isNeverUsed(app.bundleId);

  async function handle(threadId: string, msg: HostCallMsg): Promise<HostResultMsg> {
    const result = await answer(threadId, msg);
    const value = result.value && typeof result.value === 'object' && !Array.isArray(result.value) ? result.value as Record<string, unknown> : {};
    try {
      deps.audit?.({
        at: new Date().toISOString(), threadId, op: String(msg.op).slice(0, 40),
        ...(lastTarget.get(threadId) ? { bundleId: lastTarget.get(threadId) } : {}),
        ok: result.ok, ...(result.ok ? {} : { code: String(value.code ?? '') }), counts: { ...count(threadId) },
        ...(lastReceipt.get(threadId) ? { receipt: lastReceipt.get(threadId) } : {}),
      });
    } catch { /* the log must never change the answer */ }
    lastTarget.delete(threadId);
    lastReceipt.delete(threadId);
    return result;
  }

  async function answer(threadId: string, msg: HostCallMsg): Promise<HostResultMsg> {
    const c = count(threadId);
    const generation = generations.get(threadId) ?? 0;
    const preview = previewGeneration;
    const current = () => deps.enabled() && preview === previewGeneration && generation === (generations.get(threadId) ?? 0);
    const revoked = () => {
      c.refused += 1;
      return fail(msg.id, 'not_permitted', 'This look was cancelled because the task stopped or looking was turned off.');
    };
    if (msg.capability === 'press' || msg.capability === 'type') return useAnswer(threadId, msg, c, current);
    if (msg.capability !== 'look') { c.refused += 1; return fail(msg.id, 'invalid_args', 'Bimax has no such capability.'); }
    if (!deps.enabled()) {
      c.refused += 1;
      return fail(msg.id, 'not_permitted', 'Looking at other apps is turned off. The person can turn it on from the Bimax item in the menu bar ("Let Tasks Look at Other Apps").');
    }
    const args = (msg.args && typeof msg.args === 'object' && !Array.isArray(msg.args)) ? msg.args as Record<string, unknown> : {};
    try {
      if (msg.op === 'list_apps') {
        const apps = (await (await deps.driver()).runningApps()).filter((a) => !neverTouched(a));
        if (!current()) return revoked();
        c.lists += 1;
        const text = apps.length ? apps.map((a) => `${a.name} (${a.bundleId})`).join('\n') : '(no apps with windows are open)';
        return { t: 'host_result', id: msg.id, ok: true, value: { text } };
      }
      if (msg.op !== 'look') { c.refused += 1; return fail(msg.id, 'invalid_args', 'Only "list_apps" and "look" are possible here.'); }

      const want = String(args.app ?? '').slice(0, 200);
      if (!want.trim()) { c.refused += 1; return fail(msg.id, 'invalid_args', 'Say which app to look at.'); }
      const target = await find(want);
      if (!current()) return revoked();
      if (!target) { c.refused += 1; return fail(msg.id, 'not_found', `No open app is called "${want}". Use list_apps to see what is open.`); }
      lastTarget.set(threadId, target.bundleId);
      if (neverTouched(target)) {
        c.refused += 1;
        return fail(msg.id, 'denied', `${target.name} is never looked at: it shows passwords, keys, money or Bimax's own approvals.`);
      }

      let decision = grants.decision(threadId, target.bundleId);
      if (decision === 'unasked') {
        c.asked += 1;
        if (useOn()) {
          const answer = await deps.ask(
            threadId,
            `Let this task use ${target.name}?`,
            [USE(target.name), ONLY_LOOK, DENY],
            `Bimax will read ${target.name}'s front window and may press its buttons and type into its text boxes, in the ` +
            `background, without moving your pointer. Before anything is sent, posted, bought, deleted or confirmed it stops ` +
            `and asks you, showing exactly what. This is for this task only; stopping the task ends it.`,
          );
          if (!current()) return revoked();
          if (answer === USE(target.name)) grants.allowUse(threadId, target.bundleId);
          else if (answer === ONLY_LOOK) { grants.allow(threadId, target.bundleId); lookOnly.add(`${threadId}|${target.bundleId}`); }
          else grants.refuse(threadId, target.bundleId);
        } else {
          const answer = await deps.ask(
            threadId,
            `Let this task look at ${target.name}?`,
            [ALLOW(target.name), DENY],
            `Bimax will read what is in ${target.name}'s front window — its buttons, fields, lists and text — and nothing else. ` +
            `It cannot click, type or change anything there. This is for this task only; stopping the task ends it.`,
          );
          if (!current()) return revoked();
          if (answer === ALLOW(target.name)) grants.allow(threadId, target.bundleId); else grants.refuse(threadId, target.bundleId);
        }
        decision = grants.decision(threadId, target.bundleId);
      }
      if (decision !== 'allowed') {
        c.refused += 1;
        return fail(msg.id, 'denied', `The person did not let this task look at ${target.name}. Do not ask again; carry on without it or ask them what to do.`);
      }

      const query = typeof args.query === 'string' && args.query.trim() ? args.query.slice(0, 200) : undefined;
      const driver = await deps.driver();
      if (!current()) return revoked();
      const window = await driver.look(threadId, target, query);
      if (!current()) return revoked();
      // Stage 5: which build is running, so a task that just built this app can tell it is looking at that build.
      const exe = await identify(target.pid);
      if (!current()) return revoked();
      const shown = renderLook(window.markdown);
      c.looks += 1;
      // What this look showed is what one later step may be bound to.
      if (typeof window.windowId === 'number' && Array.isArray(window.elements)) {
        observations.set(`${threadId}|${target.bundleId}`, { at: now(), windowId: window.windowId, title: window.title, elements: window.elements, exe });
      }
      const running = exe ? `\nRunning build: ${exe.path} (process ${target.pid}, executable SHA-256 ${exe.sha256})` : '';
      const mode = useOn() && grants.mayUse(threadId, target.bundleId) ? 'you may press and type here' : 'read only';
      const header = `${target.name} — ${window.title ? `window “${window.title}”` : 'front window'} (${mode}${query ? `, lines matching “${query}”` : ''}):${running}`;
      return { t: 'host_result', id: msg.id, ok: true, value: { text: `${header}\n${shown.text || '(nothing readable)'}` } };
    } catch (error) {
      if (!current()) return revoked();
      c.refused += 1;
      const text = error instanceof Error ? error.message : String(error);
      if (/accessibility|not trusted|permission/i.test(text)) {
        return fail(msg.id, 'not_permitted', 'Bimax needs Accessibility permission to read other apps: System Settings → Privacy & Security → Accessibility → turn on Bimax.');
      }
      return fail(msg.id, 'unavailable', `Bimax could not look: ${text.slice(0, 200)}`);
    }
  }

  /**
   * One step in another app: a press (`capability: 'press'`) or a typing (`capability: 'type'`). Every refusal before
   * the driver is asked says nothing was done; from the driver's call on, the result says exactly what is known.
   */
  async function useAnswer(threadId: string, msg: HostCallMsg, c: LookCounts, current: () => boolean): Promise<HostResultMsg> {
    const typing = msg.capability === 'type';
    const nothing = typing ? 'Nothing was typed.' : 'Nothing was pressed.';
    const live = () => current() && useOn();
    const refuse = (code: string, text: string) => { c.refused += 1; return fail(msg.id, code, text); };
    const cancelled = () => refuse('not_permitted', `This step was cancelled because the task stopped or using other apps was turned off. ${nothing}`);
    if (!deps.enabled() || !useOn()) {
      return refuse('not_permitted', `Using other apps is turned off. The person can turn it on from the Bimax item in the menu bar ("Let Tasks Use Other Apps"). ${nothing}`);
    }
    if (msg.op !== msg.capability) return refuse('invalid_args', typing ? 'Typing has one operation: "type".' : 'Pressing has one operation: "press".');
    // A request is carried out at most once, whatever reaches the app twice.
    const seen = `${threadId}:${msg.id}`;
    if (handledSteps.has(seen)) return refuse('invalid_args', `This request was already handled; it is never carried out twice. ${nothing}`);
    handledSteps.add(seen);

    const args = (msg.args && typeof msg.args === 'object' && !Array.isArray(msg.args)) ? msg.args as Record<string, unknown> : {};
    const want = String(args.app ?? '').slice(0, 200).trim();
    const control = String((typing ? args.field : args.control) ?? '').slice(0, 200).trim();
    const role = typeof args.role === 'string' ? args.role.trim().slice(0, 40) : '';
    const text = typing && typeof args.text === 'string' ? args.text : '';
    if (!want || (!typing && !control)) return refuse('invalid_args', `Say which app, and the name of the control exactly as the look showed it. ${nothing}`);
    if (typing) {
      if (typeof args.text !== 'string') return refuse('invalid_args', `Say what text to type. ${nothing}`);
      if (/[\r\n\u2028\u2029]/.test(text)) return refuse('invalid_args', `Typing never includes a line break: in many apps Return sends. Type one line. ${nothing}`);
      if (text.length > MAX_TYPE_CHARS) return refuse('invalid_args', `At most ${MAX_TYPE_CHARS} characters at a time. ${nothing}`);
    }
    try {
      const target = await find(want);
      if (!live()) return cancelled();
      if (!target) return refuse('not_found', `No open app is called "${want}". ${nothing}`);
      lastTarget.set(threadId, target.bundleId);
      if (neverTouched(target)) return refuse('denied', `${target.name} is never used by a task: it shows passwords, keys, money or Bimax's own approvals. ${nothing}`);
      const key = `${threadId}|${target.bundleId}`;
      if (grants.decision(threadId, target.bundleId) !== 'allowed') {
        return refuse('stale', `Look at ${target.name} first (LookAtAppTool): every step is bound to what a read of the window just showed. ${nothing}`);
      }
      if (lookOnly.has(key)) return refuse('denied', `The person let this task only look at ${target.name}, not press or type there. ${nothing} Ask them what to do.`);
      if (!grants.mayUse(threadId, target.bundleId)) {
        // Allowed to look before using was turned on: asked once more, now for using it.
        c.asked += 1;
        const answer = await deps.ask(
          threadId,
          `Let this task use ${target.name}?`,
          [USE(target.name), DENY],
          `Bimax may press buttons and type into text boxes in ${target.name}, in the background, without moving your pointer. ` +
          `Before anything is sent, posted, bought, deleted or confirmed it stops and asks you, showing exactly what. ` +
          `This is for this task only; stopping the task ends it.`,
        );
        if (!live()) return cancelled();
        if (answer !== USE(target.name)) {
          lookOnly.add(key);
          return refuse('denied', `The person let this task only look at ${target.name}, not press or type there. ${nothing} Ask them what to do.`);
        }
        grants.allowUse(threadId, target.bundleId);
      }
      const look = observations.get(key);
      if (!look) return refuse('stale', `Look at ${target.name} again first: the last read was already used for a step, or its outcome was unknown. ${nothing}`);
      const age = now() - look.at;
      if (age > PRESS_FRESH_MS) {
        observations.delete(key);
        return refuse('stale', `The window was read ${Math.round(age / 1000)} s ago, too long to act from. Look again first. ${nothing}`);
      }

      // Exactly one control (or box) that the read showed. Names compare with all kinds of spaces as one (measured: a
      // model sent "Delete\u00a0Everything", a no-break space).
      let el: LookElement;
      if (typing) {
        const named = control ? look.elements.filter((e) => sameName(e.label, control) && (!role || e.role === role)) : [];
        if (control && !named.length) return refuse('not_found', `There is no box called “${control}”${role ? ` (${role})` : ''} in the window you read. ${nothing}`);
        if (named.some((e) => e.role === 'AXSecureTextField')) return refuse('denied', `“${control}” is a password field. Bimax never types into one. ${nothing}`);
        const boxes = control ? named.filter((e) => e.editable) : look.elements.filter((e) => e.editable && (!role || e.role === role));
        if (control && !boxes.length) return refuse('not_permitted', `“${control}” is ${named[0].role}, not a text box Bimax can type into. ${nothing}`);
        if (!boxes.length) return refuse('not_found', `The window you read has no text box Bimax can type into. ${nothing}`);
        if (boxes.length > 1) return refuse('ambiguous', `${boxes.length} text boxes match${control ? ` “${control}”` : ''}; give the box's name (and role) exactly as the look showed it. Bimax will not guess. ${nothing}`);
        el = boxes[0];
      } else {
        const matches = look.elements.filter((e) => sameName(e.label, control) && (!role || e.role === role));
        if (!matches.length) return refuse('not_found', `There is no control called “${control}”${role ? ` (${role})` : ''} in the window you read. ${nothing}`);
        if (matches.length > 1) return refuse('ambiguous', `${matches.length} controls are called “${control}”${role ? '' : '; give its role too'}. Bimax will not guess which one. ${nothing}`);
        el = matches[0];
        if (!el.pressable) {
          return refuse('not_permitted', el.editable
            ? `“${control}” is a text box: type into it (TypeInAppTool) instead of pressing it. ${nothing}`
            : `“${control}” is ${el.role} and has no press of its own (menus and pop-ups are not pressed). ${nothing}`);
        }
      }
      // One read, at most one step — whatever happens from here.
      observations.delete(key);
      const state = appStates.get(key) ?? {};
      appStates.set(key, state);

      const receipt: PressReceipt = {
        actionId: randomUUID(), action: typing ? 'type' : 'press', role: el.role, labelHash: hash(el.label), windowId: look.windowId,
        lookAgeMs: age, asked: null, outcome: 'cancelled', ...(typing ? { textHash: hash(text), textLength: text.length } : {}),
      };
      lastReceipt.set(threadId, receipt);

      // Does the person need to see this step first? Only from what the app's tree says and what Bimax did here.
      if (typing) {
        const existing = el.value ?? '';
        const own = state.ownText;
        const ours = own !== undefined && own.role === el.role && own.at !== undefined && own.at === el.at && own.value === existing;
        if (existing.trim() && !ours) {
          receipt.asked = 'overwrite';
          c.asked += 1;
          const answer = await deps.ask(
            threadId,
            `Replace the text in “${quote(el.label, 80)}” in ${target.name}?`,
            [REPLACE, DONT_TYPE],
            `The box already holds text Bimax did not type: “${quote(existing)}”.\nTyping replaces all of it with: “${quote(text)}”.\n` +
            `Stopping the task before then cancels it.`,
          );
          if (!live()) return cancelled();
          if (answer !== REPLACE) { receipt.outcome = 'denied'; return refuse('denied', `The person did not let this task replace that text. ${nothing} Ask them what to do.`); }
          stepsSinceCard.set(threadId, 0);
        }
      } else {
        const reason = commitReasonForPress({ label: el.label, inDialog: el.inDialog === true, typedSinceLastCard: state.typed !== undefined });
        if (reason) {
          receipt.asked = reason.kind;
          c.asked += 1;
          const typedBox = state.typed ? look.elements.find((e) => e.role === state.typed!.role && e.at !== undefined && e.at === state.typed!.at) : undefined;
          const typedNow = typedBox?.value ?? state.typed?.value ?? null;
          const lines = [
            reasonText(reason, el.label),
            look.title ? `Window: “${quote(look.title, 120)}”.` : '',
            state.lastOpened ? `Bimax last opened here: “${quote(state.lastOpened, 120)}”.` : '',
            state.typed ? `Text Bimax typed in “${quote(state.typed.field, 80)}”, as the box reads now: ${typedNow === null ? '(Bimax could not read it back)' : `“${quote(typedNow)}”`}.` : '',
            'It presses once, in the background, without moving your pointer. It checks the window first and presses nothing if it changed. Stopping the task before then cancels it.',
          ].filter(Boolean);
          const answer = await deps.ask(threadId, `Press “${el.label}” in ${target.name}?`, [PRESS(el.label), DONT_PRESS], lines.join('\n'));
          if (!live()) return cancelled();
          if (answer !== PRESS(el.label)) {
            receipt.outcome = 'denied';
            return refuse('denied', `The person did not let this task press “${el.label}”. Nothing was pressed. Do not press it again; ask them what to do.`);
          }
          stepsSinceCard.set(threadId, 0);
        }
      }
      // A long run of unasked steps stops for a word from the person.
      if (receipt.asked === null && (stepsSinceCard.get(threadId) ?? 0) >= KEEP_GOING_EVERY) {
        receipt.asked = 'keep_going';
        c.asked += 1;
        const answer = await deps.ask(
          threadId,
          `Keep going in ${target.name}?`,
          [KEEP_GOING, STOP_HERE],
          `This task has taken ${KEEP_GOING_EVERY} steps in other apps since you were last asked. Next: ${typing ? `type into “${quote(el.label, 80)}”` : `press “${quote(el.label, 80)}”`}. ` +
          `Bimax carries on only if you say so.`,
        );
        if (!live()) return cancelled();
        if (answer !== KEEP_GOING) { receipt.outcome = 'denied'; return refuse('denied', `The person stopped this task here. ${nothing} Do not continue in other apps; tell them where you got to.`); }
        stepsSinceCard.set(threadId, 0);
      }
      // Stage 5: the build the read saw must be the build that is running now. A rebuild or relaunch since the read
      // (or while a card waited) means the step would land on a different binary than the one read.
      if (look.exe) {
        const exeNow = await identify(target.pid);
        if (!live()) return cancelled();
        if (!exeNow || exeNow.sha256 !== look.exe.sha256 || exeNow.path !== look.exe.path) {
          receipt.outcome = 'not_pressed';
          return refuse('stale', `${target.name} was rebuilt or relaunched since you looked, so this step would not reach the build you read. ${nothing} Look again.`);
        }
        receipt.exeSha256 = exeNow.sha256;
        receipt.pid = target.pid;
      }
      const driver = await deps.driver();
      if (!live()) return cancelled();
      if (typing ? !driver.type : !driver.press) return refuse('unavailable', `This Bimax cannot ${typing ? 'type' : 'press'}. ${nothing}`);
      const boundTo: PressTarget = { windowId: look.windowId, role: el.role, label: el.label };
      return typing
        ? await typeStep(threadId, msg, c, current, live, refuse, cancelled, driver, target, key, state, el, boundTo, text, receipt, look)
        : await pressStep(threadId, msg, c, current, live, refuse, cancelled, driver, target, key, state, el, boundTo, receipt, look);
    } catch (error) {
      if (!live()) return cancelled();
      const detail = error instanceof Error ? error.message : String(error);
      return refuse('unavailable', `Bimax could not ${typing ? 'type' : 'press'}: ${detail.slice(0, 200)}. ${nothing}`);
    }
  }

  type Refuse = (code: string, text: string) => HostResultMsg;

  /** The step's own re-read becomes the read the next step is bound to. */
  function rebind(key: string, windowId: number, title: string, elements: LookElement[] | undefined, exe: ProcessIdentity | null | undefined): boolean {
    if (!Array.isArray(elements)) return false;
    observations.set(key, { at: now(), windowId, title, elements, exe });
    return true;
  }

  async function pressStep(
    threadId: string, msg: HostCallMsg, c: LookCounts, current: () => boolean, live: () => boolean, refuse: Refuse, cancelled: () => HostResultMsg,
    driver: LookDriver, target: RunningApp, key: string, state: AppState, el: LookElement, boundTo: PressTarget, receipt: PressReceipt, look: Observation,
  ): Promise<HostResultMsg> {
    let outcome: PressOutcome;
    try {
      outcome = await driver.press!(threadId, target, boundTo);
    } catch (error) {
      // Thrown means before the click: nothing was pressed.
      if (!live()) return cancelled();
      const detail = error instanceof Error ? error.message : String(error);
      receipt.outcome = 'not_pressed';
      return refuse('unavailable', `Bimax could not reach the window, so nothing was pressed: ${detail.slice(0, 200)}`);
    }
    if (outcome.kind === 'not_pressed') {
      receipt.outcome = 'not_pressed';
      if (outcome.reason === 'ambiguous') return refuse('ambiguous', `The window now has more than one “${el.label}”. Nothing was pressed. Look again.`);
      if (outcome.reason === 'refused') return refuse('stale', `The press was refused before it was sent (${outcome.detail ?? 'the driver said no'}). Nothing was pressed. Look again.`);
      return refuse('stale', `The window changed since you read it: “${el.label}” is not there just once any more. Nothing was pressed. Look again.`);
    }
    c.inputCalls += 1;
    if (outcome.kind === 'uncertain') {
      receipt.outcome = 'uncertain';
      return refuse('uncertain', `Bimax sent the press but cannot tell whether it happened (${outcome.detail}). Look at the window before doing anything else, and do not press it again to make sure.`);
    }
    c.presses += 1;
    const asked = receipt.asked !== null && receipt.asked !== 'keep_going';
    if (asked) state.typed = undefined; // the person saw the typed text on the card and let this press go
    else { state.lastOpened = el.label; stepsSinceCard.set(threadId, (stepsSinceCard.get(threadId) ?? 0) + 1); }
    const changes = changedLines(outcome.before, outcome.after);
    const changed = renderLook(outcome.before).text !== renderLook(outcome.after).text;
    receipt.outcome = changed ? 'pressed' : 'no_effect';
    // Pressed, then stopped or switched off: say it was pressed, show nothing of the window.
    if (!current()) return refuse('not_permitted', `“${el.label}” was pressed; then the task was stopped or looking was turned off, so the window is not shown.`);
    const reread = rebind(key, look.windowId, outcome.title || look.title, outcome.elements, look.exe);
    if (!changed) {
      return refuse('no_effect', `Pressed “${el.label}”, but nothing in the window changed. It may not have worked. Look again before trying anything else; do not press it again to make sure.`);
    }
    const build = receipt.exeSha256 ? ` — the running build with executable SHA-256 ${receipt.exeSha256}, process ${target.pid}` : '';
    const header = `Pressed “${el.label}” in ${target.name}${outcome.title ? ` (window “${outcome.title}”)` : ''}${build}. What changed in the window:`;
    const body = changes.length ? changes.join('\n') : '(it changed, but no readable line did)';
    return { t: 'host_result', id: msg.id, ok: true, value: { text: `${header}\n${body}${reread ? `\n${NEXT_STEP}` : ''}` } };
  }

  async function typeStep(
    threadId: string, msg: HostCallMsg, c: LookCounts, current: () => boolean, live: () => boolean, refuse: Refuse, cancelled: () => HostResultMsg,
    driver: LookDriver, target: RunningApp, key: string, state: AppState, el: LookElement, boundTo: PressTarget, text: string, receipt: PressReceipt, look: Observation,
  ): Promise<HostResultMsg> {
    let outcome: TypeOutcome;
    try {
      outcome = await driver.type!(threadId, target, boundTo, text);
    } catch (error) {
      if (!live()) return cancelled();
      const detail = error instanceof Error ? error.message : String(error);
      receipt.outcome = 'not_pressed';
      return refuse('unavailable', `Bimax could not reach the window, so nothing was typed: ${detail.slice(0, 200)}`);
    }
    if (outcome.kind === 'not_typed') {
      receipt.outcome = 'not_pressed';
      if (outcome.reason === 'ambiguous') return refuse('ambiguous', `The window now has more than one box “${el.label}”. Nothing was typed. Look again.`);
      if (outcome.reason === 'refused') return refuse('stale', `The typing was refused before it was sent (${outcome.detail ?? 'the driver said no'}). Nothing was typed. This box may not take typing in the background.`);
      return refuse('stale', `The window changed since you read it: the box “${el.label}” is not there just once any more. Nothing was typed. Look again.`);
    }
    c.inputCalls += 1;
    // Whatever landed, a box that is not for searching now holds text Bimax put there: the next press in this app asks.
    const searching = isSearchBox(el.role, el.label);
    const landed = outcome.kind === 'typed' ? outcome.value : null;
    if (!searching) state.typed = { field: el.label, role: el.role, ...(el.at !== undefined ? { at: el.at } : {}), value: landed };
    state.ownText = { role: el.role, ...(el.at !== undefined ? { at: el.at } : {}), value: landed };
    if (outcome.kind === 'uncertain') {
      receipt.outcome = 'uncertain';
      return refuse('uncertain', `Bimax sent the text but cannot tell whether it landed (${outcome.detail}). Look at the window before doing anything else, and do not type it again to make sure.`);
    }
    if (receipt.asked === null) stepsSinceCard.set(threadId, (stepsSinceCard.get(threadId) ?? 0) + 1);
    if (!current()) { receipt.outcome = 'uncertain'; return refuse('not_permitted', 'The text was sent to the box; then the task was stopped or looking was turned off, so the window is not shown.'); }
    const reread = rebind(key, look.windowId, outcome.title || look.title, outcome.elements, look.exe);
    if (outcome.value === null) {
      receipt.outcome = 'uncertain';
      return refuse('uncertain', `Bimax sent the text but could not find the box again to check it. Look at the window before doing anything else, and do not type it again to make sure.`);
    }
    if (outcome.value !== text) {
      const unchanged = outcome.value === (el.value ?? '');
      receipt.outcome = unchanged ? 'no_effect' : 'mismatch';
      return refuse(unchanged ? 'no_effect' : 'uncertain', unchanged
        ? `The text did not land: the box still reads “${quote(outcome.value)}”. This box may not take typing in the background. Nothing else was tried.`
        : `The box reads “${quote(outcome.value)}”, not the text Bimax typed. Look at it before doing anything else.`);
    }
    c.typings += 1;
    receipt.outcome = 'typed';
    const header = `Typed into “${el.label}” in ${target.name}${outcome.title ? ` (window “${outcome.title}”)` : ''}. The box now reads exactly: “${quote(outcome.value, 600)}”.`;
    const note = searching ? '' : '\nNothing was sent: the next press in this app is shown to the person first, with this text.';
    return { t: 'host_result', id: msg.id, ok: true, value: { text: `${header}${note}${reread ? `\n${NEXT_STEP}` : ''}` } };
  }

  /** The Thread stopped or closed: every grant and session it had ends. */
  async function end(threadId: string): Promise<void> {
    generations.set(threadId, (generations.get(threadId) ?? 0) + 1);
    for (const key of [...observations.keys()]) if (key.startsWith(`${threadId}|`)) observations.delete(key);
    for (const key of [...appStates.keys()]) if (key.startsWith(`${threadId}|`)) appStates.delete(key);
    for (const key of [...lookOnly]) if (key.startsWith(`${threadId}|`)) lookOnly.delete(key);
    stepsSinceCard.delete(threadId);
    const had = grants.end(threadId);
    if (had.length) { try { await (await deps.driver()).end(threadId); } catch { /* the driver may never have started */ } }
  }

  /** Turning the preview off revokes existing sessions as well as requests still waiting for an answer. */
  async function revokeAll(): Promise<void> {
    previewGeneration += 1;
    await Promise.all([...counts.keys()].map(end));
  }

  return { handle, end, revokeAll, counts: (threadId: string): LookCounts | undefined => counts.get(threadId), grants };
}

export type LookService = ReturnType<typeof createLookService>;
