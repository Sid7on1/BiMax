import {
  CapabilityPlan, CrashKind, CrashRecord, EnginePhase, HeartbeatInfo, MemoryInfo, ProfileId,
  SupervisorStatus,
} from './types';
import { bootProgress, isLivePhase, isStartupPhase, phaseMessage, transition } from './machine';
import {
  CrashEvent, DEFAULT_POLICY, PolicyConfig, classifyExit, decideRestart,
} from './policy';
import { degradedCapabilities, minProfile, planCapabilities } from './resources';
import { CrashJournal } from './journal';
import {
  CLIENT_MAX_COMPATIBLE_MAJOR, CLIENT_MIN_COMPATIBLE_MAJOR, supportsProtocolMajor,
} from '../../shared/protocol.compat';

/**
 * EngineSupervisor — the authoritative engine lifecycle for the desktop app. Starts, monitors,
 * recovers, and resumes the headless engine child:
 *
 *   • explicit phase machine (machine.ts) fed by the engine's `boot`/`ready` protocol lines
 *   • heartbeat watchdog with separate startup / idle / active-turn thresholds
 *   • resource-aware capability planning per launch (resources.ts)
 *   • bounded auto-restart with backoff+jitter and progressive capability shedding (policy.ts)
 *   • desktop-owned crash journal (journal.ts)
 *   • generation ids: every spawn increments `generation`; events and messages from a superseded
 *     child compare against the CURRENT generation and are dropped — a stale exit can never
 *     clobber a fresh child's state, and a stale child never receives current messages.
 *
 * Everything external is injected (clock, timers, spawn, memory, randomness, journal storage),
 * so the whole lifecycle runs deterministically under test.
 */

export const EXPECTED_PROTOCOL = CLIENT_MAX_COMPATIBLE_MAJOR;

// ---------------------------------------------------------------------------------------------
// Injected dependencies

export interface EngineHandle {
  pid?: number;
  /** Human-readable launch command for the crash journal (no env, no secrets). */
  command: string;
  write(line: string): void;
  endStdin(): void;
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
}

export interface SpawnCallbacks {
  onMessage(msg: Record<string, unknown>): void;
  onMalformed(line: string): void;
  onExit(code: number | null, signal: string | null): void;
  onError(err: Error): void;
}

export interface SupervisorDeps {
  spawn(projectDir: string, extraEnv: Record<string, string>, cb: SpawnCallbacks): EngineHandle;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  random(): number;
  memory(): MemoryInfo;
  env: Record<string, string | undefined>;
  journal: CrashJournal;
  /** Bounded, desktop-owned tail of the engine log (journal evidence). */
  logTail(): string;
  onStatus(status: SupervisorStatus): void;
  /** Protocol passthrough to the renderer — only ever called for the CURRENT generation. */
  onMessage(msg: unknown): void;
  onNotice(level: 'info' | 'warn' | 'error', text: string): void;
}

export interface SupervisorTimeouts {
  startupTimeoutMs: number;
  idleHeartbeatTimeoutMs: number;
  activeHeartbeatTimeoutMs: number;
  watchdogTickMs: number;
  killEscalationMs: number;
}

export const DEFAULT_TIMEOUTS: SupervisorTimeouts = {
  startupTimeoutMs: 120_000,        // dev boots compile TS from source — generous on purpose
  idleHeartbeatTimeoutMs: 20_000,   // heartbeats arrive every ~3s; 20s of silence is a wedge
  activeHeartbeatTimeoutMs: 600_000, // long legitimate work still ticks the timer-based heartbeat
  watchdogTickMs: 2_000,
  killEscalationMs: 3_000,
};

// ---------------------------------------------------------------------------------------------
// Renderer-originated inputs (validated — the renderer is not trusted)

export type RecoveryAction =
  | { action: 'retry' }
  | { action: 'restartSafe'; sessionId?: string }
  | { action: 'resume'; sessionId: string }
  | { action: 'startMinimal' }
  | { action: 'stop' };

const SESSION_ID_RE = /^[\w.:-]{1,128}$/;

