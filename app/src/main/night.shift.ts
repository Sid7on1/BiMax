/**
 * Night Shift (backlog FL5): "Work on this migration tonight, at most $12, a reviewable branch by morning."
 *
 * A night shift is a ⌘2 task that works in an isolated checkout — a git worktree on a new branch, kept in Bimax's app
 * data — so nothing in the person's working copy changes overnight. Its words ask for milestones, each checked and
 * committed on the branch, and for decisions to be written down and worked around rather than waited on. Bimax keeps
 * the Mac awake while it runs (it cannot run while the Mac sleeps), stops it at the morning time or at its budget,
 * and leaves a briefing: the branch, its commits, what changed, what was spent, how the check went, and the
 * questions it recorded.
 *
 * Pure: the git commands and the briefing are built here and tested; index.ts runs them.
 */

export const MAX_NIGHT_BUDGET = 100;
export const MAX_NIGHT_HOURS = 16;

export interface NightShift {
  threadId: string;
  repo: string;
  worktree: string;
  branch: string;
  base: string;
  goal: string;
  budgetUsd: number;
  startedAt: number;
  until: number;
}

/** The branch a shift works on: `bimax/night-2026-09-22-2330`, unique to the minute it started. */
export function nightBranch(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `bimax/night-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/** "07:00" → the next 07:00 after `now`, at most MAX_NIGHT_HOURS away; null when it cannot be read or is too far. */
export function nightDeadline(text: string, now: number): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const [hours, minutes] = [Number(match[1]), Number(match[2])];
  if (hours > 23 || minutes > 59) return null;
  const when = new Date(now);
  when.setHours(hours, minutes, 0, 0);
  if (when.getTime() <= now) when.setDate(when.getDate() + 1);
  return when.getTime() - now > MAX_NIGHT_HOURS * 3600_000 ? null : when.getTime();
}

/** A budget in dollars between $1 and $100, or null. */
export function nightBudget(raw: unknown): number | null {
  const value = typeof raw === 'number' ? raw : Number.parseFloat(String(raw ?? ''));
  return Number.isFinite(value) && value >= 1 && value <= MAX_NIGHT_BUDGET ? Math.round(value * 100) / 100 : null;
}

/** What to tell the person before starting: the daily cap is Mac-wide and stops a bigger budget first. */
export function budgetNote(budget: number, dailyCap: number): string | null {
  return dailyCap > 0 && budget > dailyCap
    ? `Your daily spending cap is $${dailyCap}, so the shift stops at $${dailyCap} unless you raise it in Settings → Agent behavior.`
    : null;
}

/** The task's words: the goal, and how to work unattended. */
export function nightWords(goal: string, branch: string, budget: number, until: number): string {
  const morning = new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${goal}

[Night shift: you are working unattended until ${morning}, on the branch ${branch} in an isolated checkout, with at most $${budget} to spend. Nobody will answer questions tonight.
- Split the work into milestones. After each one, run the project's check (its tests or build) and commit it on this branch with a message starting "milestone:". Never push.
- When you need a decision, choose the safer option, write the question and what you chose in NIGHT-QUESTIONS.md, commit it, and carry on with work that does not depend on it.
- When you finish or run out of time, end with a short briefing: what is done, what is not, and how to review it.
- When everything is done, end your final message with the line ${NIGHT_DONE}.]`;
}

/** The line a shift ends with when all its work is done. */
export const NIGHT_DONE = 'NIGHT SHIFT DONE';
/** A shift's turn can end before its work does; it is continued at most this many times. */
export const MAX_CONTINUATIONS = 20;

/** What the shift does after a turn ends: carry on with the next milestone, or stop and brief — and why. */
export function nightNext(input: { now: number; until: number; spent: number; budget: number; answer: string; outcome?: string; continuations: number }): 'continue' | BriefingFacts['stoppedBy'] {
  if (input.answer.includes(NIGHT_DONE)) return 'finished';
  // Before "failed": at its budget the engine refuses the next call, and that is why the turn failed.
  if (input.spent >= input.budget) return 'budget';
  if (input.outcome === 'failed') return 'failed';
  if (input.now >= input.until - 5 * 60_000) return 'morning';
  if (input.outcome === 'interrupted') return 'stopped';
  if (input.continuations >= MAX_CONTINUATIONS) return 'finished';
  return 'continue';
}

