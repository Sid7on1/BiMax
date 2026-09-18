import { execFile } from 'child_process';
import * as fs from 'fs';
import { promisify } from 'util';
import { engineEvents } from '../engine/events';
import { MAX_CONCURRENT_SUBAGENTS } from '../core/subagent.capacity';

const execFileAsync = promisify(execFile);

/**
 * Phase 3a — Power-awareness (Grok `xai-system-power` port, in concept).
 *
 * A per-OS, shell-out battery/thermal sensor that turns hardware pressure into an *advisory* the
 * autonomous machinery can respect. It never vetoes and never blocks a single foreground action:
 * its whole job on a laptop that's unplugged or thermally throttled is to stop Bimax fanning out
 * parallel sub-agents and to slow the loop's retry cadence, so a long unattended run doesn't drain
 * the battery flat or cook the CPU. The design mirrors {@link BudgetVeto}: a small, injectable,
 * self-contained governor sibling with a pure decision function on top of an impure reader.
 *
 * Reads are cheap but not free (they fork `pmset`), so the monitor polls on a background interval
 * and every consumer reads a *cached* {@link PowerState}. Before the first poll settles the state
 * is `unknown`, which deliberately advises no throttling — power-awareness must fail *open* (never
 * make Bimax more restrictive because it couldn't read the battery).
 */

export type PowerSource = 'ac' | 'battery' | 'unknown';
export type ThrottleLevel = 'none' | 'soft';

export interface PowerState {
  source: PowerSource;
  /** 0–100, or null when unreadable / no battery (desktop). */
  batteryPercent: number | null;
  charging: boolean;
  /** True when the OS reports the CPU is being speed-limited for thermal reasons. */
  thermalThrottled: boolean;
  /** macOS `pmset -g therm` CPU_Speed_Limit (100 = unthrottled), or null when unknown. */
  cpuSpeedLimitPct: number | null;
  /** Wall-clock ms this reading was taken. */
  readAt: number;
}

export interface ThrottleAdvice {
  level: ThrottleLevel;
  /** Effective concurrent sub-agent ceiling the spawn gate should honor (≤ the hard cap). */
  maxConcurrentSubagents: number;
  /** Extra backoff the autonomous loop should add between transient retries, in ms. */
  loopBackoffMs: number;
  /** Human-readable cause, or empty when not throttling. */
  reason: string;
}

export interface PowerThresholds {
  /** On battery at or below this %, engage soft throttle. */
  batteryPct: number;
  /** On battery below this % (and not charging), tighten to a single sub-agent. */
  criticalBatteryPct: number;
  /** Concurrent sub-agents allowed while soft-throttled but not critical. */
  softMaxSubagents: number;
  /** Extra loop backoff (ms) while any throttle is engaged. */
  loopBackoffMs: number;
}

export const UNKNOWN_POWER: PowerState = {
  source: 'unknown',
  batteryPercent: null,
  charging: false,
  thermalThrottled: false,
  cpuSpeedLimitPct: null,
  readAt: 0,
};

export const NO_THROTTLE: ThrottleAdvice = {
  level: 'none',
  maxConcurrentSubagents: MAX_CONCURRENT_SUBAGENTS,
  loopBackoffMs: 0,
  reason: '',
};