/** Parse an untrusted renderer payload into a typed action, or null when malformed. */
export function parseRecoveryAction(raw: unknown): RecoveryAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = (raw as Record<string, unknown>).action;
  const sid = (raw as Record<string, unknown>).sessionId;
  const sessionId = typeof sid === 'string' && SESSION_ID_RE.test(sid) ? sid : undefined;
  switch (a) {
    case 'retry': return { action: 'retry' };
    case 'restartSafe': return { action: 'restartSafe', sessionId };
    case 'resume': return sessionId ? { action: 'resume', sessionId } : null;
    case 'startMinimal': return { action: 'startMinimal' };
    case 'stop': return { action: 'stop' };
    default: return null;
  }
}

/**
 * Protocol messages that are safe to hold and replay once a (re)started engine is ready: pure
 * reads with no side effects. Everything else — inputs, approval replies, menu selections, config
 * writes, interrupts — would duplicate or misdirect a mutation if replayed against a different
 * engine process, so it is rejected loudly instead of queued.
 */
const SAFE_REPLAY = new Set(['ping', 'query', 'configGet']);
const MAX_QUEUE = 32;

export function isSafeToReplay(msg: unknown): boolean {
  return !!msg && typeof msg === 'object' && SAFE_REPLAY.has(String((msg as Record<string, unknown>).t));
}

// ---------------------------------------------------------------------------------------------

interface HealthLine {
  uptimeMs: number; rssMb: number; heapMb: number; eventLoopDelayMs: number; activeTurn: boolean;
}

export class EngineSupervisor {
  private phase: EnginePhase = 'idle';
  private enteredAt: number;
  private attempt = 1;
  private generation = 0;
  private reason = 'idle';

  private child: EngineHandle | null = null;
  private childGen = 0;
  private spawnedAt = 0;
  private childProtocol: number | null = null;
  private childIdentity: { version: string; buildCommit: string; features: string[] } | null = null;
  private intentionalStop = false;
  private watchdogVerdict: 'startup_timeout' | 'unresponsive' | 'protocol_failure' | null = null;
  private malformedLines = 0;

  private plan: CapabilityPlan;
  private profileFloor: ProfileId = 'full';

  private heartbeat: HeartbeatInfo | null = null;
  private heartbeatSeen = false;

  private history: CrashEvent[] = [];
  private projectDir = '';

  private queue: unknown[] = [];
  private pendingResume: string | null = null;
  private lastSession: { id: string; messageCount: number } | null = null;
  private interruptedSessionId: string | null = null;

  private watchdogTimer: unknown = null;
  private restartTimer: unknown = null;
  private restartAt = 0;
  private killTimers = new Set<unknown>();
  private disposed = false;

  constructor(
    private deps: SupervisorDeps,
    private timeouts: SupervisorTimeouts = DEFAULT_TIMEOUTS,
    private policy: PolicyConfig = DEFAULT_POLICY,
  ) {
    this.enteredAt = deps.now();
    this.plan = planCapabilities(deps.memory(), deps.env, 'full');
  }

  // --- public surface --------------------------------------------------------------------------

  get currentProject(): string { return this.projectDir; }

  status(): SupervisorStatus {
    return {
      phase: this.phase,
      enteredAt: this.enteredAt,
      attempt: this.attempt,
      generation: this.generation,
      message: phaseMessage(this.phase),
      reason: this.reason,
      recoverable: this.phase === 'failed' ? true : undefined,
      progress: bootProgress(this.phase),
      pid: this.child?.pid,
      profile: this.plan.profile,
      capabilities: this.plan.capabilities,
      degradedCapabilities: degradedCapabilities(this.plan),
      lastHeartbeat: this.heartbeat,
      countdownMs: this.phase === 'restarting' ? Math.max(0, this.restartAt - this.deps.now()) : undefined,
      interruptedSessionId: this.interruptedSessionId ?? undefined,
    };
  }

  /** Open (or switch to) a project: supersede any running child, fresh restart budget. */
  openProject(dir: string): void {
    if (this.disposed) return;
    this.projectDir = dir;
    this.history = [];
    this.profileFloor = 'full';
    this.attempt = 1;
    this.interruptedSessionId = null;
    this.lastSession = null;
    this.pendingResume = null;
    this.queue = [];
    this.cancelScheduledRestart();
    this.supersedeChild();
    this.spawnChild();
  }

  /** Intentional stop — never auto-restarted. */
  stop(): void {
    this.cancelScheduledRestart();
    if (!this.child) {
      if (this.phase !== 'idle') this.enter('idle', 'stopped');
      return;
    }
    this.intentionalStop = true;
    this.enter('stopping', 'stop_requested');
    this.terminateChild(this.child);
  }

