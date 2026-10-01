import { createHash, randomUUID } from 'node:crypto';
import type { Outbound, Inbound } from '../../renderer/src/protocol';
import { LookGrants } from './look.grants';
import { NEVER_LOOK, PRESS_APPS, validBundleId } from './look.manifest';
import { renderLook } from './look.observation';

/**
 * The app's answer to a Bimax Thread asking to look at another app's window (record 65, stage 2).
 *
 * Order of checks, each before the next costs anything: the person turned looking on (the menu bar item) → the
 * request is one of the two this capability has → the app exists and is not one a task never looks at → the person
 * allowed it for this Thread on a card this app raised → the driver, in a look-only session for that one app. The
 * engine only ever gets text: the window, with the menu bar cut out and password fields blank.
 *
 * Stage 3 adds one press at a time (`capability: 'press'`), checked in this order and again after every wait: pressing
 * is on (its own menu bar item) → the app is on PRESS_APPS (the test app only) → this Thread may look at it → a look
 * of it is fresh (PRESS_FRESH_MS) and has not been used for a press yet → exactly one named, pressable control in it
 * matches → the person allows THIS press on the app's card (every time; the engine has already asked once too) → no
 * Stop and no switch turned off since → the driver re-reads the window, still finds exactly that control, and presses
 * it once, never retrying → the window is read again and the result says whether anything changed.
 */

type HostCallMsg = Extract<Outbound, { t: 'host_call' }>;
type HostResultMsg = Extract<Inbound, { t: 'host_result' }>;

export interface RunningApp { name: string; bundleId: string; pid: number }

/** A control a look showed (stage 3): enough to bind a later press to it — never the driver's token. */
export interface LookElement { role: string; label: string; pressable: boolean }

/** What a press is bound to: the window a look read, and one control in it by role and name. */
export interface PressTarget { windowId: number; role: string; label: string }

/** One press. Anything that fails before the click throws (nothing was pressed); from the click on, it is returned. */
export type PressOutcome =
  | { kind: 'pressed'; title: string; before: string; after: string }
  | { kind: 'not_pressed'; reason: 'changed' | 'ambiguous' | 'refused'; detail?: string }
  | { kind: 'uncertain'; detail: string };

/** The driver as this service needs it. The real one is look.driver.ts; tests give a fake. */
export interface LookDriver {
  runningApps(): Promise<RunningApp[]>;
  /** The app's front window, read only, in a session scoped to that app for this Thread. */
  look(threadId: string, app: RunningApp, query?: string): Promise<{ title: string; markdown: string; windowId?: number; elements?: LookElement[] }>;
  /** Stage 3: one press of one control, for an app on PRESS_APPS, in its own press session. */
  press?(threadId: string, app: RunningApp, target: PressTarget): Promise<PressOutcome>;
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
  /** Stage 3: the person also turned pressing on (its own menu bar item, off by default). Read at every step. */
  pressEnabled?(): boolean;
  /** The clock a look's freshness is measured by. Tests set it. */
  now?(): number;
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
  /** A press's receipt (stage 3), content-free: the control's name only as a hash. */
  receipt?: PressReceipt;
}

/** What the app did for each Thread, counted by the app itself — never taken from the model's account of it. */
export interface LookCounts {
  lists: number; looks: number; refused: number; asked: number;
  /** Presses the driver accepted (stage 3). */
  presses: number;
  /** Input calls the app sent to the driver at all — accepted or with an unknown outcome. Zero for a look-only Thread. */
  inputCalls: number;
}

/** One press, as the audit keeps it: which action, bound to which look, and what came of it. */
export interface PressReceipt {
  actionId: string;
  role: string;
  labelHash: string;
  windowId: number;
  lookAgeMs: number;
  outcome: 'pressed' | 'no_effect' | 'not_pressed' | 'uncertain' | 'cancelled' | 'denied';
}

const ALLOW = (name: string) => `Allow looking at ${name}`;
const DENY = 'Not now';
const PRESS = (label: string) => `Press “${label}”`;
const DONT_PRESS = 'Don’t press';
/** How old the look a press is bound to may be when the press is asked for. */
export const PRESS_FRESH_MS = 2 * 60 * 1000;
const ROLE_WORD: Record<string, string> = { AXButton: 'button', AXCheckBox: 'checkbox', AXRadioButton: 'radio button' };
const hashLabel = (label: string) => createHash('sha256').update(label).digest('hex').slice(0, 12);
/** Two control names are the same when they differ only in their spaces (no-break, thin, doubled). Nothing else. */
const sameName = (a: string, b: string) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

