import type { Outbound, Inbound } from '../../renderer/src/protocol';
import { LookGrants } from './look.grants';
import { NEVER_LOOK, validBundleId } from './look.manifest';
import { renderLook } from './look.observation';

/**
 * The app's answer to a Bimax Thread asking to look at another app's window (record 65, stage 2).
 *
 * Order of checks, each before the next costs anything: the person turned looking on (the menu bar item) → the
 * request is one of the two this capability has → the app exists and is not one a task never looks at → the person
 * allowed it for this Thread on a card this app raised → the driver, in a look-only session for that one app. The
 * engine only ever gets text: the window, with the menu bar cut out and password fields blank.
 */

type HostCallMsg = Extract<Outbound, { t: 'host_call' }>;
type HostResultMsg = Extract<Inbound, { t: 'host_result' }>;

export interface RunningApp { name: string; bundleId: string; pid: number }

/** The driver as this service needs it. The real one is look.driver.ts; tests give a fake. */
export interface LookDriver {
  runningApps(): Promise<RunningApp[]>;
  /** The app's front window, read only, in a session scoped to that app for this Thread. */
  look(threadId: string, app: RunningApp, query?: string): Promise<{ title: string; markdown: string }>;
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
}

/** What the app did for each Thread, counted by the app itself — never taken from the model's account of it. */
export interface LookCounts { lists: number; looks: number; refused: number; asked: number; inputCalls: 0 }

const ALLOW = (name: string) => `Allow looking at ${name}`;
const DENY = 'Not now';

const fail = (id: number, code: string, error: string): HostResultMsg => ({ t: 'host_result', id, ok: false, error, value: { code } });

export function createLookService(deps: LookServiceDeps) {
  const grants = new LookGrants();
  const counts = new Map<string, LookCounts>();
  const count = (threadId: string): LookCounts => {
    let c = counts.get(threadId);
    if (!c) { c = { lists: 0, looks: 0, refused: 0, asked: 0, inputCalls: 0 }; counts.set(threadId, c); }
    return c;
  };

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
      });
    } catch { /* the log must never change the answer */ }
    lastTarget.delete(threadId);
    return result;
  }

  const lastTarget = new Map<string, string>();

  async function answer(threadId: string, msg: HostCallMsg): Promise<HostResultMsg> {
    const c = count(threadId);
    if (msg.capability !== 'look') { c.refused += 1; return fail(msg.id, 'invalid_args', 'Bimax has no such capability.'); }
    if (!deps.enabled()) {
      c.refused += 1;
      return fail(msg.id, 'not_permitted', 'Looking at other apps is turned off. The person can turn it on from the Bimax item in the menu bar ("Let Tasks Look at Other Apps").');
    }
    const args = (msg.args && typeof msg.args === 'object' && !Array.isArray(msg.args)) ? msg.args as Record<string, unknown> : {};
    try {
      if (msg.op === 'list_apps') {
        const apps = (await (await deps.driver()).runningApps()).filter((a) => !NEVER_LOOK.has(a.bundleId));
        c.lists += 1;
        const text = apps.length ? apps.map((a) => `${a.name} (${a.bundleId})`).join('\n') : '(no apps with windows are open)';
        return { t: 'host_result', id: msg.id, ok: true, value: { text } };
      }
      if (msg.op !== 'look') { c.refused += 1; return fail(msg.id, 'invalid_args', 'Only "list_apps" and "look" are possible: Bimax can look, not act.'); }

      const want = String(args.app ?? '').slice(0, 200);
      if (!want.trim()) { c.refused += 1; return fail(msg.id, 'invalid_args', 'Say which app to look at.'); }
      const target = await find(want);
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
        if (answer === ALLOW(target.name)) grants.allow(threadId, target.bundleId); else grants.refuse(threadId, target.bundleId);
        decision = grants.decision(threadId, target.bundleId);
      }
      if (decision !== 'allowed') {
        c.refused += 1;
        return fail(msg.id, 'denied', `The person did not let this task look at ${target.name}. Do not ask again; carry on without it or ask them what to do.`);
      }

      const query = typeof args.query === 'string' && args.query.trim() ? args.query.slice(0, 200) : undefined;
      const window = await (await deps.driver()).look(threadId, target, query);
      const shown = renderLook(window.markdown);
      c.looks += 1;
      const header = `${target.name} — ${window.title ? `window “${window.title}”` : 'front window'} (read only${query ? `, lines matching “${query}”` : ''}):`;
      return { t: 'host_result', id: msg.id, ok: true, value: { text: `${header}\n${shown.text || '(nothing readable)'}` } };
    } catch (error) {
      c.refused += 1;
      const text = error instanceof Error ? error.message : String(error);
      if (/accessibility|not trusted|permission/i.test(text)) {
        return fail(msg.id, 'not_permitted', 'Bimax needs Accessibility permission to read other apps: System Settings → Privacy & Security → Accessibility → turn on Bimax.');
      }
      return fail(msg.id, 'unavailable', `Bimax could not look: ${text.slice(0, 200)}`);
    }
  }

  /** The Thread stopped or closed: every grant and session it had ends. */
  async function end(threadId: string): Promise<void> {
    const had = grants.end(threadId);
    if (had.length) { try { await (await deps.driver()).end(threadId); } catch { /* the driver may never have started */ } }
  }

  return { handle, end, counts: (threadId: string): LookCounts | undefined => counts.get(threadId), grants };
}

export type LookService = ReturnType<typeof createLookService>;
