import { Logger } from '../utils';
import { Mutex } from 'async-mutex';
import { KeyUsage, KeyUsageStore, RPM_WINDOW_MS, keyId, resolveKeyUsageStore } from './key.usage.ledger';

export interface KeyConfig {
  keyStr: string;
  model?: string;
  baseURL?: string;
  provider?: string;
  label?: string;
  /**
   * The provider's per-key request limit, per minute, shared by every engine on the Mac (0 or
   * absent = no known limit; the pool then learns only from 429s).
   */
  rpm?: number;
}

export interface KeyState extends KeyConfig {
  /** Ledger identity: a hash prefix, never the key. */
  id: string;
  /** Starts this process handed out inside the window — the pacing used when the shared ledger is unusable. */
  local_starts: number[];
  cooldown_until: number;
  consecutive_429: number;
  consecutive_403: number;
  consecutive_401: number;
  total_ok: number;
  total_fail: number;
  last_used: number;
  // Latency health (NIM free-tier keys get server-side queued INDIVIDUALLY — one key answers in
  // 1s while a sibling takes 40s or hangs, so rotation must be latency-aware, not blind RR).
  ewma_first_ms: number; // time-to-first-token EWMA; 0 = no data yet
  hang_strikes: number;  // consecutive first-token timeouts — benched with growing cooldowns
}

export interface KeyResult {
  keyStr: string | null;
  model: string | null;
  baseURL: string | null;
  provider: string | null;
  idx: number | null;
  waitTimeSecs: number;
}

export interface ApiKeyManagerOptions {
  /** Shared per-key request ledger. Defaults to the machine-wide file (see key.usage.ledger.ts). */
  store?: KeyUsageStore;
  /** Clock, epoch ms. Injected by tests. */
  now?: () => number;
}

export class ApiKeyManager {
  private keyStates: KeyState[] = [];
  private keyRR: number = 0;
  private readonly store: KeyUsageStore;
  private readonly clock: () => number;

  private readonly KEY_COOLDOWN_BASE = 2.0;
  private readonly KEY_COOLDOWN_MAX = 60.0;
  private readonly KEY_COOLDOWN_JITTER = 1.0;
  // RPM pacing: with SEVERAL keys in the pool, avoid re-using the same key within this window when
  // a colder sibling is available — a burst of calls then fans out across the whole pool instead of
  // hammering one key into its per-key RPM limit and eating a 429 + cooldown. With a single key this
  // never applies (nothing to prefer), so solo setups see zero added latency. Seconds.
  private readonly MIN_REUSE_SECS = Math.max(0, (parseInt(process.env.BIMAX_KEY_MIN_INTERVAL_MS || '1100', 10) || 0) / 1000);

  constructor(keys: KeyConfig[], options: ApiKeyManagerOptions = {}) {
    this.store = options.store ?? resolveKeyUsageStore();
    this.clock = options.now ?? Date.now;
    this.setKeys(keys);
  }

  /**
   * Replace the key pool in place (e.g. after /keys adds a key mid-session — previously a new key
   * only took effect after a restart). Health state is preserved for keys that survive the rebuild,
   * so a key on 429 cooldown doesn't get a clean slate just because a sibling was added.
   */
  public setKeys(keys: KeyConfig[]): void {
    const prior = new Map(this.keyStates.map(s => [s.keyStr, s]));
    const uniqueKeys = new Map<string, KeyConfig>();
    for (const k of keys) {
      if (!uniqueKeys.has(k.keyStr)) uniqueKeys.set(k.keyStr, k);
    }
    this.keyStates = Array.from(uniqueKeys.values()).map(k => {
      const old = prior.get(k.keyStr);
      return {
        ...k,
        id: keyId(k.keyStr),
        local_starts: old?.local_starts ?? [],
        cooldown_until: old?.cooldown_until ?? 0.0,
        consecutive_429: old?.consecutive_429 ?? 0,
        consecutive_403: old?.consecutive_403 ?? 0,
        consecutive_401: old?.consecutive_401 ?? 0,
        total_ok: old?.total_ok ?? 0,
        total_fail: old?.total_fail ?? 0,
        last_used: old?.last_used ?? 0,
        ewma_first_ms: old?.ewma_first_ms ?? 0,
        hang_strikes: old?.hang_strikes ?? 0,
      };
    });
    // Start the rotation at a random index: N parallel sub-agent workers each build their OWN
    // manager over the same pool, and a deterministic start had them all piling onto key #1.
    this.keyRR = this.keyStates.length > 0
      ? (this.keyRR || Math.floor(Math.random() * this.keyStates.length)) % this.keyStates.length
      : 0;
    const limits = Array.from(new Set(this.keyStates.map(s => s.rpm || 0)));
    const rpmNote = limits.length === 1 && limits[0] > 0 ? `, ${limits[0]} requests/min each` : '';
    Logger.info(`[ApiKeyManager] Key pool set: ${this.keyStates.length} key(s) across ${new Set(keys.map(k => k.provider || 'unknown')).size} provider(s)${rpmNote}.`);
  }

