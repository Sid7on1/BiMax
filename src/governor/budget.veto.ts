import { stateDir } from '../utils/state.dir';
import { Logger } from '../utils';
import { SafetyPolicy } from './policy.engine';
import { GovernorVetoError } from '../core/errors';
import { engineEvents } from '../engine/events';
import * as fsSync from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Mutex } from 'async-mutex';
import { SpendLedger, resolveSpendContext, type SpendCaps } from './spend.ledger';

export class BudgetVeto {
  /**
   * The machine-wide ledger, when the host configured one (`BIMAX_SPEND_LEDGER_PATH`), plus the
   * scope this engine charges to (`BIMAX_SPEND_SCOPE`, normally one Bimax Thread).
   *
   * WHY. The file this class writes lives under `stateDir('.breakglass')`, and `stateDir` honours
   * `BIMAX_STATE_DIR` — which the desktop sets PER Bimax Thread. So every Thread had its own
   * spend.json and its own full daily cap; measured 2026-09-19, four independent ledgers already
   * existed on the development machine. See src/governor/spend.ledger.ts for the measurement.
   *
   * The local counters below are kept either way: they are what the warning and the log line read,
   * and they still bound THIS process. The shared ledger is authoritative for the refusal.
   *
   * KNOWN BOUND, stated rather than hidden: reservations remain in-process, so two engines can each
   * pass a check and each start one call before either settles. The overshoot is therefore at most
   * one in-flight call per live engine — bounded by MAX_LIVE_ENGINES — and `recordSettled` always
   * books the real cost, so the total stays truthful and the next check refuses. Distributed
   * reservations would need a lease protocol; that is not worth it for a bounded single-call window.
   */
  private readonly shared: SpendLedger | null;
  private readonly scope: string | null;
  private currentDailySpend: number = 0;
  private reservedSpend: number = 0;
  // The day `currentDailySpend` belongs to. A long-running process (day-long autonomous loops)
  // crosses midnight, so the reset can't live only in the constructor — it's re-checked on every
  // spend/veto via rolloverIfNewDay(), otherwise yesterday's spend carries into today (tripping the
  // cap early) and gets persisted stamped with today's date.
  private spendDate: string = new Date().toISOString().split('T')[0];
  private readonly spendFilePath: string;
  private budgetMutex = new Mutex();
  // When the governor is bypassed (/governor off), the budget stops vetoing — it still TRACKS spend
  // so the running total stays accurate, but it never blocks a call. The adapter holds this instance
  // directly (container.setBudgetVeto), so without this flag disabling the governor left the daily
  // cap silently killing every LLM response ("Budget limit exceeded" with no output). The Governor
  // keeps this in sync with its mode.
  public enabled: boolean = true;
  /** Fraction of the daily cap at which the user is warned that a long run is about to be stopped. */
  private static readonly WARN_AT = 0.8;
  /** The day the approaching-cap warning was last shown, so it appears once rather than per call. */
  private warnedOn: string | null = null;

  constructor() {
    const { path: sharedPath, scope } = resolveSpendContext();
    this.shared = sharedPath ? new SpendLedger(sharedPath) : null;
    this.scope = scope;

    const creditsDir = path.join(stateDir('.breakglass'), 'credits');
    this.spendFilePath = path.join(creditsDir, 'spend.json');

    // Use sync fs here because constructor cannot be async easily
    if (!fsSync.existsSync(creditsDir)) {
      fsSync.mkdirSync(creditsDir, { recursive: true });
    }

    this.loadPersistentSpendSync();
  }

  private loadPersistentSpendSync() {
    try {
      if (fsSync.existsSync(this.spendFilePath)) {
        const data = JSON.parse(fsSync.readFileSync(this.spendFilePath, 'utf8'));
        
        // Reset budget if it's a new day
        const today = new Date().toISOString().split('T')[0];
        this.spendDate = today;
        if (data.date !== today) {
          this.currentDailySpend = 0;
          this.savePersistentSpendSync();
          Logger.info(`[Governor] New day detected. Budget reset to $0.00.`);
        } else {
          this.currentDailySpend = data.spend || 0;
          Logger.info(`[Governor] Loaded physical budget: $${this.currentDailySpend.toFixed(2)} / $${SafetyPolicy.maxDailySpendUsd.toFixed(2)}`);
        }
      } else {
        this.savePersistentSpendSync();
      }
    } catch (e: any) {
      Logger.error(`[Governor] Failed to load spend.json: ${e.message}`);
    }
  }