  /** Resolvers waiting for a disposed child's exit, by its generation. */
  private exitWaiters = new Map<number, (confirmed: boolean) => void>();

  /**
   * App quit or a thread's Stop: stop everything and make sure no timer can relaunch the engine afterwards.
   *
   * Resolves true once the process has exited, and false if it still had not by the time SIGKILL should have ended it,
   * so a caller can hold a folder until the old writer is really gone without waiting forever (backlog F11, T04).
   */
  dispose(): Promise<boolean> {
    this.disposed = true;
    this.cancelScheduledRestart();
    this.stopWatchdog();
    for (const t of this.killTimers) this.deps.clearTimeout(t);
    this.killTimers.clear();
    const child = this.child;
    const gen = this.childGen;
    // Supersede first: the exit event of the dying child must not run recovery logic.
    this.supersedeChild();
    if (!child) return Promise.resolve(true);
    try { child.endStdin(); } catch { /* gone */ }
    try { child.kill('SIGTERM'); } catch { /* gone */ }
    return new Promise((resolve) => {
      let settled = false;
      const settle = (confirmed: boolean): void => {
        if (settled) return;
        settled = true;
        this.exitWaiters.delete(gen);
        resolve(confirmed);
      };
      this.exitWaiters.set(gen, settle);
      this.deps.setTimeout(() => settle(false), this.timeouts.killEscalationMs + 2000);
    });
  }

  /** A validated renderer recovery action. Returns false when the payload was malformed. */
  handleAction(raw: unknown): boolean {
    const action = parseRecoveryAction(raw);
    if (!action) {
      this.deps.onNotice('warn', 'Ignored malformed recovery action from the renderer.');
      return false;
    }
    switch (action.action) {
      case 'retry':
        this.manualRestart(this.profileFloor);
        return true;
      case 'restartSafe':
        if (action.sessionId) this.pendingResume = action.sessionId;
        this.manualRestart(minProfile(this.profileFloor, 'conservative'));
        return true;
      case 'startMinimal':
        this.manualRestart('minimal');
        return true;
      case 'resume':
        this.requestResume(action.sessionId);
        return true;
      case 'stop':
        this.stop();
        return true;
    }
  }

  /**
   * A protocol message from the renderer. Delivered when the engine is interactive; queued when
   * it's merely a safe-to-replay read; rejected (with a visible notice) otherwise — an unsafe
   * message must never be silently replayed into a different engine process.
   */
  sendFromRenderer(raw: unknown): void {
    if (!raw || typeof raw !== 'object' || typeof (raw as Record<string, unknown>).t !== 'string') {
      this.deps.onNotice('warn', 'Ignored malformed engine message from the renderer.');
      return;
    }
    const t = String((raw as Record<string, unknown>).t);
    if ((this.phase === 'ready' || this.phase === 'degraded') && this.child) {
      this.writeToChild(raw);
      return;
    }
    // A correlated request — one the renderer is holding a promise open on — must never be met
    // with silence. Queuing is honest only while an engine is actually on its way; from a terminal
    // phase nothing will ever drain the queue, and the front-end is left to time out and report
    // the only thing IT can see ("the engine did not answer… check the provider key") while the
    // supervisor already knows the real reason and knows the key is not it.
    if (!this.answerIsComing() && this.answerUndeliverable(raw, t)) return;
    if (isSafeToReplay(raw)) {
      this.queue.push(raw);
      if (this.queue.length > MAX_QUEUE) this.queue.shift();
      return;
    }
    if (t === 'interrupt') return; // nothing to interrupt — dropping is the correct semantics
    this.deps.onNotice('warn', `Engine is not ready (${this.phase}) — "${t}" was not delivered. Retry once the engine is back.`);
  }

  /** True while a child is alive or a (re)start is in flight — i.e. a queued read still has a reader. */
  private answerIsComing(): boolean {
    return isLivePhase(this.phase) || this.phase === 'restarting';
  }

