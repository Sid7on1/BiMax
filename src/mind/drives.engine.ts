import { stateDir, stateRoot } from '../utils/state.dir';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { mindSingletonRoot } from './self.model';

/**
 * DrivesEngine — goal homeostasis. The agent gets persistent *drives*: measurable
 * codebase health signals with setpoints (tests green, zero type errors, TODO debt
 * bounded, working tree not sprawling). Deviation from a setpoint is "discomfort":
 * it is surfaced in the system prompt so the agent proactively offers to restore
 * equilibrium, feeds Dream Mode's practice-task supply, and is inspectable via /drives.
 *
 * Measurement is ON DEMAND (/drives check, dream cycles) and strictly SEQUENTIAL —
 * never a hot background loop — so it can't cook the user's machine.
 */

export interface DriveMeasurement { at: string; ok: boolean }

export interface DriveState {
  id: string;
  label: string;
  enabled: boolean;
  /** true = at setpoint (comfortable), false = deviating. undefined = never measured. */
  lastOk?: boolean;
  lastValue?: string;   // human-readable measurement ("3 type errors", "41 TODOs")
  detail?: string;      // first lines of evidence (truncated command output)
  lastRun?: string;     // ISO timestamp
  heavy: boolean;       // heavy drives run builds/tests — only on explicit full checks
  /** Recent measurement history — persistence-gated drives alarm only on sustained breaches. */
  history?: DriveMeasurement[];
}

interface DrivesFile { version: 1; drives: Record<string, Partial<DriveState>> }

interface DriveDef {
  id: string;
  label: string;
  heavy: boolean;
  /**
   * Noisy-by-nature drives (a dirty tree during active work is normal, not a deviation)
   * must breach on ≥2 measurements spaced ≥30 min apart before they alarm — a CUSUM-lite
   * persistence gate. A single spike never nags.
   */
  requiresPersistence?: boolean;
  /** Whether this drive applies to the project at all. */
  applies(root: string): boolean;
  measure(root: string): Promise<{ ok: boolean; value: string; detail?: string }>;
}

const EXEC_TIMEOUT_MS = 180_000;

function run(cmd: string, cwd: string, timeout = EXEC_TIMEOUT_MS): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    exec(cmd, { cwd, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0, out: `${stdout}\n${stderr}`.trim() });
    });
  });
}

function hasFile(root: string, name: string): boolean {
  try { return fs.existsSync(path.join(root, name)); } catch { return false; }
}

function pkgScripts(root: string): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')).scripts || {}; } catch { return {}; }
}

const TODO_SETPOINT = 60;
const DIRTY_FILES_SETPOINT = 25;