  private savePersistentSpendSync() {
    const data = {
      date: this.spendDate,
      spend: this.currentDailySpend
    };
    fsSync.writeFileSync(this.spendFilePath, JSON.stringify(data, null, 2), 'utf8');
  }

  private async savePersistentSpendAsync() {
    const data = {
      date: this.spendDate,
      spend: this.currentDailySpend
    };
    await fs.writeFile(this.spendFilePath, JSON.stringify(data, null, 2), 'utf8');
  }

  /**
   * Roll the daily counters over when the wall-clock day has advanced since the last spend was
   * recorded. Called inside the budget mutex at the top of every spend/veto path so a process that
   * outlives midnight resets exactly once, instead of carrying yesterday's total into today.
   */
  private rolloverIfNewDay() {
    const today = new Date().toISOString().split('T')[0];
    if (this.spendDate !== today) {
      this.currentDailySpend = 0;
      this.reservedSpend = 0;
      this.spendDate = today;
      Logger.info(`[Governor] New day detected mid-session. Budget reset to $0.00.`);
    }
  }

  /** The ceilings in force: the machine's daily cap, and this Thread's share of it when set. */
  private caps(): SpendCaps {
    const daily = SafetyPolicy.maxDailySpendUsd;
    const share = parseFloat(process.env.BIMAX_SPEND_SCOPE_CAP || '');
    return { daily, perScope: Number.isFinite(share) && share > 0 ? share : undefined };
  }

  /**
   * Book a cost that has ALREADY been incurred, in the shared ledger as well as locally.
   *
   * Deliberately never conditional on the cap: a provider call that completed cost money whatever
   * the ledger says, and skipping it would make the machine total under-report — the one direction
   * that turns this from a safety rail into a lie.
   */
  private bookShared(actualCostUsd: number): void {
    if (!this.shared || !(actualCostUsd > 0)) return;
    try { this.shared.recordSettled(actualCostUsd, this.scope); } catch (e: any) {
      // A ledger that cannot be written must not fail the turn whose money is already spent. It is
      // logged rather than swallowed, because a silently unrecorded charge is how a cap drifts.
      Logger.error(`[Governor] Shared spend ledger write failed; machine total is now under-reported: ${e?.message || e}`);
    }
  }

  async recordSpend(actualCostUsd: number, estimatedCostUsd: number = 0): Promise<void> {
    await this.budgetMutex.runExclusive(async () => {
      this.rolloverIfNewDay();
      this.reservedSpend = Math.max(0, this.reservedSpend - estimatedCostUsd);
      this.currentDailySpend += actualCostUsd;
      this.bookShared(actualCostUsd);
      await this.savePersistentSpendAsync();
      Logger.info(`[Governor] Budget updated: $${this.currentDailySpend.toFixed(2)} / $${SafetyPolicy.maxDailySpendUsd.toFixed(2)}`);
      this.warnIfApproachingCap();
    });
  }

  /**
   * Tell the user BEFORE the cap stops them, once per day.
   *
   * The cap was previously silent until it fired: spend crossed only into a Logger.info line the
   * user never sees, and the first signal was a veto mid-task — observed killing a real run at
   * 15/16 completed steps, which reads as a crash rather than a budget decision. A warning at 80%
   * is the difference between raising the cap now and losing the work in progress.
   *
   * Caller holds the budget mutex. Never throws: a warning that breaks a turn would be worse than
   * the silence it replaces.
   */
  private warnIfApproachingCap(): void {
    if (!this.enabled) return;
    const cap = SafetyPolicy.maxDailySpendUsd;
    if (!(cap > 0) || this.warnedOn === this.spendDate) return;
    if (this.currentDailySpend < cap * BudgetVeto.WARN_AT) return;
    this.warnedOn = this.spendDate;
    const remaining = Math.max(0, cap - this.currentDailySpend);
    try {
      engineEvents.emit('status',
        `Daily budget ${Math.round((this.currentDailySpend / cap) * 100)}% used `
        + `($${this.currentDailySpend.toFixed(2)} of $${cap.toFixed(2)}, $${remaining.toFixed(2)} left). `
        + `Raise it with MAX_DAILY_SPEND or disable the cap with /governor off before starting long work.`);
    } catch { /* the warning is an observer — never let it break a turn */ }
  }