  /**
   * Answer a correlated request the engine will not receive, using the phase as the reason.
   * Returns false for kinds that carry no reply contract, which keep the queue/notice path.
   *
   * Reads only. A mutation (`configSet`) is deliberately absent: "not delivered" and "delivered
   * and rejected" are different facts about the user's config, and only the notice path can say
   * the first without implying the second.
   */
  private answerUndeliverable(raw: unknown, t: string): boolean {
    const id = (raw as Record<string, unknown>).id;
    if (typeof id !== 'number') return false;
    const because = `${phaseMessage(this.phase)}. This request never reached it — `
      + 'your provider key and endpoint were not involved.';
    if (t === 'catalogGet' || t === 'providerSet') {
      this.deps.onMessage({ t: 'catalogResult', id, providers: [], models: [], error: because });
      return true;
    }
    if (t === 'configGet') {
      // `configResult` carries no error field, so this says only what its shape can say: no
      // config. The catalogue reply above is what actually names the cause on screen.
      this.deps.onMessage({ t: 'configResult', id, config: {} });
      return true;
    }
    return false;
  }

  /** Resume a saved session: immediately when ready, otherwise after the next successful start. */
  requestResume(sessionId: string): void {
    if (!SESSION_ID_RE.test(sessionId)) {
      this.deps.onNotice('warn', 'Ignored resume request with an invalid session id.');
      return;
    }
    if ((this.phase === 'ready' || this.phase === 'degraded') && this.child) {
      this.sendResume(sessionId);
      return;
    }
    this.pendingResume = sessionId;
    if (!this.child && this.phase !== 'restarting') this.manualRestart(this.profileFloor);
  }

  crashHistory(): CrashRecord[] {
    return this.deps.journal.list();
  }

  /** Plain-text diagnostics for the "Copy diagnostics" button. Already redacted via the journal. */
  diagnosticsText(): string {
    const s = this.status();
    const lines = [
      `Bimax engine diagnostics — ${new Date(this.deps.now()).toISOString()}`,
      `project: ${this.projectDir || '(none)'}`,
      `phase: ${s.phase} (${s.reason}) attempt ${s.attempt} generation ${s.generation}`,
      `profile: ${s.profile}  pid: ${s.pid ?? '-'}  protocol: ${this.childProtocol ?? '-'}`,
      `capabilities: ${s.capabilities.map((c) => `${c.id}=${c.enabled ? 'on' : `off(${c.reason})`}`).join(', ')}`,
      `lastHeartbeat: ${s.lastHeartbeat ? JSON.stringify(s.lastHeartbeat) : 'none'}`,
      '',
      'Recent crashes:',
      ...this.crashHistory().slice(-5).map((r) =>
        `  ${r.at} ${r.kind} phase=${r.lastPhase} uptime=${Math.round(r.uptimeMs / 1000)}s exit=${r.exitCode ?? r.signal} attempt=${r.attempt} recovery=${r.recovery}`),
    ];
    return lines.join('\n');
  }

  // --- child lifecycle -------------------------------------------------------------------------

  private manualRestart(floor: ProfileId): void {
    if (this.disposed || !this.projectDir) return;
    // Duplicate-restart guard: while a child is already coming up, a second click must not spawn
    // a second engine. (An automatic-restart countdown IS cancelled — the user asked for "now".)
    if (this.child && isStartupPhase(this.phase)) {
      this.deps.onNotice('info', 'Engine is already starting.');
      return;
    }
    this.cancelScheduledRestart();
    this.profileFloor = floor;
    this.supersedeChild();
    this.attempt = 1;
    this.spawnChild();
  }

  private spawnChild(): void {
    if (this.disposed) return;
    // From ready/degraded the machine routes through `restarting` (a running engine never jumps
    // straight back to `spawning`); everywhere else `spawning` is directly legal.
    if (!transition(this.phase, 'spawning').ok) this.enter('restarting', 'relaunch');
    this.generation += 1;
    const gen = this.generation;
    this.childGen = gen;
    this.intentionalStop = false;
    this.watchdogVerdict = null;
    this.heartbeatSeen = false;
    this.heartbeat = null;
    this.childProtocol = null;
    this.childIdentity = null;
    this.malformedLines = 0;
    this.plan = planCapabilities(this.deps.memory(), this.deps.env, this.profileFloor);
    this.enter('spawning', 'launch');

    let handle: EngineHandle;
    try {
      handle = this.deps.spawn(this.projectDir, this.plan.env, {
        onMessage: (m) => this.onChildMessage(gen, m),
        onMalformed: (l) => this.onChildMalformed(gen, l),
        onExit: (code, signal) => this.onChildExit(gen, code, signal),
        onError: (err) => this.onChildError(gen, err),
      });
    } catch (err) {
      this.handleDeath(gen, null, null, true, err instanceof Error ? err.message : String(err));
      return;
    }
    this.child = handle;
    this.spawnedAt = this.deps.now();
    this.startWatchdog();
    this.emitStatus(); // now that we have a pid
  }

