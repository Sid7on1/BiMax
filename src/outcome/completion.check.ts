import * as fs from 'fs';
import * as path from 'path';
import { engineEvents } from '../engine/events';
import { sessionDir } from '../engine/session';
import { getSessionRecorder } from '../engine/session.recorder';
import { BashStaticAnalyzer } from '../governor/bash.analyzer';

/**
 * Completion checks (backlog F3): "done" means a stated check passed, not that the model stopped talking.
 *
 * Before this a task ended "completed" whenever a turn finished without an error, and nothing looked at the work. The
 * outcome contract could require proof, but only if the model chose to define one — on the development machine, 22
 * saved tasks and 0 contracts. So the check is asked for by the harness, not left to the model's initiative:
 * - a turn that changed files and has no check is asked, once, to state one (or to skip, with a reason);
 * - when the turn ends, the ENGINE runs the checks itself — a command through the same shell tool and permission rules
 *   as any other, a file or JSON check read directly — and grades them by what it observed, never by what the model
 *   said about them;
 * - a failed check sends the task back to work with the failure, up to a retry limit (F5), and a turn that still fails
 *   ends "check failed", not "done";
 * - the model cannot swap or skip a check that failed in the same turn; the user can, in their next message.
 * The checks and their last result are saved per session next to the outcome contract, so a resumed task (F2) keeps them.
 */

export type CompletionCheck =
  | { kind: 'command'; command: string }
  | { kind: 'file'; path: string; contains?: string }
  | { kind: 'json'; path: string };

/**
 * none: nothing changed, nothing to check. unchecked: files changed and there is no check (or it was skipped).
 * pending: a check is set and has not run since the last change. passed / failed: its last run.
 */
export type CheckState = 'none' | 'unchecked' | 'pending' | 'passed' | 'failed';

export interface CheckResult { check: CompletionCheck; ok: boolean; detail: string }

export interface CheckSnapshot {
  state: CheckState;
  checks: CompletionCheck[];
  skipped?: string;
  results: CheckResult[];
  /** Test files this user turn changed before the checks passed: the pass may rest on those edits. */
  testsEdited?: string[];
  /** Failed runs in the current user turn; the task goes back to work while this is at most `maxRetries`. */
  attempts: number;
  maxRetries: number;
  checkedAt?: number;
}

/** Runs a command the way the task's own shell would, and reports the exit code the engine observed. */
export type CommandRunner = (command: string) => Promise<{ exitCode: number | null; output: string }>;

/** What the loop does at the end of a turn: go back to work with this message, or end, optionally saying something. */
export type Verdict = { continue: string } | { end: string | null };

interface Stored {
  version: 1;
  sessionId: string;
  checks: CompletionCheck[];
  skipped?: string;
  state: CheckState;
  results: CheckResult[];
  attempts: number;
  checkedAt?: number;
  testsEdited?: string[];
}

/** Automatic retries after a failed check, per user turn. The app sets it per task from Settings (F5). */
export const DEFAULT_CHECK_RETRIES = 2;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const DETAIL_CHARS = 1200;

export const ASK_FOR_CHECK = [
  '[Completion check] This task changed files. Before you finish, state how the result will be checked: call',
  'CompletionCheckTool with action "set" and one or more checks — a command that must exit 0 (such as the project\'s',
  'tests or its build), a file that must exist (optionally containing some text), or a JSON file that must parse.',
  'Bimax runs the checks itself when you finish, and the user can change them. If nothing meaningful can be checked,',
  'call CompletionCheckTool with action "skip" and say why.',
].join(' ');

export function describeCheck(check: CompletionCheck): string {
  if (check.kind === 'command') return `\`${check.command}\` exits 0`;
  if (check.kind === 'json') return `${check.path} is valid JSON`;
  return check.contains !== undefined ? `${check.path} contains "${check.contains}"` : `${check.path} exists`;
}

/** The checks in `input` that are well formed, or the reason the list is not. */
export function parseChecks(input: unknown): { checks: CompletionCheck[] } | { error: string } {
  if (!Array.isArray(input) || input.length === 0) return { error: 'give at least one check' };
  const checks: CompletionCheck[] = [];
  for (const [index, raw] of input.entries()) {
    const item = (raw ?? {}) as Record<string, unknown>;
    const text = (key: string): string => (typeof item[key] === 'string' ? (item[key] as string).trim() : '');
    if (item.kind === 'command' && text('command')) checks.push({ kind: 'command', command: text('command') });
    else if (item.kind === 'file' && text('path')) {
      checks.push({ kind: 'file', path: text('path'), ...(typeof item.contains === 'string' && item.contains ? { contains: item.contains } : {}) });
    } else if (item.kind === 'json' && text('path')) checks.push({ kind: 'json', path: text('path') });
    else return { error: `check ${index + 1} needs kind "command" with a command, or kind "file"/"json" with a path` };
  }
  return { checks };
}