  /**
   * The shared ledger's refusal for this call, or null when it allows it (or is not configured).
   *
   * Consulted IN ADDITION to the local counters, never instead of them: the local total still
   * bounds this process, and the shared one bounds the machine. Whichever refuses first wins, and
   * its own message is used — a Thread that has used its share needs to hear that, not "daily
   * budget reached", which would send the user raising a cap that is not the one stopping them.
   */
  private sharedRefusal(estimatedCostUsd: number): string | null {
    if (!this.shared || !this.enabled) return null;
    try {
      const verdict = this.shared.wouldAllow(estimatedCostUsd, this.caps(), this.scope);
      return verdict.ok ? null : verdict.reason;
    } catch (e: any) {
      // Fail OPEN. A locked or unreadable ledger must not stop work the user is watching; the local
      // cap below still applies, so this degrades to the old per-process behaviour rather than to
      // no limit at all.
      Logger.error(`[Governor] Shared spend ledger unreadable, falling back to the local cap: ${e?.message || e}`);
      return null;
    }
  }

  async checkVeto(estimatedCostUsd: number): Promise<void> {
    await this.budgetMutex.runExclusive(async () => {
      this.rolloverIfNewDay();
      const refusal = this.sharedRefusal(estimatedCostUsd);
      if (refusal) {
        Logger.error(`[Governor: Veto] API call blocked by the machine-wide budget.`);
        throw new GovernorVetoError(refusal);
      }
      // Bypassed governor → reserve (to keep the running estimate honest) but never veto.
      if (this.enabled && this.currentDailySpend + this.reservedSpend + estimatedCostUsd > SafetyPolicy.maxDailySpendUsd) {
        Logger.error(`[Governor: Veto] API call blocked. Exceeds daily limit of $${SafetyPolicy.maxDailySpendUsd}`);
        throw new GovernorVetoError(`Daily budget of $${SafetyPolicy.maxDailySpendUsd.toFixed(2)} reached (spent $${this.currentDailySpend.toFixed(2)}). Disable the cap with /governor off, or raise it via MAX_DAILY_SPEND.`);
      }
      this.reservedSpend += estimatedCostUsd;
    });
  }

  async releaseReservation(estimatedCostUsd: number): Promise<void> {
    await this.budgetMutex.runExclusive(async () => {
      this.reservedSpend = Math.max(0, this.reservedSpend - estimatedCostUsd);
    });
  }

  async executeWithBudget<T>(estimatedCostUsd: number, action: () => Promise<{ actualCostUsd: number, result: T }>): Promise<T> {
    return await this.budgetMutex.runExclusive(async () => {
      this.rolloverIfNewDay();
      const refusal = this.sharedRefusal(estimatedCostUsd);
      if (refusal) {
        Logger.error(`[Governor: Veto] API call blocked by the machine-wide budget.`);
        throw new GovernorVetoError(refusal);
      }
      if (this.enabled && this.currentDailySpend + this.reservedSpend + estimatedCostUsd > SafetyPolicy.maxDailySpendUsd) {
        Logger.error(`[Governor: Veto] API call blocked. Exceeds daily limit of $${SafetyPolicy.maxDailySpendUsd}`);
        throw new GovernorVetoError(`Daily budget of $${SafetyPolicy.maxDailySpendUsd.toFixed(2)} reached (spent $${this.currentDailySpend.toFixed(2)}). Disable the cap with /governor off, or raise it via MAX_DAILY_SPEND.`);
      }

      const { actualCostUsd, result } = await action();
      this.currentDailySpend += actualCostUsd;
      this.bookShared(actualCostUsd);
      await this.savePersistentSpendAsync();
      Logger.info(`[Governor] Budget updated: $${this.currentDailySpend.toFixed(2)} / $${SafetyPolicy.maxDailySpendUsd.toFixed(2)}`);
      this.warnIfApproachingCap();
      return result;
    });
  }
}