  private onChildMessage(gen: number, msg: Record<string, unknown>): void {
    if (gen !== this.childGen) return; // stale child — its output must not touch current state
    const t = String(msg.t ?? '');

    if (t === 'hello') {
      const major = Number(msg.protocolMajor);
      const engineMin = Number(msg.minCompatibleMajor);
      const engineMax = Number(msg.maxCompatibleMajor);
      const overlaps = Number.isInteger(engineMin) && Number.isInteger(engineMax)
        && Math.max(engineMin, CLIENT_MIN_COMPATIBLE_MAJOR) <= Math.min(engineMax, CLIENT_MAX_COMPATIBLE_MAJOR)
        && supportsProtocolMajor(major);
      if (!overlaps) {
        this.childProtocol = Number.isFinite(major) ? major : null;
        this.watchdogVerdict = 'protocol_failure';
        this.deps.onNotice('error', `Engine protocol ${String(msg.protocolVersion ?? major)} is incompatible with Desktop ${CLIENT_MIN_COMPATIBLE_MAJOR}–${CLIENT_MAX_COMPATIBLE_MAJOR}.`);
        this.killCurrentChild();
        return;
      }
      const identity = msg.engine as Record<string, unknown> | undefined;
      this.childProtocol = major;
      this.childIdentity = {
        version: String(identity?.version ?? 'unknown'),
        buildCommit: String(identity?.buildCommit ?? 'unknown'),
        features: Array.isArray(msg.features) ? msg.features.map(String) : [],
      };
    } else if (t === 'boot') {
      const phase = String(msg.phase ?? '') as EnginePhase;
      const res = transition(this.phase, phase);
      // Illegal here means out-of-order/backwards (dup line, phase we already passed) — keep going.
      if (res.ok && res.phase !== this.phase) this.enter(res.phase, 'boot_progress');
    } else if (t === 'health') {
      const h = msg as unknown as HealthLine;
      this.heartbeat = {
        at: this.deps.now(),
        uptimeMs: Number(h.uptimeMs) || 0,
        rssMb: Number(h.rssMb) || 0,
        heapMb: Number(h.heapMb) || 0,
        eventLoopDelayMs: Number(h.eventLoopDelayMs) || 0,
        activeTurn: !!h.activeTurn,
      };
      this.heartbeatSeen = true;
      this.emitStatus();
    } else if (t === 'ready') {
      const legacyMajor = Number(msg.protocol) || null;
      if (this.childProtocol === null) this.childProtocol = legacyMajor;
      if (legacyMajor !== null && !supportsProtocolMajor(legacyMajor)) {
        this.watchdogVerdict = 'protocol_failure';
        this.deps.onNotice('error', `Engine protocol v${legacyMajor} is incompatible with Desktop ${CLIENT_MIN_COMPATIBLE_MAJOR}–${CLIENT_MAX_COMPATIBLE_MAJOR}.`);
        this.killCurrentChild();
        return;
      }
      const degraded = degradedCapabilities(this.plan).length > 0;
      const res = transition(this.phase, degraded ? 'degraded' : 'ready');
      if (res.ok) this.enter(res.phase, degraded ? 'capabilities_shed' : 'ready');
      this.flushQueue();
      this.maybeSendPendingResume();
    } else if (t === 'event' && msg.name === 'ui_snapshot') {
      this.sniffSession(msg);
    }

    this.deps.onMessage(msg);
  }

  private onChildMalformed(gen: number, _line: string): void {
    if (gen !== this.childGen) return;
    this.malformedLines += 1;
    // Garbage instead of protocol lines before the handshake = wrong binary / corrupted install.
    if (this.childProtocol === null && this.malformedLines > 20 && !this.watchdogVerdict) {
      this.watchdogVerdict = 'protocol_failure';
      this.killCurrentChild();
    }
  }

  private onChildError(gen: number, err: Error): void {
    if (gen !== this.childGen) return;
    this.handleDeath(gen, null, null, true, err.message);
  }

  private onChildExit(gen: number, code: number | null, signal: string | null): void {
    this.exitWaiters.get(gen)?.(true);
    if (gen !== this.childGen) {
      // Superseded child finished dying (project switch / manual restart) — evidence only.
      this.deps.onNotice('info', `Previous engine process exited (${signal ?? `code ${code ?? '?'}`}).`);
      return;
    }
    this.handleDeath(gen, code, signal, false);
  }

