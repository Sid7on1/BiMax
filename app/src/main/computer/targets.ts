import { randomUUID } from 'node:crypto';
import type { ComputerApp, ComputerRoute, ComputerTargets } from '../../shared/computer';
import { identifyProcess, type ProcessIdentity } from './process.identity';

export interface NativeTarget extends ComputerApp { window_id: number; identity: ProcessIdentity; label: string }
interface Receipt { owner: string; at: number; target: NativeTarget }
interface Driver { request(method: string, args?: any): Promise<any>; close(): void }
export const protectedComputerApp = (app: ComputerApp) => /bimax|keychain|1password|bitwarden|lastpass|keepass|systempreferences|systemsettings|securityagent|loginwindow|passwords/i.test(app.bundle_id + ' ' + app.name);

/** Short-lived, single-use target receipts. Discovery grants never become turn grants. */
export class ComputerTargetPicker {
  private receipts = new Map<string, Receipt>();
  private automatic = new Map<string, { owner: string; at: number }>();
  private pending = new Map<string, AbortController>();
  constructor(private options: {
    driver(): Driver;
    approve(application: string, signal: AbortSignal): Promise<boolean>;
    accessibility(): boolean;
    identify?(pid: number): Promise<ProcessIdentity | null>;
    now?(): number;
  }) {}
  private now() { return this.options.now?.() ?? Date.now(); }
  private prune() {
    for (const [token, r] of this.receipts) if (this.now() - r.at > 600_000) this.receipts.delete(token);
    for (const [token, r] of this.automatic) if (this.now() - r.at > 600_000) this.automatic.delete(token);
  }
  /** Admission ticket only: discovery, read grants and native authority start at dispatch. */
  auto(threadId: string): ComputerRoute {
    this.prune(); const request = randomUUID();
    this.automatic.set(request, { owner: threadId, at: this.now() });
    while (this.automatic.size > 256) this.automatic.delete(this.automatic.keys().next().value!);
    return { kind: 'computer-use', request };
  }
  takeAuto(threadId: string, route: ComputerRoute): void {
    this.prune(); const receipt = this.automatic.get(route.request || '');
    if (!receipt || receipt.owner !== threadId) throw new Error('Computer Use request expired. Send @CU again.');
    this.automatic.delete(route.request!);
  }
  cancel(owner: string) { this.pending.get(owner)?.abort(); this.pending.delete(owner); }
  cancelSender(prefix: string) { for (const owner of this.pending.keys()) if (owner.startsWith(prefix)) this.cancel(owner); }
  async discover(owner: string, pid?: number, ownerActive: () => boolean = () => true): Promise<ComputerTargets> {
    this.cancel(owner); this.prune();
    const controller = new AbortController(); this.pending.set(owner, controller);
    const deadline = setTimeout(() => controller.abort(), 60_000);
    let driver: Driver;
    try { driver = this.options.driver(); } catch (error) { clearTimeout(deadline); this.pending.delete(owner); return { ok: false, error: (error as Error).message }; }
    controller.signal.addEventListener('abort', () => driver.close(), { once: true });
    const live = () => { if (controller.signal.aborted || this.pending.get(owner) !== controller || !ownerActive()) throw new Error('Target selection expired. Choose again.'); };
    const request = async (name: string, args?: any) => {
      live(); const result = await driver.request(name, args); live();
      if (result.isError) throw new Error(result.structuredContent?.message || 'Could not read running apps.');
      return result.structuredContent;
    };
    try {
      const apps: ComputerApp[] = (await request('apps')).apps.filter((a: ComputerApp) => Number.isSafeInteger(a.pid) && a.pid > 0 && a.bundle_id && !protectedComputerApp(a)).slice(0, 200);
      if (pid === undefined) return { ok: true, apps };
      const app = apps.find(a => a.pid === pid);
      if (!app) throw new Error('That app is no longer available. Refresh the app list.');
      const identity = await (this.options.identify || identifyProcess)(pid); live();
      if (!identity) throw new Error('Cannot identify this running app.');
      if (!await this.options.approve(app.name, controller.signal)) throw new Error('Window discovery was cancelled.');
      live();
      if (!this.options.accessibility()) throw new Error('Enable Bimax Accessibility permission to choose a window.');
      const current = (await request('apps')).apps.find((a: ComputerApp) => a.pid === pid);
      const currentIdentity = await (this.options.identify || identifyProcess)(pid); live();
      if (current?.bundle_id !== app.bundle_id || currentIdentity?.path !== identity.path || currentIdentity?.sha256 !== identity.sha256) throw new Error('The app changed during selection. Choose again.');
      const windows = (await request('windows', { pid })).windows.filter((w: any) => Number.isSafeInteger(w.window_id) && w.window_id > 0).slice(0, 100);
      return { ok: true, windows: windows.map((w: any) => {
        const title = String(w.title || `Untitled window (${w.window_id})`);
        const token = randomUUID(), label = `${app.name} · ${title}`.slice(0, 500);
        this.receipts.set(token, { owner, at: this.now(), target: { ...app, identity, window_id: w.window_id, label } });
        while (this.receipts.size > 256) this.receipts.delete(this.receipts.keys().next().value!);
        return { id: w.window_id, title, target: { token, label } };
      }) };
    } catch (error) { return { ok: false, error: (error as Error).message }; }
    finally { clearTimeout(deadline); driver.close(); if (this.pending.get(owner) === controller) this.pending.delete(owner); }
  }
  claim(owner: string, token: string, threadId: string): ComputerRoute {
    this.prune();
    const receipt = this.receipts.get(token);
    if (!receipt || receipt.owner !== owner) throw new Error('Computer Use target expired. Choose its app and window again.');
    receipt.owner = `turn:${threadId}`;
    return { kind: 'computer-use', target: { token, label: receipt.target.label } };
  }
  take(threadId: string, route: ComputerRoute): NativeTarget {
    this.prune();
    const receipt = this.receipts.get(route.target?.token || '');
    if (!receipt || receipt.owner !== `turn:${threadId}`) throw new Error('Computer Use target expired. Send @CU again and choose its app and window.');
    this.receipts.delete(route.target!.token);
    return receipt.target;
  }
  close() { for (const controller of this.pending.values()) controller.abort(); this.pending.clear(); this.receipts.clear(); this.automatic.clear(); }
}