const tail = (text: string): string => {
  const flat = text.trim();
  return flat.length > DETAIL_CHARS ? `…${flat.slice(-DETAIL_CHARS)}` : flat;
};

/** The output a command left, without the shell tool's JSON wrapping when it has one. */
function commandText(output: string): string {
  try {
    const parsed = JSON.parse(output) as { stdout?: string; stderr?: string };
    return [parsed.stdout, parsed.stderr].filter(Boolean).join('\n');
  } catch { return output; }
}

async function evaluate(check: CompletionCheck, run: CommandRunner, cwd: string): Promise<CheckResult> {
  if (check.kind === 'command') {
    const { exitCode, output } = await run(check.command);
    const status = exitCode === null ? 'did not run to an exit code' : `exit ${exitCode}`;
    const text = tail(commandText(output));
    return { check, ok: exitCode === 0, detail: text ? `${status}: ${text}` : status };
  }
  const file = path.resolve(cwd, check.path);
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch { return { check, ok: false, detail: `${check.path} does not exist` }; }
  if (!stat.isFile()) return { check, ok: false, detail: `${check.path} is not a file` };
  if (check.kind === 'file' && check.contains === undefined) return { check, ok: true, detail: `${check.path} exists (${stat.size} bytes)` };
  if (stat.size > MAX_FILE_BYTES) return { check, ok: false, detail: `${check.path} is ${stat.size} bytes, more than the ${MAX_FILE_BYTES} a check reads` };
  const text = fs.readFileSync(file, 'utf8');
  if (check.kind === 'json') {
    try { JSON.parse(text); return { check, ok: true, detail: `${check.path} parses as JSON` }; }
    catch (error) { return { check, ok: false, detail: `${check.path} is not valid JSON: ${(error as Error).message}` }; }
  }
  return text.includes(check.contains!)
    ? { check, ok: true, detail: `${check.path} contains "${check.contains}"` }
    : { check, ok: false, detail: `${check.path} exists but does not contain "${check.contains}"` };
}

/**
 * Whether a path names a test file: a tests/spec folder, or a name like test.js, test-strings.js, test_math.py,
 * math.test.ts or math_test.go. A command check usually runs these, so a task that edits them can pass its own exam.
 * Measured live: given a test it could not pass, a model rewrote the test's expected value and the check went green.
 */
export function isTestFile(file: string): boolean {
  const parts = file.split(/[\\/]/).filter(Boolean);
  const name = parts.pop() ?? '';
  if (parts.some((dir) => /^(tests?|__tests__|specs?)$/i.test(dir))) return true;
  return /^(tests?|specs?)([._-][^/]*)?\.[a-z0-9]+$/i.test(name) || /[._-](tests?|specs?)\.[a-z0-9]+$/i.test(name);
}

const FILE_TOOLS = new Set(['EditFileTool', 'WriteFileTool', 'MultiEditTool', 'SymbolEditTool', 'DeleteTool', 'CreateDirectoryTool']);
let analyzer: BashStaticAnalyzer | null = null;

/**
 * Whether a successful tool call changed files, which makes the task one that needs a check. A shell command counts when
 * the governor's own analyzer classifies it as a write or an install; anything it cannot place ("unknown", such as a
 * script) does not, so a question answered by running the tests is not asked for a check.
 */
export function changesFiles(tool: string, args: string, result: string): boolean {
  if (FILE_TOOLS.has(tool)) return true;
  if (tool === 'DocumentTool') return !result.startsWith('Draft retained');
  if (tool !== 'BashTool') return false;
  let command = '';
  try { command = String((JSON.parse(args) as { command?: unknown }).command ?? ''); } catch { return false; }
  analyzer ??= new BashStaticAnalyzer();
  const { category } = analyzer.analyze(command);
  return category === 'write' || category === 'install';
}

const empty = (sessionId: string): Stored => ({ version: 1, sessionId, checks: [], state: 'none', results: [], attempts: 0 });

