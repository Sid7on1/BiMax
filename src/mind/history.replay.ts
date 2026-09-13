import { stateDir } from '../utils/state.dir';
import * as fs from 'fs';
import * as path from 'path';
import { execSync, execFileSync } from 'child_process';
import { listEpisodes, loadEpisode } from './episode.recorder';
import { isEvidenceCommand } from './epistemic.ledger';
import { WorktreeManager } from '../evolution/worktree.manager';
import { getEventLedger } from './event.ledger';
import { mindSingletonRoot } from './self.model';
import { mulberry32 } from './mutation.engine';

/**
 * History-replay generator (dream v2, generator #4): re-attempt a REAL past task.
 *
 * Episode bundles record the repo's HEAD commit and the user's actual request; when the
 * recording also contains a build/test evidence command, the episode is harvestable as
 * a practice task with an objective grade: reset a worktree to that commit, hand a
 * sandboxed agent the original request from scratch, then re-run the recorded evidence
 * command — green or not, no self-assessment. This is the plan's T3 corpus (harvested
 * real episodes with verified outcomes) feeding practice directly.
 *
 * The result is never merged (the real work already happened); the value is the
 * repetition — same distillation path as mutation/regeneration (ledger + exemplars).
 */

export interface HistoryTask {
  episodeId: string;
  commit: string;
  userTask: string;
  evidenceCommand: string;
}

export interface HistoryReplayReport {
  attempted: boolean;
  note?: string;
  episodeId?: string;
  taskPreview?: string;
  evidenceCommand?: string;
  fixed?: boolean;
  durationMs?: number;
}

type EvidenceRunner = (worktree: string, command: string) => { ok: boolean; output: string };
type FixAttempter = (worktree: string, prompt: string, stamp: string) => Promise<void>;

const EVIDENCE_TIMEOUT_MS = 240_000;

/** Re-run the episode's own recorded evidence command — the objective grade. */
function defaultRunEvidence(worktree: string, command: string): { ok: boolean; output: string } {
  try {
    const out = execSync(command, { cwd: worktree, stdio: 'pipe', timeout: EVIDENCE_TIMEOUT_MS, encoding: 'utf-8' });
    return { ok: true, output: String(out).slice(-4000) };
  } catch (e: any) {
    return { ok: false, output: String(e?.stdout || '').slice(-4000) + String(e?.stderr || '').slice(-2000) };
  }
}

async function defaultAttemptFix(worktree: string, prompt: string, stamp: string): Promise<void> {
  const { SubAgentManager } = await import('../core/subagent.manager');
  await new SubAgentManager().spawnWorker(`dream-hist-${stamp}`, {
    agentType: 'OpenClaw',
    prompt,
    cwd: worktree,
    parentMode: 'auto',
    sandboxFloorRoot: worktree,
  });
}

/**
 * Episodes that qualify as practice tasks: intact chain, a recorded commit, a real user
 * request, and at least one build/test evidence command to grade with.
 */
export function harvestHistoryTasks(root: string = mindSingletonRoot()): HistoryTask[] {
  const out: HistoryTask[] = [];
  for (const summary of listEpisodes(root)) {
    const ep = loadEpisode(summary.id, root);
    if (!ep || !ep.chainOk || !ep.header.commit || ep.calls.length === 0) continue;

    // The task = the latest user message in the first call's history (loop-injected
    // nudges are bracketed — skip them).
    let userTask = '';
    for (const m of [...ep.calls[0].newMessages].reverse()) {
      if (m.role === 'user' && typeof m.content === 'string' && m.content.trim() && !m.content.startsWith('[')) {
        userTask = m.content.trim();
        break;
      }
    }
    if (!userTask) continue;

    // The grade = the LAST evidence command the recorded run actually used.
    let evidenceCommand = '';
    for (const c of ep.calls) {
      for (const tc of c.response?.toolCalls || []) {
        if (tc.name !== 'BashTool') continue;
        try {
          const cmd = String(JSON.parse(tc.args || '{}').command || '');
          if (cmd && isEvidenceCommand(cmd)) evidenceCommand = cmd;
        } catch { /* unparseable args */ }
      }
    }
    if (!evidenceCommand) continue;

    out.push({ episodeId: ep.header.id, commit: ep.header.commit, userTask, evidenceCommand });
  }
  return out;
}