function envInt(name: string, fallback: number): number {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** Env-tunable, mirroring {@link SafetyPolicy}. Read once per monitor construction. */
export function defaultThresholds(): PowerThresholds {
  return {
    batteryPct: envInt('BIMAX_POWER_BATTERY_THRESHOLD', 30),
    criticalBatteryPct: envInt('BIMAX_POWER_CRITICAL_THRESHOLD', 15),
    softMaxSubagents: Math.max(1, Math.min(MAX_CONCURRENT_SUBAGENTS, envInt('BIMAX_POWER_SOFT_SUBAGENTS', 2))),
    loopBackoffMs: envInt('BIMAX_POWER_LOOP_BACKOFF_MS', 4000),
  };
}

/**
 * OPT-IN: power-awareness is off unless explicitly enabled (BIMAX_POWER_AWARE=1/on). It ships
 * disabled because its user benefit is unproven; when enabled it constrains only NEW
 * background/sub-agent work and never delays the interactive loop.
 */
export function powerAwarenessEnabled(): boolean {
  const v = String(process.env.BIMAX_POWER_AWARE || '').toLowerCase();
  return v === '1' || v === 'on' || v === 'true';
}

// ── Parsers (pure — the impure reader feeds these; tests hit them directly) ──────────────────────

/**
 * Parse macOS `pmset -g batt`, e.g.:
 *   Now drawing from 'Battery Power'
 *    -InternalBattery-0 (id=…)  47%; discharging; 2:41 remaining present: true
 */
export function parsePmsetBatt(out: string): Pick<PowerState, 'source' | 'batteryPercent' | 'charging'> {
  const drawingAc = /drawing from '\s*AC Power\s*'/i.test(out);
  const pctMatch = out.match(/(\d{1,3})%/);
  const batteryPercent = pctMatch ? Math.max(0, Math.min(100, parseInt(pctMatch[1], 10))) : null;
  // "charging" appears while plugged in and topping up; "charged"/"AC attached"/"finishing charge"
  // also mean on-wall. "discharging" is the only truly-on-battery drain state.
  const discharging = /;\s*discharging\b/i.test(out);
  const chargingWord = /;\s*(charging|finishing charge|charged|AC attached)\b/i.test(out);
  const source: PowerSource = drawingAc || (!discharging && chargingWord) ? 'ac' : 'battery';
  const charging = source === 'ac';
  return { source, batteryPercent, charging };
}

/**
 * Parse macOS `pmset -g therm`. When the CPU is being throttled it reports a CPU_Speed_Limit under
 * 100; on a cool machine it either omits the line or prints a "No thermal warning level" note.
 */
export function parsePmsetTherm(out: string): { thermalThrottled: boolean; cpuSpeedLimitPct: number | null } {
  const m = out.match(/CPU_Speed_Limit\s*=\s*(\d{1,3})/i);
  if (!m) return { thermalThrottled: false, cpuSpeedLimitPct: null };
  const limit = Math.max(0, Math.min(100, parseInt(m[1], 10)));
  return { thermalThrottled: limit < 100, cpuSpeedLimitPct: limit };
}

// ── The monitor ──────────────────────────────────────────────────────────────────────────────────

export interface PowerMonitorOptions {
  /** Fork a command and return its stdout. Injected in tests. */
  exec?: (cmd: string, args: string[]) => Promise<string>;
  /** Read a sysfs file as utf8, or null when absent. Injected in tests. */
  readFile?: (path: string) => string | null;
  platform?: NodeJS.Platform;
  now?: () => number;
  /** Cache TTL / background poll cadence, ms. */
  pollMs?: number;
  thresholds?: PowerThresholds;
  /** Announce throttle transitions on engineEvents. Off in tests. */
  announce?: boolean;
}

export class PowerMonitor {
  private state: PowerState = UNKNOWN_POWER;
  private lastLevel: ThrottleLevel = 'none';
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<PowerState> | null = null;

  private readonly exec: (cmd: string, args: string[]) => Promise<string>;
  private readonly readFile: (path: string) => string | null;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly thresholds: PowerThresholds;
  private readonly announce: boolean;

  constructor(opts: PowerMonitorOptions = {}) {
    this.exec = opts.exec ?? (async (cmd, args) => {
      const { stdout } = await execFileAsync(cmd, args, { timeout: 4000, windowsHide: true });
      return stdout;
    });
    this.readFile = opts.readFile ?? ((p) => {
      try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
    });
    this.platform = opts.platform ?? process.platform;
    this.now = opts.now ?? Date.now;
    this.pollMs = opts.pollMs ?? envInt('BIMAX_POWER_POLL_MS', 30_000);
    this.thresholds = opts.thresholds ?? defaultThresholds();
    this.announce = opts.announce ?? false;
  }

  /** Begin background polling. Idempotent; the timer is unref'd so it never holds the process open. */
  start(): this {
    if (this.timer) return this;
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, this.pollMs);
    this.timer.unref?.();
    return this;
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Last cached reading. Consumers should prefer this — it never forks a process. */
  snapshot(): PowerState { return this.state; }

  /** Read hardware now, update the cache, and (once running) announce level transitions. */
  async refresh(): Promise<PowerState> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.read()
      .then((next) => {
        this.state = next;
        this.reconcileLevel();
        return next;
      })
      .catch(() => {
        // Fail open: a reader that throws (unsupported platform, missing binary) leaves the last
        // good state — or `unknown`, which advises no throttle — in place. Deliberately silent:
        // this fires every poll on platforms without a reader and must never spam the log.
        return this.state;
      })
      .finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async read(): Promise<PowerState> {
    if (this.platform === 'darwin') return this.readDarwin();
    if (this.platform === 'linux') return this.readLinux();
    // Windows/other: no cheap sudo-free reader we trust — treat as AC (fail open).
    return { ...UNKNOWN_POWER, source: 'unknown', readAt: this.now() };
  }

  private async readDarwin(): Promise<PowerState> {
    const battOut = await this.exec('pmset', ['-g', 'batt']).catch(() => '');
    const batt = parsePmsetBatt(battOut);
    const thermOut = await this.exec('pmset', ['-g', 'therm']).catch(() => '');
    const therm = parsePmsetTherm(thermOut);
    // A machine that never reports a battery (Mac mini/Studio) reads as AC.
    const source: PowerSource = batt.batteryPercent == null && !/Battery Power/i.test(battOut)
      ? 'ac' : batt.source;
    return {
      source,
      batteryPercent: batt.batteryPercent,
      charging: source === 'ac',
      thermalThrottled: therm.thermalThrottled,
      cpuSpeedLimitPct: therm.cpuSpeedLimitPct,
      readAt: this.now(),
    };
  }

  private async readLinux(): Promise<PowerState> {
    // AC first: any online power_supply of type Mains means we're plugged in.
    const acOnline = ['AC', 'ACAD', 'ADP0', 'AC0'].some(
      (n) => (this.readFile(`/sys/class/power_supply/${n}/online`) || '').trim() === '1'
    );
    let batteryPercent: number | null = null;
    let batteryStatus = '';
    for (const n of ['BAT0', 'BAT1', 'battery']) {
      const cap = this.readFile(`/sys/class/power_supply/${n}/capacity`);
      if (cap != null) {
        const pct = parseInt(cap.trim(), 10);
        if (Number.isFinite(pct)) batteryPercent = Math.max(0, Math.min(100, pct));
        batteryStatus = (this.readFile(`/sys/class/power_supply/${n}/status`) || '').trim();
        break;
      }
    }
    const hasBattery = batteryPercent != null;
    // sysfs `status` is a single word (Charging/Discharging/Full/Not charging/Unknown). Anchor the
    // match so "Discharging" is not caught by a bare "charging" substring.
    const charging = acOnline || /^(charging|full)$/i.test(batteryStatus);
    const source: PowerSource = !hasBattery ? 'ac' : (charging ? 'ac' : 'battery');
    return {
      source,
      batteryPercent,
      charging,
      // Sudo-free thermal throttle detection on Linux is unreliable across drivers; leave it to
      // battery pressure here rather than guess from raw thermal_zone temps.
      thermalThrottled: false,
      cpuSpeedLimitPct: null,
      readAt: this.now(),
    };
  }

  /** Pure decision: hardware state → advisory. Exposed for direct testing. */
  advice(state: PowerState = this.state): ThrottleAdvice {
    if (!powerAwarenessEnabled()) return NO_THROTTLE;
    const t = this.thresholds;
    const onBattery = state.source === 'battery' && !state.charging;
    const pct = state.batteryPercent ?? 100;

    const critical = onBattery && pct <= t.criticalBatteryPct;
    const lowBattery = onBattery && pct <= t.batteryPct;
    const thermal = state.thermalThrottled;

    if (!critical && !lowBattery && !thermal) return NO_THROTTLE;

    const reasons: string[] = [];
    if (critical) reasons.push(`battery critically low (${pct}%)`);
    else if (lowBattery) reasons.push(`on battery (${pct}%)`);
    if (thermal) reasons.push(`thermal throttling (CPU limited to ${state.cpuSpeedLimitPct ?? '?'}%)`);

    return {
      level: 'soft',
      maxConcurrentSubagents: critical ? 1 : t.softMaxSubagents,
      loopBackoffMs: t.loopBackoffMs,
      reason: reasons.join('; '),
    };
  }

  private reconcileLevel(): void {
    const level = this.advice().level;
    if (level === this.lastLevel) return;
    const prev = this.lastLevel;
    this.lastLevel = level;
    if (!this.announce) return;
    // Refresh any ui_snapshot-driven footer chip immediately on a throttle transition.
    engineEvents.emit('power_changed');
    if (level === 'soft') {
      const a = this.advice();
      const text = `🔋 Power-aware backoff engaged — ${a.reason}. Limiting parallel sub-agents to ${a.maxConcurrentSubagents} and slowing the loop.`;
      engineEvents.emit('log', { id: Date.now(), level: 'warn', text, timestamp: new Date() });
      engineEvents.emit('status', 'Power-aware backoff active');
    } else if (prev === 'soft') {
      engineEvents.emit('log', { id: Date.now(), level: 'info', text: '🔌 Power restored — full concurrency resumed.', timestamp: new Date() });
    }
  }
}

/**
 * Process-wide monitor. Consumers (the spawn gate, the loop) read {@link PowerMonitor.snapshot} /
 * {@link PowerMonitor.advice} off this instance; the app boot starts it once. Tests construct their
 * own {@link PowerMonitor} and never touch this singleton.
 */
export const powerMonitor = new PowerMonitor({ announce: true });

/** Cached advice for hot-path callers (spawn gate). Zero I/O — reads the last poll. */
export function powerThrottleAdvice(): ThrottleAdvice {
  return powerMonitor.advice();
}

/**
 * Flattened power + throttle view — the single shape every surface reads (ui_snapshot footer, the
 * `/power` command, the ACP session banner) so they never drift. Pure read off the cached poll.
 */
export interface PowerSummary {
  source: PowerSource;
  batteryPercent: number | null;
  charging: boolean;
  thermalThrottled: boolean;
  cpuSpeedLimitPct: number | null;
  level: ThrottleLevel;
  maxConcurrentSubagents: number;
  loopBackoffMs: number;
  reason: string;
  /** True once at least one real reading has landed (source left `unknown`). */
  known: boolean;
}

export function powerSummary(monitor: PowerMonitor = powerMonitor): PowerSummary {
  const s = monitor.snapshot();
  const a = monitor.advice();
  return {
    source: s.source,
    batteryPercent: s.batteryPercent,
    charging: s.charging,
    thermalThrottled: s.thermalThrottled,
    cpuSpeedLimitPct: s.cpuSpeedLimitPct,
    level: a.level,
    maxConcurrentSubagents: a.maxConcurrentSubagents,
    loopBackoffMs: a.loopBackoffMs,
    reason: a.reason,
    known: s.source !== 'unknown',
  };
}

/** One-line human summary for status chips / the `/power` header. */
export function powerStatusLine(sum: PowerSummary = powerSummary()): string {
  if (!sum.known) return 'Power: unknown (no reading yet)';
  const src = sum.source === 'ac' ? (sum.charging ? 'AC (charging)' : 'AC') : 'battery';
  const batt = sum.batteryPercent != null ? ` ${sum.batteryPercent}%` : '';
  const therm = sum.thermalThrottled ? `, thermal-limited to ${sum.cpuSpeedLimitPct ?? '?'}%` : '';
  const throttle = sum.level === 'soft' ? ` — backoff active (≤${sum.maxConcurrentSubagents} sub-agents)` : '';
  return `Power: ${src}${batt}${therm}${throttle}`;
}

/** Re-export of the shared hard cap so consumers/tests confirm they agree on the ceiling. */
export const MAX_CONCURRENT_SUBAGENTS_REEXPORT_CHECK = MAX_CONCURRENT_SUBAGENTS;