  private handleDeath(gen: number, code: number | null, signal: string | null, spawnError: boolean, detail?: string): void {
    if (gen !== this.childGen) return;
    const now = this.deps.now();
    const lastPhase = this.phase;
    const child = this.child;
    this.child = null;
    this.stopWatchdog();

    const kind = classifyExit({
      code, signal,
      intentional: this.intentionalStop,
      phase: lastPhase,
      watchdog: this.watchdogVerdict ?? undefined,
      spawnError,
    });
    const uptimeMs = this.spawnedAt ? now - this.spawnedAt : 0;
    this.history.push({ at: now, kind, uptimeMs });

    const interrupted = kind !== 'clean_shutdown' && (this.heartbeat?.activeTurn === true || (this.lastSession?.messageCount ?? 0) > 0);
    if (interrupted && this.lastSession) this.interruptedSessionId = this.lastSession.id;

    const mem = this.deps.memory();
    const record: CrashRecord = {
      at: new Date(now).toISOString(),
      project: this.projectDir,
      sessionId: this.lastSession?.id,
      command: child?.command ?? 'unknown',
      protocol: this.childProtocol ?? undefined,
      pid: child?.pid,
      uptimeMs,
      exitCode: code,
      signal,
      kind,
      lastPhase,
      lastHeartbeat: this.heartbeat,
      memory: { freeMb: Math.round(mem.freeBytes / 1048576), totalMb: Math.round(mem.totalBytes / 1048576) },
      profile: this.plan.profile,
      capabilities: this.plan.capabilities.map((c) => ({ id: c.id, enabled: c.enabled })),
      attempt: this.attempt,
      logTail: (detail ? `[spawn] ${detail}\n` : '') + this.deps.logTail(),
      interruptedWork: interrupted,
      recovery: 'manual',
    };

    if (this.intentionalStop || this.disposed) {
      record.recovery = 'intentional';
      this.deps.journal.append(record);
      this.enter(this.disposed ? 'exited' : 'exited', 'clean_shutdown');
      return;
    }
    if (kind === 'clean_shutdown') {
      record.recovery = 'intentional';
      this.deps.journal.append(record);
      this.enter('exited', 'clean_shutdown');
      return;
    }

    const decision = decideRestart(this.history, now, this.plan.profile, this.policy, this.deps.random);
    // Resource-style deaths shed capabilities on the NEXT launch (and keep them shed until the
    // user or a project switch raises the floor again).
    if (kind === 'external_kill' || kind === 'unresponsive') {
      this.profileFloor = minProfile(this.profileFloor, decision.profile);
    }

    if (decision.restart) {
      record.recovery = 'auto_restart';
      this.deps.journal.append(record);
      this.attempt = decision.attempt;
      // Keep the interrupted session offered across the restart; do NOT auto-resume it — replaying
      // a turn that may have been mid-mutation is the user's call (Restart & resume).
      this.enter('restarting', kind);
      this.restartAt = now + decision.delayMs;
      this.emitStatus();
      this.restartTimer = this.deps.setTimeout(() => {
        this.restartTimer = null;
        this.spawnChild();
      }, decision.delayMs);
      this.deps.onNotice('warn', `Engine ${describeKind(kind)} — restarting in ${Math.round(decision.delayMs / 1000)}s (attempt ${decision.attempt}/${this.policy.maxAttempts}).`);
    } else if (decision.reason === 'budget_exhausted') {
      record.recovery = 'budget_exhausted';
      this.deps.journal.append(record);
      this.enter('failed', 'restart_budget_exhausted');
      this.deps.onNotice('error', `Engine ${describeKind(kind)} ${decision.attempt} times — automatic restarts paused. Use Retry or Start without optional services.`);
    } else {
      record.recovery = 'manual';
      this.deps.journal.append(record);
      this.enter('exited', kind);
    }
  }

