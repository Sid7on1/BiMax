/**
 * Desktop Engine Supervisor — deterministic lifecycle tests. The supervisor modules live in
 * app/src/main/supervisor and are Electron-free by design (clock, timers, spawn, memory,
 * randomness and journal storage are injected), so the full crash/recovery matrix runs here
 * without a real process or real time.
 */
import {
  EngineSupervisor, EngineHandle, SpawnCallbacks, SupervisorDeps, SupervisorTimeouts,
  parseRecoveryAction, isSafeToReplay, EXPECTED_PROTOCOL,
} from '../main/supervisor/supervisor';
import { transition, bootProgress, isStartupPhase } from '../main/supervisor/machine';
import {
  classifyExit, decideRestart, consecutiveCrashes, shedProfile, DEFAULT_POLICY, PolicyConfig,
} from '../main/supervisor/policy';
import { planCapabilities, profileForMemory, minProfile } from '../main/supervisor/resources';
import {
  CrashJournal, redactSecrets, appendRecord, parseJournal, serializeJournal, MAX_RECORDS, MAX_LOG_TAIL_CHARS,
} from '../main/supervisor/journal';
import { CrashRecord, SupervisorStatus } from '../main/supervisor/types';
import type { EnginePhase } from '../main/supervisor/types';

// ---------------------------------------------------------------------------------------------
// Harness: fake clock/timers/spawn — every test drives time explicitly.

class FakeClock {
  now = 1_000_000;
  private timers: Array<{ id: number; at: number; fn: () => void; interval?: number }> = [];
  private seq = 1;

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.seq++;
    this.timers.push({ id, at: this.now + ms, fn });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== h);
  }
  setInterval(fn: () => void, ms: number): unknown {
    const id = this.seq++;
    this.timers.push({ id, at: this.now + ms, fn, interval: ms });
    return id;
  }
  clearInterval(h: unknown): void {
    this.clearTimeout(h);
  }
  /** Advance time, firing due timers in order. */
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.now = due.at;
      if (due.interval) due.at = this.now + due.interval;
      else this.timers = this.timers.filter((t) => t.id !== due.id);
      due.fn();
    }
    this.now = end;
  }
}

class FakeChild implements EngineHandle {
  pid: number;
  command = 'fake-engine';
  written: string[] = [];
  killed: string[] = [];
  stdinEnded = false;
  exited = false;
  constructor(public cb: SpawnCallbacks, pid: number) { this.pid = pid; }

  write(line: string): void { this.written.push(line); }
  endStdin(): void { this.stdinEnded = true; }
  kill(signal: 'SIGTERM' | 'SIGKILL'): void { this.killed.push(signal); }

  // test drivers
  emit(msg: Record<string, unknown>): void { this.cb.onMessage(msg); }
  ready(protocol = EXPECTED_PROTOCOL): void { this.emit({ t: 'ready', protocol }); }
  beat(activeTurn = false, extra: Record<string, unknown> = {}): void {
    this.emit({ t: 'health', uptimeMs: 1000, rssMb: 100, heapMb: 50, eventLoopDelayMs: 2, activeTurn, ...extra });
  }
  exit(code: number | null, signal: string | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.cb.onExit(code, signal);
  }
}

interface Harness {
  clock: FakeClock;
  sup: EngineSupervisor;
  children: FakeChild[];
  statuses: SupervisorStatus[];
  messages: unknown[];
  notices: Array<{ level: string; text: string }>;
  journalText: () => string | null;
  lastChild: () => FakeChild;
  phase: () => EnginePhase;
}

const FAST: SupervisorTimeouts = {
  startupTimeoutMs: 10_000,
  idleHeartbeatTimeoutMs: 5_000,
  activeHeartbeatTimeoutMs: 60_000,
  watchdogTickMs: 1_000,
  killEscalationMs: 500,
};

const TIGHT_POLICY: PolicyConfig = {
  maxAttempts: 3,
  windowMs: 60_000,
  baseDelayMs: 100,
  maxDelayMs: 1_000,
  jitterRatio: 0,
  stableMs: 30_000,
};