  private mutex = new Mutex();

  /**
   * The hybrid round robin. Every call walks the pool in rotation order and considers only keys
   * that are usable right now: off this process's cooldown, off any cooldown another engine
   * recorded for the key, and under the key's requests-per-minute limit counted across EVERY
   * engine on the Mac. Among those it prefers, in order:
   *   1. a key not used in the last MIN_REUSE_SECS (a burst fans out across the pool instead of
   *      hammering one key into its limit), then
   *   2. the lowest measured time-to-first-token, weighted up by how much of its minute the key
   *      has already spent — NIM free-tier keys are queued individually server-side (1s on one
   *      key, 40s on a sibling), so blind rotation kept walking calls into the slow lane.
   * Ties go to rotation order. When no key is usable, nothing is reserved and `waitTimeSecs`
   * says when the earliest one frees; the caller waits and asks again.
   */
  public async getNextKey(options: { exclude?: number } = {}): Promise<KeyResult> {
    return await this.mutex.runExclusive(async () => {
      if (this.keyStates.length === 0) return { keyStr: null, model: null, baseURL: null, provider: null, idx: null, waitTimeSecs: 0 };

      const nowMs = this.clock();
      let pickedIdx = -1;
      let seen = new Map<string, KeyUsage>();
      const choose = (usage: Map<string, KeyUsage>): string | null => {
        seen = usage;
        pickedIdx = this.choose(usage, nowMs, options.exclude);
        return pickedIdx >= 0 ? this.keyStates[pickedIdx].id : null;
      };
      try {
        this.store.reserve(this.keyStates.map(s => s.id), nowMs, choose);
      } catch (e: any) {
        // The shared ledger is unusable (disk full, a lock held by a dead process past its stale
        // window). Pace from this process's own memory — the pre-ledger behaviour — rather than
        // refuse a turn over bookkeeping.
        Logger.warn(`[ApiKeyManager] shared key ledger unavailable (${e?.message || e}); pacing this engine alone.`);
        choose(this.localUsage(nowMs));
      }

      if (pickedIdx >= 0) {
        const state = this.keyStates[pickedIdx];
        this.keyRR = (pickedIdx + 1) % this.keyStates.length;
        state.last_used = nowMs / 1000;
        state.local_starts = state.local_starts.filter(t => nowMs - t < RPM_WINDOW_MS);
        state.local_starts.push(nowMs);
        return { keyStr: state.keyStr, model: state.model || null, baseURL: state.baseURL || null, provider: state.provider || null, idx: pickedIdx, waitTimeSecs: 0 };
      }

      // Nothing usable: report the key that frees soonest, and when. Not reserved — the caller
      // must come back, because by then a different key may be the better pick.
      let soonIdx = 0;
      let soonest = Infinity;
      for (let idx = 0; idx < this.keyStates.length; idx++) {
        const freeAt = this.freeAt(this.keyStates[idx], seen.get(this.keyStates[idx].id), nowMs);
        if (freeAt < soonest) { soonest = freeAt; soonIdx = idx; }
      }
      const s = this.keyStates[soonIdx];
      return { keyStr: s.keyStr, model: s.model || null, baseURL: s.baseURL || null, provider: s.provider || null, idx: soonIdx, waitTimeSecs: Math.max(0, (soonest - nowMs) / 1000) };
    });
  }

