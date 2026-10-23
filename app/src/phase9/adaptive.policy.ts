import { createHash } from 'node:crypto';

/**
 * Phase 9 / V01 + V03 + V05 + V27B + V29B / S29-F.
 *
 * Only `background-concurrency` is allowed to act automatically in this first canary. Model backend,
 * indexing, networking, and nonessential rendering remain observe-only. Reduce Motion is a hard
 * accessibility constraint and is therefore applied regardless of canary state or performance.
 */

export type ThermalState = 'nominal' | 'fair' | 'serious' | 'critical' | 'unknown';
export type MemoryPressure = 'normal' | 'warning' | 'critical' | 'unknown';
export type PowerSource = 'ac' | 'battery' | 'unknown';
export type NetworkQuality = 'offline' | 'constrained' | 'normal' | 'unknown';

export interface RuntimeSignals {
  observedAt: number;
  architecture: 'arm64' | 'x64' | 'unknown';
  cpuCount: number;
  availableMemoryMb: number;
  /**
   * Installed physical memory. The policy itself only needs the headroom figure above, but the
   * ratio between the two is what makes that figure legible to a person — "3.1 GB free" means
   * nothing without the total beside it. It was already being computed here to derive memory
   * pressure and then thrown away, which is why Machine Health showed an invented "16 GB".
   */
  totalMemoryMb: number;
  thermal: ThermalState;
  memoryPressure: MemoryPressure;
  powerSource: PowerSource;
  lowPowerMode: boolean | null;
  network: NetworkQuality;
  activeInteraction: boolean;
  reduceMotion: boolean;
  simulatorReservationMb: number;
  localModelReservationMb: number;
}

export interface AdaptiveDecision {
  decisionClass: 'background-concurrency';
  policyVersion: 'bimax-adaptive/1';
  snapshotHash: string;
  previous: number;
  selected: number;
  automatic: boolean;
  changed: boolean;
  reasons: string[];
  thresholds: { minimumResidenceMs: number; interactionCooldownMs: number; minimumHeadroomMb: number };
  expiresAt: number;
}

export interface RenderingDecision {
  mode: 'full' | 'quiet' | 'reduced-motion';
  preferredFps: 60 | 30;
  nonessentialAnimation: boolean;
  automatic: boolean;
  reasons: string[];
}

export interface AdaptivePolicyOptions {
  canaryEnabled?: boolean;
  minimumResidenceMs?: number;
  interactionCooldownMs?: number;
  minimumHeadroomMb?: number;
  now?: () => number;
}

