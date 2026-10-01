import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LookDriver, LookElement, PressOutcome, PressTarget, RunningApp } from './look.service';
import { PRESS_ROLES, lookManifest, pressManifest, runtimeManifest } from './look.manifest';

/**
 * Cua Driver 0.31, embedded in this process: look (record 65, stage 2) and, for the test app only, one press at a time
 * (stage 3).
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
 * about on a card or matched again before a press.
 */
export function windowElements(raw: unknown): WindowElement[] {
  const list: any[] = Array.isArray(raw) ? raw : [];
  const byIndex = new Map<number, any>(list.map((e) => [Number(e?.element_index), e]));
  const inWindow = (e: any): boolean => {
    for (let cur = e, hops = 0; cur && hops < 64; cur = byIndex.get(Number(cur.parent_index)), hops++) {
      if (cur.role === 'AXMenuBar') return false;
      if (cur.role === 'AXWindow') return true;
      if (cur.parent_index === undefined) return false;
    }
    return false;
  };
  return list
    .filter((e) => e && typeof e.role === 'string' && typeof e.label === 'string' && e.label.trim() && e.role !== 'AXWindow' && inWindow(e))
    .map((e) => ({
      role: String(e.role),
      label: String(e.label),
      pressable: PRESS_ROLES.has(String(e.role)) && Array.isArray(e.actions) && e.actions.includes('AXPress') && e.enabled !== false,
      token: String(e.element_token ?? ''),
    }));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

  /** A press session: its own short-lived trusted session whose manifest adds `click`, for an app on PRESS_APPS only. */
  async function pressSessionFor(threadId: string, app: RunningApp, generation: number): Promise<any> {
    requireCurrent(threadId, generation);
    const key = `${threadId}|${app.bundleId}|press`;
    const existing = sessions.get(key);
    if (existing) return existing.session;
    const manifestText = pressManifest(app.bundleId); // throws for any app not on PRESS_APPS
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
        .map((a: any) => ({ name: String(a.name ?? a.bundle_id), bundleId: String(a.bundle_id), pid: Number(a.pid) }));
    },

    async look(threadId: string, app: RunningApp, query?: string) {
      const generation = generations.get(threadId) ?? 0;
      return withRuntime(() => lookOnce(threadId, app, query, generation));
    },

    /**
     * One press (stage 3). Never through withRuntime and never retried: once `click` may have been sent, repeating it
     * could press twice. Everything before the click throws (nothing was pressed); everything after it is returned.
     */
    async press(threadId: string, app: RunningApp, target: PressTarget): Promise<PressOutcome> {
      const generation = generations.get(threadId) ?? 0;
      const session = await pressSessionFor(threadId, app, generation);
      requireCurrent(threadId, generation);
      // A fresh snapshot in this session: its tokens are the only ones a press uses.
      const before = await call(session, 'get_window_state', { pid: app.pid, window_id: target.windowId, include_screenshot: false });
      const matches = windowElements(before.elements).filter((e) => e.role === target.role && e.label === target.label);
      if (matches.length !== 1 || !matches[0].pressable || !matches[0].token) {
        return { kind: 'not_pressed', reason: matches.length > 1 ? 'ambiguous' : 'changed' };
      }
      // The last moment a Stop or a switch turned off can cancel it: nothing has been sent yet.
      requireCurrent(threadId, generation);
      try {
        await call(session, 'click', { pid: app.pid, window_id: target.windowId, element_token: matches[0].token, action: 'press', delivery_mode: 'background' });
      } catch (error: any) {
        const text = String(error?.inner?.reason ?? error?.message ?? error);
        // Refused by the driver before dispatch (a stale token, outside the manifest): nothing was pressed.
        if (/stale|supersed|not allowed|denied|refus|outside|not permitted/i.test(text)) return { kind: 'not_pressed', reason: 'refused', detail: text.slice(0, 200) };
        return { kind: 'uncertain', detail: text.slice(0, 200) };
      }
      // Read again until the window shows a change, for about 1.5 s. A read may repeat; the press never does.
      let after = before;
      for (const wait of [150, 300, 450, 600]) {
        await sleep(wait);
        try { after = await call(session, 'get_window_state', { pid: app.pid, window_id: target.windowId, include_screenshot: false }); }
        catch { break; }
        if (String(after.tree_markdown ?? '') !== String(before.tree_markdown ?? '')) break;
      }
      return { kind: 'pressed', title: String(before.window_title ?? ''), before: String(before.tree_markdown ?? ''), after: String(after.tree_markdown ?? '') };
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
      pid: app.pid, window_id: pick.window_id, include_screenshot: false, ...(query ? { query } : {}),
    });
    requireCurrent(threadId, generation);
    if (state.degraded && !state.tree_markdown) throw new Error(String(state.degraded_reason ?? 'the window could not be read'));
    // The controls are kept (without their tokens) so a later press can be bound to what this look showed.
    const elements: LookElement[] = windowElements(state.elements).map(({ role, label, pressable }) => ({ role, label, pressable }));
    return { title: String(pick.title ?? ''), markdown: String(state.tree_markdown ?? ''), windowId: Number(pick.window_id), elements };
  }
}