  /**
   * A key that is usable now, waiting — for at most `maxWaitMs` — while every key is cooling down
   * or at its per-minute limit. Each wake asks the pool again, because the key that frees first is
   * not necessarily the one to use (another engine may have taken it, or a faster one freed).
   *
   * Stops waiting early when every key has failed authentication: that can never clear by itself.
   * Past the budget it returns the soonest key anyway and lets the provider answer, so a
   * misconfigured limit can slow a turn but never wedge it.
   */
  public async acquire(options: {
    maxWaitMs?: number;
    sleep?: (ms: number) => Promise<void>;
    onWait?: (waitSecs: number) => void;
  } = {}): Promise<KeyResult> {
    const maxWaitMs = options.maxWaitMs ?? 120_000;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    const started = this.clock();
    let kr = await this.getNextKey();
    while (kr.keyStr && kr.waitTimeSecs > 0 && !this.allKeysAuthDead()) {
      const remaining = maxWaitMs - (this.clock() - started);
      if (remaining <= 0) break;
      options.onWait?.(kr.waitTimeSecs);
      // Never sleep less than a beat: a slot that frees "in 0.001s" would otherwise spin the loop.
      await sleep(Math.max(50, Math.min(kr.waitTimeSecs * 1000, remaining)));
      kr = await this.getNextKey();
    }
    return kr;
  }

  /**
   * Index of the key to use now, or -1 when every key is cooling down or at its limit. `exclude` is a
   * key that must not be picked — the one a hedged request is already waiting on.
   */
  private choose(usage: Map<string, KeyUsage>, nowMs: number, exclude?: number): number {
    const n = this.keyStates.length;
    const now = nowMs / 1000;
    const known = this.keyStates.filter(s => s.ewma_first_ms > 0).map(s => s.ewma_first_ms).sort((a, b) => a - b);
    const median = known.length ? known[Math.floor(known.length / 2)] : 1000;
    let bestIdx = -1;
    let bestScore = Infinity;
    for (let i = 0; i < n; i++) {
      const idx = (this.keyRR + i) % n;
      if (idx === exclude) continue;
      const state = this.keyStates[idx];
      const u = usage.get(state.id) ?? { recent: 0, cooldownUntil: 0, starts: [] };
      if (now < state.cooldown_until || u.cooldownUntil > nowMs) continue;
      const rpm = state.rpm || 0;
      if (rpm > 0 && u.recent >= rpm) continue;
      const latency = state.ewma_first_ms > 0 ? state.ewma_first_ms : median;
      const load = rpm > 0 ? u.recent / rpm : 0;
      const warm = n > 1 && this.MIN_REUSE_SECS > 0 && now - state.last_used < this.MIN_REUSE_SECS;
      const score = (warm ? 1e12 : 0) + latency * (1 + load);
      if (score < bestScore) {
        bestScore = score;
        bestIdx = idx;
      }
    }
    return bestIdx;
  }

  /** Epoch ms at which this key next becomes usable. */
  private freeAt(state: KeyState, u: KeyUsage | undefined, nowMs: number): number {
    let at = Math.max(nowMs, state.cooldown_until * 1000, u?.cooldownUntil ?? 0);
    const rpm = state.rpm || 0;
    if (rpm > 0 && u && u.recent >= rpm) at = Math.max(at, u.starts[u.recent - rpm] + RPM_WINDOW_MS);
    return at;
  }

  private localUsage(nowMs: number): Map<string, KeyUsage> {
    return new Map(this.keyStates.map(s => {
      const starts = s.local_starts.filter(t => nowMs - t < RPM_WINDOW_MS).sort((a, b) => a - b);
      return [s.id, { recent: starts.length, cooldownUntil: 0, starts }];
    }));
  }

  /** Tell every other engine on the Mac that a provider asked for this key to be left alone. */
  private shareCooldown(s: KeyState, untilSecs: number): void {
    try { this.store.cooldown(s.id, untilSecs * 1000, this.clock()); } catch { /* local cooldown still applies */ }
  }

