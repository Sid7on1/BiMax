import { createHash, randomUUID } from 'node:crypto';
import type { Outbound, Inbound } from '../../renderer/src/protocol';
import { LookGrants } from './look.grants';
import { NEVER_LOOK, isNeverUsed, validBundleId } from './look.manifest';
import { renderLook } from './look.observation';
import { controlSuggestions } from './look.suggestions';
import { commitReasonForPress, commitWordIn, isSearchBox, reasonText, type CommitReason } from './look.commit';
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
export interface LookElement {
  role: string; label: string; pressable: boolean; editable?: boolean; value?: string; inDialog?: boolean; at?: string;
  /** A pop-up button whose items can be picked without opening its menu. */
  pickable?: boolean;
  /** A text box for finding things (its role, its name, or a child control named Search): Return there sends nothing. */
  searchBox?: boolean;
}

export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

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
  look(threadId: string, app: RunningApp, query?: string): Promise<{ title: string; markdown: string; windowId?: number; elements?: LookElement[]; partial?: boolean }>;
  /** One press of one control, in a use session for that app; `front`: with the app brought forward for it (ability 4). */
  press?(threadId: string, app: RunningApp, target: PressTarget, front?: boolean): Promise<PressOutcome>;
  /** Ability 4: empty one box, then type into it with the app brought forward for a moment. */
  typeFront?(threadId: string, app: RunningApp, target: PressTarget, text: string): Promise<TypeOutcome>;
  /** Ability 4: a real Return keystroke into one box, with the app brought forward for a moment. */
  returnFront?(threadId: string, app: RunningApp, target: PressTarget & { at?: string }): Promise<PressOutcome>;
  /** Which app is in front now, by name (null: unknown). */
  frontApp?(): Promise<string | null>;
  /** One typing into one box, in a use session for that app. */
  type?(threadId: string, app: RunningApp, target: PressTarget, text: string): Promise<TypeOutcome>;
  /** Return in one box (its AX confirm), found by role and position when `at` is given. */
  confirm?(threadId: string, app: RunningApp, target: PressTarget & { at?: string }): Promise<PressOutcome>;
  /** One item of a pop-up, chosen without opening its menu; `value` is what the pop-up shows afterwards. */
  pick?(threadId: string, app: RunningApp, target: PressTarget, option: string): Promise<TypeOutcome>;
  /** Scroll the area under one control, in the background. */
  scroll?(threadId: string, app: RunningApp, target: PressTarget, direction: ScrollDirection, pages: number): Promise<PressOutcome>;
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
  /** Pop-up items chosen and read back, and scrolls that moved something. */
  picks: number;
  scrolls: number;
  /** Input calls the app sent to the driver at all — accepted or with an unknown outcome. Zero for a look-only Thread. */
  inputCalls: number;
}

/** One step, as the audit keeps it: which action, bound to which read, whether the person was asked, and the outcome. */
export interface PressReceipt {
  actionId: string;
  action: 'press' | 'type' | 'pick' | 'scroll';
  role: string;
  labelHash: string;
  windowId: number;
  lookAgeMs: number;
  /** Why the person was asked first, or null for an ordinary step that ran without a card. */
  asked: CommitReason['kind'] | 'overwrite' | 'keep_going' | null;
  /** Typing (or the item picked): the text's hash and length, never the text. */
  textHash?: string;
  textLength?: number;
  /** Typing with Return: whether Return was pressed. */
  submitted?: boolean;
  /** Ability 4: the app was brought forward for this step — whether its own card asked, and whether the front app came back. */
  front?: { asked: boolean; before: string | null; after?: string | null; restored?: boolean };
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
const BRING = (name: string) => `Bring ${name} forward once`;
const RETURN = 'Press Return';
const DONT_RETURN = 'Don’t press Return';
const CHOOSE = (option: string) => `Choose “${option}”`;
const DONT_CHOOSE = 'Don’t choose';
const KEEP_GOING = 'Keep going';
const STOP_HERE = 'Stop here';
/** How old the read a step is bound to may be when the step is asked for. */
export const PRESS_FRESH_MS = 2 * 60 * 1000;
/** Steps a task may take in other apps without a card before it is asked whether to keep going. */
export const KEEP_GOING_EVERY = 40;
/** The longest text one typing may set. */
export const MAX_TYPE_CHARS = 2000;
/** The most a single scroll may move, in pages. */
export const MAX_SCROLL_PAGES = 5;
const DIRECTIONS: readonly ScrollDirection[] = ['up', 'down', 'left', 'right'];
/** A pop-up shows the chosen item: compared without case, spaces or invisible marks (the driver matches without case). */
const sameChoice = (shown: string, option: string) => plainName(shown).replace(/\s+/g, ' ').trim().toLowerCase() === plainName(option).replace(/\s+/g, ' ').trim().toLowerCase();
const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);
/**
 * A name without its invisible formatting characters (Unicode Cf: direction marks, zero-width joiners). Measured: the
 * driver names WhatsApp "\u200eWhatsApp", so "WhatsApp" found no app at all.
 */