/** What a press changed, as the model will read it: lines gone and lines new, from the same rendering a look uses. */
function changedLines(before: string, after: string): string[] {
  const a = renderLook(before).text.split('\n').map((l) => l.trim()).filter(Boolean);
  const b = renderLook(after).text.split('\n').map((l) => l.trim()).filter(Boolean);
  return [...a.filter((l) => !b.includes(l)).map((l) => `- ${l}`), ...b.filter((l) => !a.includes(l)).map((l) => `+ ${l}`)].slice(0, 40);
}

const fail = (id: number, code: string, error: string): HostResultMsg => ({ t: 'host_result', id, ok: false, error, value: { code } });

export function createLookService(deps: LookServiceDeps) {
  const grants = new LookGrants();
  const counts = new Map<string, LookCounts>();
  // A stopped Thread or an off/on cycle invalidates requests already waiting on discovery, a card or a read.
  const generations = new Map<string, number>();
  let previewGeneration = 0;
  const count = (threadId: string): LookCounts => {
    let c = counts.get(threadId);
    if (!c) { c = { lists: 0, looks: 0, refused: 0, asked: 0, presses: 0, inputCalls: 0 }; counts.set(threadId, c); }
    return c;
  };
  const now = () => (deps.now ? deps.now() : Date.now());
  // Stage 3: the last look of each app per Thread, which at most one press may use; and every press request seen.
  const observations = new Map<string, { at: number; windowId: number; title: string; elements: LookElement[] }>();
  const handledPresses = new Set<string>();
  const lastReceipt = new Map<string, PressReceipt>();

  async function find(want: string): Promise<RunningApp | null> {
    const apps = await (await deps.driver()).runningApps();
    const key = want.trim().toLowerCase();
    return apps.find((a) => a.bundleId.toLowerCase() === key)
      ?? apps.find((a) => a.name.toLowerCase() === key)
      ?? apps.find((a) => a.name.toLowerCase().startsWith(key))
      ?? null;
  }

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

  const lastTarget = new Map<string, string>();

  async function answer(threadId: string, msg: HostCallMsg): Promise<HostResultMsg> {
    const c = count(threadId);
    const generation = generations.get(threadId) ?? 0;
    const preview = previewGeneration;
    const current = () => deps.enabled() && preview === previewGeneration && generation === (generations.get(threadId) ?? 0);
    const revoked = () => {
      c.refused += 1;
      return fail(msg.id, 'not_permitted', 'This look was cancelled because the task stopped or looking was turned off.');
    };
    if (msg.capability === 'press') return pressAnswer(threadId, msg, c, current);
    if (msg.capability !== 'look') { c.refused += 1; return fail(msg.id, 'invalid_args', 'Bimax has no such capability.'); }
    if (!deps.enabled()) {
      c.refused += 1;
      return fail(msg.id, 'not_permitted', 'Looking at other apps is turned off. The person can turn it on from the Bimax item in the menu bar ("Let Tasks Look at Other Apps").');
    }
    const args = (msg.args && typeof msg.args === 'object' && !Array.isArray(msg.args)) ? msg.args as Record<string, unknown> : {};
    try {
      if (msg.op === 'list_apps') {
        const apps = (await (await deps.driver()).runningApps()).filter((a) => !NEVER_LOOK.has(a.bundleId));
        if (!current()) return revoked();
        c.lists += 1;
        const text = apps.length ? apps.map((a) => `${a.name} (${a.bundleId})`).join('\n') : '(no apps with windows are open)';
        return { t: 'host_result', id: msg.id, ok: true, value: { text } };
      }
      if (msg.op !== 'look') { c.refused += 1; return fail(msg.id, 'invalid_args', 'Only "list_apps" and "look" are possible: Bimax can look, not act.'); }

      const want = String(args.app ?? '').slice(0, 200);
      if (!want.trim()) { c.refused += 1; return fail(msg.id, 'invalid_args', 'Say which app to look at.'); }
      const target = await find(want);
      if (!current()) return revoked();
      if (!target) { c.refused += 1; return fail(msg.id, 'not_found', `No open app is called "${want}". Use list_apps to see what is open.`); }
      lastTarget.set(threadId, target.bundleId);
      if (NEVER_LOOK.has(target.bundleId) || !validBundleId(target.bundleId)) {
        c.refused += 1;
        return fail(msg.id, 'denied', `${target.name} is never looked at: it shows passwords, keys or Bimax's own approvals.`);
      }

      let decision = grants.decision(threadId, target.bundleId);
      if (decision === 'unasked') {
        c.asked += 1;
        const answer = await deps.ask(
          threadId,
          `Let this task look at ${target.name}?`,
          [ALLOW(target.name), DENY],
          `Bimax will read what is in ${target.name}'s front window — its buttons, fields, lists and text — and nothing else. ` +
          `It cannot click, type or change anything there. This is for this task only; stopping the task ends it.`,
        );
        if (!current()) return revoked();
        if (answer === ALLOW(target.name)) grants.allow(threadId, target.bundleId); else grants.refuse(threadId, target.bundleId);
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
      const shown = renderLook(window.markdown);
      c.looks += 1;
      // Stage 3: what this look showed is what one later press may be bound to.
      if (typeof window.windowId === 'number' && Array.isArray(window.elements)) {
        observations.set(`${threadId}|${target.bundleId}`, { at: now(), windowId: window.windowId, title: window.title, elements: window.elements });
      }
      const header = `${target.name} — ${window.title ? `window “${window.title}”` : 'front window'} (read only${query ? `, lines matching “${query}”` : ''}):`;
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
   * Stage 3: one press. Every refusal before the driver is asked says "Nothing was pressed"; from the driver's click on,
   * the result says exactly what is known — pressed and changed, pressed and nothing changed, or unknown.
   */
  async function pressAnswer(threadId: string, msg: HostCallMsg, c: LookCounts, current: () => boolean): Promise<HostResultMsg> {
    const pressOn = () => deps.pressEnabled?.() === true;
    const live = () => current() && pressOn();
    const refuse = (code: string, text: string) => { c.refused += 1; return fail(msg.id, code, text); };
    const cancelled = () => refuse('not_permitted', 'This press was cancelled because the task stopped or pressing was turned off. Nothing was pressed.');
    if (!deps.enabled() || !pressOn()) {
      return refuse('not_permitted', 'Pressing in other apps is turned off. The person can turn it on from the Bimax item in the menu bar ("Let Tasks Press Buttons in the Test App").');
    }
    if (msg.op !== 'press') return refuse('invalid_args', 'Pressing has one operation: "press".');
    // A request is carried out at most once, whatever reaches the app twice.
    const seen = `${threadId}:${msg.id}`;
    if (handledPresses.has(seen)) return refuse('invalid_args', 'This press request was already handled; it is never carried out twice.');
    handledPresses.add(seen);

    const args = (msg.args && typeof msg.args === 'object' && !Array.isArray(msg.args)) ? msg.args as Record<string, unknown> : {};
    const want = String(args.app ?? '').slice(0, 200).trim();
    const control = String(args.control ?? '').slice(0, 200).trim();
    const role = typeof args.role === 'string' ? args.role.trim().slice(0, 40) : '';
    if (!want || !control) return refuse('invalid_args', 'Say which app, and the name of the control exactly as the look showed it.');
    try {
      const target = await find(want);
      if (!live()) return cancelled();
      if (!target) return refuse('not_found', `No open app is called "${want}". Nothing was pressed.`);
      lastTarget.set(threadId, target.bundleId);
      if (!PRESS_APPS.has(target.bundleId) || NEVER_LOOK.has(target.bundleId)) {
        return refuse('not_permitted', `In this preview Bimax presses only in its own test app; ${target.name} can be looked at, not pressed. Nothing was pressed.`);
      }
      const key = `${threadId}|${target.bundleId}`;
      const look = observations.get(key);
      if (grants.decision(threadId, target.bundleId) !== 'allowed' || !look) {
        return refuse('stale', `Look at ${target.name} first (LookAtAppTool): a press is bound to what a look just showed, and each look allows one press. Nothing was pressed.`);
      }
      const age = now() - look.at;
      if (age > PRESS_FRESH_MS) {
        observations.delete(key);
        return refuse('stale', `The window was read ${Math.round(age / 1000)} s ago, too long to press from. Look again first. Nothing was pressed.`);
      }
      // Names compare with all kinds of spaces as one (measured: a model sent "Delete\u00a0Everything", a no-break space).
      const matches = look.elements.filter((e) => sameName(e.label, control) && (!role || e.role === role));
      if (!matches.length) return refuse('not_found', `There is no control called “${control}”${role ? ` (${role})` : ''} in the window you read. Nothing was pressed.`);
      if (matches.length > 1) {
        return refuse('ambiguous', `${matches.length} controls are called “${control}”${role ? '' : '; give its role too'}. Bimax will not guess which one. Nothing was pressed.`);
      }
      const el = matches[0];
      if (!el.pressable) return refuse('not_permitted', `“${control}” is ${el.role}; only an enabled button, checkbox or radio button can be pressed. Nothing was pressed.`);
      // One look, at most one press — whatever happens from here.
      observations.delete(key);

      const receipt: PressReceipt = { actionId: randomUUID(), role: el.role, labelHash: hashLabel(el.label), windowId: look.windowId, lookAgeMs: age, outcome: 'cancelled' };
      lastReceipt.set(threadId, receipt);
      // The app's card: every press, no "for this task" — after the engine's own card, which no mode skips either.
      c.asked += 1;
      const answer = await deps.ask(
        threadId,
        `Press “${el.label}” in ${target.name}?`,
        [PRESS(el.label), DONT_PRESS],
        `Bimax will press the ${ROLE_WORD[el.role] ?? 'control'} “${el.label}” in ${target.name}${look.title ? `’s window “${look.title}”` : ''}, once, ` +
        `without moving your pointer or bringing the app forward. It checks the window again first and presses nothing if it changed. ` +
        `Stopping the task before then cancels it.`,
      );
      if (!live()) return cancelled();
      if (answer !== PRESS(el.label)) {
        receipt.outcome = 'denied';
        return refuse('denied', `The person did not let this task press “${el.label}”. Nothing was pressed. Do not press it again; ask them what to do.`);
      }
      const driver = await deps.driver();
      if (!live()) return cancelled();
      if (!driver.press) return refuse('unavailable', 'This Bimax cannot press. Nothing was pressed.');

      let outcome: PressOutcome;
      try {
        outcome = await driver.press(threadId, target, { windowId: look.windowId, role: el.role, label: el.label });
      } catch (error) {
        // Thrown means before the click: nothing was pressed.
        if (!live()) return cancelled();
        const text = error instanceof Error ? error.message : String(error);
        receipt.outcome = 'not_pressed';
        return refuse('unavailable', `Bimax could not reach the window, so nothing was pressed: ${text.slice(0, 200)}`);
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
      const changes = changedLines(outcome.before, outcome.after);
      const changed = renderLook(outcome.before).text !== renderLook(outcome.after).text;
      receipt.outcome = changed ? 'pressed' : 'no_effect';
      // Pressed, then stopped or switched off: say it was pressed, show nothing of the window.
      if (!current()) return refuse('not_permitted', `“${el.label}” was pressed; then the task was stopped or looking was turned off, so the window is not shown.`);
      if (!changed) {
        return refuse('no_effect', `Pressed “${el.label}”, but nothing in the window changed. It may not have worked. Look again before trying anything else; do not press it again to make sure.`);
      }
      const header = `Pressed “${el.label}” in ${target.name}${outcome.title ? ` (window “${outcome.title}”)` : ''}. What changed in the window:`;
      return { t: 'host_result', id: msg.id, ok: true, value: { text: `${header}\n${changes.length ? changes.join('\n') : '(it changed, but no readable line did)'}` } };
    } catch (error) {
      if (!live()) return cancelled();
      const text = error instanceof Error ? error.message : String(error);
      return refuse('unavailable', `Bimax could not press: ${text.slice(0, 200)}. Nothing was pressed.`);
    }
  }

  /** The Thread stopped or closed: every grant and session it had ends. */
  async function end(threadId: string): Promise<void> {
    generations.set(threadId, (generations.get(threadId) ?? 0) + 1);
    for (const key of [...observations.keys()]) if (key.startsWith(`${threadId}|`)) observations.delete(key);
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