  public reportKeyResult(idx: number, status: number, retryAfterSecs: number | null = null): void {
    const now = this.clock() / 1000;
    const s = this.keyStates[idx];
    if (!s) return;

    // Status 0 = the failure was LOCAL (DNS, socket, connect) — the provider never saw the
    // request, so the key is not to blame. Neutral: no health counters, no cooldown. Billing
    // the machine's network to the key is how one blip snowballed into a benched pool.
    if (status === 0) return;

    if (status >= 200 && status < 300) {
      s.total_ok++;
      s.consecutive_429 = 0;
      s.consecutive_403 = 0;
      s.consecutive_401 = 0;
      s.cooldown_until = 0.0;
      return;
    }

    s.total_fail++;

    if (status === 429) {
      s.consecutive_429++;
      const cooldown = retryAfterSecs ?? Math.min(this.KEY_COOLDOWN_BASE * Math.pow(2, s.consecutive_429 - 1), this.KEY_COOLDOWN_MAX);
      const jitter = Math.random() * this.KEY_COOLDOWN_JITTER;
      s.cooldown_until = now + cooldown + jitter;
      this.shareCooldown(s, s.cooldown_until);
      Logger.warn(`[ApiKeyManager] KEY #${idx + 1} (${s.label || s.provider || '?'}) -> 429 cooldown ${cooldown.toFixed(1)}s`);
    } else if (status === 403) {
      s.consecutive_403++;
      s.cooldown_until = now + 2.0;
    } else if (status === 401) {
      s.consecutive_401++;
      s.cooldown_until = now + 5.0;
    } else if (status === 408) {
      s.cooldown_until = now + 2.0;
    } else if (status === 502 || status === 504) {
      s.cooldown_until = now + 2.0;
    } else if (status >= 500) {
      s.cooldown_until = now + 3.0;
    }
  }

  /**
   * Feed back a successful call's time-to-first-token so the picker can prefer fast keys.
   * EWMA (α=0.3) smooths jitter; a success also clears the hang bench.
   */
  public reportKeyLatency(idx: number, firstTokenMs: number): void {
    const s = this.keyStates[idx];
    if (!s || !(firstTokenMs > 0)) return;
    s.ewma_first_ms = s.ewma_first_ms > 0 ? Math.round(0.7 * s.ewma_first_ms + 0.3 * firstTokenMs) : Math.round(firstTokenMs);
    s.hang_strikes = 0;
  }

  /**
   * A first-token timeout on this key — the provider is queueing/hanging it server-side. Bench it
   * with a growing cooldown (45s → 90s → 3min → capped 10min) so rotation stops feeding the dead
   * lane; a later success clears the strikes (reportKeyLatency).
   */
  public reportKeyHang(idx: number): void {
    const now = this.clock() / 1000;
    const s = this.keyStates[idx];
    if (!s) return;
    s.hang_strikes++;
    // Benching exists to steer ROTATION away from a hanging lane. With a single key there is
    // nothing to rotate to — a long bench just converts one stall into minutes of self-inflicted
    // "all keys cooling down" dead time (observed live). Cap the solo-pool bench at 3s.
    const benchSecs = this.keyStates.length === 1
      ? 3
      : Math.min(45 * Math.pow(2, s.hang_strikes - 1), 600);
    s.cooldown_until = Math.max(s.cooldown_until, now + benchSecs);
    if (this.keyStates.length > 1) this.shareCooldown(s, s.cooldown_until);
    // Poison the latency estimate too, so pass-1 stops preferring it even after the bench expires.
    s.ewma_first_ms = Math.max(s.ewma_first_ms, 60_000);
    Logger.warn(`[ApiKeyManager] KEY #${idx + 1} (${s.label || s.provider || '?'}) hung before first token — benched ${benchSecs.toFixed(0)}s (strike ${s.hang_strikes})`);
  }

  /** Pool size — lets the adapter pick a tighter first-token budget when rotation is possible. */
  public size(): number {
    return this.keyStates.length;
  }

  /**
   * True when EVERY key in the pool has most recently failed auth (401/403). Auth failures are
   * permanent for a given key string — sleeping through a cooldown and retrying the same key can
   * never succeed, it just adds dead seconds to every turn. Callers should fail fast with an
   * actionable "fix your key" error instead of waiting. A success resets the counters (see
   * reportKeyResult), so a key fixed mid-session recovers on its next use.
   */
  public allKeysAuthDead(): boolean {
    return this.keyStates.length > 0 &&
      this.keyStates.every(s => s.consecutive_401 > 0 || s.consecutive_403 > 1);
  }

  public getStates() {
    const now = this.clock() / 1000;
    return this.keyStates.map(s => ({
      label: s.label || s.provider || 'key',
      model: s.model || 'default',
      baseURL: s.baseURL || 'default',
      ok: s.total_ok,
      fail: s.total_fail,
      onCooldown: s.cooldown_until > now,
      cooldownSecs: Math.max(0, s.cooldown_until - now),
      firstTokenMs: s.ewma_first_ms,
      hangs: s.hang_strikes,
      rpm: s.rpm || 0,
      lastMinute: s.local_starts.filter(t => this.clock() - t < RPM_WINDOW_MS).length,
    }));
  }
}
