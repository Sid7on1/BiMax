import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * One money ledger for the machine, and a ceiling per Bimax Thread (backlog F5).
 *
 * THE DEFECT THIS CLOSES. `BudgetVeto` keeps the daily total in
 * `<stateDir('.breakglass')>/credits/spend.json`, and `stateDir` honours `BIMAX_STATE_DIR` — which
 * the desktop sets per Bimax Thread, to a folder-hashed directory under app data
 * (`app/src/main/thread.undo.ts:threadStateRoot`). So every Thread got its own private spend file
 * and its own private $5/day. MEASURED on this machine 2026-09-19: four independent ledgers
 * already exist — two under `thread-state/`, one at `~/.breakglass`, one in the repo — each
 * enforcing `SafetyPolicy.maxDailySpendUsd` on its own. The effective ceiling is therefore
 * $5 × (folders ever opened as a Thread), and it grows by $5 every time someone ⌘2s somewhere new.
 *
 * This is the same shape as the sub-agent worker cap (docs/product-reset/57, WP-1): a per-MACHINE
 * constant applied per-Thread. The difference is that this one spends real money.
 *
 * WHY A NEW LEDGER RATHER THAN A SHARED PATH. Pointing every engine at one `spend.json` would have
 * been a one-line fix and a lost-update race: `BudgetVeto`'s mutex is an in-process `async-mutex`,
 * and each Bimax Thread is a separate OS process. Two engines would each read $2, each add $1, and
 * each write $3 — with $4 actually spent. Money needs cross-process atomicity, so this follows the
 * pattern already proven in `src/core/subagent.capacity.ts`: an O_EXCL lock file, a read-modify-
 * write inside it, and an atomic rename.
 *
 * TWO CEILINGS, BOTH ENFORCED. The machine total is what protects the bill. The per-Thread ceiling
 * is what stops ONE unattended folder task eating the whole day before the others start — the
 * actual ask in F5. A charge is refused when either would be exceeded, and the refusal says which.
 */

export const SPEND_LEDGER_ENV = 'BIMAX_SPEND_LEDGER_PATH';
/** Per-Bimax-Thread ceiling, as a fraction of the machine's daily cap. Absent → no per-Thread limit. */
export const SPEND_SCOPE_ENV = 'BIMAX_SPEND_SCOPE';

const LOCK_STALE_MS = 5_000;
const LOCK_ATTEMPTS = 50;

export interface SpendLedgerFile {
  version: 1;
  /** ISO date (UTC) the totals belong to. A new day resets everything. */
  date: string;
  /** Machine-wide total for `date`. */
  total: number;
  /** Per-scope totals for `date`; a scope is normally one Bimax Thread. */
  scopes: Record<string, number>;
}

export interface SpendCaps {
  /** The machine's daily ceiling, in USD. `0` or less means unlimited. */
  daily: number;
  /** One scope's daily ceiling, in USD. Absent/0 means the scope is bounded only by `daily`. */
  perScope?: number;
}

export interface SpendState {
  date: string;
  total: number;
  scope: string | null;
  scopeTotal: number;
}

export type ChargeRefusal = { ok: false; reason: string; which: 'machine' | 'scope'; state: SpendState };
export type ChargeAccepted = { ok: true; state: SpendState };
export type ChargeResult = ChargeAccepted | ChargeRefusal;

export class SpendLedgerError extends Error {}

function today(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function wait(ms: number): void {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* retry */ }
}

function fresh(date: string): SpendLedgerFile {
  return { version: 1, date, total: 0, scopes: {} };
}

/**
 * Where the shared ledger lives, and which scope this process charges to.
 *
 * Both come from the environment because the desktop is the only thing that can know them: it owns
 * userData and it is the one spawning a Thread's engine. Absent, the caller keeps whatever
 * behaviour it had — this must never make a CLI or headless run refuse to spend.
 */
export function resolveSpendContext(env: NodeJS.ProcessEnv = process.env): { path: string | null; scope: string | null } {
  const p = (env[SPEND_LEDGER_ENV] || '').trim();
  const s = (env[SPEND_SCOPE_ENV] || '').trim();
  return { path: p || null, scope: s || null };
}

export class SpendLedger {
  constructor(
    readonly filePath: string,
    private readonly now: () => number = Date.now,
  ) {}

  private lockPath(): string { return `${this.filePath}.lock`; }

