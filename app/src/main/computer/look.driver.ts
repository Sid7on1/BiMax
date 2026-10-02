import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LookDriver, LookElement, PressOutcome, PressTarget, RunningApp, ScrollDirection, TypeOutcome } from './look.service';
import { PICK_ROLES, PRESS_EXCLUDED_ROLES, TYPE_ROLES, lookManifest, runtimeManifest, useManifest } from './look.manifest';
import { DIALOG_ROLES } from './look.commit';

/**
 * Cua Driver 0.31, embedded in this process: look (record 65, stage 2) and, in an app the person let the task use, one
 * step at a time — press, type, Return in a box, pick from a pop-up, scroll (stage 3, widened by stage 6 §6h).
 *
 * In-process (`@trycua/cua-driver`, no daemon), so macOS attributes Accessibility to Bimax itself. Loaded on the first
 * look a person allowed — never at launch, so a coding task never loads it and never meets a permission prompt. The
 * runtime is `bounded`: its own manifest lets it list apps and nothing else, and each grant opens a trusted session
 * whose manifest names that one app and denies every input tool. The driver enforces both, so a defect in Bimax's own
 * checks still cannot make it click.
 *
 * Packaged, the SDK is imported from app.asar.unpacked by its real path: it hands its native library's path to
 * `dlopen`, which cannot read inside an asar archive.
 */

export interface DriverActivity { authorized: Record<string, number>; refused: Record<string, number> }

/** The input tools among a tally — the stage's proof is that this is always empty for `authorized`. */
export function inputToolsIn(counts: Record<string, number>, inputTools: readonly string[]): string[] {
  return Object.keys(counts).filter((tool) => inputTools.includes(tool) && counts[tool] > 0);
}

interface Session { session: any; manifest: string }

/** A control in the window's own tree (never the menu bar), with the token a press needs. Internal: tokens stay here. */
interface WindowElement extends LookElement { token: string }

/**
 * The controls inside the window — under its AXWindow, never under the menu bar the driver also returns (the model
 * never sees the menu bar, so it can never be pressed). Only named ones: a control without a name cannot be asked
 * about on a card or matched again before a press. Pressable: any enabled control whose own AX action is a press,
 * except those that open a menu or take text (PRESS_EXCLUDED_ROLES). Editable: an enabled text box (TYPE_ROLES) — never
 * a password field. A text box with no title is named by its value, so its name changes as text goes in; a box is
 * found again after typing by its role and where it starts on screen (`at`).
 */
export function windowElements(raw: unknown): WindowElement[] {
  const list: any[] = Array.isArray(raw) ? raw : [];
  const byIndex = new Map<number, any>(list.map((e) => [Number(e?.element_index), e]));
  const ancestry = (e: any): { inWindow: boolean; inDialog: boolean } => {
    let inDialog = false;
    for (let cur = byIndex.get(Number(e.parent_index)), hops = 0; cur && hops < 64; cur = byIndex.get(Number(cur.parent_index)), hops++) {
      if (cur.role === 'AXMenuBar') return { inWindow: false, inDialog };
      if (DIALOG_ROLES.has(cur.role)) inDialog = true;
      if (cur.role === 'AXWindow') return { inWindow: true, inDialog };
      if (cur.parent_index === undefined) break;
    }
    return { inWindow: false, inDialog };
  };
  // A text box with a child control named Search (or Find) is a search box, whatever text it shows (measured: Music's
  // toolbar search field reads "Apple Music", with a Search button inside it).
  const searchParents = new Set<number>(list
    .filter((e) => e && typeof e.label === 'string' && /^\s*(search|find)\s*$/i.test(e.label.replace(/\p{Cf}/gu, '')) && e.parent_index !== undefined)
    .map((e) => Number(e.parent_index)));
  const out: WindowElement[] = [];
  for (const e of list) {
    if (!e || typeof e.role !== 'string' || typeof e.label !== 'string' || !e.label.trim() || e.role === 'AXWindow' || e.role === 'AXMenuBar') continue;
    const place = ancestry(e);
    if (!place.inWindow) continue;
    const role = String(e.role);
    const enabled = e.enabled !== false;
    const frame = e.frame && typeof e.frame === 'object' ? e.frame : null;
    out.push({
      role,
      label: String(e.label),
      pressable: enabled && !PRESS_EXCLUDED_ROLES.has(role) && Array.isArray(e.actions) && e.actions.includes('AXPress'),
      editable: enabled && TYPE_ROLES.has(role),
      ...(enabled && PICK_ROLES.has(role) ? { pickable: true } : {}),
      // A box's text, or a pop-up's chosen item — never a button's value (measured: a chat row's value is its last message).
      ...(TYPE_ROLES.has(role) || PICK_ROLES.has(role) ? { value: typeof e.value === 'string' ? e.value : '' } : {}),
      inDialog: place.inDialog,
      ...(TYPE_ROLES.has(role) && (role === 'AXSearchField' || searchParents.has(Number(e.element_index))) ? { searchBox: true } : {}),
      ...(frame && Number.isFinite(Number(frame.x)) && Number.isFinite(Number(frame.y)) ? { at: `${Math.round(Number(frame.x))},${Math.round(Number(frame.y))}` } : {}),
      token: String(e.element_token ?? ''),
    });
  }
  return out;
}