export class CompletionChecks {
  private data: Stored = empty('');
  /** Per turn: whether it changed files, whether it was already asked for a check, whether it set one. */
  private changed = false;
  private asked = false;
  private setThisTurn = false;
  /** Files the current user turn changed, as the tools named them. */
  private changedFiles = new Set<string>();

  constructor(private readonly io: {
    sessionId?: () => string;
    directory?: () => string;
    /** Fixed limit, for tests. */
    maxRetries?: () => number;
    /** The engine config's `taskCheckRetries`, used when the environment sets none. */
    configuredRetries?: () => number | undefined;
  } = {}) {}

  private sessionId(): string { return this.io.sessionId?.() || getSessionRecorder()?.currentId() || ''; }
  private directory(): string { return this.io.directory?.() || sessionDir(); }
  /** The first valid of: the fixed limit, BIMAX_TASK_MAX_RETRIES, the engine config; else the default (F5). */
  private maxRetries(): number {
    const env = process.env.BIMAX_TASK_MAX_RETRIES?.trim();
    for (const value of [this.io.maxRetries?.(), env ? Number(env) : undefined, this.io.configuredRetries?.()]) {
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
    }
    return DEFAULT_CHECK_RETRIES;
  }

  /** Follow the active session: save the one being left, load the one arrived at. */
  syncSession(): void {
    const id = this.sessionId();
    if (id === this.data.sessionId) return;
    this.data = id ? this.load(id) : empty('');
    this.publish();
  }

  /** A new turn. A user's turn also resets the retry count, so asking again gets fresh attempts. */
  beginTurn(internal = false): void {
    this.syncSession();
    this.changed = false;
    this.asked = false;
    this.setThisTurn = false;
    if (!internal) { this.data.attempts = 0; this.changedFiles.clear(); }
  }

  /** The turn changed files: a check that passed before this no longer says anything about the result. */
  noteChange(file?: string): void {
    this.changed = true;
    if (file) this.changedFiles.add(file);
    if (this.data.checks.length && this.data.state === 'passed') this.update('pending');
  }

  /** Set by the model. Refused when a check failed earlier in this same turn: the task may not change its own grader. */
  set(checks: CompletionCheck[]): string | null {
    if (this.data.attempts > 0) return 'a check failed in this turn, so it can only be changed when the user asks for it';
    this.syncSession();
    this.data = { ...this.data, checks, skipped: undefined, results: [], attempts: 0, checkedAt: undefined };
    this.setThisTurn = true;
    this.update('pending');
    return null;
  }

  skip(reason: string): string | null {
    if (this.data.attempts > 0) return 'a check failed in this turn, so it can only be skipped when the user asks for it';
    this.syncSession();
    this.data = { ...this.data, checks: [], skipped: reason.trim() || 'no reason given', results: [], attempts: 0, checkedAt: undefined };
    this.update(this.changed ? 'unchecked' : 'none');
    return null;
  }

  snapshot(): CheckSnapshot {
    const { state, checks, skipped, results, attempts, checkedAt, testsEdited } = this.data;
    return {
      state, checks, ...(skipped ? { skipped } : {}), results, ...(testsEdited?.length ? { testsEdited } : {}),
      attempts, maxRetries: this.maxRetries(), ...(checkedAt ? { checkedAt } : {}),
    };
  }

  /** The standing prompt block while a check is set, so the model works toward it rather than learning of it at the end. */
  promptBlock(): string {
    if (!this.data.checks.length) return '';
    const last = this.data.results.length && this.data.state !== 'pending'
      ? `\nLast run: ${this.data.state}${this.data.results.filter((r) => !r.ok).map((r) => `\n- ${describeCheck(r.check)}: ${r.detail.slice(0, 300)}`).join('')}`
      : '';
    return [
      '### COMPLETION CHECK',
      'Bimax runs these itself when you finish; the task is not done until every one passes:',
      ...this.data.checks.map((check) => `- ${describeCheck(check)}`),
      'Do not edit the tests a check runs to make it pass. If a test looks wrong, say so to the user instead.',
    ].join('\n') + last;
  }

