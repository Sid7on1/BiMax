import { stateDir } from '../utils/state.dir';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export const MAX_CONCURRENT_SUBAGENTS = 4;

/**
 * Desktop Phase 9 may canary a lower background-concurrency ceiling. The immutable hard cap stays
 * four; an untrusted, malformed, or higher value can never widen it. Terminal behavior is
 * unchanged when the embedding host supplies no policy value.
 */
export function runtimeConcurrentSubagentLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.BIMAX_MAX_CONCURRENT_SUBAGENTS);
  return Number.isInteger(raw) ? Math.max(1, Math.min(MAX_CONCURRENT_SUBAGENTS, raw)) : MAX_CONCURRENT_SUBAGENTS;
}
export const CAPACITY_PATH_ENV = 'BIMAX_AGENT_CAPACITY_PATH';
export const CAPACITY_RUN_ENV = 'BIMAX_AGENT_RUN_ID';
export const CAPACITY_LEASE_ENV = 'BIMAX_AGENT_LEASE_ID';

const DEFAULT_TTL_MS = 30_000;
const LOCK_STALE_MS = 5_000;

export interface SubAgentCapacityLease {
  id: string;
  taskId: string;
  runId: string;
  parentLeaseId?: string;
  holderPid: number;
  acquiredAt: number;
  heartbeatAt: number;
  expiresAt: number;
}

interface CapacityLedger {
  version: 1;
  leases: SubAgentCapacityLease[];
}

export class SubAgentCapacityError extends Error {}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function wait(ms: number): void {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* retry */ }
}

/** One inherited path/run id keeps nested workers and worktrees on the same capacity ledger. */
export function resolveCapacityContext(cwd: string, capacityPath?: string, runId?: string): { path: string; runId: string } {
  const resolvedPath = capacityPath || process.env[CAPACITY_PATH_ENV]
    || path.join(stateDir('.bimax', cwd || process.cwd()), 'subagent-capacity.json');
  const resolvedRun = runId || process.env[CAPACITY_RUN_ENV]
    || `run-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  return { path: resolvedPath, runId: resolvedRun };
}

/**
 * Cross-process, fail-closed counting semaphore for the whole nested agent tree. The file lock is
 * acquired with O_EXCL, the ledger is replaced atomically, and leases expire unless heartbeated.
 */
export class SubAgentCapacityCoordinator {
  constructor(
    readonly filePath: string,
    readonly max = runtimeConcurrentSubagentLimit(),
    readonly ttlMs = DEFAULT_TTL_MS,
  ) {}

  private lockPath(): string { return `${this.filePath}.lock`; }

  private withLock<T>(fn: (ledger: CapacityLedger, now: number) => T): T {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const lock = this.lockPath();
    let fd: number | null = null;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        fd = fs.openSync(lock, 'wx', 0o600);
        break;
      } catch (error: any) {
        if (error?.code !== 'EEXIST') throw new SubAgentCapacityError(`Capacity coordinator unavailable: ${error?.message || error}`);
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(lock);
        } catch { /* another process released it */ }
        wait(5);
      }
    }
    if (fd === null) throw new SubAgentCapacityError('Capacity coordinator is busy; spawn denied safely.');

    try {
      const now = Date.now();
      let ledger: CapacityLedger = { version: 1, leases: [] };
      if (fs.existsSync(this.filePath)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
          if (parsed?.version !== 1 || !Array.isArray(parsed.leases)) throw new Error('invalid ledger schema');
          ledger = parsed;
        } catch (error: any) {
          throw new SubAgentCapacityError(`Capacity ledger is corrupt; spawn denied safely: ${error?.message || error}`);
        }
      }
      ledger.leases = ledger.leases.filter(lease =>
        lease && lease.id && lease.expiresAt > now && pidAlive(Number(lease.holderPid))
      );
      const result = fn(ledger, now);
      const tmp = `${this.filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2), { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tmp, this.filePath);
      } finally {
        try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
      }
      return result;
    } finally {
      try { if (fd !== null) fs.closeSync(fd); } catch { /* best-effort */ }
      try { fs.unlinkSync(lock); } catch { /* best-effort */ }
    }
  }

  acquire(input: { taskId: string; runId: string; parentLeaseId?: string; holderPid?: number }): SubAgentCapacityLease {
    return this.withLock((ledger, now) => {
      if (ledger.leases.length >= this.max) {
        throw new SubAgentCapacityError(`Concurrent sub-agent limit reached (${this.max}).`);
      }
      const lease: SubAgentCapacityLease = {
        id: `lease-${crypto.randomBytes(8).toString('hex')}`,
        taskId: input.taskId,
        runId: input.runId,
        parentLeaseId: input.parentLeaseId,
        holderPid: input.holderPid || process.pid,
        acquiredAt: now,
        heartbeatAt: now,
        expiresAt: now + this.ttlMs,
      };
      ledger.leases.push(lease);
      return { ...lease };
    });
  }

  heartbeat(id: string, holderPid = process.pid): boolean {
    return this.withLock((ledger, now) => {
      const lease = ledger.leases.find(item => item.id === id);
      if (!lease) return false;
      lease.holderPid = holderPid;
      lease.heartbeatAt = now;
      lease.expiresAt = now + this.ttlMs;
      return true;
    });
  }

  release(id: string): void {
    this.withLock(ledger => {
      ledger.leases = ledger.leases.filter(lease => lease.id !== id);
    });
  }

  active(): SubAgentCapacityLease[] {
    return this.withLock(ledger => ledger.leases.map(lease => ({ ...lease })));
  }
}
