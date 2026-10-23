import { stateDir } from '../utils/state.dir';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Logger } from '../utils';
import { Mutex } from 'async-mutex';

export class FreeCreditsTracker {
  private dailyQuota = 10;
  private currentUsage = 0;
  private lastResetDate = '';
  private readonly QUOTA_PATH = path.join(stateDir('.breakglass'), 'credits', 'quota.json');
  private mutex = new Mutex();

  constructor() {
    this.loadQuota().catch(() => {});
  }

  private getLocalDate(): string {
    // Returns YYYY-MM-DD in local timezone
    return new Date().toLocaleDateString('en-CA');
  }

  private async loadQuota() {
    return await this.mutex.runExclusive(async () => {
      try {
        const data = await fs.readFile(this.QUOTA_PATH, 'utf-8');
        const payload = JSON.parse(data);
        
        const today = this.getLocalDate();
        if (payload.lastResetDate === today) {
          this.currentUsage = payload.currentUsage;
          this.lastResetDate = payload.lastResetDate;
        } else {
          // New day, reset quota
          this.currentUsage = 0;
          this.lastResetDate = today;
          await this.saveQuotaInternal();
          Logger.info(`[FreeTier] Local midnight passed. Free quota reset to 0.`);
        }
      } catch (e) {
        // Initialize fresh
        this.lastResetDate = this.getLocalDate();
        await this.saveQuotaInternal();
      }
    });
  }

  private async saveQuotaInternal() {
    try {
      await fs.mkdir(path.dirname(this.QUOTA_PATH), { recursive: true });
      await fs.writeFile(this.QUOTA_PATH, JSON.stringify({
        currentUsage: this.currentUsage,
        lastResetDate: this.lastResetDate
      }, null, 2), 'utf-8');
    } catch (e) {
      Logger.error(`[FreeTier] Failed to write quota to disk.`);
    }
  }

  private async saveQuota() {
    return await this.mutex.runExclusive(async () => {
      await this.saveQuotaInternal();
    });
  }

  async canUseFreeTier(): Promise<boolean> {
    await this.loadQuota(); // ensure state is synced
    return this.currentUsage < this.dailyQuota;
  }

  async recordUsage(): Promise<void> {
    // Check-and-increment must be atomic so concurrent calls cannot both pass the
    // quota check and over-spend. saveQuotaInternal is used (not saveQuota) because
    // the mutex is not reentrant.
    await this.mutex.runExclusive(async () => {
      if (this.currentUsage < this.dailyQuota) {
        this.currentUsage++;
        await this.saveQuotaInternal();
        Logger.info(`[FreeTier] Used 1 free credit. (${this.currentUsage}/${this.dailyQuota} used today)`);
      }
    });
  }

  getRemaining(): number {
    return this.dailyQuota - this.currentUsage;
  }
}
