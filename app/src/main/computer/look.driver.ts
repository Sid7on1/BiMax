import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LookDriver, RunningApp } from './look.service';
import { lookManifest, runtimeManifest } from './look.manifest';

/**
 * Cua Driver 0.31, embedded in this process, look only (record 65, stage 2).
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
    return { title: String(pick.title ?? ''), markdown: String(state.tree_markdown ?? '') };
  }
}
