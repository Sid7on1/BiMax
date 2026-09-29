import { app, Notification, powerSaveBlocker } from 'electron';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ThreadManager } from './thread.manager';
import { briefing, budgetNote, nightBranch, nightBudget, nightContinue, nightDeadline, nightNext, nightWords, spentBy, worktreeCommand, type NightShift } from './night.shift';

/**
 * Night shift (backlog FL5): the running shifts, their git worktrees, the keep-awake, and the morning briefing. Moved
 * out of main/index.ts (flaw list C13); the decisions themselves (budget, deadline, next step, briefing) are
 * night.shift.ts.
 */
export interface NightRunnerHost {
  threads(): Pick<ThreadManager, 'create' | 'rename' | 'get' | 'send' | 'submit' | 'addNote'>;
  quickModel(): string | undefined;
  showQuickThread(id: string): void;
  openThread(id: string): void;
}

let host: NightRunnerHost | null = null;
export function setNightRunnerHost(next: NightRunnerHost): void { host = next; }
const threads = (): ReturnType<NightRunnerHost['threads']> => {
  if (!host) throw new Error('Night shifts are not set up yet.');
  return host.threads();
};

/** The running shift's per-task budget, when this Bimax Thread is one (its engine gets it as the spend share). */
export function nightShiftBudget(id: string): number | undefined { return nightShifts.get(id)?.budgetUsd; }
export function isNightShift(id: string): boolean { return nightShifts.has(id); }
export function nightShiftIds(): Set<string> { return new Set(nightShifts.keys()); }