const DRIVE_DEFS: DriveDef[] = [
  {
    id: 'todo-debt',
    label: 'TODO/FIXME debt bounded',
    heavy: false,
    applies: root => hasFile(root, 'src') || hasFile(root, 'package.json') || hasFile(root, 'go.mod'),
    measure: async root => {
      const dir = hasFile(root, 'src') ? 'src' : '.';
      const excludes = "--exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git --exclude-dir=vendor --exclude-dir=coverage";
      const { out } = await run(`grep -rEc "TODO|FIXME|HACK" ${dir} ${excludes} --include='*.ts' --include='*.js' --include='*.go' --include='*.py' 2>/dev/null | awk -F: '{s+=$2} END {print s+0}'`, root, 30_000);
      const n = parseInt(out.trim(), 10) || 0;
      return { ok: n <= TODO_SETPOINT, value: `${n} TODO/FIXME markers (setpoint ≤ ${TODO_SETPOINT})` };
    },
  },
  {
    id: 'tree-hygiene',
    label: 'working tree not sprawling',
    heavy: false,
    requiresPersistence: true, // a dirty tree mid-feature is WIP, not a deviation — must persist ≥30 min
    applies: root => hasFile(root, '.git'),
    measure: async root => {
      const { out } = await run('git status --porcelain', root, 20_000);
      const n = out ? out.split('\n').filter(Boolean).length : 0;
      return { ok: n <= DIRTY_FILES_SETPOINT, value: `${n} uncommitted paths (setpoint ≤ ${DIRTY_FILES_SETPOINT})` };
    },
  },
  {
    // Cross-engine insight no other tool can compute: the epistemic ledger knows how many
    // of the agent's correctness claims EXPIRED without any build/test ever checking them.
    // Low coverage = the agent (and the repo) is flying blind — a testing-culture gap
    // surfaced as a measurable drive, not a lecture.
    id: 'verify-coverage',
    label: 'edits actually get verified',
    heavy: false,
    applies: root => hasFile(stateRoot(root), path.join('.bimax', 'epistemic.json')),
    measure: async root => {
      const { EpistemicLedger } = await import('./epistemic.ledger');
      const s = new EpistemicLedger(root).stats();
      const total = s.resolved + s.expired;
      if (total < 20) return { ok: true, value: `only ${total} claims so far — too few to judge (needs 20)` };
      const coverage = s.resolved / total;
      return {
        ok: coverage >= 0.4,
        value: `${Math.round(coverage * 100)}% of ${total} correctness claims met build/test evidence (setpoint ≥ 40%)`,
        detail: coverage < 0.4 ? 'Most edits are never followed by a verifying build/test run — run checks after changes, or add tests where none exist.' : undefined,
      };
    },
  },
  {
    id: 'type-clean',
    label: 'zero TypeScript errors',
    heavy: true,
    applies: root => hasFile(root, 'tsconfig.json'),
    measure: async root => {
      const { code, out } = await run('npx tsc --noEmit --pretty false 2>&1 | head -40', root);
      const errors = (out.match(/error TS\d+/g) || []).length;
      return { ok: code === 0 && errors === 0, value: errors === 0 ? 'typecheck clean' : `${errors}+ type errors`, detail: errors ? out.slice(0, 800) : undefined };
    },
  },
  {
    id: 'tests-green',
    label: 'test suite green',
    heavy: true,
    applies: root => !!pkgScripts(root).test || hasFile(root, 'go.mod'),
    measure: async root => {
      const cmd = pkgScripts(root).test ? 'npm test --silent 2>&1 | tail -25' : 'go test ./... 2>&1 | tail -25';
      const { code, out } = await run(cmd, root, 420_000);
      const failMatch = out.match(/(\d+) failed/i);
      const ok = code === 0 && !/FAIL/i.test(out.replace(/\d+ passed/gi, ''));
      return { ok, value: ok ? 'tests green' : failMatch ? `${failMatch[1]} tests failing` : 'tests failing', detail: ok ? undefined : out.slice(0, 800) };
    },
  },
  {
    id: 'build-green',
    label: 'build succeeds',
    heavy: true,
    applies: root => !!pkgScripts(root).build,
    measure: async root => {
      const { code, out } = await run('npm run build --silent 2>&1 | tail -25', root, 420_000);
      return { ok: code === 0, value: code === 0 ? 'build green' : 'build broken', detail: code === 0 ? undefined : out.slice(0, 800) };
    },
  },
];

export class DrivesEngine {
  private state: Record<string, Partial<DriveState>> = {};
  private loaded = false;
  private filePath: string;
  private root: string;