function makeHarness(opts: {
  freeBytes?: number;
  env?: Record<string, string>;
  policy?: PolicyConfig;
  failSpawn?: boolean;
} = {}): Harness {
  const clock = new FakeClock();
  const children: FakeChild[] = [];
  const statuses: SupervisorStatus[] = [];
  const messages: unknown[] = [];
  const notices: Array<{ level: string; text: string }> = [];
  let journalBlob: string | null = null;
  let pidSeq = 100;

  const deps: SupervisorDeps = {
    spawn: (_dir, _env, cb) => {
      if (opts.failSpawn) throw new Error('ENOENT: engine binary missing');
      const child = new FakeChild(cb, pidSeq++);
      children.push(child);
      return child;
    },
    now: () => clock.now,
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (h) => clock.clearTimeout(h),
    setInterval: (fn, ms) => clock.setInterval(fn, ms),
    clearInterval: (h) => clock.clearInterval(h),
    random: () => 0.5, // deterministic: jitter multiplier = 1
    memory: () => ({ freeBytes: opts.freeBytes ?? 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 }),
    env: opts.env ?? {},
    journal: new CrashJournal({ load: () => journalBlob, save: (t) => { journalBlob = t; } }),
    logTail: () => 'engine log tail\nAPI_KEY=super-secret-value',
    onStatus: (s) => statuses.push(s),
    onMessage: (m) => messages.push(m),
    onNotice: (level, text) => notices.push({ level, text }),
  };
  const sup = new EngineSupervisor(deps, FAST, opts.policy ?? TIGHT_POLICY);
  return {
    clock, sup, children, statuses, messages, notices,
    journalText: () => journalBlob,
    lastChild: () => children[children.length - 1],
    phase: () => sup.status().phase,
  };
}

// ---------------------------------------------------------------------------------------------
// State machine