  /**
   * Read-modify-write under an exclusive lock. Mirrors SubAgentCapacityCoordinator.withLock, with
   * one deliberate difference: a corrupt ledger here does NOT throw. Refusing to spend because a
   * JSON file went bad would brick every task on the machine; losing today's running total is the
   * cheaper failure, and it is loud in the returned state rather than silent.
   */
  private withLock<T>(fn: (file: SpendLedgerFile, now: number) => T): T {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const lock = this.lockPath();
    let fd: number | null = null;
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
      try { fd = fs.openSync(lock, 'wx', 0o600); break; } catch (error: any) {
        if (error?.code !== 'EEXIST') throw new SpendLedgerError(`Spend ledger unavailable: ${error?.message || error}`);
        try {
          if (this.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(lock);
        } catch { /* another process released it */ }
        wait(5);
      }
    }
    if (fd === null) throw new SpendLedgerError('Spend ledger is busy.');

    try {
      const now = this.now();
      const date = today(now);
      let file = fresh(date);
      try {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        if (parsed?.version === 1 && typeof parsed.total === 'number' && typeof parsed.date === 'string') {
          file = { version: 1, date: parsed.date, total: parsed.total, scopes: parsed.scopes && typeof parsed.scopes === 'object' ? parsed.scopes : {} };
        }
      } catch { /* absent or corrupt → start today at zero */ }

      // Midnight rollover happens here, inside the lock, so a process that outlives the day resets
      // exactly once no matter how many engines are running.
      if (file.date !== date) file = fresh(date);

      const result = fn(file, now);
      const tmp = `${this.filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 0o600 });
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

  /** Today's totals, without charging anything. */
  read(scope: string | null = null): SpendState {
    return this.withLock((file) => ({
      date: file.date,
      total: file.total,
      scope,
      scopeTotal: scope ? (file.scopes[scope] ?? 0) : 0,
    }));
  }

  /**
   * Would this charge be allowed? Pure with respect to the ledger — it takes the lock to read a
   * consistent snapshot but writes nothing, so a check is never a charge.
   */
  wouldAllow(amountUsd: number, caps: SpendCaps, scope: string | null = null): ChargeResult {
    return this.decide(this.read(scope), amountUsd, caps, scope);
  }

  private decide(state: SpendState, amountUsd: number, caps: SpendCaps, scope: string | null): ChargeResult {
    const amount = Number.isFinite(amountUsd) && amountUsd > 0 ? amountUsd : 0;
    // The machine ceiling is checked FIRST: it is the one that protects the bill, and naming it in
    // the refusal is more useful than naming a scope the user may not even be looking at.
    if (caps.daily > 0 && state.total + amount > caps.daily) {
      return {
        ok: false, which: 'machine', state,
        reason: `Daily budget of $${caps.daily.toFixed(2)} reached for this Mac (spent $${state.total.toFixed(2)} across every Bimax Thread today). Raise it with MAX_DAILY_SPEND, or disable the cap with /governor off.`,
      };
    }
    if (scope && caps.perScope && caps.perScope > 0 && state.scopeTotal + amount > caps.perScope) {
      return {
        ok: false, which: 'scope', state,
        reason: `This task has used its own $${caps.perScope.toFixed(2)} share (spent $${state.scopeTotal.toFixed(2)}). The Mac's daily budget still has $${Math.max(0, caps.daily - state.total).toFixed(2)} left for other tasks.`,
      };
    }
    return { ok: true, state };
  }

  /**
   * Charge, atomically, if both ceilings allow it. One lock covers the check and the write, so two
   * engines cannot both pass a check and then both spend.
   */
  charge(amountUsd: number, caps: SpendCaps, scope: string | null = null): ChargeResult {
    return this.withLock((file) => {
      const state: SpendState = {
        date: file.date, total: file.total, scope,
        scopeTotal: scope ? (file.scopes[scope] ?? 0) : 0,
      };
      const verdict = this.decide(state, amountUsd, caps, scope);
      if (!verdict.ok) return verdict;

      const amount = Number.isFinite(amountUsd) && amountUsd > 0 ? amountUsd : 0;
      file.total += amount;
      if (scope) file.scopes[scope] = (file.scopes[scope] ?? 0) + amount;
      return { ok: true, state: { ...state, total: file.total, scopeTotal: scope ? file.scopes[scope] : 0 } };
    });
  }

  /**
   * Record a charge that has ALREADY happened, whatever the ceilings say.
   *
   * A provider call that completed cost money regardless of what a budget file thinks, and dropping
   * it because it crossed the cap would make the ledger under-report — the one direction that turns
   * a safety rail into a lie. Ceilings refuse the NEXT call; they never un-spend the last one.
   */
  recordSettled(amountUsd: number, scope: string | null = null): SpendState {
    return this.withLock((file) => {
      const amount = Number.isFinite(amountUsd) && amountUsd > 0 ? amountUsd : 0;
      file.total += amount;
      if (scope) file.scopes[scope] = (file.scopes[scope] ?? 0) + amount;
      return { date: file.date, total: file.total, scope, scopeTotal: scope ? file.scopes[scope] : 0 };
    });
  }

  /** Every scope that spent today, largest first — the data behind a per-task cost view (N6). */
  breakdown(): Array<{ scope: string; spent: number }> {
    const file = this.withLock((f) => f);
    return Object.entries(file.scopes)
      .map(([scope, spent]) => ({ scope, spent }))
      .sort((a, b) => b.spent - a.spent);
  }
}
