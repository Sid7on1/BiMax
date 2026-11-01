import { randomUUID } from 'node:crypto';
import type { ComputerControl, ComputerMode, ComputerRunState } from '../../shared/computer';

/** Human controls are revision-bound and never supplied through the model tool. */
export class ComputerRun {
  state: ComputerRunState;
  epoch = 0;
  approval = new AbortController();
  private decision?: boolean;
  correction?: { role: string; value: string };
  private previous: ComputerRunState['phase'] = 'running';
  private listeners = new Set<() => void>();
  constructor(mode: ComputerMode, target: string, private changed: (state: ComputerRunState) => void, private revoke: () => void) {
    this.state = { revision: randomUUID(), mode, target, phase: 'running' };
  }
  get paused(): boolean { return this.state.phase === 'paused' || this.state.phase === 'takeover'; }
  get ended(): boolean { return ['complete', 'stopped', 'failed'].includes(this.state.phase); }
  update(change: Partial<ComputerRunState>): void {
    this.state = { ...this.state, ...change, revision: randomUUID() };
    this.changed(structuredClone(this.state));
    for (const listener of [...this.listeners]) listener();
  }
  control(revision: string, action: ComputerControl, candidate?: number): boolean {
    if (revision !== this.state.revision || this.ended) return false;
    if (action === 'stop') { this.stop(); return true; }
    if (action === 'pause' || action === 'takeover') {
      if (!this.paused) this.previous = this.state.phase === 'approval' ? 'running' : this.state.phase;
      this.epoch++; this.approval.abort(); this.approval = new AbortController(); this.revoke();
      this.update({ phase: action === 'pause' ? 'paused' : 'takeover', approval: undefined }); return true;
    }
    if (action === 'resume' && this.paused) { this.update({ phase: this.previous }); return true; }
    if ((action === 'allow' || action === 'deny') && this.state.phase === 'approval') { this.decision = action === 'allow'; this.update({ phase: 'running', approval: undefined }); return true; }
    if (action === 'check' && this.state.phase === 'waiting-user') { this.update({ phase: 'running' }); return true; }
    if (action === 'correct' && this.state.phase === 'verification' && Number.isInteger(candidate)) {
      const value = this.state.candidates?.[candidate!]; if (!value) return false;
      this.correction = { ...value }; this.update({ phase: 'running', candidates: undefined }); return true;
    }
    return false;
  }
  async ask(application: string, operation: string, signal: AbortSignal): Promise<boolean> {
    await this.ready(signal);
    if (signal.aborted || this.paused || this.ended) throw new ComputerInterrupted();
    this.decision = undefined;
    this.update({ phase: 'approval', approval: { application, operation } });
    try { await this.ready(signal); return this.decision === true; }
    finally { if (this.state.phase === 'approval') this.update({ phase: 'running', approval: undefined }); }
  }
  stop(): void {
    if (this.ended) return;
    this.epoch++; this.approval.abort(); this.revoke(); this.update({ phase: 'stopped' });
  }
  async ready(signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.ended) throw new Error('Computer Use stopped.');
    if (this.state.phase === 'running') return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { this.listeners.delete(check); signal.removeEventListener('abort', abort); };
      const abort = () => { cleanup(); reject(new Error('Computer Use stopped.')); };
      const check = () => {
        if (this.ended) { abort(); return; }
        if (this.state.phase === 'running') { cleanup(); resolve(); }
      };
      this.listeners.add(check); signal.addEventListener('abort', abort, { once: true }); check();
    });
  }
}
export class ComputerInterrupted extends Error {
  constructor() { super('Paused before native input. Observe and ask again after explicit resume.'); }
}