describe('supervisor state machine', () => {
  test('legal startup ladder transitions are accepted in order', () => {
    const ladder = ['spawning', 'booting', 'loading_storage', 'loading_graph', 'loading_tools', 'restoring_session', 'ready'] as const;
    let cur: (typeof ladder)[number] | 'idle' = 'idle';
    for (const next of ladder) {
      const res = transition(cur as any, next as any);
      expect(res.ok).toBe(true);
      cur = next;
    }
  });

  test('boot phases may be skipped forward but never go backwards', () => {
    expect(transition('booting', 'ready').ok).toBe(true);          // old engine, no phases
    expect(transition('loading_tools', 'loading_storage').ok).toBe(false); // backwards → rejected
    expect(transition('loading_tools', 'loading_storage').phase).toBe('loading_tools'); // normalized
  });

  test('illegal transitions are normalized, not thrown', () => {
    expect(transition('idle', 'ready').ok).toBe(false);
    expect(transition('idle', 'ready').phase).toBe('idle');
    expect(transition('exited', 'degraded').ok).toBe(false);
  });

  test('boot progress reports position in the ladder', () => {
    expect(bootProgress('spawning')).toEqual({ step: 1, total: 7 });
    expect(bootProgress('loading_graph')).toEqual({ step: 4, total: 7 });
    expect(bootProgress('ready')).toBeUndefined();
    expect(isStartupPhase('loading_graph')).toBe(true);
    expect(isStartupPhase('ready')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Healthy lifecycle

describe('healthy startup', () => {
  test('spawn → boot phases → ready, with heartbeats recorded', () => {
    const h = makeHarness();
    h.sup.openProject('/proj');
    expect(h.phase()).toBe('spawning');
    const child = h.lastChild();
    child.emit({ t: 'boot', phase: 'booting', pid: child.pid });
    expect(h.phase()).toBe('booting');
    child.emit({ t: 'boot', phase: 'loading_graph', pid: child.pid });
    expect(h.phase()).toBe('loading_graph');
    child.ready();
    expect(h.phase()).toBe('ready');
    child.beat();
    expect(h.sup.status().lastHeartbeat?.rssMb).toBe(100);
    // messages are forwarded to the renderer
    expect(h.messages.some((m: any) => m.t === 'ready')).toBe(true);
  });

  test('duplicate/out-of-order boot lines cannot move the phase backwards', () => {
    const h = makeHarness();
    h.sup.openProject('/proj');
    const child = h.lastChild();
    child.emit({ t: 'boot', phase: 'loading_tools', pid: child.pid });
    child.emit({ t: 'boot', phase: 'loading_storage', pid: child.pid }); // stale/dup
    expect(h.phase()).toBe('loading_tools');
  });

  test('current rich hello negotiates identity/features before ready', () => {
    const h = makeHarness();
    h.sup.openProject('/proj');
    const child = h.lastChild();
    child.emit({
      t: 'hello', engine: { version: '1.1.0', buildCommit: '01234567' },
      protocolVersion: '3.1.0', protocolMajor: 3, minCompatibleMajor: 2,
      maxCompatibleMajor: 3, features: ['resume', 'interrupt'],
    });
    child.ready(3);
    expect(h.phase()).toBe('ready');
    expect(h.notices.filter((n) => /incompatible/.test(n.text))).toHaveLength(0);
  });

  test('previous supported v2 engine reaches ready through the legacy handshake', () => {
    const h = makeHarness();
    h.sup.openProject('/proj');
    h.lastChild().ready(2);
    expect(h.phase()).toBe('ready');
    expect(h.notices.filter((n) => /incompatible/.test(n.text))).toHaveLength(0);
  });

  test('an incompatible rich hello is refused before ready', () => {
    const h = makeHarness();
    h.sup.openProject('/proj');
    const child = h.lastChild();
    child.emit({
      t: 'hello', engine: { version: '9.0.0', buildCommit: 'bad' },
      protocolVersion: '9.0.0', protocolMajor: 9, minCompatibleMajor: 9,
      maxCompatibleMajor: 9, features: [],
    });
    expect(child.killed).toContain('SIGTERM');
    expect(h.notices.some((n) => /incompatible/.test(n.text))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Watchdog: startup timeout, idle hang, long active work

describe('watchdog', () => {
  test('startup timeout kills the child and schedules a restart', () => {
    const h = makeHarness();
    h.sup.openProject('/proj');
    const child = h.lastChild();
    h.clock.advance(FAST.startupTimeoutMs + FAST.watchdogTickMs + 1);
    expect(child.killed).toContain('SIGTERM');
    child.exit(null, 'SIGTERM');
    expect(h.phase()).toBe('restarting');
    const rec = parseJournal(h.journalText())[0];
    expect(rec.kind).toBe('startup_timeout');
  });

  test('heartbeat timeout while idle classifies as unresponsive', () => {
    const h = makeHarness();
    h.sup.openProject('/proj');
    const child = h.lastChild();
    child.ready();
    child.beat(false);
    h.clock.advance(FAST.idleHeartbeatTimeoutMs + FAST.watchdogTickMs + 1);
    expect(child.killed).toContain('SIGTERM');
    child.exit(null, 'SIGTERM');
    expect(parseJournal(h.journalText())[0].kind).toBe('unresponsive');
  });

  test('a long active task does NOT trigger a false crash', () => {
    const h = makeHarness();
    h.sup.openProject('/proj');
    const child = h.lastChild();
    child.ready();
    child.beat(true); // activeTurn: legitimate long work
    // Way past the idle threshold, well under the active threshold:
    h.clock.advance(FAST.idleHeartbeatTimeoutMs * 3);
    expect(child.killed).toHaveLength(0);
    expect(h.phase()).toBe('ready');
    // …but a fully wedged event loop (no beats at all past the active threshold) does trip it.
    h.clock.advance(FAST.activeHeartbeatTimeoutMs + FAST.watchdogTickMs);
    expect(child.killed).toContain('SIGTERM');
  });

  test('an engine that never emitted heartbeats is never hang-killed (older binaries)', () => {
    const h = makeHarness();
    h.sup.openProject('/proj');
    const child = h.lastChild();
    child.ready();
    h.clock.advance(FAST.idleHeartbeatTimeoutMs * 10);
    expect(child.killed).toHaveLength(0);
    expect(h.phase()).toBe('ready');
  });
});

// ---------------------------------------------------------------------------------------------
// Crash classification + restart policy

describe('crash classification', () => {
  test('classifyExit distinguishes the failure families', () => {
    expect(classifyExit({ code: 0, signal: null, intentional: false, phase: 'ready' })).toBe('clean_shutdown');
    expect(classifyExit({ code: 1, signal: null, intentional: false, phase: 'ready' })).toBe('crash');
    expect(classifyExit({ code: null, signal: 'SIGKILL', intentional: false, phase: 'ready' })).toBe('external_kill');
    expect(classifyExit({ code: 1, signal: null, intentional: true, phase: 'ready' })).toBe('clean_shutdown');
    expect(classifyExit({ code: null, signal: 'SIGTERM', intentional: false, phase: 'spawning', watchdog: 'startup_timeout' })).toBe('startup_timeout');
    expect(classifyExit({ code: null, signal: null, intentional: false, phase: 'spawning', spawnError: true })).toBe('spawn_error');
  });

  test('SIGKILL restarts in a safer capability profile and sheds progressively', () => {
    const h = makeHarness();
    h.sup.openProject('/proj');
    h.lastChild().ready();
    expect(h.sup.status().profile).toBe('full');

    h.lastChild().exit(null, 'SIGKILL');
    expect(h.phase()).toBe('restarting');
    h.clock.advance(2_000); // past backoff → respawn
    expect(h.children).toHaveLength(2);
    expect(h.sup.status().profile).toBe('conservative');
    expect(h.sup.status().capabilities.find((c) => c.id === 'codebaseMemory')?.enabled).toBe(false);

    // Second resource kill → minimal.
    h.lastChild().ready();
    h.lastChild().exit(null, 'SIGKILL');
    h.clock.advance(2_000);
    expect(h.children).toHaveLength(3);
    expect(h.sup.status().profile).toBe('minimal');
    expect(h.sup.status().capabilities.find((c) => c.id === 'autoIndex')?.enabled).toBe(false);
  });

  test('repeated crashes stop at the restart budget', () => {
    const h = makeHarness();
    h.sup.openProject('/proj');
    for (let i = 0; i < TIGHT_POLICY.maxAttempts; i++) {
      h.lastChild().ready();
      h.lastChild().exit(1);
      expect(h.phase()).toBe('restarting');
      h.clock.advance(TIGHT_POLICY.maxDelayMs + 100);
    }
    // One more crash exceeds the budget.
    h.lastChild().ready();
    h.lastChild().exit(1);
    expect(h.phase()).toBe('failed');
    expect(h.sup.status().reason).toBe('restart_budget_exhausted');
    // …and no further child is spawned no matter how long we wait.
    const count = h.children.length;
    h.clock.advance(600_000);
    expect(h.children).toHaveLength(count);
  });

  test('backoff resets after a stability period', () => {
    const now = 1_000_000;
    const cfg = TIGHT_POLICY;
    // Three rapid crashes → attempt 3; then a crash after a long stable run → attempt 1 again.
    const rapid = [
      { at: now - 3000, kind: 'crash' as const, uptimeMs: 50 },
      { at: now - 2000, kind: 'crash' as const, uptimeMs: 50 },
      { at: now - 1000, kind: 'crash' as const, uptimeMs: 50 },
    ];
    expect(consecutiveCrashes(rapid, now, cfg)).toBe(3);
    const afterStable = [...rapid, { at: now, kind: 'crash' as const, uptimeMs: cfg.stableMs + 1 }];
    expect(consecutiveCrashes(afterStable, now, cfg)).toBe(1);
    const d = decideRestart(afterStable, now, 'full', cfg, () => 0.5);
    expect(d.restart).toBe(true);
    expect(d.attempt).toBe(1);
    expect(d.delayMs).toBe(cfg.baseDelayMs);
  });

  test('backoff grows exponentially with jitter bounded', () => {
    const now = 1_000_000;
    const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ at: now - (n - i) * 10, kind: 'crash' as const, uptimeMs: 10 }));
    const d1 = decideRestart(mk(1), now, 'full', TIGHT_POLICY, () => 0.5);
    const d3 = decideRestart(mk(3), now, 'full', TIGHT_POLICY, () => 0.5);
    expect(d1.delayMs).toBe(100);
    expect(d3.delayMs).toBe(400);
    // jitter never exceeds the configured ratio
    const jit = decideRestart(mk(1), now, 'full', { ...TIGHT_POLICY, jitterRatio: 0.25 }, () => 1);
    expect(jit.delayMs).toBe(125);
  });

  test('intentional stop does not restart', () => {
    const h = makeHarness();
    h.sup.openProject('/proj');
    const child = h.lastChild();
    child.ready();
    h.sup.stop();
    expect(h.phase()).toBe('stopping');
    child.exit(null, 'SIGTERM');
    expect(h.phase()).toBe('exited');
    expect(h.sup.status().reason).toBe('clean_shutdown');
    h.clock.advance(600_000);
    expect(h.children).toHaveLength(1); // never relaunched
    expect(parseJournal(h.journalText())[0].recovery).toBe('intentional');
  });

  test('spawn errors surface as failed launches, not silent hangs', () => {
    const h = makeHarness({ failSpawn: true });
    h.sup.openProject('/proj');
    // First spawn dies synchronously → restarting w/ backoff; advancing burns the budget.
    h.clock.advance(600_000);
    expect(h.phase()).toBe('failed');
    expect(parseJournal(h.journalText()).every((r) => r.kind === 'spawn_error')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Generation isolation (stale children)

describe('generation isolation', () => {
  test('a stale child exit cannot clobber the current child state', () => {
    const h = makeHarness();
    h.sup.openProject('/projA');
    const oldChild = h.lastChild();
    oldChild.ready();
    h.sup.openProject('/projB'); // supersedes A
    const newChild = h.lastChild();
    expect(newChild).not.toBe(oldChild);
    newChild.ready();
    expect(h.phase()).toBe('ready');
    oldChild.exit(null, 'SIGKILL'); // the old child dies late — must be inert
    expect(h.phase()).toBe('ready');
    expect(parseJournal(h.journalText())).toHaveLength(0); // no crash recorded for a superseded child
  });

  test('messages from a stale child are dropped, not forwarded or folded into state', () => {
    const h = makeHarness();
    h.sup.openProject('/projA');
    const oldChild = h.lastChild();
    h.sup.openProject('/projB');
    h.messages.length = 0;
    oldChild.emit({ t: 'ready', protocol: EXPECTED_PROTOCOL });
    oldChild.emit({ t: 'event', name: 'message', args: [{ role: 'assistant', content: 'stale' }] });
    expect(h.messages).toHaveLength(0);
    expect(h.phase()).toBe('spawning'); // the stale ready did not flip phase
  });

  test('a stale child never receives messages intended for the current child', () => {
    const h = makeHarness();
    h.sup.openProject('/projA');
    const oldChild = h.lastChild();
    oldChild.ready();
    h.sup.openProject('/projB');
    const newChild = h.lastChild();
    newChild.ready();
    h.sup.sendFromRenderer({ t: 'input', text: 'hello new engine' });
    expect(newChild.written.some((l) => l.includes('hello new engine'))).toBe(true);
    expect(oldChild.written).toHaveLength(0);
  });

  test('project switch gets a fresh restart budget and full profile', () => {
    const h = makeHarness();
    h.sup.openProject('/projA');
    h.lastChild().ready();
    h.lastChild().exit(null, 'SIGKILL');
    h.clock.advance(2_000);
    expect(h.sup.status().profile).toBe('conservative');
    h.sup.openProject('/projB');
    expect(h.sup.status().profile).toBe('full');
    expect(h.sup.status().attempt).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Message queueing safety

describe('message safety while the engine is down', () => {
  test('safe reads are queued and replayed once ready; mutations are rejected loudly', () => {
    const h = makeHarness();
    h.sup.openProject('/proj');
    // still starting: a ping is safe to hold, an input is not
    h.sup.sendFromRenderer({ t: 'ping', id: 1 });
    h.sup.sendFromRenderer({ t: 'input', text: 'dangerous mutation' });
    h.sup.sendFromRenderer({ t: 'reply', id: 4, value: 'Yes' });
    const child = h.lastChild();
    expect(child.written).toHaveLength(0);
    child.ready();
    // Only the ping was replayed — the input/reply were rejected, never duplicated.
    expect(child.written).toHaveLength(1);
    expect(child.written[0]).toContain('"ping"');
    expect(child.written.every((l) => !l.includes('dangerous mutation'))).toBe(true);
    expect(h.notices.filter((n) => n.level === 'warn')).toHaveLength(2);
  });

  test('a correlated read is answered with the real reason once no engine is coming', () => {
    // Measured live 2026-09-04: with the engine dead at `failed`, `catalogGet` matched no branch
    // and was dropped behind a main-process notice. The renderer sat on its promise for the full
    // 30s, then rendered its own timeout copy — "check the provider key or endpoint" — while the
    // supervisor knew the engine had been killed five times and that the key was never involved.
    // A dropped request is the one outcome a correlated read must never get.
    const h = makeHarness();
    h.sup.openProject('/proj');
    for (let i = 0; i < TIGHT_POLICY.maxAttempts; i++) {
      h.lastChild().ready();
      h.lastChild().exit(1);
      h.clock.advance(TIGHT_POLICY.maxDelayMs + 100);
    }
    h.lastChild().ready();
    h.lastChild().exit(1);
    expect(h.phase()).toBe('failed');

    h.messages.length = 0;
    h.sup.sendFromRenderer({ t: 'catalogGet', id: 7, refresh: true });
    h.sup.sendFromRenderer({ t: 'configGet', id: 8 });

    const catalog = h.messages.find((m: any) => m.t === 'catalogResult') as any;
    expect(catalog.id).toBe(7);
    expect(catalog.models).toEqual([]);
    expect(catalog.error).toContain('Engine failed to start');
    expect(catalog.error).toMatch(/provider key/i); // says the key is NOT the cause
    expect(h.messages.find((m: any) => m.t === 'configResult')).toMatchObject({ id: 8, config: {} });
  });

  test('a correlated read is still queued while an engine is on its way', () => {
    // The rule is "answer when nothing will", not "stop queueing". During startup a real answer
    // is seconds away and is strictly better than an immediate empty one, so configGet still
    // rides the replay queue and catalogGet still waits for the child rather than being faked.
    const h = makeHarness();
    h.sup.openProject('/proj');
    expect(isStartupPhase(h.phase())).toBe(true);

    h.messages.length = 0;
    h.sup.sendFromRenderer({ t: 'configGet', id: 3 });
    h.sup.sendFromRenderer({ t: 'catalogGet', id: 4 });
    expect(h.messages).toHaveLength(0);

    const child = h.lastChild();
    child.ready();
    expect(child.written.some((l) => l.includes('"configGet"'))).toBe(true);
  });

  test('isSafeToReplay allows only side-effect-free reads', () => {
    expect(isSafeToReplay({ t: 'ping', id: 1 })).toBe(true);
    expect(isSafeToReplay({ t: 'query', id: 1, text: '/g' })).toBe(true);
    expect(isSafeToReplay({ t: 'configGet', id: 1 })).toBe(true);
    expect(isSafeToReplay({ t: 'input', text: 'x' })).toBe(false);
    expect(isSafeToReplay({ t: 'reply', id: 1, value: 'Yes' })).toBe(false);
    expect(isSafeToReplay({ t: 'configSet', id: 1, patch: {} })).toBe(false);
    expect(isSafeToReplay({ t: 'resume', id: 'x' })).toBe(false);
    expect(isSafeToReplay(null)).toBe(false);
  });

  test('malformed renderer messages are ignored with a notice', () => {
    const h = makeHarness();
    h.sup.openProject('/proj');
    h.lastChild().ready();
    h.sup.sendFromRenderer('not an object');
    h.sup.sendFromRenderer({ nope: true });
    expect(h.lastChild().written).toHaveLength(0);
    expect(h.notices.filter((n) => n.text.includes('malformed'))).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------
// Session recovery

describe('session recovery', () => {
  function crashWithSession(h: Harness): void {
    h.sup.openProject('/proj');
    const child = h.lastChild();
    child.ready();
    child.emit({
      t: 'event', name: 'ui_snapshot',
      args: [{ sessions: [{ id: 'sess-abc', current: true, messageCount: 7 }] }],
    });
    child.beat(true); // a turn was executing
    child.exit(null, 'SIGKILL');
  }

  test('a crash mid-task records interrupted work and offers the session', () => {
    const h = makeHarness();
    crashWithSession(h);
    const rec = parseJournal(h.journalText())[0];
    expect(rec.interruptedWork).toBe(true);
    expect(rec.sessionId).toBe('sess-abc');
    expect(h.sup.status().interruptedSessionId).toBe('sess-abc');
  });

  test('restart & resume sends a typed resume only after the NEW engine is ready — never input text', () => {
    const h = makeHarness();
    crashWithSession(h);
    h.sup.handleAction({ action: 'restartSafe', sessionId: 'sess-abc' });
    const child = h.lastChild();
    expect(child.written).toHaveLength(0); // nothing sent before ready
    child.ready();
    expect(child.written).toHaveLength(1);
    expect(JSON.parse(child.written[0])).toEqual({ t: 'resume', id: 'sess-abc' });
    // No user input was re-sent — resume replays from the session file engine-side.
    expect(child.written.every((l) => !l.includes('"input"'))).toBe(true);
  });

  test('resume is skipped when the new engine speaks an incompatible protocol', () => {
    const h = makeHarness();
    crashWithSession(h);
    h.sup.handleAction({ action: 'restartSafe', sessionId: 'sess-abc' });
    h.lastChild().ready(99);
    expect(h.lastChild().written).toHaveLength(0);
    expect(h.notices.some((n) => n.text.includes('protocol'))).toBe(true);
  });

  test('a stale ready from the superseded child cannot trigger the pending resume', () => {
    const h = makeHarness();
    crashWithSession(h);
    h.sup.handleAction({ action: 'restartSafe', sessionId: 'sess-abc' });
    const fresh = h.lastChild();
    // Simulate a zombie previous child spitting a late ready — supervisor must ignore it.
    const zombie = h.children[0];
    zombie.emit({ t: 'ready', protocol: EXPECTED_PROTOCOL });
    expect(fresh.written).toHaveLength(0);
    fresh.ready();
    expect(fresh.written).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Renderer action validation

describe('recovery action validation', () => {
  test('malformed actions fail safely and change nothing', () => {
    const h = makeHarness();
    h.sup.openProject('/proj');
    h.lastChild().ready();
    expect(h.sup.handleAction(null)).toBe(false);
    expect(h.sup.handleAction('retry')).toBe(false);
    expect(h.sup.handleAction({ action: 'exec', cmd: 'rm -rf /' })).toBe(false);
    expect(h.sup.handleAction({ action: 'resume' })).toBe(false); // resume without id
    expect(h.sup.handleAction({ action: 'resume', sessionId: 'bad id\nwith newline' })).toBe(false);
    expect(h.phase()).toBe('ready');
    expect(h.children).toHaveLength(1);
  });

  test('parseRecoveryAction accepts only the typed action set', () => {
    expect(parseRecoveryAction({ action: 'retry' })).toEqual({ action: 'retry' });
    expect(parseRecoveryAction({ action: 'resume', sessionId: 'sess-1' })).toEqual({ action: 'resume', sessionId: 'sess-1' });
    expect(parseRecoveryAction({ action: 'resume', sessionId: 'x'.repeat(200) })).toBeNull();
    expect(parseRecoveryAction({ action: 'startMinimal', extra: 'ignored' })).toEqual({ action: 'startMinimal' });
    expect(parseRecoveryAction({})).toBeNull();
  });

  test('duplicate restart clicks do not spawn a second engine', () => {
    const h = makeHarness();
    h.sup.openProject('/proj');
    h.lastChild().ready();
    h.lastChild().exit(1);
    h.clock.advance(TIGHT_POLICY.maxDelayMs + 100); // auto-restart fired → starting
    const count = h.children.length;
    h.sup.handleAction({ action: 'retry' });
    h.sup.handleAction({ action: 'retry' });
    expect(h.children).toHaveLength(count); // still starting — duplicates ignored
  });
});

// ---------------------------------------------------------------------------------------------
// Resource-aware capability planning

describe('resource-aware startup', () => {
  test('profiles map to memory headroom', () => {
    expect(profileForMemory({ freeBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 })).toBe('full');
    expect(profileForMemory({ freeBytes: 1 * 1024 ** 3, totalBytes: 8 * 1024 ** 3 })).toBe('conservative');
    expect(profileForMemory({ freeBytes: 300 * 1024 ** 2, totalBytes: 8 * 1024 ** 3 })).toBe('minimal');
    expect(minProfile('conservative', 'minimal')).toBe('minimal');
    expect(minProfile('full', 'conservative')).toBe('conservative');
  });

  test('low memory sheds optional services but keeps native compression', () => {
    const plan = planCapabilities({ freeBytes: 500 * 1024 ** 2, totalBytes: 8 * 1024 ** 3 }, {});
    expect(plan.profile).toBe('minimal');
    expect(plan.env.BIMAX_DISABLE_CODEMEM).toBe('1');
    expect(plan.env.BIMAX_AUTO_INDEX).toBe('0');
    expect(plan.env.BIMAX_DISABLE_HEADROOM).toBe('1');
    const native = plan.capabilities.find((c) => c.id === 'nativeCompression');
    expect(native?.enabled).toBe(true); // compression works without the Headroom sidecar
    // Nothing disabled is ever represented as active:
    for (const c of plan.capabilities) {
      if (!c.enabled) expect(c.reason.length).toBeGreaterThan(0);
    }
  });

  test('explicit env overrides win over the adaptive plan', () => {
    const plenty = { freeBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 };
    const p1 = planCapabilities(plenty, { BIMAX_DISABLE_HEADROOM: '0' });
    expect(p1.env.BIMAX_DISABLE_HEADROOM).toBe('0');
    expect(p1.capabilities.find((c) => c.id === 'headroomProxy')?.enabled).toBe(true);
    const p2 = planCapabilities(plenty, { BIMAX_FORCE_PROFILE: 'minimal' });
    expect(p2.profile).toBe('minimal');
    const p3 = planCapabilities(plenty, { BIMAX_AUTO_INDEX: '0' });
    expect(p3.capabilities.find((c) => c.id === 'autoIndex')?.reason).toBe('env override');
  });

  test('a degraded plan reaches ready as `degraded`, reporting what is off', () => {
    const h = makeHarness({ freeBytes: 500 * 1024 ** 2 });
    h.sup.openProject('/proj');
    h.lastChild().ready();
    expect(h.phase()).toBe('degraded');
    expect(h.sup.status().degradedCapabilities).toEqual(expect.arrayContaining(['codebaseMemory', 'autoIndex']));
  });

  test('a degraded launch that walked the full boot ladder still lands on `degraded` — never a startup-timeout loop', () => {
    // Regression: `degraded` was missing from every startup phase's legal transitions, so a
    // low-memory (capability-shed) launch got stuck in restoring_session until the watchdog
    // killed it — every 120s, forever.
    const h = makeHarness({ freeBytes: 500 * 1024 ** 2 });
    h.sup.openProject('/proj');
    const child = h.lastChild();
    for (const phase of ['booting', 'loading_storage', 'loading_graph', 'loading_tools', 'restoring_session']) {
      child.emit({ t: 'boot', phase, pid: child.pid });
    }
    expect(h.phase()).toBe('restoring_session');
    child.ready();
    expect(h.phase()).toBe('degraded');
    // Well past the startup timeout: the startup watchdog must no longer apply to a
    // ready-but-degraded engine (no heartbeats emitted → the hang detector stays out of it too).
    h.clock.advance(FAST.startupTimeoutMs + FAST.watchdogTickMs);
    expect(child.killed).toHaveLength(0);
    expect(h.children).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Crash journal

describe('crash journal', () => {
  const baseRecord: CrashRecord = {
    at: '2026-07-12T00:00:00.000Z', project: '/proj', command: 'node dist/index.js',
    uptimeMs: 1234, exitCode: 1, signal: null, kind: 'crash', lastPhase: 'ready',
    lastHeartbeat: null, memory: { freeMb: 1000, totalMb: 8000 }, profile: 'full',
    capabilities: [], attempt: 1, logTail: '', interruptedWork: false, recovery: 'manual',
  };

  test('secrets are redacted from log tails', () => {
    const dirty = [
      'OPENAI_API_KEY=sk-abcdef1234567890abc',
      'authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
      'GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
      'aws AKIAIOSFODNN7EXAMPLE',
      'password: "hunter2"',
      'normal log line stays',
    ].join('\n');
    const clean = redactSecrets(dirty);
    expect(clean).not.toContain('sk-abcdef');
    expect(clean).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(clean).not.toContain('ghp_ABCDEFGH');
    expect(clean).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(clean).not.toContain('hunter2');
    expect(clean).toContain('normal log line stays');
    expect(clean).toContain('[REDACTED]');
  });

  test('the supervisor journals redacted evidence on crash', () => {
    const h = makeHarness(); // harness logTail contains API_KEY=super-secret-value
    h.sup.openProject('/proj');
    h.lastChild().ready();
    h.lastChild().exit(1);
    const rec = parseJournal(h.journalText())[0];
    expect(rec.logTail).not.toContain('super-secret-value');
    expect(rec.logTail).toContain('[REDACTED]');
    expect(rec.kind).toBe('crash');
    expect(rec.memory.totalMb).toBeGreaterThan(0);
  });

  test('journal history and log excerpts stay bounded', () => {
    let records: CrashRecord[] = [];
    for (let i = 0; i < MAX_RECORDS + 15; i++) {
      records = appendRecord(records, { ...baseRecord, logTail: 'x'.repeat(MAX_LOG_TAIL_CHARS * 2), attempt: i });
    }
    expect(records).toHaveLength(MAX_RECORDS);
    expect(records[0].attempt).toBe(15); // oldest were dropped
    for (const r of records) expect(r.logTail.length).toBeLessThanOrEqual(MAX_LOG_TAIL_CHARS);
  });

  test('a corrupt journal parses to empty instead of blocking recovery', () => {
    expect(parseJournal('{ not json')).toEqual([]);
    expect(parseJournal(null)).toEqual([]);
    expect(parseJournal(serializeJournal([baseRecord]))).toHaveLength(1);
  });

  test('shed profile ladder responds to resource crashes only', () => {
    const now = 1_000_000;
    const res = (n: number) => Array.from({ length: n }, (_, i) => ({ at: now - i, kind: 'external_kill' as const, uptimeMs: 10 }));
    expect(shedProfile('full', res(1), now, DEFAULT_POLICY)).toBe('conservative');
    expect(shedProfile('full', res(2), now, DEFAULT_POLICY)).toBe('minimal');
    expect(shedProfile('full', [{ at: now, kind: 'crash', uptimeMs: 10 }], now, DEFAULT_POLICY)).toBe('full');
  });
});

// ---------------------------------------------------------------------------------------------
// Quit safety

describe('dispose', () => {
  test('dispose never relaunches the engine, even with a pending restart', () => {
    const h = makeHarness();
    h.sup.openProject('/proj');
    h.lastChild().ready();
    h.lastChild().exit(1); // schedules an auto-restart
    expect(h.phase()).toBe('restarting');
    h.sup.dispose();
    h.clock.advance(600_000);
    expect(h.children).toHaveLength(1);
  });
});