/** What a look or a re-read hands the service: the controls without their tokens (tokens never leave this file). */
const shown = (els: WindowElement[]): LookElement[] => els.map(({ token, ...rest }) => { void token; return rest; });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The time one window read may take. The driver's default (1 s) walks the menu bar first and, on a busy Mac, ran out
 * before the window: measured 2026-10-02, Music read as 2 controls instead of 115. A read still cut short says so.
 */
export const READ_TIMEOUT_MS = 4000;

/** Wheel notches per page the model asks for (the driver's `by: page` step is small: measured 2 notches ≈ one chat row). */
export const SCROLL_NOTCHES_PER_PAGE = 5;

export interface LookDriverOptions {
  /** Where the manifests are written (0700 folder, 0600 files); removed with each session. */
  stateDir: string;
  packaged: boolean;
  resourcesPath: string;
  /** app.getAppPath(): where node_modules is when not packaged. */
  appPath: string;
}

/** Always a real file path: a computed import() of a bare name would resolve from the working folder, not from here. */
export function sdkEntry(o: Pick<LookDriverOptions, 'packaged' | 'resourcesPath' | 'appPath'>): string {
  const base = o.packaged ? path.join(o.resourcesPath, 'app.asar.unpacked') : o.appPath;
  return pathToFileURL(path.join(base, 'node_modules', '@trycua', 'cua-driver', 'dist', 'index.js')).href;
}

// Kept out of the bundler's reach: the specifier is computed, and the module is ESM-only while this bundle is CJS.
const importEsm = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<any>;