export const plainName = (name: string) => name.replace(/\p{Cf}/gu, '');
/** Two control names are the same when they differ only in their spaces (no-break, thin, doubled) and invisible marks. */
const sameName = (a: string, b: string) => plainName(a).replace(/\s+/g, ' ').trim() === plainName(b).replace(/\s+/g, ' ').trim();
/** The shortest name a model may give as the start of a longer one: a look shows a line of at most 300 characters. */
export const LONG_NAME_PREFIX = 120;
/**
 * A control the model named: the same name, or — for a long name (measured: a WhatsApp community row runs past 200
 * characters with its last message) — the start of it, at least LONG_NAME_PREFIX characters. Callers still require
 * exactly one match, so a shared start is refused as ambiguous, never guessed.
 */
const isNamed = (label: string, wanted: string) => {
  if (sameName(label, wanted)) return true;
  const w = plainName(wanted).replace(/\s+/g, ' ').trim();
  return w.length >= LONG_NAME_PREFIX && plainName(label).replace(/\s+/g, ' ').trim().startsWith(w);
};
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
    if (!c) { c = { lists: 0, looks: 0, refused: 0, asked: 0, presses: 0, typings: 0, picks: 0, scrolls: 0, inputCalls: 0 }; counts.set(threadId, c); }
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
    const key = plainName(want).trim().toLowerCase();
    const name = (a: RunningApp) => plainName(a.name).trim().toLowerCase();
    if (!key) return null;
    return apps.find((a) => a.bundleId.toLowerCase() === key)
      ?? apps.find((a) => name(a) === key)
      ?? apps.find((a) => name(a).startsWith(key))
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
    if (msg.capability === 'press' || msg.capability === 'type' || msg.capability === 'scroll') return useAnswer(threadId, msg, c, current);
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
      const partial = window.partial ? '\n(Only part of the window could be read in time — the Mac is busy or the window is large. Look again if what you need is missing.)' : '';
      return { t: 'host_result', id: msg.id, ok: true, value: { text: `${header}\n${shown.text || '(nothing readable)'}${partial}` } };
    } catch (error) {
      if (!current()) return revoked();
      c.refused += 1;
      const text = error instanceof Error ? error.message : String(error);
      if (/accessibility|process is not trusted/i.test(text)) {
        return fail(msg.id, 'not_permitted', 'Bimax needs Accessibility permission to read other apps: System Settings → Privacy & Security → Accessibility → turn on Bimax.');
      }
      return fail(msg.id, 'unavailable', `Bimax could not look: ${text.slice(0, 200)}`);
    }
  }

  /**
   * One step in another app: a press (`capability: 'press'`; with `option`, an item picked from a pop-up), a typing
   * (`capability: 'type'`; with `submit`, then Return in that box) or a scroll (`capability: 'scroll'`). Every refusal
   * before the driver is asked says nothing was done; from the driver's call on, the result says exactly what is known.
   */
  async function useAnswer(threadId: string, msg: HostCallMsg, c: LookCounts, current: () => boolean): Promise<HostResultMsg> {
    const typing = msg.capability === 'type';
    const scrolling = msg.capability === 'scroll';
    const raw = (msg.args && typeof msg.args === 'object' && !Array.isArray(msg.args)) ? msg.args as Record<string, unknown> : {};
    const option = !typing && !scrolling && typeof raw.option === 'string' ? raw.option.slice(0, 200).trim() : '';
    const picking = option !== '';
    const nothing = typing ? 'Nothing was typed.' : scrolling ? 'Nothing was scrolled.' : picking ? 'Nothing was chosen.' : 'Nothing was pressed.';
    const live = () => current() && useOn();
    const refuse = (code: string, text: string) => { c.refused += 1; return fail(msg.id, code, text); };
    const cancelled = () => refuse('not_permitted', `This step was cancelled because the task stopped or using other apps was turned off. ${nothing}`);
    if (!deps.enabled() || !useOn()) {
      return refuse('not_permitted', `Using other apps is turned off. The person can turn it on from the Bimax item in the menu bar ("Let Tasks Use Other Apps"). ${nothing}`);
    }
    if (msg.op !== msg.capability) return refuse('invalid_args', `This step has one operation: "${msg.capability}". ${nothing}`);
    // A request is carried out at most once, whatever reaches the app twice.
    const seen = `${threadId}:${msg.id}`;
    if (handledSteps.has(seen)) return refuse('invalid_args', `This request was already handled; it is never carried out twice. ${nothing}`);
    handledSteps.add(seen);

    const args = raw;
    const want = String(args.app ?? '').slice(0, 200).trim();
    const control = String((typing ? args.field : args.control) ?? '').slice(0, 1000).trim();
    const role = typeof args.role === 'string' ? args.role.trim().slice(0, 40) : '';
    const text = typing && typeof args.text === 'string' ? args.text : '';
    if (!want || (!typing && !control)) return refuse('invalid_args', `Say which app, and the name of the control exactly as the look showed it. ${nothing}`);
    if (typing) {
      if (typeof args.text !== 'string') return refuse('invalid_args', `Say what text to type. ${nothing}`);
      if (/[\r\n\u2028\u2029]/.test(text)) return refuse('invalid_args', `Typing never includes a line break: in many apps Return sends. Type one line. ${nothing}`);
      if (text.length > MAX_TYPE_CHARS) return refuse('invalid_args', `At most ${MAX_TYPE_CHARS} characters at a time. ${nothing}`);
    }
    const submit = typing && args.submit === true;
    // Ability 4: this one step with the app brought forward for a moment, on the person's card — never by itself.
    const front = args.front === true;
    if (front && (scrolling || picking)) return refuse('invalid_args', `Bringing an app forward is for one press or one typing; scrolling and choosing work from behind. ${nothing}`);
    const direction = String(args.direction ?? '') as ScrollDirection;
    const pages = Number.isInteger(args.pages) ? Number(args.pages) : 1;
    if (scrolling && !DIRECTIONS.includes(direction)) return refuse('invalid_args', `Say which way to scroll: up, down, left or right. ${nothing}`);
    if (scrolling && (pages < 1 || pages > MAX_SCROLL_PAGES)) return refuse('invalid_args', `Scroll 1 to ${MAX_SCROLL_PAGES} pages at a time. ${nothing}`);
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

      const suggestions = () => controlSuggestions(look.elements, control, typing ? 'type' : scrolling ? 'scroll' : picking ? 'pick' : 'press');

      // Exactly one control (or box) that the read showed. Names compare with all kinds of spaces as one (measured: a
      // model sent "Delete\u00a0Everything", a no-break space).
      let el: LookElement;
      if (typing) {
        const named = control ? look.elements.filter((e) => isNamed(e.label, control) && (!role || e.role === role)) : [];
        if (control && !named.length) return refuse('not_found', `There is no box called “${quote(control, 80)}”${role ? ` (${role})` : ''} in the window you read. ${nothing}${suggestions()}`);
        if (named.some((e) => e.role === 'AXSecureTextField')) return refuse('denied', `“${quote(control, 80)}” is a password field. Bimax never types into one. ${nothing}`);
        const boxes = control ? named.filter((e) => e.editable) : look.elements.filter((e) => e.editable && (!role || e.role === role));
        if (control && !boxes.length) return refuse('not_permitted', `“${quote(control, 80)}” is ${named[0].role}, not a text box Bimax can type into. ${nothing}`);
        if (!boxes.length) return refuse('not_found', `The window you read has no text box Bimax can type into. ${nothing}`);
        if (boxes.length > 1) return refuse('ambiguous', `${boxes.length} text boxes match${control ? ` “${quote(control, 80)}”` : ''}; give the box's name (and role) exactly as the look showed it. Bimax will not guess. ${nothing}`);
        el = boxes[0];
      } else if (scrolling) {
        // Any control the read showed marks the place to scroll — usually a row of the list to move.
        const places = look.elements.filter((e) => isNamed(e.label, control) && (!role || e.role === role));
        if (!places.length) return refuse('not_found', `There is no control called “${quote(control, 80)}”${role ? ` (${role})` : ''} in the window you read: name one inside the list to scroll. ${nothing}${suggestions()}`);
        if (places.length >= 2) return refuse('ambiguous', `${places.length} controls are called “${quote(control, 80)}”; name one that is there once. ${nothing}`);
        el = places[0];
      } else {
        const matches = look.elements.filter((e) => isNamed(e.label, control) && (!role || e.role === role));
        if (!matches.length) return refuse('not_found', `There is no control called “${quote(control, 80)}”${role ? ` (${role})` : ''} in the window you read. ${nothing}${suggestions()}`);
        if (matches.length > 1) return refuse('ambiguous', `${matches.length} controls are called “${quote(control, 80)}”${role ? '' : '; give its role too'}. Bimax will not guess which one. ${nothing}`);
        el = matches[0];
        if (picking) {
          if (!el.pickable) return refuse('not_permitted', `“${quote(control, 80)}” is ${el.role}, not a pop-up menu: press it instead, without "option". ${nothing}`);
        } else if (!el.pressable) {
          return refuse('not_permitted', el.editable
            ? `“${quote(control, 80)}” is a text box: type into it (TypeInAppTool) instead of pressing it. ${nothing}`
            : el.pickable
              ? `“${quote(control, 80)}” is a pop-up menu: give the item to choose as "option" (Bimax picks it without opening the menu). ${nothing}`
              : `“${quote(control, 80)}” is ${el.role} and has no press of its own. ${nothing}`);
        }
      }
      // One read, at most one step — whatever happens from here.
      observations.delete(key);
      const state = appStates.get(key) ?? {};
      appStates.set(key, state);

      const receipt: PressReceipt = {
        actionId: randomUUID(), action: typing ? 'type' : scrolling ? 'scroll' : picking ? 'pick' : 'press', role: el.role, labelHash: hash(el.label), windowId: look.windowId,
        lookAgeMs: age, asked: null, outcome: 'cancelled',
        ...(typing ? { textHash: hash(text), textLength: text.length } : picking ? { textHash: hash(option), textLength: option.length } : {}),
      };
      lastReceipt.set(threadId, receipt);
      // Which app is in front now: the one Bimax promises to put back.
      const frontBefore = front ? ((await (await deps.driver()).frontApp?.()) ?? null) : null;
      if (front && !live()) return cancelled();
      const backTo = frontBefore && frontBefore !== target.name ? frontBefore : 'your current app';
      const frontLine = front
        ? `To do this Bimax brings ${target.name} to the front for about 3 seconds, then puts ${backTo} back. Please don't type until it has.`
        : '';
      if (front) receipt.front = { asked: false, before: frontBefore };

      // Does the person need to see this step first? Only from what the app's tree says and what Bimax did here.
      if (typing) {
        const existing = el.value ?? '';
        const own = state.ownText;
        const ours = own !== undefined && own.role === el.role && own.at !== undefined && own.at === el.at && own.value === existing;
        // A search box's text is a query, not something the person wrote to anyone: replacing it never asks.
        const findBox = el.searchBox === true || isSearchBox(el.role, el.label);
        if (existing.trim() && !ours && !findBox) {
          receipt.asked = 'overwrite';
          c.asked += 1;
          const answer = await deps.ask(
            threadId,
            `Replace the text in “${quote(el.label, 80)}” in ${target.name}?`,
            [REPLACE, DONT_TYPE],
            `The box already holds text Bimax did not type: “${quote(existing)}”.\nTyping replaces all of it with: “${quote(text)}”.\n` +
            `${frontLine ? `${frontLine}\n` : ''}Stopping the task before then cancels it.`,
          );
          if (!live()) return cancelled();
          if (answer !== REPLACE) { receipt.outcome = 'denied'; return refuse('denied', `The person did not let this task replace that text. ${nothing} Ask them what to do.`); }
          stepsSinceCard.set(threadId, 0);
          if (receipt.front) receipt.front.asked = true;
        }
      } else if (picking) {
        // The item is what happens: "Delete" in a pop-up commits as surely as a Delete button. The pop-up's own name counts too.
        const typedHere = state.typed !== undefined;
        const ownWord = commitWordIn(el.label);
        const fromOption = commitReasonForPress({ label: option, inDialog: el.inDialog === true, typedSinceLastCard: typedHere });
        const pickReason: CommitReason | null = fromOption ?? (ownWord ? { kind: 'word', word: ownWord } : null);
        if (pickReason) {
          receipt.asked = pickReason.kind;
          c.asked += 1;
          const lines = [
            reasonText(pickReason, fromOption ? option : el.label),
            look.title ? `Window: “${quote(look.title, 120)}”.` : '',
            `It chooses “${quote(option, 120)}” in the pop-up “${quote(el.label, 80)}” once, in the background, without opening the menu or moving your pointer. Stopping the task before then cancels it.`,
          ].filter(Boolean);
          const answer = await deps.ask(threadId, `Choose “${option}” in “${el.label}” in ${target.name}?`, [CHOOSE(option), DONT_CHOOSE], lines.join('\n'));
          if (!live()) return cancelled();
          if (answer !== CHOOSE(option)) {
            receipt.outcome = 'denied';
            return refuse('denied', `The person did not let this task choose “${option}”. Nothing was chosen. Do not choose it again; ask them what to do.`);
          }
          stepsSinceCard.set(threadId, 0);
        }
      } else if (!scrolling) {
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
            front
              ? `${frontLine} It presses once, without moving your pointer. It checks the window first and presses nothing if it changed. Stopping the task before then cancels it.`
              : 'It presses once, in the background, without moving your pointer. It checks the window first and presses nothing if it changed. Stopping the task before then cancels it.',
          ].filter(Boolean);
          const answer = await deps.ask(threadId, `Press “${el.label}” in ${target.name}?`, [PRESS(el.label), DONT_PRESS], lines.join('\n'));
          if (!live()) return cancelled();
          if (answer !== PRESS(el.label)) {
            receipt.outcome = 'denied';
            return refuse('denied', `The person did not let this task press “${el.label}”. Nothing was pressed. Do not press it again; ask them what to do.`);
          }
          stepsSinceCard.set(threadId, 0);
          if (receipt.front) receipt.front.asked = true;
        }
      }
      // Ability 4: bringing the app forward takes the person's screen, so it is asked every time — on the step's own card
      // when it had one (above), or on this one.
      if (front && receipt.front && !receipt.front.asked) {
        c.asked += 1;
        const step = typing ? `type into “${quote(el.label, 80)}”` : `press “${quote(el.label, 80)}”`;
        const answer = await deps.ask(
          threadId,
          `Bring ${target.name} forward for a moment?`,
          [BRING(target.name), DENY],
          `Some apps only respond to the app in front. For one step — ${step} — Bimax brings ${target.name} to the front for about ` +
          `3 seconds, then puts ${backTo} back. Please don't type until it has. Bimax asks every time.`,
        );
        if (!live()) return cancelled();
        if (answer !== BRING(target.name)) {
          receipt.outcome = 'denied';
          return refuse('denied', `The person did not let this task bring ${target.name} forward. ${nothing} Do not ask again for this step; tell them it needs ${target.name} in front.`);
        }
        receipt.front.asked = true;
        stepsSinceCard.set(threadId, 0);
      }
      // A long run of unasked steps stops for a word from the person.
      if (receipt.asked === null && !receipt.front && (stepsSinceCard.get(threadId) ?? 0) >= KEEP_GOING_EVERY) {
        receipt.asked = 'keep_going';
        c.asked += 1;
        const answer = await deps.ask(
          threadId,
          `Keep going in ${target.name}?`,
          [KEEP_GOING, STOP_HERE],
          `This task has taken ${KEEP_GOING_EVERY} steps in other apps since you were last asked. Next: ${typing ? `type into “${quote(el.label, 80)}”` : scrolling ? `scroll ${direction} at “${quote(el.label, 80)}”` : picking ? `choose “${quote(option, 80)}” in “${quote(el.label, 80)}”` : `press “${quote(el.label, 80)}”`}. ` +
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
      if (typing ? !(front ? driver.typeFront : driver.type) : scrolling ? !driver.scroll : picking ? !driver.pick : !driver.press) return refuse('unavailable', `This Bimax cannot do that step. ${nothing}`);
      const boundTo: PressTarget = { windowId: look.windowId, role: el.role, label: el.label };
      if (typing) return await typeStep(threadId, msg, c, current, live, refuse, cancelled, driver, target, key, state, el, boundTo, text, receipt, look, submit, front, frontLine);
      if (scrolling) return await scrollStep(threadId, msg, c, current, live, refuse, cancelled, driver, target, key, el, boundTo, direction, pages, receipt, look);
      if (picking) return await pickStep(threadId, msg, c, current, live, refuse, cancelled, driver, target, key, el, boundTo, option, receipt, look);
      return await pressStep(threadId, msg, c, current, live, refuse, cancelled, driver, target, key, state, el, boundTo, receipt, look, front);
    } catch (error) {
      if (!live()) return cancelled();
      const detail = error instanceof Error ? error.message : String(error);
      return refuse('unavailable', `Bimax could not do that step: ${detail.slice(0, 200)}. ${nothing}`);
    }
  }

  type Refuse = (code: string, text: string) => HostResultMsg;

  /** The step's own re-read becomes the read the next step is bound to. */
  function rebind(key: string, windowId: number, title: string, elements: LookElement[] | undefined, exe: ProcessIdentity | null | undefined): boolean {
    if (!Array.isArray(elements)) return false;
    observations.set(key, { at: now(), windowId, title, elements, exe });
    return true;
  }

  /**
   * After a step that brought the app forward: is the person's app back in front? Read from the driver's own app list,
   * said plainly either way; Bimax never moves apps around to put it right.
   */
  async function frontReport(driver: LookDriver, receipt: PressReceipt, appName: string): Promise<string> {
    if (!receipt.front) return '';
    const after = (await driver.frontApp?.()) ?? null;
    const before = receipt.front.before;
    receipt.front.after = after;
    receipt.front.restored = before !== null && after === before;
    if (before === null || after === null) return `\nBimax brought ${appName} forward for this step; it could not tell which app is in front now.`;
    return after === before
      ? `\nBimax brought ${appName} forward for this step and put ${before} back in front.`
      : `\n${before} did not come back to the front: ${after} is in front now. Tell the person; do not try to move apps around.`;
  }

  async function pressStep(
    threadId: string, msg: HostCallMsg, c: LookCounts, current: () => boolean, live: () => boolean, refuse: Refuse, cancelled: () => HostResultMsg,
    driver: LookDriver, target: RunningApp, key: string, state: AppState, el: LookElement, boundTo: PressTarget, receipt: PressReceipt, look: Observation,
    front = false,
  ): Promise<HostResultMsg> {
    let outcome: PressOutcome;
    try {
      outcome = front ? await driver.press!(threadId, target, boundTo, true) : await driver.press!(threadId, target, boundTo);
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
    const frontNote = await frontReport(driver, receipt, target.name);
    if (outcome.kind === 'uncertain') {
      receipt.outcome = 'uncertain';
      return refuse('uncertain', `Bimax sent the press but cannot tell whether it happened (${outcome.detail}). Look at the window before doing anything else, and do not press it again to make sure.${frontNote}`);
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
      return refuse('no_effect', `Pressed “${el.label}”, but nothing in the window changed. It may not have worked${front ? '' : ' (some apps only respond to the app in front: the person can let Bimax bring it forward — press again with "front": true)'}. Look again before trying anything else.${frontNote}`);
    }
    const build = receipt.exeSha256 ? ` — the running build with executable SHA-256 ${receipt.exeSha256}, process ${target.pid}` : '';
    const header = `Pressed “${el.label}” in ${target.name}${outcome.title ? ` (window “${outcome.title}”)` : ''}${build}. What changed in the window:`;
    const body = changes.length ? changes.join('\n') : '(it changed, but no readable line did)';
    return { t: 'host_result', id: msg.id, ok: true, value: { text: `${header}\n${body}${frontNote}${reread ? `\n${NEXT_STEP}` : ''}` } };
  }

  async function typeStep(
    threadId: string, msg: HostCallMsg, c: LookCounts, current: () => boolean, live: () => boolean, refuse: Refuse, cancelled: () => HostResultMsg,
    driver: LookDriver, target: RunningApp, key: string, state: AppState, el: LookElement, boundTo: PressTarget, text: string, receipt: PressReceipt, look: Observation,
    submit = false, front = false, frontLine = '',
  ): Promise<HostResultMsg> {
    let outcome: TypeOutcome;
    try {
      // Brought forward: the box is emptied, then typed into as keystrokes, and the person's app put back (ability 4).
      outcome = front ? await driver.typeFront!(threadId, target, boundTo, text) : await driver.type!(threadId, target, boundTo, text);
    } catch (error) {
      if (!live()) return cancelled();
      const detail = error instanceof Error ? error.message : String(error);
      receipt.outcome = 'not_pressed';
      return refuse('unavailable', `Bimax could not reach the window, so nothing was typed: ${detail.slice(0, 200)}`);
    }
    if (outcome.kind === 'not_typed') {
      receipt.outcome = 'not_pressed';
      if (outcome.reason === 'ambiguous') return refuse('ambiguous', `The window now has more than one box “${el.label}”. Nothing was typed. Look again.`);
      if (outcome.reason === 'refused') return refuse('stale', `The typing was refused before it was sent (${outcome.detail ?? 'the driver said no'}). Nothing was typed.${front ? '' : ' This box may not take typing in the background.'}`);
      return refuse('stale', `The window changed since you read it: the box “${el.label}” is not there just once any more. Nothing was typed. Look again.`);
    }
    c.inputCalls += 1;
    const frontNote = await frontReport(driver, receipt, target.name);
    // Whatever landed, a box that is not for searching now holds text Bimax put there: the next press in this app asks.
    const searching = el.searchBox === true || isSearchBox(el.role, el.label);
    const landed = outcome.kind === 'typed' ? outcome.value : null;
    if (!searching) state.typed = { field: el.label, role: el.role, ...(el.at !== undefined ? { at: el.at } : {}), value: landed };
    state.ownText = { role: el.role, ...(el.at !== undefined ? { at: el.at } : {}), value: landed };
    if (outcome.kind === 'uncertain') {
      receipt.outcome = 'uncertain';
      return refuse('uncertain', `Bimax sent the text but cannot tell whether it landed (${outcome.detail}). Look at the window before doing anything else, and do not type it again to make sure.${frontNote}`);
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
        ? `The text did not land: the box still reads “${quote(outcome.value)}”.${front ? '' : ' This box may not take typing in the background: the person can let Bimax bring the app forward — type again with "front": true.'} Nothing else was tried.${frontNote}`
        : `The box reads “${quote(outcome.value)}”, not the text Bimax typed. Look at it before doing anything else.${frontNote}`);
    }
    c.typings += 1;
    receipt.outcome = 'typed';
    const header = `Typed into “${el.label}” in ${target.name}${outcome.title ? ` (window “${outcome.title}”)` : ''}. The box now reads exactly: “${quote(outcome.value, 600)}”.${frontNote}`;
    if (!submit) {
      const note = searching ? '' : '\nNothing was sent: the next press in this app is shown to the person first, with this text.';
      return { t: 'host_result', id: msg.id, ok: true, value: { text: `${header}${note}${reread ? `\n${NEXT_STEP}` : ''}` } };
    }
    // Return in this box. In a search box it runs the search; in any other box it may send what the box holds, so the
    // person sees the box's text first — read back from the screen just now, never the model's words.
    receipt.submitted = false;
    if (!searching) {
      receipt.asked = 'submit';
      c.asked += 1;
      const lines = [
        reasonText({ kind: 'submit' }, el.label),
        look.title ? `Window: “${quote(look.title, 120)}”.` : '',
        state.lastOpened ? `Bimax last opened here: “${quote(state.lastOpened, 120)}”.` : '',
        `The box reads now: “${quote(outcome.value)}”.`,
        front
          ? `${frontLine} It presses Return once, in the box, without moving your pointer. Stopping the task before then cancels it.`
          : 'It presses Return once, in the box, in the background, without moving your pointer. Stopping the task before then cancels it.',
      ].filter(Boolean);
      const answer = await deps.ask(threadId, `Press Return in “${quote(el.label, 80)}” in ${target.name}?`, [RETURN, DONT_RETURN], lines.join('\n'));
      if (!live()) return refuse('not_permitted', `Typed into “${el.label}”; Return was not pressed, because the task stopped or using other apps was turned off. Nothing was sent.`);
      if (answer !== RETURN) return refuse('denied', `Typed into “${el.label}”, but the person did not let this task press Return. Nothing was sent. Do not press Return again; ask them what to do.`);
      stepsSinceCard.set(threadId, 0);
    }
    if (front ? !driver.returnFront : !driver.confirm) return refuse('unavailable', `Typed into “${el.label}”; this Bimax cannot press Return. Nothing was sent.`);
    // The box is found again by where it starts: typing renamed it if the app names it by its text.
    observations.delete(key);
    let confirmed: PressOutcome;
    try {
      // In front, Return is a real keystroke (measured: Music runs its search from nothing else); behind, the box's AX confirm.
      const box = { windowId: look.windowId, role: el.role, label: outcome.value, ...(el.at !== undefined ? { at: el.at } : {}) };
      confirmed = front ? await driver.returnFront!(threadId, target, box) : await driver.confirm!(threadId, target, box);
    } catch (error) {
      if (!live()) return refuse('not_permitted', `Typed into “${el.label}”; Return was not pressed, because the task stopped. Nothing was sent.`);
      const detail = error instanceof Error ? error.message : String(error);
      return refuse('unavailable', `Typed into “${el.label}”, but Bimax could not reach the box, so Return was not pressed: ${detail.slice(0, 200)}`);
    }
    if (confirmed.kind === 'not_pressed') {
      return refuse('stale', `Typed into “${el.label}”, but the box changed before Return, so Return was not pressed (${confirmed.detail ?? confirmed.reason}). Look again.`);
    }
    c.inputCalls += 1;
    const returnNote = front ? await frontReport(driver, receipt, target.name) : '';
    if (confirmed.kind === 'uncertain') {
      return refuse('uncertain', `Typed into “${el.label}” and sent Return, but Bimax cannot tell whether it happened (${confirmed.detail}). Look before doing anything else; do not press Return again to make sure.`);
    }
    receipt.submitted = true;
    if (!searching) state.typed = undefined; // the person saw the text on the card and let Return go
    if (!current()) return refuse('not_permitted', `Typed into “${el.label}” and pressed Return; then the task was stopped, so the window is not shown.`);
    const again = rebind(key, look.windowId, confirmed.title || look.title, confirmed.elements, look.exe);
    const changes = changedLines(outcome.after, confirmed.after);
    if (renderLook(outcome.after).text === renderLook(confirmed.after).text) {
      // A copyable recovery request, from the re-read target. Hint only: it still needs a new read and a foreground
      // card. Never recommend replaying Return in a message/transaction box, or repeating an uncertain input.
      const boxes = (confirmed.elements ?? []).filter(e => e.editable && e.role === el.role &&
        (el.at !== undefined ? e.at === el.at : e.label === el.label));
      const retry = !front && searching && boxes.length === 1 && boxes[0].label.length <= 300
        ? `\nAfter a fresh LookAtAppTool read, if search results are still absent and this box is still the intended target, request this once (Bimax asks the user first):\nTypeInAppTool ${JSON.stringify({ app: target.name, field: boxes[0].label, role: boxes[0].role, text, submit: true, front: true })}` : '';
      return refuse('no_effect', `Typed into “${el.label}” and pressed Return, but nothing in the window changed yet.${front ? '' : ' Some apps only take Return from the app in front: the person can let Bimax bring it forward — type again with "front": true.'} Look again before doing anything else.${returnNote}${retry}`);
    }
    return { t: 'host_result', id: msg.id, ok: true, value: { text: `${header}\nThen pressed Return in it. What changed in the window:\n${changes.length ? changes.join('\n') : '(it changed, but no readable line did)'}${returnNote}${again ? `\n${NEXT_STEP}` : ''}` } };
  }

  async function pickStep(
    threadId: string, msg: HostCallMsg, c: LookCounts, current: () => boolean, live: () => boolean, refuse: Refuse, cancelled: () => HostResultMsg,
    driver: LookDriver, target: RunningApp, key: string, el: LookElement, boundTo: PressTarget, option: string, receipt: PressReceipt, look: Observation,
  ): Promise<HostResultMsg> {
    let outcome: TypeOutcome;
    try {
      outcome = await driver.pick!(threadId, target, boundTo, option);
    } catch (error) {
      if (!live()) return cancelled();
      const detail = error instanceof Error ? error.message : String(error);
      receipt.outcome = 'not_pressed';
      return refuse('unavailable', `Bimax could not reach the window, so nothing was chosen: ${detail.slice(0, 200)}`);
    }
    if (outcome.kind === 'not_typed') {
      receipt.outcome = 'not_pressed';
      if (outcome.reason === 'ambiguous') return refuse('ambiguous', `The window now has more than one pop-up “${el.label}”. Nothing was chosen. Look again.`);
      if (outcome.reason === 'refused') return refuse('not_found', `“${el.label}” did not take “${option}” (${outcome.detail ?? 'the driver said no'}). Nothing was chosen. Check the item's exact name.`);
      return refuse('stale', `The window changed since you read it: the pop-up “${el.label}” is not there just once any more. Nothing was chosen. Look again.`);
    }
    c.inputCalls += 1;
    if (outcome.kind === 'uncertain') {
      receipt.outcome = 'uncertain';
      return refuse('uncertain', `Bimax sent the choice but cannot tell whether it happened (${outcome.detail}). Look at the window before doing anything else; do not choose it again to make sure.`);
    }
    if (receipt.asked === null) stepsSinceCard.set(threadId, (stepsSinceCard.get(threadId) ?? 0) + 1);
    if (!current()) { receipt.outcome = 'uncertain'; return refuse('not_permitted', 'The choice was sent; then the task was stopped, so the window is not shown.'); }
    const reread = rebind(key, look.windowId, outcome.title || look.title, outcome.elements, look.exe);
    if (outcome.value === null) {
      receipt.outcome = 'uncertain';
      return refuse('uncertain', `Bimax sent the choice but could not find the pop-up again to check it. Look before doing anything else.`);
    }
    if (!sameChoice(outcome.value, option)) {
      const unchanged = outcome.value === (el.value ?? '');
      receipt.outcome = unchanged ? 'no_effect' : 'mismatch';
      return refuse(unchanged ? 'no_effect' : 'uncertain', unchanged
        ? `The pop-up “${el.label}” still shows “${quote(outcome.value)}”: “${option}” was not chosen. Nothing else was tried.`
        : `The pop-up “${el.label}” shows “${quote(outcome.value)}”, not “${option}”. Look at it before doing anything else.`);
    }
    c.picks += 1;
    receipt.outcome = 'pressed';
    const changes = changedLines(outcome.before, outcome.after);
    return { t: 'host_result', id: msg.id, ok: true, value: { text: `Chose “${outcome.value}” in “${el.label}” in ${target.name}. What changed in the window:\n${changes.length ? changes.join('\n') : '(no readable line changed)'}${reread ? `\n${NEXT_STEP}` : ''}` } };
  }

  async function scrollStep(
    threadId: string, msg: HostCallMsg, c: LookCounts, current: () => boolean, live: () => boolean, refuse: Refuse, cancelled: () => HostResultMsg,
    driver: LookDriver, target: RunningApp, key: string, el: LookElement, boundTo: PressTarget, direction: ScrollDirection, pages: number, receipt: PressReceipt, look: Observation,
  ): Promise<HostResultMsg> {
    let outcome: PressOutcome;
    try {
      outcome = await driver.scroll!(threadId, target, boundTo, direction, pages);
    } catch (error) {
      if (!live()) return cancelled();
      const detail = error instanceof Error ? error.message : String(error);
      receipt.outcome = 'not_pressed';
      return refuse('unavailable', `Bimax could not reach the window, so nothing was scrolled: ${detail.slice(0, 200)}`);
    }
    if (outcome.kind === 'not_pressed') {
      receipt.outcome = 'not_pressed';
      if (outcome.reason === 'ambiguous') return refuse('ambiguous', `The window now has more than one “${el.label}”. Nothing was scrolled. Look again.`);
      if (outcome.reason === 'refused') return refuse('stale', `The scroll was refused before it was sent (${outcome.detail ?? 'the driver said no'}). Nothing was scrolled. Look again.`);
      return refuse('stale', `The window changed since you read it: “${el.label}” is not there just once any more. Nothing was scrolled. Look again.`);
    }
    c.inputCalls += 1;
    if (outcome.kind === 'uncertain') {
      receipt.outcome = 'uncertain';
      return refuse('uncertain', `Bimax sent the scroll but cannot tell whether it happened (${outcome.detail}). Look at the window before doing anything else.`);
    }
    if (receipt.asked === null) stepsSinceCard.set(threadId, (stepsSinceCard.get(threadId) ?? 0) + 1);
    if (!current()) return refuse('not_permitted', 'Scrolled; then the task was stopped, so the window is not shown.');
    const reread = rebind(key, look.windowId, outcome.title || look.title, outcome.elements, look.exe);
    const moved = renderLook(outcome.before).text !== renderLook(outcome.after).text;
    receipt.outcome = moved ? 'pressed' : 'no_effect';
    if (!moved) return refuse('no_effect', `Scrolled ${direction} at “${el.label}”, but nothing moved: the end of the list, or this place does not scroll. Look at what is there before trying elsewhere.`);
    c.scrolls += 1;
    const changes = changedLines(outcome.before, outcome.after);
    return { t: 'host_result', id: msg.id, ok: true, value: { text: `Scrolled ${direction} in ${target.name}. What changed in the window:\n${changes.join('\n')}${reread ? `\n${NEXT_STEP}` : ''}` } };
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