/** One history-replay practice episode. Same lifecycle discipline as mutation self-play. */
export async function replayHistoryTask(
  root: string = mindSingletonRoot(),
  opts?: { seed?: number; runEvidence?: EvidenceRunner; attemptFix?: FixAttempter },
  log: (level: 'info' | 'success' | 'error', msg: string) => void = () => {}
): Promise<HistoryReplayReport> {
  const report: HistoryReplayReport = { attempted: false };
  const started = Date.now();
  const rng = mulberry32(opts?.seed ?? (Date.now() & 0xffffffff));
  const runEvidence = opts?.runEvidence || defaultRunEvidence;
  const attemptFix = opts?.attemptFix || defaultAttemptFix;

  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, stdio: 'pipe' });
  } catch {
    report.note = 'skipped: not a git repository';
    return report;
  }

  const tasks = harvestHistoryTasks(root);
  if (tasks.length === 0) {
    report.note = 'skipped: no harvestable episode (needs an intact bundle with a commit + an evidence command)';
    return report;
  }
  const task = tasks[Math.floor(rng() * tasks.length)];
  report.episodeId = task.episodeId;
  report.taskPreview = task.userTask.replace(/\s+/g, ' ').slice(0, 120);
  report.evidenceCommand = task.evidenceCommand;

  const stamp = Date.now().toString(36);
  const branch = `dream/hist-${stamp}`;
  const worktrees = new WorktreeManager(root);
  let worktreePath: string;
  try {
    ({ worktreePath } = await worktrees.createWorktree(branch, task.commit));
  } catch (e: any) {
    report.note = `skipped: could not create worktree at ${task.commit.slice(0, 8)} (${e?.message})`;
    return report;
  }

  try {
    report.attempted = true;
    log('info', `Re-attempting episode ${task.episodeId} at ${task.commit.slice(0, 8)}: "${report.taskPreview}"`);
    try {
      await attemptFix(
        worktreePath,
        `Complete this task (the repo is reset to the state it had when it was first asked):\n\n${task.userTask}\n\n` +
        `Verify your work by running \`${task.evidenceCommand}\` before finishing. ` +
        `You are in an isolated practice worktree — work only here.`,
        stamp
      );
    } catch (e: any) {
      log('error', `Attempt errored: ${e?.message}`);
    }

    const grade = runEvidence(worktreePath, task.evidenceCommand);
    report.fixed = grade.ok;
    report.durationMs = Date.now() - started;

    getEventLedger().append('dream_episode', {
      generator: 'history',
      op: 'history', episodeId: task.episodeId, commit: task.commit,
      evidenceCommand: task.evidenceCommand.slice(0, 200),
      killed: true, fixed: report.fixed, durationMs: report.durationMs,
    });

    // Exemplar on success — a real task, re-solved and re-verified in this repo.
    if (grade.ok) {
      try {
        const file = path.join(stateDir('.bimax', root), 'exemplars.json');
        let all: any[] = [];
        try { const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')); if (Array.isArray(parsed)) all = parsed; } catch { /* first */ }
        all.push({
          at: new Date().toISOString(), kind: 'history-replay',
          episodeId: task.episodeId, task: report.taskPreview,
          evidence: task.evidenceCommand.slice(0, 200), outcome: 'verified',
        });
        if (all.length > 200) all.splice(0, all.length - 200);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(all, null, 2), 'utf-8');
      } catch { /* best-effort */ }
      log('success', 'Re-attempt VERIFIED by the recorded evidence command — exemplar stored.');
    } else {
      log('info', 'Re-attempt failed the recorded evidence command — the failure event is the lesson.');
    }
    return report;
  } finally {
    try { await worktrees.removeWorktree(branch, true); } catch { /* best-effort cleanup */ }
  }
}