  /**
   * The end of a turn. Asks once for a check when the turn changed files and has none; otherwise runs the checks when
   * there is something new to grade, and sends the task back to work while failures remain within the retry limit.
   */
  async settle(run: CommandRunner, cwd: string): Promise<Verdict> {
    this.syncSession();
    if (!this.data.checks.length) {
      if (!this.changed) return { end: null };
      if (!this.data.skipped && !this.asked) { this.asked = true; return { continue: ASK_FOR_CHECK }; }
      this.update('unchecked');
      return { end: null };
    }
    // Nothing new to grade: no change, no new check, no run owed, and nothing failed in this turn. After a failure the
    // check reruns even with no change seen — a command that changes files is not always recognisable as one.
    if (!this.changed && !this.setThisTurn && this.data.state !== 'pending' && this.data.attempts === 0) return { end: null };

    const results: CheckResult[] = [];
    for (const check of this.data.checks) results.push(await evaluate(check, run, cwd));
    this.data.results = results;
    this.data.checkedAt = Date.now();
    // A later edit makes this run stale again; until then nothing new needs grading.
    this.changed = false;
    this.setThisTurn = false;
    const failed = results.filter((r) => !r.ok);
    if (!failed.length) {
      // A pass is reported with the test files this turn changed, when it changed any: the pass may rest on them.
      const edited = [...this.changedFiles].filter(isTestFile);
      this.data.testsEdited = edited.length ? edited : undefined;
      this.update('passed');
      const passed = `\n\n✓ Completion check passed: ${results.map((r) => describeCheck(r.check)).join('; ')}.`;
      return {
        end: edited.length
          ? `${passed} This task also changed test files (${edited.join(', ')}), so the pass may rest on those edits — review them.\n`
          : `${passed}\n`,
      };
    }
    this.data.attempts++;
    const max = this.maxRetries();
    const lines = failed.map((r) => `- ${describeCheck(r.check)} — ${r.detail}`).join('\n');
    this.update('failed');
    if (this.data.attempts <= max) {
      return {
        continue: `[Completion check] The check did not pass, so the task is not done (attempt ${this.data.attempts} of ${max + 1}):\n${lines}\n`
          + 'Find and fix the cause, then finish again; Bimax will rerun the check. Do not change or skip the check, or edit the '
          + 'tests it runs, to make it pass; if a test itself is wrong, say so to the user instead.',
      };
    }
    return { end: `\n\n✕ Completion check failed ${this.data.attempts} time${this.data.attempts === 1 ? '' : 's'}, so this task is not done:\n${lines}\n` };
  }

  private update(state: CheckState): void {
    this.data.state = state;
    this.save();
    this.publish();
  }

  private publish(): void {
    try { engineEvents.emit('completion_check', this.snapshot()); } catch { /* best-effort */ }
  }

  private file(id: string): string { return path.join(this.directory(), `${id}.checks.json`); }

  private save(): void {
    if (!this.data.sessionId) return;
    try {
      fs.mkdirSync(this.directory(), { recursive: true });
      const target = this.file(this.data.sessionId);
      const temporary = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(temporary, target);
    } catch { /* persistence must never break a live turn */ }
  }

  private load(id: string): Stored {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file(id), 'utf8')) as Partial<Stored>;
      const checks = parseChecks(parsed.checks);
      const states: CheckState[] = ['none', 'unchecked', 'pending', 'passed', 'failed'];
      return {
        version: 1,
        sessionId: id,
        checks: 'checks' in checks ? checks.checks : [],
        ...(typeof parsed.skipped === 'string' ? { skipped: parsed.skipped } : {}),
        state: states.includes(parsed.state as CheckState) ? parsed.state as CheckState : 'none',
        results: Array.isArray(parsed.results) ? parsed.results : [],
        attempts: 0,
        ...(typeof parsed.checkedAt === 'number' ? { checkedAt: parsed.checkedAt } : {}),
        ...(Array.isArray(parsed.testsEdited) && parsed.testsEdited.length ? { testsEdited: parsed.testsEdited.map(String) } : {}),
      };
    } catch { return empty(id); }
  }
}

let runtime: CompletionChecks | null = null;

/** The root engine's checks (headless entry). Workers and tests without it get null, and the loop skips checks. */
export function startCompletionChecks(): CompletionChecks {
  if (runtime) return runtime;
  runtime = new CompletionChecks({
    configuredRetries: () => {
      try { return (require('../engine/config') as typeof import('../engine/config')).getConfig().taskCheckRetries; } catch { return undefined; }
    },
  });
  engineEvents.on('session_changed', () => runtime?.syncSession());
  runtime.syncSession();
  return runtime;
}

export function getCompletionChecks(): CompletionChecks | null { return runtime; }

/** Test seam: do not use in production code. */
export function __setCompletionChecks(value: CompletionChecks | null): void { runtime = value; }