function hashSignals(signals: RuntimeSignals): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(signals)).digest('hex')}`;
}

export class AdaptiveRuntimePolicy {
  private current = 2;
  private lastChangedAt = Number.NEGATIVE_INFINITY;
  private lastInteractionAt = Number.NEGATIVE_INFINITY;
  private readonly now: () => number;
  private readonly thresholds: AdaptiveDecision['thresholds'];
  private readonly canaryEnabled: boolean;

  constructor(options: AdaptivePolicyOptions = {}) {
    this.now = options.now ?? Date.now;
    this.thresholds = {
      minimumResidenceMs: options.minimumResidenceMs ?? 30_000,
      interactionCooldownMs: options.interactionCooldownMs ?? 2_000,
      minimumHeadroomMb: options.minimumHeadroomMb ?? 1536,
    };
    this.canaryEnabled = options.canaryEnabled === true;
  }

  decide(signals: RuntimeSignals): AdaptiveDecision {
    const now = this.now();
    if (signals.activeInteraction) this.lastInteractionAt = now;
    const reasons: string[] = [];
    const reserved = Math.max(0, signals.simulatorReservationMb) + Math.max(0, signals.localModelReservationMb);
    const headroom = signals.availableMemoryMb - reserved;
    let desired = Math.max(1, Math.min(4, Math.floor(Math.max(1, signals.cpuCount) / 2)));
    if (signals.activeInteraction || now - this.lastInteractionAt < this.thresholds.interactionCooldownMs) {
      desired = 1;
      reasons.push('Active interaction has priority over new background work.');
    }
    if (signals.memoryPressure === 'critical' || headroom < this.thresholds.minimumHeadroomMb) {
      desired = 1;
      reasons.push('Memory headroom is below the safe background-work floor.');
    } else if (signals.memoryPressure === 'warning') {
      desired = Math.min(desired, 2);
      reasons.push('Memory pressure is elevated.');
    }
    if (signals.thermal === 'critical' || signals.thermal === 'serious') {
      desired = 1;
      reasons.push(`Thermal state is ${signals.thermal}.`);
    } else if (signals.thermal === 'fair') {
      desired = Math.min(desired, 2);
      reasons.push('Thermal state is fair.');
    }
    if (signals.lowPowerMode === true || signals.powerSource === 'battery') {
      desired = Math.min(desired, signals.lowPowerMode ? 1 : 2);
      reasons.push(signals.lowPowerMode === true ? 'Low Power Mode is enabled.' : 'The Mac is on battery power.');
    }
    if (signals.memoryPressure === 'unknown' || signals.thermal === 'unknown') {
      desired = Math.min(desired, 2);
      reasons.push('A required system signal is unknown, so policy uses a bounded default.');
    }
    desired = Math.max(1, Math.min(4, desired));

    // Constrain immediately; relax only after the minimum residence time. This prevents noisy
    // sensors from fanning work in and out while still protecting an interactive/pressured Mac.
    const constraining = desired < this.current;
    const mayRelax = now - this.lastChangedAt >= this.thresholds.minimumResidenceMs;
    const next = this.canaryEnabled && (constraining || mayRelax) ? desired : this.current;
    const changed = next !== this.current;
    const previous = this.current;
    if (changed) { this.current = next; this.lastChangedAt = now; }
    if (!this.canaryEnabled) reasons.push('The background-concurrency policy is in shadow mode.');
    if (this.canaryEnabled && desired > this.current && !mayRelax) reasons.push('Hysteresis held the prior limit until minimum residence time expires.');
    return {
      decisionClass: 'background-concurrency', policyVersion: 'bimax-adaptive/1',
      snapshotHash: hashSignals(signals), previous, selected: this.current,
      automatic: this.canaryEnabled, changed, reasons: reasons.length ? reasons : ['System capacity is inside the measured baseline.'],
      thresholds: { ...this.thresholds }, expiresAt: now + 60_000,
    };
  }

  engineEnvironment(decision: AdaptiveDecision): Record<string, string> {
    if (!decision.automatic) return {};
    return {
      BIMAX_MAX_CONCURRENT_SUBAGENTS: String(decision.selected),
      BIMAX_POWER_AWARE: '1',
      BIMAX_POWER_SOFT_SUBAGENTS: String(decision.selected),
    };
  }
}

/**
 * What the renderer may spend frames on. Applied for real since WP-1/WP-2 (record 57); before that
 * every caller passed `canaryEnabled: false`, so this function was computed every 30 s, broadcast
 * over IPC, and discarded — the GPU half of the adaptive design had never executed once.
 *
 * `quiet` stops DECORATIVE motion only: the infinite loops (blink, shimmer, orbit, the talk orb)
 * that cost a compositor pass every frame and communicate nothing. Motion that carries state — a
 * turn's elapsed seconds, a notice's expiry, a surface arriving — keeps running, because a person
 * on battery still needs to know what the agent is doing.
 *
 * `activeInteraction` is deliberately NOT a quiet trigger, though it is one for background
 * concurrency. The two mean different things. For background work "the user is typing" is a good
 * reason to hold off for two seconds. For rendering it would stop decoration on every keystroke and
 * restart it two seconds later, so the decoration would flicker in and out while someone typed —
 * visibly worse than either steady state. Quiet is driven by sustained machine pressure instead,
 * which changes on the scale of minutes and therefore does not churn.
 */
export function renderingPolicy(signals: RuntimeSignals, canaryEnabled = false): RenderingDecision {
  if (signals.reduceMotion) {
    return {
      mode: 'reduced-motion', preferredFps: 30, nonessentialAnimation: false, automatic: true,
      reasons: ['Reduce Motion is a hard accessibility constraint.'],
    };
  }
  const pressure: string[] = [];
  if (signals.lowPowerMode === true) pressure.push('Low Power Mode is enabled.');
  if (signals.thermal === 'serious' || signals.thermal === 'critical') pressure.push(`Thermal state is ${signals.thermal}.`);
  if (signals.memoryPressure === 'critical') pressure.push('Memory pressure is critical.');
  if (signals.powerSource === 'battery') pressure.push('The Mac is on battery power.');
  const quiet = pressure.length > 0;
  return {
    mode: quiet ? 'quiet' : 'full', preferredFps: quiet ? 30 : 60,
    nonessentialAnimation: canaryEnabled ? !quiet : true,
    automatic: canaryEnabled,
    reasons: quiet
      ? [...pressure, ...(canaryEnabled ? [] : ['Rendering adaptation remains in shadow mode.'])]
      : ['Runtime signals allow full rendering.', ...(canaryEnabled ? [] : ['Rendering adaptation remains in shadow mode.'])],
  };
}

export interface ReplayResult {
  decisions: AdaptiveDecision[];
  transitions: number;
  maximumSelected: number;
  minimumSelected: number;
}

export function replayPolicy(policy: AdaptiveRuntimePolicy, trace: RuntimeSignals[]): ReplayResult {
  const decisions = trace.map((signals) => policy.decide(signals));
  const selected = decisions.map((decision) => decision.selected);
  return {
    decisions,
    transitions: decisions.filter((decision) => decision.changed).length,
    maximumSelected: selected.length ? Math.max(...selected) : 0,
    minimumSelected: selected.length ? Math.min(...selected) : 0,
  };
}
