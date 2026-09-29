import { dialog, type BrowserWindow } from 'electron';
import { renameSync, writeFileSync } from 'node:fs';
import type { IpcGate } from './ipc.gate';
import type { EngineSupervisor } from './supervisor/supervisor';
import type { SupervisorStatus } from './supervisor/types';
import type { DesktopEvidenceStore } from './evidence.store';
import { recentEngineLog } from './engine';
import { buildDiagnosticExport } from './diagnostic.export';
import { buildEvidenceTimeline, retentionControls } from '../shared/evidence.timeline';
import { redactSecrets } from './supervisor/journal';
import { asSupervisorAction, InvalidPayloadError } from './security';

/** What the diagnostics channels read from the app: moved out of main/index.ts (flaw list C13). */
export interface DiagnosticsIpcHost {
  /** The project window's engine supervisor; null before the first project opens. */
  supervisor(): EngineSupervisor | null;
  /** The last status the supervisor broadcast, which can be newer than a fresh status() read. */
  lastStatus(): SupervisorStatus | null;
  mainWindow(): BrowserWindow | null;
  evidence: DesktopEvidenceStore;
}

/** The engine supervisor's surface, the private diagnostics export, and the evidence timeline. */
export function registerDiagnosticsIpc(ipc: IpcGate, host: DiagnosticsIpcHost): void {
  // Supervisor surface: typed state + validated recovery actions. The renderer never gets raw
  // process access — these are the only levers, and the action name must be one of the five.
  ipc.handle<unknown>('supervisor:get-status', null, () => host.lastStatus() ?? host.supervisor()?.status() ?? null);
  ipc.handle<boolean>('supervisor:action', false, (_e, raw: unknown) =>
    host.supervisor()?.handleAction(asSupervisorAction(raw)) ?? false);
  ipc.handle<unknown[]>('supervisor:crash-history', [], () => host.supervisor()?.crashHistory() ?? []);
  ipc.handle<string>('supervisor:diagnostics', '', () => host.supervisor()?.diagnosticsText() ?? '');
  // The engine's stderr, live — not only after a crash. A CrashRecord carries a logTail, so the
  // reason a DEAD engine died was already recoverable; the reason a LIVE one is misbehaving was
  // not reachable from inside the app at all. It went to <userData>/engine.log and stayed there,
  // which is why an engine-side fault presented as a spinner that never resolved. Same redaction
  // the crash journal applies, because this tail is read and pasted by the same people.
  ipc.handle<string>('supervisor:engine-log', '', () => redactSecrets(recentEngineLog()));

  ipc.handle<'saved' | 'cancelled' | 'failed'>('trust:export-diagnostics', 'failed', async () => {
    const win = host.mainWindow();
    if (!win) return 'failed';
    const selected = await dialog.showSaveDialog(win, {
      title: 'Export private Bimax diagnostics',
      defaultPath: `Bimax-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (selected.canceled || !selected.filePath) return 'cancelled';
    const payload = buildDiagnosticExport({
      now: () => new Date(),
      status: host.lastStatus() ?? host.supervisor()?.status() ?? null,
      crashes: host.supervisor()?.crashHistory() ?? [],
    });
    const tmp = `${selected.filePath}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, selected.filePath);
      return 'saved';
    } catch (error) {
      console.error('[diagnostics] export failed:', error);
      return 'failed';
    }
  });

  // Contextual evidence (Phase 8, owner section 28). The renderer receives typed findings and
  // retention controls — never a raw record it could edit and send back, never a native handle.
  // Ingest is one-way from the engine and the Mac provider into main; the renderer only reads.
  ipc.handle<unknown>('evidence:timeline', null, (_e, raw: unknown) => {
    const taskIntentId = typeof raw === 'string' && raw ? raw : null;
    const records = taskIntentId ? host.evidence.forTask(taskIntentId) : host.evidence.all();
    return buildEvidenceTimeline(records, [...host.evidence.evictionLog()]);
  });

  ipc.handle<unknown[]>('evidence:retention-controls', [], (_e, raw: unknown) => {
    const taskIntentId = typeof raw === 'string' && raw ? raw : null;
    return retentionControls(host.evidence.all(), taskIntentId);
  });

  // Deletion is real: the records are gone from the store, and the eviction is recorded so the
  // timeline shows an evidence gap rather than a shorter, calmer-looking history.
  ipc.handle<number>('evidence:delete', 0, (_e, raw: unknown) => {
    const request = raw as { scope?: unknown; taskIntentId?: unknown } | null;
    const scope = typeof request?.scope === 'string' ? request.scope : '';
    if (scope === 'task') {
      const taskIntentId = typeof request?.taskIntentId === 'string' ? request.taskIntentId : '';
      if (!taskIntentId) throw new InvalidPayloadError('delete scope "task" needs a taskIntentId');
      return host.evidence.deleteTask(taskIntentId);
    }
    if (scope === 'observations') return host.evidence.deleteObservations();
    if (scope === 'all') return host.evidence.deleteAll();
    throw new InvalidPayloadError('unknown evidence delete scope');
  });
}
