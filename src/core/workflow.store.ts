import { randomUUID } from 'crypto';
import { WorkflowStep, WorkflowStepState } from './tool.workflow';

interface StoredWorkflow {
  scope: string;
  steps: WorkflowStep[];
  state: Map<string, WorkflowStepState>;
  bytes: number;
  at: number;
  busy: boolean;
}
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_RECORDS = 16;
const TTL_MS = 30 * 60_000;

/** Container-local, bounded, session+cwd scoped. This is reuse state, never crash recovery. */
export class WorkflowStore {
  private records = new Map<string, StoredWorkflow>();
  private prune(): void {
    for (const [id, record] of this.records) if (!record.busy && Date.now() - record.at > TTL_MS) this.records.delete(id);
  }
  acquire(id: string, scope: string): StoredWorkflow {
    this.prune();
    const record = this.records.get(id);
    if (!record || record.scope !== scope) throw new Error('Workflow unavailable in this session and directory; run a new workflow.');
    if (record.busy) throw new Error('Workflow refresh already running.');
    record.busy = true;
    return record;
  }
  release(id: string): void { const record = this.records.get(id); if (record) record.busy = false; }
  save(scope: string, steps: WorkflowStep[], state: Map<string, WorkflowStepState>, id: string = randomUUID()): string | undefined {
    this.prune();
    const graph = JSON.stringify(steps);
    const bytes = Buffer.byteLength(graph) + [...state.values()].reduce((sum, s) =>
      sum + Buffer.byteLength(s.raw ?? '') + Buffer.byteLength(s.output) + Buffer.byteLength(s.args)
      + Buffer.byteLength(JSON.stringify(s.evidence)), 0);
    this.records.delete(id);
    if (bytes > MAX_BYTES) return undefined;
    let total = [...this.records.values()].reduce((sum, r) => sum + r.bytes, 0);
    for (const [key, record] of this.records) {
      if (total + bytes <= MAX_BYTES && this.records.size < MAX_RECORDS) break;
      if (record.busy) continue;
      total -= record.bytes;
      this.records.delete(key);
    }
    if (total + bytes > MAX_BYTES || this.records.size >= MAX_RECORDS) return undefined;
    this.records.set(id, { scope, steps: JSON.parse(graph), state, bytes, at: Date.now(), busy: false });
    return id;
  }
}