export function createLookDriver(options: LookDriverOptions): LookDriver & { activity(threadId: string): DriverActivity } {
  let runtime: Promise<{ cua: any; driver: any }> | null = null;
  const sessions = new Map<string, Session>();
  const generations = new Map<string, number>();
  const sessionThread = new Map<string, string>();
  const activity = new Map<string, DriverActivity>();

  const tally = (threadId: string): DriverActivity => {
    let a = activity.get(threadId);
    if (!a) { a = { authorized: {}, refused: {} }; activity.set(threadId, a); }
    return a;
  };

  function dir(): string {
    mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
    return options.stateDir;
  }

  function start(): Promise<{ cua: any; driver: any }> {
    runtime ??= (async () => {
      const cua = await importEsm(sdkEntry(options));
      const manifest = path.join(dir(), 'runtime.yaml');
      writeFileSync(manifest, runtimeManifest(), { mode: 0o600 });
      // Content-free events: which tool, allowed or refused. The count of authorized INPUT tools is the stage's proof.
      const observer = {
        onActivity(event: { kind: number; toolName: string; publicSession?: string }) {
          const threadId = (event.publicSession && sessionThread.get(event.publicSession)) || '(runtime)';
          const kind = cua.DriverActivityKind?.[event.kind] ?? String(event.kind);
          const bucket = kind === 'AuthorizedAction' ? tally(threadId).authorized : kind === 'AuthorizationRefused' ? tally(threadId).refused : null;
          if (bucket) bucket[event.toolName] = (bucket[event.toolName] ?? 0) + 1;
        },
      };
      const driver = cua.CuaDriver.createConfiguredWithActivityObserver(cua.ConfiguredDriverOptions.create({
        claudeCodeCompatibility: false,
        authorization: cua.RuntimeAuthorizationOptions.create({
          allowedModes: [cua.SessionPermissionMode.Bounded],
          compatibilityMode: cua.SessionPermissionMode.Bounded,
          compatibilityCapabilityManifestPath: manifest,
          unrestrictedAcknowledged: false,
          maxSessionTtlSeconds: 1800n,
          maxIdleTtlSeconds: 600n,
        }),
      }), observer);
      return { cua, driver };
    })();
    runtime.catch(() => { runtime = null; });
    return runtime;
  }

  /** The driver's own reason, not the error's class name ("DriverError.Configuration" says nothing to a person). */
  const reason = (error: any): Error => new Error(String(error?.inner?.reason ?? error?.message ?? error));

  /** A runtime past its lease (RUNTIME_HOURS, RUNTIME_IDLE_MINUTES) is replaced once, with every session it held. */
  async function withRuntime<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch (first: any) {
      if (!/expire|idle|lease|ttl/i.test(String(first?.inner?.reason ?? first?.message ?? first))) throw reason(first);
      runtime = null;
      sessions.clear();
      try { return await work(); } catch (second) { throw reason(second); }
    }
  }

  const parse = (result: any): any => {
    if (result?.isError) throw new Error(result.text || result.errorCode || 'the driver refused');
    try { return JSON.parse(result?.structuredJson ?? 'null') ?? {}; } catch { return {}; }
  };

  function requireCurrent(threadId: string, generation: number): void {
    if ((generations.get(threadId) ?? 0) !== generation) throw new Error('This look grant ended.');
  }

  async function sessionFor(threadId: string, app: RunningApp, generation: number): Promise<any> {
    requireCurrent(threadId, generation);
    const key = `${threadId}|${app.bundleId}`;
    const existing = sessions.get(key);
    if (existing) return existing.session;
    const { cua, driver } = await start();
    requireCurrent(threadId, generation);
    const name = `bimax-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
    const manifest = path.join(dir(), `${name}.yaml`);
    writeFileSync(manifest, lookManifest(app.bundleId), { mode: 0o600 });
    const session = cua.createTrustedSession(driver, cua.TrustedSessionOptions.create({
      publicSession: name, mode: cua.SessionPermissionMode.Bounded, ttlSeconds: 1800n, idleTtlSeconds: 600n,
      capabilityManifestPath: manifest,
    }));
    sessions.set(key, { session, manifest });
    sessionThread.set(name, threadId);
    return session;
  }

  async function call(session: any, tool: string, args: Record<string, unknown>): Promise<any> {
    return parse(await session.callTool(tool, JSON.stringify(args)));
  }

  /** The one way anything is clicked: an AX action on an element token, in the background — never coordinates. */
  function clickToken(session: any, app: RunningApp, windowId: number, token: string, action: 'press' | 'confirm'): Promise<any> {
    return call(session, 'click', { pid: app.pid, window_id: windowId, element_token: token, action, delivery_mode: 'background' });
  }

  /** The one way a value is set: an AX value write on an element token — a text box's text, or a pop-up's item. */
  function setValueToken(session: any, app: RunningApp, token: string, value: string): Promise<any> {
    return call(session, 'set_value', { pid: app.pid, element_token: token, value });
  }

  /** Read again until the window shows a change, for about 1.5 s. A read may repeat; the action never does. */
  async function readUntilChanged(session: any, app: RunningApp, windowId: number, before: any): Promise<any> {
    let after = before;
    for (const wait of [150, 300, 450, 600]) {
      await sleep(wait);
      try { after = await call(session, 'get_window_state', { pid: app.pid, window_id: windowId, include_screenshot: false, timeout_ms: READ_TIMEOUT_MS }); }
      catch { break; }
      if (String(after.tree_markdown ?? '') !== String(before.tree_markdown ?? '')) break;
    }
    return after;
  }

  /** A use session: its own short-lived trusted session whose manifest adds `click` and `set_value` for this one app. */
  async function useSessionFor(threadId: string, app: RunningApp, generation: number): Promise<any> {
    requireCurrent(threadId, generation);
    const key = `${threadId}|${app.bundleId}|use`;
    const existing = sessions.get(key);
    if (existing) return existing.session;
    const manifestText = useManifest(app.bundleId); // throws for an app a task never uses
    const { cua, driver } = await start();
    requireCurrent(threadId, generation);
    const name = `bimax-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
    const manifest = path.join(dir(), `${name}.yaml`);
    writeFileSync(manifest, manifestText, { mode: 0o600 });
    const session = cua.createTrustedSession(driver, cua.TrustedSessionOptions.create({
      publicSession: name, mode: cua.SessionPermissionMode.Bounded, ttlSeconds: 300n, idleTtlSeconds: 120n,
      capabilityManifestPath: manifest,
    }));
    sessions.set(key, { session, manifest });
    sessionThread.set(name, threadId);
    return session;
  }

  return {
    async runningApps(): Promise<RunningApp[]> {
      const data = await withRuntime(async () => { const { driver } = await start(); return parse(await driver.callTool('list_apps', '{}')); });
      return (Array.isArray(data.apps) ? data.apps : [])
        .filter((a: any) => a && a.running === true && Number(a.pid) > 0 && typeof a.bundle_id === 'string' && a.kind !== 'background')
        // Names lose invisible formatting marks (measured: "\u200eWhatsApp"), so cards and matches read as the person does.
        .map((a: any) => ({ name: String(a.name ?? a.bundle_id).replace(/\p{Cf}/gu, '').trim() || String(a.bundle_id), bundleId: String(a.bundle_id), pid: Number(a.pid) }));
    },

    async look(threadId: string, app: RunningApp, query?: string) {
      const generation = generations.get(threadId) ?? 0;
      return withRuntime(() => lookOnce(threadId, app, query, generation));
    },

    /**
     * One press (stage 3). Never through withRuntime and never retried: once `click` may have been sent, repeating it
     * could press twice. Everything before the click throws (nothing was pressed); everything after it is returned,
     * with the window as read afterwards — what the next step is bound to.
     */
    async press(threadId: string, app: RunningApp, target: PressTarget): Promise<PressOutcome> {
      const generation = generations.get(threadId) ?? 0;
      const session = await useSessionFor(threadId, app, generation);
      requireCurrent(threadId, generation);
      // A fresh snapshot in this session: its tokens are the only ones a press uses.
      const before = await call(session, 'get_window_state', { pid: app.pid, window_id: target.windowId, include_screenshot: false, timeout_ms: READ_TIMEOUT_MS });
      const matches = windowElements(before.elements).filter((e) => e.role === target.role && e.label === target.label);
      if (matches.length !== 1 || !matches[0].pressable || !matches[0].token) {
        return { kind: 'not_pressed', reason: matches.length > 1 ? 'ambiguous' : 'changed' };
      }
      // The last moment a Stop or a switch turned off can cancel it: nothing has been sent yet.
      requireCurrent(threadId, generation);
      try {
        await clickToken(session, app, target.windowId, matches[0].token, 'press');
      } catch (error: any) {
        const text = String(error?.inner?.reason ?? error?.message ?? error);
        // Refused by the driver before dispatch (a stale token, outside the manifest): nothing was pressed.
        if (/stale|supersed|not allowed|denied|refus|outside|not permitted/i.test(text)) return { kind: 'not_pressed', reason: 'refused', detail: text.slice(0, 200) };
        return { kind: 'uncertain', detail: text.slice(0, 200) };
      }
      const after = await readUntilChanged(session, app, target.windowId, before);
      return {
        kind: 'pressed', title: String(before.window_title ?? ''), before: String(before.tree_markdown ?? ''), after: String(after.tree_markdown ?? ''),
        elements: shown(windowElements(after.elements)),
      };
    },

    /**
     * One typing (stage 6): set one text box's whole value, by the token of a snapshot taken just before, in the
     * background — never keystrokes, so never Return. Never retried. The box is found again by its role and where it
     * starts, and the result says exactly what it reads now; the driver's "ok" is not proof.
     */
    async type(threadId: string, app: RunningApp, target: PressTarget, text: string): Promise<TypeOutcome> {
      const generation = generations.get(threadId) ?? 0;
      const session = await useSessionFor(threadId, app, generation);
      requireCurrent(threadId, generation);
      const before = await call(session, 'get_window_state', { pid: app.pid, window_id: target.windowId, include_screenshot: false, timeout_ms: READ_TIMEOUT_MS });
      const matches = windowElements(before.elements).filter((e) => e.role === target.role && e.label === target.label);
      if (matches.length !== 1 || !matches[0].editable || !matches[0].token) {
        return { kind: 'not_typed', reason: matches.length > 1 ? 'ambiguous' : 'changed' };
      }
      const box = matches[0];
      requireCurrent(threadId, generation);
      try {
        await setValueToken(session, app, box.token, text);
      } catch (error: any) {
        const reasonText = String(error?.inner?.reason ?? error?.message ?? error);
        if (/stale|supersed|not allowed|denied|refus|outside|not permitted|not settable|unsupported/i.test(reasonText)) return { kind: 'not_typed', reason: 'refused', detail: reasonText.slice(0, 200) };
        return { kind: 'uncertain', detail: reasonText.slice(0, 200) };
      }
      let after = before;
      let value: string | null = null;
      for (const wait of [150, 300, 450]) {
        await sleep(wait);
        try { after = await call(session, 'get_window_state', { pid: app.pid, window_id: target.windowId, include_screenshot: false, timeout_ms: READ_TIMEOUT_MS }); }
        catch { break; }
        const again = windowElements(after.elements).filter((e) => e.role === box.role && box.at !== undefined && e.at === box.at);
        value = again.length === 1 ? (again[0].value ?? '') : null;
        if (value === text) break;
      }
      return {
        kind: 'typed', title: String(before.window_title ?? ''), before: String(before.tree_markdown ?? ''), after: String(after.tree_markdown ?? ''),
        value, elements: shown(windowElements(after.elements)),
      };
    },

    /**
     * Stage 6: Return in one text box — its own AX "confirm" action, by token, in the background; never a key event.
     * The box is found by role and screen position (`at`), since typing renames a box named by its value. Never retried.
     */
    async confirm(threadId: string, app: RunningApp, target: PressTarget & { at?: string }): Promise<PressOutcome> {
      const generation = generations.get(threadId) ?? 0;
      const session = await useSessionFor(threadId, app, generation);
      requireCurrent(threadId, generation);
      const before = await call(session, 'get_window_state', { pid: app.pid, window_id: target.windowId, include_screenshot: false, timeout_ms: READ_TIMEOUT_MS });
      const matches = windowElements(before.elements).filter((e) => e.role === target.role && (target.at !== undefined ? e.at === target.at : e.label === target.label));
      if (matches.length !== 1 || !matches[0].editable || !matches[0].token) {
        return { kind: 'not_pressed', reason: matches.length > 1 ? 'ambiguous' : 'changed' };
      }
      requireCurrent(threadId, generation);
      try {
        await clickToken(session, app, target.windowId, matches[0].token, 'confirm');
      } catch (error: any) {
        const text = String(error?.inner?.reason ?? error?.message ?? error);
        if (/stale|supersed|not allowed|denied|refus|outside|not permitted|unsupported/i.test(text)) return { kind: 'not_pressed', reason: 'refused', detail: text.slice(0, 200) };
        return { kind: 'uncertain', detail: text.slice(0, 200) };
      }
      const after = await readUntilChanged(session, app, target.windowId, before);
      return {
        kind: 'pressed', title: String(before.window_title ?? ''), before: String(before.tree_markdown ?? ''), after: String(after.tree_markdown ?? ''),
        elements: shown(windowElements(after.elements)),
      };
    },

    /**
     * Stage 6: choose one item of a pop-up button without opening its menu — the driver's set_value finds the child item
     * by title and presses it directly. The pop-up is found again by role and position, and its value read back.
     */
    async pick(threadId: string, app: RunningApp, target: PressTarget, option: string): Promise<TypeOutcome> {
      const generation = generations.get(threadId) ?? 0;
      const session = await useSessionFor(threadId, app, generation);
      requireCurrent(threadId, generation);
      const before = await call(session, 'get_window_state', { pid: app.pid, window_id: target.windowId, include_screenshot: false, timeout_ms: READ_TIMEOUT_MS });
      const matches = windowElements(before.elements).filter((e) => e.role === target.role && e.label === target.label);
      if (matches.length !== 1 || !matches[0].pickable || !matches[0].token) {
        return { kind: 'not_typed', reason: matches.length > 1 ? 'ambiguous' : 'changed' };
      }
      const popup = matches[0];
      requireCurrent(threadId, generation);
      try {
        await setValueToken(session, app, popup.token, option);
      } catch (error: any) {
        const text = String(error?.inner?.reason ?? error?.message ?? error);
        if (/stale|supersed|not allowed|denied|refus|outside|not permitted|no (child|option|item)|not found|unsupported/i.test(text)) return { kind: 'not_typed', reason: 'refused', detail: text.slice(0, 200) };
        return { kind: 'uncertain', detail: text.slice(0, 200) };
      }
      const after = await readUntilChanged(session, app, target.windowId, before);
      const again = windowElements(after.elements).filter((e) => e.role === popup.role && popup.at !== undefined && e.at === popup.at);
      return {
        kind: 'typed', title: String(before.window_title ?? ''), before: String(before.tree_markdown ?? ''), after: String(after.tree_markdown ?? ''),
        value: again.length === 1 ? (again[0].value ?? '') : null, elements: shown(windowElements(after.elements)),
      };
    },

    /**
     * Stage 6: scroll the area under one named control — the driver's targeted wheel path, by token, in the background
     * (measured in WhatsApp behind the terminal: the list moved; the front app and the pointer did not). Never retried.
     */
    async scroll(threadId: string, app: RunningApp, target: PressTarget, direction: ScrollDirection, pages: number): Promise<PressOutcome> {
      const generation = generations.get(threadId) ?? 0;
      const session = await useSessionFor(threadId, app, generation);
      requireCurrent(threadId, generation);
      const before = await call(session, 'get_window_state', { pid: app.pid, window_id: target.windowId, include_screenshot: false, timeout_ms: READ_TIMEOUT_MS });
      const matches = windowElements(before.elements).filter((e) => e.role === target.role && e.label === target.label);
      if (matches.length !== 1 || !matches[0].token) return { kind: 'not_pressed', reason: matches.length > 1 ? 'ambiguous' : 'changed' };
      requireCurrent(threadId, generation);
      try {
        await call(session, 'scroll', { pid: app.pid, element_token: matches[0].token, direction, by: 'page', amount: Math.min(50, Math.max(1, Math.round(pages)) * SCROLL_NOTCHES_PER_PAGE), delivery_mode: 'background' });
      } catch (error: any) {
        const text = String(error?.inner?.reason ?? error?.message ?? error);
        if (/stale|supersed|not allowed|denied|refus|outside|not permitted/i.test(text)) return { kind: 'not_pressed', reason: 'refused', detail: text.slice(0, 200) };
        return { kind: 'uncertain', detail: text.slice(0, 200) };
      }
      const after = await readUntilChanged(session, app, target.windowId, before);
      return {
        kind: 'pressed', title: String(before.window_title ?? ''), before: String(before.tree_markdown ?? ''), after: String(after.tree_markdown ?? ''),
        elements: shown(windowElements(after.elements)),
      };
    },

    async end(threadId: string): Promise<void> {
      generations.set(threadId, (generations.get(threadId) ?? 0) + 1);
      for (const [key, value] of [...sessions]) {
        if (!key.startsWith(`${threadId}|`)) continue;
        sessions.delete(key);
        try { await value.session.close?.(); } catch { /* already gone */ }
        rmSync(value.manifest, { force: true });
      }
    },

    activity(threadId: string): DriverActivity {
      return activity.get(threadId) ?? { authorized: {}, refused: {} };
    },
  };

  async function lookOnce(threadId: string, app: RunningApp, query: string | undefined, generation: number) {
    let session = await sessionFor(threadId, app, generation);
    requireCurrent(threadId, generation);
    let windows: any;
    try { windows = await call(session, 'list_windows', { pid: app.pid }); }
    catch (error) {
      requireCurrent(threadId, generation);
      // A session past its time is renewed once: the person's grant still stands; only the driver's lease ended.
      sessions.delete(`${threadId}|${app.bundleId}`);
      session = await sessionFor(threadId, app, generation);
      requireCurrent(threadId, generation);
      windows = await call(session, 'list_windows', { pid: app.pid });
      void error;
    }
    requireCurrent(threadId, generation);
    const all: any[] = Array.isArray(windows.windows) ? windows.windows : [];
    const visible = all.filter((w) => w.is_on_screen && (w.bounds?.width ?? 0) > 60 && (w.bounds?.height ?? 0) > 60);
    const pick = (visible.length ? visible : all.filter((w) => w.title))
      .sort((a, b) => (b.z_index ?? 0) - (a.z_index ?? 0) || (b.bounds?.width ?? 0) * (b.bounds?.height ?? 0) - (a.bounds?.width ?? 0) * (a.bounds?.height ?? 0))[0];
    if (!pick) throw new Error(`${app.name} has no window open`);
    const state = await call(session, 'get_window_state', {
      pid: app.pid, window_id: pick.window_id, include_screenshot: false, timeout_ms: READ_TIMEOUT_MS, ...(query ? { query } : {}),
    });
    requireCurrent(threadId, generation);
    if (state.degraded && !state.tree_markdown) throw new Error(String(state.degraded_reason ?? 'the window could not be read'));
    const partial = state.truncated === true;
    // The controls are kept (without their tokens) so a later press or typing can be bound to what this look showed.
    const elements: LookElement[] = shown(windowElements(state.elements));
    return { title: String(pick.title ?? ''), markdown: String(state.tree_markdown ?? ''), windowId: Number(pick.window_id), elements, ...(partial ? { partial: true } : {}) };
  }
}