const nightShifts = new Map<string, NightShift & { continuations: number; timer?: NodeJS.Timeout }>();
let nightAwake: number | null = null;
const git = (cwd: string, args: string[]): Promise<string> => new Promise((resolve, reject) => {
  execFile('git', ['-C', cwd, ...args], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(new Error(String(stderr || error.message).trim().split('\n')[0])); else resolve(String(stdout));
  });
});
/** The Mac-wide daily cap (N6): Settings wins, then MAX_DAILY_SPEND, then $5; 0 means none. */
export function dailyCapUsd(): number {
  try {
    const value = JSON.parse(readFileSync(path.join(os.homedir(), '.breakglass', 'config.json'), 'utf8')).spendDailyCapUsd;
    if (typeof value === 'number' && value >= 0) return value;
  } catch { /* no config yet */ }
  const env = Number(process.env.MAX_DAILY_SPEND);
  return Number.isFinite(env) && env >= 0 ? env : 5;
}
/** Bimax keeps the Mac awake while any shift runs; the shift cannot work while it sleeps. */
function keepAwake(on: boolean): void {
  if (on && nightAwake === null) nightAwake = powerSaveBlocker.start('prevent-app-suspension');
  if (!on && nightAwake !== null && !nightShifts.size) { powerSaveBlocker.stop(nightAwake); nightAwake = null; }
}
export async function startNightShift(folder: string, goal: string, rawBudget: unknown, untilText: unknown): Promise<{ ok: boolean; error?: string; note?: string }> {
  const budget = nightBudget(rawBudget);
  if (!budget) return { ok: false, error: 'Give a budget between $1 and $100.' };
  const until = nightDeadline(String(untilText ?? ''), Date.now());
  if (!until) return { ok: false, error: 'Give the morning time as HH:MM, within 16 hours.' };
  if (!goal.trim()) return { ok: false, error: 'Say what the shift should work on.' };
  let repo: string;
  let base: string;
  try {
    repo = (await git(folder, ['rev-parse', '--show-toplevel'])).trim();
    base = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  } catch {
    return { ok: false, error: 'A night shift works on its own git branch, and this folder is not in a git repository with a commit.' };
  }
  const branch = nightBranch(new Date());
  const worktree = path.join(app.getPath('userData'), 'night', branch.replace(/\//g, '-'));
  try { await git(repo, worktreeCommand(worktree, branch)); } catch (error) { return { ok: false, error: `Could not make the isolated checkout: ${(error as Error).message}` }; }
  const id = threads().create(worktree, '', 'quick', host!.quickModel());
  threads().rename(id, `Night shift: ${goal.replace(/\s+/g, ' ').trim().slice(0, 60)}`);
  const shift: NightShift & { continuations: number; timer?: NodeJS.Timeout } = { threadId: id, repo, worktree, branch, base, goal, budgetUsd: budget, startedAt: Date.now(), until, continuations: 0 };
  nightShifts.set(id, shift);
  keepAwake(true);
  shift.timer = setTimeout(() => {
    const s = nightShifts.get(id);
    if (!s) return;
    const { status } = threads().get(id).summary;
    if (status === 'working' || status === 'needs-you' || status === 'starting') threads().send(id, { t: 'interrupt' });
    else void endNightShift(id, 'morning');
  }, until - Date.now());
  threads().submit(id, nightWords(goal, branch, budget, until), goal, true);
  const morning = new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  threads().addNote(id, `Night shift on ${branch} until ${morning}, at most $${budget}. It works in an isolated checkout, so your working copy is not touched, and Bimax keeps this Mac awake until it is done.`);
  host!.showQuickThread(id);
  return { ok: true, note: budgetNote(budget, dailyCapUsd()) ?? undefined };
}
function readSpendLedger(): unknown {
  try { return JSON.parse(readFileSync(path.join(app.getPath('userData'), 'spend-ledger.json'), 'utf8')); } catch { return null; }
}
const utcDate = (at: number): string => new Date(at).toISOString().slice(0, 10);
/** A shift's turn ended: carry on with the next milestone, or stop and write the briefing. */
export function afterNightTurn(id: string): void {
  const shift = nightShifts.get(id);
  if (!shift) return;
  const { summary, state } = threads().get(id);
  const last = [...state.items].reverse().find((item) => item.kind === 'msg' && item.msg.role === 'assistant');
  const answer = last && last.kind === 'msg' ? last.msg.content : '';
  const spent = spentBy(readSpendLedger(), id, utcDate(shift.startedAt));
  const next = nightNext({ now: Date.now(), until: shift.until, spent, budget: shift.budgetUsd, answer, outcome: summary.outcome, continuations: shift.continuations });
  if (next === 'continue') {
    shift.continuations += 1;
    threads().submit(id, nightContinue((shift.until - Date.now()) / 60_000, shift.budgetUsd - spent), 'Night shift: next milestone', true);
    return;
  }
  void endNightShift(id, next);
}
async function endNightShift(id: string, stoppedBy: 'finished' | 'morning' | 'budget' | 'failed' | 'stopped'): Promise<void> {
  const shift = nightShifts.get(id);
  if (!shift) return;
  nightShifts.delete(id);
  if (shift.timer) clearTimeout(shift.timer);
  keepAwake(false);
  const { summary, state } = threads().get(id);
  const last = [...state.items].reverse().find((item) => item.kind === 'msg' && item.msg.role === 'assistant');
  const answer = last && last.kind === 'msg' ? last.msg.content.replace(/NIGHT SHIFT DONE\s*$/, '').trim() : '';
  const commits = await git(shift.worktree, ['log', '--oneline', '--no-decorate', `${shift.base}..HEAD`]).then((out) => out.split('\n').filter(Boolean), () => []);
  const diffstat = await git(shift.worktree, ['diff', '--stat', `${shift.base}..HEAD`]).catch(() => '');
  const questions = await fsp.readFile(path.join(shift.worktree, 'NIGHT-QUESTIONS.md'), 'utf8').then((t) => t.slice(0, 4000), () => '');
  const text = briefing({ goal: shift.goal, branch: shift.branch, repo: shift.repo, worktree: shift.worktree, commits, diffstat, spentUsd: spentBy(readSpendLedger(), id, utcDate(shift.startedAt)), budgetUsd: shift.budgetUsd, check: summary.check, stoppedBy, answer, questions });
  const file = path.join(app.getPath('userData'), 'night', `${shift.branch.replace(/\//g, '-')}-briefing.md`);
  await fsp.writeFile(file, text, 'utf8').catch(() => undefined);
  threads().addNote(id, text);
  if (Notification.isSupported()) {
    const note = new Notification({ title: 'Night shift briefing', subtitle: `${commits.length} commit${commits.length === 1 ? '' : 's'} on ${shift.branch}`, body: text.split('\n')[2] ?? '' });
    note.on('click', () => host!.openThread(id));
    note.show();
  }
}