  constructor(projectRoot: string = process.cwd()) {
    this.root = projectRoot;
    this.filePath = path.join(stateDir('.bimax', projectRoot), 'drives.json');
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed: DrivesFile = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      if (parsed && parsed.drives && typeof parsed.drives === 'object') this.state = parsed.drives;
    } catch { /* first run */ }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify({ version: 1, drives: this.state } as DrivesFile, null, 2), 'utf-8');
    } catch { /* best-effort */ }
  }

  /** All drives applicable to this project, merged with persisted state. */
  list(): DriveState[] {
    this.load();
    return DRIVE_DEFS.filter(d => {
      try { return d.applies(this.root); } catch { return false; }
    }).map(d => {
      const s = this.state[d.id] || {};
      return {
        id: d.id,
        label: d.label,
        heavy: d.heavy,
        enabled: s.enabled !== false, // enabled unless explicitly disabled
        lastOk: s.lastOk,
        lastValue: s.lastValue,
        detail: s.detail,
        lastRun: s.lastRun,
        history: s.history,
      };
    });
  }

  setEnabled(id: string, enabled: boolean): boolean {
    this.load();
    if (!DRIVE_DEFS.some(d => d.id === id)) return false;
    this.state[id] = { ...(this.state[id] || {}), enabled };
    this.save();
    return true;
  }

  /**
   * Measure drives SEQUENTIALLY (never in parallel — thermal discipline). `quick`
   * skips heavy drives (builds/tests). `only` restricts to one drive id.
   */
  async check(opts?: { quick?: boolean; only?: string }): Promise<DriveState[]> {
    this.load();
    const targets = this.list().filter(d =>
      d.enabled &&
      (!opts?.only || d.id === opts.only) &&
      (!opts?.quick || !d.heavy)
    );
    for (const t of targets) {
      const def = DRIVE_DEFS.find(d => d.id === t.id)!;
      const now = new Date().toISOString();
      try {
        const r = await def.measure(this.root);
        const prev = this.state[t.id] || {};
        const history = [...(prev.history || []), { at: now, ok: r.ok }].slice(-30);
        this.state[t.id] = { ...prev, lastOk: r.ok, lastValue: r.value, detail: r.detail, lastRun: now, history };
      } catch (e: any) {
        this.state[t.id] = { ...(this.state[t.id] || {}), lastOk: undefined, lastValue: `measurement failed: ${e?.message}`, lastRun: now };
      }
      this.save(); // persist after each so a long check that gets interrupted keeps partial results
    }
    return this.list();
  }

  /**
   * Persistence gate for noisy drives: the CURRENT breach must have held across ≥2
   * measurements ≥30 minutes apart with no green measurement in between. A single
   * spike (or a rapid re-check of the same state) never alarms.
   */
  private breachPersisted(d: DriveState): boolean {
    const h = d.history || [];
    if (h.length === 0 || h[h.length - 1].ok) return false;
    // Walk back through the current uninterrupted breach run.
    let earliest = h[h.length - 1].at;
    for (let i = h.length - 2; i >= 0; i--) {
      if (h[i].ok) break;
      earliest = h[i].at;
    }
    const spanMs = new Date(h[h.length - 1].at).getTime() - new Date(earliest).getTime();
    return spanMs >= 30 * 60_000;
  }

  /**
   * Drives currently deviating from setpoint: fresh breach, and for persistence-gated
   * drives the breach must have HELD across measurements (see breachPersisted).
   */
  deviations(maxAgeHours = 24): DriveState[] {
    const cutoff = Date.now() - maxAgeHours * 3600_000;
    return this.list().filter(d => {
      if (!d.enabled || d.lastOk !== false || d.lastRun === undefined || new Date(d.lastRun).getTime() < cutoff) return false;
      const def = DRIVE_DEFS.find(x => x.id === d.id);
      if (def?.requiresPersistence) return this.breachPersisted(d);
      return true;
    });
  }

  /**
   * Prompt block: current deviations as standing discomfort. Only fresh measurements —
   * stale deviations would have the agent chasing ghosts.
   */
  getPromptBlock(): string {
    const dev = this.deviations();
    if (dev.length === 0) return '';
    const lines = dev.map(d => `- ${d.label}: ${d.lastValue}${d.detail ? `\n  evidence: ${d.detail.split('\n')[0]}` : ''}`);
    return `### DRIVES (homeostasis — the codebase is off its setpoints)\nThese measured health signals are deviating. If the user's request touches related code, fix the deviation as part of the work; otherwise briefly offer to. Do not silently ignore them.\n${lines.join('\n')}`;
  }

  /** A concrete micro-task prompt to restore the worst deviation — Dream Mode's task supply. */
  nextRestorationTask(): { drive: DriveState; prompt: string } | null {
    const dev = this.deviations();
    if (dev.length === 0) return null;
    // Heavy signals (broken build/tests) outrank hygiene ones.
    const worst = dev.sort((a, b) => Number(b.heavy) - Number(a.heavy))[0];
    const prompts: Record<string, string> = {
      'type-clean': `The TypeScript typecheck is failing (${worst.lastValue}). Run \`npx tsc --noEmit\`, fix every error, and verify the typecheck passes.`,
      'tests-green': `The test suite is failing (${worst.lastValue}). Run the tests, fix the failures (fix the code, not the assertions, unless the test is provably stale), and verify green.`,
      'build-green': `The build is broken (${worst.lastValue}). Run the build, fix the errors, and verify it completes.`,
      'todo-debt': `TODO/FIXME debt is above setpoint (${worst.lastValue}). Pick the 5 oldest/riskiest markers in src/, resolve them properly (implement or delete with justification), and re-count.`,
      'tree-hygiene': `The working tree has too many uncommitted paths (${worst.lastValue}). Review git status, group related changes, and propose commit(s) — do not commit without approval.`,
      'verify-coverage': `Most recent edits were never verified by any build/test run (${worst.lastValue}). Identify the recently-edited files with no covering tests, add focused tests for the riskiest ones, and run them.`,
    };
    return { drive: worst, prompt: prompts[worst.id] || `Restore drive "${worst.label}" — current: ${worst.lastValue}.` };
  }

  report(): string[] {
    const all = this.list();
    if (all.length === 0) return ['- No drives apply to this directory.'];
    return all.map(d => {
      const def = DRIVE_DEFS.find(x => x.id === d.id);
      const pending = d.lastOk === false && def?.requiresPersistence && !this.breachPersisted(d);
      const glyph = !d.enabled ? '○' : d.lastOk === undefined ? '·' : d.lastOk ? '✓' : pending ? '~' : '✗';
      const age = d.lastRun ? ` (checked ${timeAgo(d.lastRun)})` : ' (never checked)';
      const note = pending ? ' — breach not yet persistent (likely WIP, watching)' : '';
      return `- ${glyph} ${d.label}${d.enabled ? `: ${d.lastValue ?? 'unmeasured'}${age}${note}` : ' — disabled'}`;
    });
  }
}

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

let _global: DrivesEngine | null = null;
export function getDrivesEngine(): DrivesEngine {
  if (!_global) _global = new DrivesEngine(mindSingletonRoot());
  return _global;
}
export function __setDrivesEngine(e: DrivesEngine | null): void { _global = e; }