  // --- watchdog --------------------------------------------------------------------------------

  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdogTimer = this.deps.setInterval(() => this.tick(), this.timeouts.watchdogTickMs);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer !== null) {
      this.deps.clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  /** One watchdog evaluation. Public-ish for tests (deterministic, clock-injected). */
  tick(): void {
    if (!this.child || this.watchdogVerdict) return;
    const now = this.deps.now();

    if (isStartupPhase(this.phase)) {
      if (now - this.spawnedAt > this.timeouts.startupTimeoutMs) {
        this.watchdogVerdict = 'startup_timeout';
        this.deps.onNotice('warn', `Engine did not become ready within ${Math.round(this.timeouts.startupTimeoutMs / 1000)}s — restarting it.`);
        this.killCurrentChild();
      }
      return;
    }

    // Hang detection only ever applies to engines that HAVE a heartbeat (older binaries emit
    // none — never kill those on silence), and legitimate long work gets the active threshold:
    // heartbeats are timer-driven, so they only stop when the event loop is truly wedged.
    if ((this.phase === 'ready' || this.phase === 'degraded') && this.heartbeatSeen && this.heartbeat) {
      const limit = this.heartbeat.activeTurn
        ? this.timeouts.activeHeartbeatTimeoutMs
        : this.timeouts.idleHeartbeatTimeoutMs;
      if (now - this.heartbeat.at > limit) {
        this.watchdogVerdict = 'unresponsive';
        this.deps.onNotice('warn', 'Engine stopped responding — restarting it.');
        this.killCurrentChild();
      }
    }
  }

  private killCurrentChild(): void {
    if (this.child) this.terminateChild(this.child);
  }

  /** SIGTERM, then SIGKILL if the child lingers. The exit event drives everything else. */
  private terminateChild(child: EngineHandle): void {
    try { child.endStdin(); } catch { /* gone */ }
    try { child.kill('SIGTERM'); } catch { /* gone */ }
    const t = this.deps.setTimeout(() => {
      this.killTimers.delete(t);
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }, this.timeouts.killEscalationMs);
    this.killTimers.add(t);
  }

  /** Detach the current child from state (its events become stale) without waiting for its exit. */
  private supersedeChild(): void {
    const child = this.child;
    this.child = null;
    this.childGen = -1; // no live generation — anything in flight is stale
    if (child) this.terminateChild(child);
  }

  private cancelScheduledRestart(): void {
    if (this.restartTimer !== null) {
      this.deps.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  // --- helpers ---------------------------------------------------------------------------------

  private writeToChild(msg: unknown): void {
    if (!this.child) return;
    try { this.child.write(JSON.stringify(msg) + '\n'); } catch { /* exit event will handle it */ }
  }

  private flushQueue(): void {
    const queued = this.queue;
    this.queue = [];
    for (const msg of queued) this.writeToChild(msg);
  }

  private maybeSendPendingResume(): void {
    if (!this.pendingResume) return;
    if (this.childProtocol !== null && this.childProtocol < 3) {
      this.deps.onNotice('warn', `Engine protocol v${this.childProtocol} predates typed resume — skipped automatic session resume.`);
      this.pendingResume = null;
      return;
    }
    const id = this.pendingResume;
    this.pendingResume = null;
    this.sendResume(id);
  }

  private sendResume(sessionId: string): void {
    this.writeToChild({ t: 'resume', id: sessionId });
    this.interruptedSessionId = null;
    this.emitStatus();
  }

  private sniffSession(msg: Record<string, unknown>): void {
    try {
      const args = msg.args as unknown[];
      const snapshot = args?.[0] as { sessions?: Array<{ id?: string; current?: boolean; messageCount?: number }> } | undefined;
      const cur = snapshot?.sessions?.find((s) => s.current);
      if (cur?.id) this.lastSession = { id: String(cur.id), messageCount: Number(cur.messageCount) || 0 };
    } catch { /* a snapshot we can't read is not an error */ }
  }

  private enter(phase: EnginePhase, reason: string): void {
    const res = transition(this.phase, phase);
    if (!res.ok) return; // normalized: illegal moves keep the current phase, predictably
    if (res.phase === this.phase && this.reason === reason) return;
    this.phase = res.phase;
    this.reason = reason;
    this.enteredAt = this.deps.now();
    this.emitStatus();
  }

  private emitStatus(): void {
    this.deps.onStatus(this.status());
  }
}

function describeKind(kind: CrashKind): string {
  switch (kind) {
    case 'external_kill': return 'was force-terminated (likely memory pressure)';
    case 'startup_timeout': return 'timed out during startup';
    case 'unresponsive': return 'stopped responding';
    case 'protocol_failure': return 'produced an invalid protocol stream';
    case 'spawn_error': return 'could not be launched';
    case 'crash': return 'crashed';
    case 'clean_shutdown': return 'exited';
  }
}