/** The words that continue a shift after a turn ended early. */
export function nightContinue(minutesLeft: number, dollarsLeft: number): string {
  return `[Night shift: carry on with the next milestone. About ${Math.max(1, Math.round(minutesLeft))} minutes and $${dollarsLeft.toFixed(2)} are left. If everything is done, end with ${NIGHT_DONE}.]`;
}

/** What the shift spent: its scope's totals today and on earlier days since it started (a shift can cross midnight UTC). */
export function spentBy(ledger: unknown, scope: string, sinceDate: string): number {
  const file = ledger as { date?: string; scopes?: Record<string, number>; history?: Array<{ date?: string; scopes?: Record<string, number> }> } | null;
  if (!file) return 0;
  let sum = 0;
  if (typeof file.date === 'string' && file.date >= sinceDate) sum += Number(file.scopes?.[scope]) || 0;
  for (const day of file.history ?? []) if (typeof day?.date === 'string' && day.date >= sinceDate) sum += Number(day.scopes?.[scope]) || 0;
  return Math.round(sum * 100) / 100;
}

/** `git worktree add` for the shift: a new branch from the current HEAD, checked out in Bimax's app data. */
export function worktreeCommand(worktree: string, branch: string): string[] {
  return ['worktree', 'add', '-b', branch, worktree, 'HEAD'];
}

export interface BriefingFacts {
  goal: string;
  branch: string;
  repo: string;
  worktree: string;
  commits: string[];
  diffstat: string;
  spentUsd: number | null;
  budgetUsd: number;
  check?: string;
  stoppedBy: 'finished' | 'morning' | 'budget' | 'failed' | 'stopped';
  answer: string;
  questions: string;
}

/** The morning briefing, as Markdown: short enough to read over coffee, with the commands to review it. */
export function briefing(facts: BriefingFacts): string {
  const ended = { finished: 'Finished on its own', morning: 'Stopped at the morning time', budget: 'Stopped at its budget', failed: 'Stopped by an error', stopped: 'Stopped by you' }[facts.stoppedBy];
  const check = facts.check === 'passed' ? 'the check passed' : facts.check === 'failed' ? 'the check FAILED' : facts.check === 'tests-edited' ? 'the check passed after test files changed — read those' : 'no check result';
  const spent = facts.spentUsd === null ? 'spend unknown' : `$${facts.spentUsd.toFixed(2)} of $${facts.budgetUsd}`;
  const lines = [
    `# Night shift: ${facts.goal.split('\n')[0]!.slice(0, 80)}`,
    '',
    `${ended} · ${facts.commits.length} commit${facts.commits.length === 1 ? '' : 's'} on \`${facts.branch}\` · ${check} · ${spent}`,
    '',
    '## Commits',
    ...(facts.commits.length ? facts.commits.map((c) => `- ${c}`) : ['- None: nothing was committed.']),
  ];
  if (facts.diffstat.trim()) lines.push('', '## What changed', '```', facts.diffstat.trim(), '```');
  if (facts.questions.trim()) lines.push('', '## Questions it recorded', facts.questions.trim());
  if (facts.answer.trim()) lines.push('', '## Its own summary', facts.answer.trim());
  lines.push('', '## Review it', '```', `cd ${JSON.stringify(facts.repo)}`, `git log --oneline HEAD..${facts.branch}`, `git diff HEAD...${facts.branch}`,
    `# keep it: git merge ${facts.branch}    # drop it: git worktree remove ${JSON.stringify(facts.worktree)} && git branch -D ${facts.branch}`, '```');
  return `${lines.join('\n')}\n`;
}
