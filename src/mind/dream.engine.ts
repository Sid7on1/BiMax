import { stateDir } from '../utils/state.dir';
import * as fs from 'fs';
import * as path from 'path';
import { getSelfModel, mindSingletonRoot } from './self.model';
import { getHabitMiner } from './habit.compiler';
import { getDrivesEngine, DrivesEngine } from './drives.engine';
import { globalProjectMemory } from '../memory/project.memory';
import { WorktreeManager } from '../evolution/worktree.manager';
import { SubAgentManager } from '../core/subagent.manager';
import { MutationEngine, SelfPlayReport } from './mutation.engine';
import { replayHistoryTask, HistoryReplayReport } from './history.replay';

/**
 * DreamEngine — offline consolidation + self-play. One dream cycle, run while the
 * user is away (/dream, or scheduled via /watch):
 *
 *   1. MEASURE    — check the drives (sequential; heavy checks only with `deep`).
 *   2. CONSOLIDATE— distill the self-model's weak spots into durable lessons in
 *                   project memory, and mine + compile habits from tool history.
 *   3. PRACTICE   — take the worst drive deviation as a real practice task, attempt
 *                   it with a sub-agent in a throwaway git worktree, and grade the
 *                   attempt OBJECTIVELY by re-measuring the drive inside the worktree.
 *                   A passing patch is kept on a dream/<stamp> branch for review;
 *                   a failing one is discarded — but the lesson is kept either way.
 *   4. JOURNAL    — append the cycle to .bimax/dreams.json so /dream history shows
 *                   what the agent learned night over night.
 *
 * Everything is sequential and bounded: one worktree, one sub-agent, hard timeouts.
 */

export interface DreamPractice {
  driveId: string;
  task: string;
  attempted: boolean;
  graded?: boolean;      // objective: did the drive measure OK in the worktree afterwards
  branch?: string;       // kept only when the patch graded green and changed something
  note?: string;
}

export interface DreamReport {
  at: string;
  deviations: string[];
  lessons: string[];
  habitsMined: number;
  habitsCompiled: number;
  practice?: DreamPractice;
  /** Dream v2: mutation/regeneration self-play with known ground truth — runs even when healthy. */
  selfPlay?: SelfPlayReport;
  /** Dream v2 (deep cycles): re-attempt a real recorded task at its original commit. */
  history?: HistoryReplayReport;
}

type DreamLogger = (level: 'info' | 'success' | 'error', msg: string) => void;

export class DreamEngine {
  private journalPath: string;

  constructor(private projectRoot: string = process.cwd()) {
    this.journalPath = path.join(stateDir('.bimax', projectRoot), 'dreams.json');
  }

  private appendJournal(report: DreamReport): void {
    try {
      let journal: DreamReport[] = [];
      try {
        const parsed = JSON.parse(fs.readFileSync(this.journalPath, 'utf-8'));
        if (Array.isArray(parsed)) journal = parsed;
      } catch { /* first dream */ }
      journal.push(report);
      if (journal.length > 100) journal.splice(0, journal.length - 100);
      fs.mkdirSync(path.dirname(this.journalPath), { recursive: true });
      fs.writeFileSync(this.journalPath, JSON.stringify(journal, null, 2), 'utf-8');
    } catch { /* journaling is best-effort */ }
  }

  journal(): DreamReport[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.journalPath, 'utf-8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }

  /**
   * Distill weak spots into durable, rate-free lessons. Rate-free on purpose: the
   * lesson text stays byte-stable as the numbers move, so ProjectMemory's
   * content-hash id dedupes re-remembering instead of piling up near-duplicates.
   */
  private async consolidate(log: DreamLogger): Promise<string[]> {
    const lessons: string[] = [];
    for (const w of getSelfModel().weakSpots().slice(0, 5)) {
      const lesson = `${w.tool} is unreliable on \`${w.domain}\` in this repo — ${w.advice}.`;
      try {
        await globalProjectMemory.remember(lesson, 'gotcha', ['dream', 'self-model']);
        lessons.push(lesson);
      } catch { /* memory is best-effort */ }
    }
    const miner = getHabitMiner();
    miner.mine();
    const compiled = miner.compileAll();
    if (compiled.length > 0) {
      log('info', `Compiled ${compiled.length} new habit(s) from recurring tool sequences.`);
    }
    return lessons;
  }

  /** Self-play: attempt the worst drive deviation in a throwaway worktree, grade objectively. */
  private async practice(log: DreamLogger): Promise<DreamPractice | undefined> {
    const task = getDrivesEngine().nextRestorationTask();
    if (!task) return undefined;
    const practice: DreamPractice = { driveId: task.drive.id, task: task.prompt, attempted: false };

    // Practice needs git (the whole point is an isolated, discardable attempt).
    try {
      const { execFileSync } = await import('child_process');
      execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: this.projectRoot, stdio: 'pipe' });
    } catch {
      practice.note = 'skipped: not a git repository (practice runs in a worktree)';
      return practice;
    }

    const stamp = Date.now().toString(36);
    const branch = `dream/${stamp}`;
    const worktrees = new WorktreeManager(this.projectRoot);
    const subagents = new SubAgentManager();

    let worktreePath: string;
    try {
      ({ worktreePath } = await worktrees.createWorktree(branch, 'HEAD'));
    } catch (e: any) {
      practice.note = `skipped: could not create worktree (${e?.message})`;
      return practice;
    }

    try {
      log('info', `Practicing in worktree: ${task.drive.label}`);
      practice.attempted = true;
      try {
        await subagents.spawnWorker(`dream-${stamp}`, {
          agentType: 'OpenClaw',
          prompt:
            `${task.prompt}\n\nYou are in an isolated practice worktree — work only here. ` +
            `Verify your work by actually running the relevant command before finishing.`,
          cwd: worktreePath,
          parentMode: 'auto',
          // Dream episodes run unattended in auto mode — they get the sandbox floor
          // (writes confined to the worktree, net: none, scrubbed child env). Not optional.
          sandboxFloorRoot: worktreePath,
        });
      } catch (e: any) {
        practice.note = `agent error: ${e?.message}`;
      }

      // Objective grade: re-measure the SAME drive inside the worktree. No self-assessment.
      const grader = new DrivesEngine(worktreePath);
      const after = await grader.check({ only: task.drive.id });
      const graded = after.find(d => d.id === task.drive.id)?.lastOk === true;
      practice.graded = graded;

      const changed = await worktrees.hasChanges(worktreePath);
      if (graded && changed) {
        await worktrees.commitChanges(worktreePath, `dream: restore drive "${task.drive.label}" (${stamp})`);
        practice.branch = branch;
        log('success', `Practice PASSED — patch kept on branch ${branch} for review.`);
        try {
          await globalProjectMemory.remember(
            `Drive "${task.drive.label}" was successfully restored by the dream loop — the approach in branch ${branch} works for this class of problem.`,
            'note', ['dream', 'practice']
          );
        } catch { /* best-effort */ }
      } else {
        log('info', graded ? 'Practice graded green but changed nothing — discarding.' : 'Practice FAILED the objective grade — discarding attempt, keeping the lesson.');
        if (!graded) {
          try {
            await globalProjectMemory.remember(
              `The dream loop attempted to restore drive "${task.drive.label}" and failed the objective re-measurement — this deviation needs human attention or a different approach.`,
              'gotcha', ['dream', 'practice']
            );
          } catch { /* best-effort */ }
        }
      }
    } finally {
      // Remove the worktree; drop the branch too unless it carries a passing patch.
      try {
        if (practice.branch) {
          const { execFileSync } = await import('child_process');
          execFileSync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: this.projectRoot, stdio: 'pipe' });
        } else {
          await worktrees.removeWorktree(branch, true);
        }
      } catch { /* best-effort cleanup */ }
    }
    return practice;
  }

  /** One full dream cycle. Strictly sequential; `deep` includes heavy drive checks (build/tests). */
  async cycle(opts?: { deep?: boolean; practice?: boolean; log?: DreamLogger }): Promise<DreamReport> {
    const log: DreamLogger = opts?.log || (() => {});

    log('info', `Dreaming: measuring drives${opts?.deep ? ' (deep — includes build/tests)' : ' (quick)'}…`);
    await getDrivesEngine().check({ quick: !opts?.deep });
    const deviating = getDrivesEngine().deviations();
    if (deviating.length > 0) {
      log('info', `Deviations: ${deviating.map(d => d.label).join(', ')}`);
    }

    log('info', 'Consolidating: distilling lessons + compiling habits…');
    const lessons = await this.consolidate(log);
    const habits = getHabitMiner().habits();

    let practiceResult: DreamPractice | undefined;
    if (opts?.practice !== false && deviating.length > 0) {
      practiceResult = await this.practice(log);
    }

    // Dream v2: mutation self-play needs nothing to be wrong — it manufactures a defect
    // with known ground truth and practices the diagnose-and-fix loop on it. One mutant
    // per cycle, bounded like everything else here.
    let selfPlayResult: SelfPlayReport | undefined;
    if (opts?.practice !== false) {
      log('info', 'Self-play: planting a mutation with covering tests…');
      try {
        selfPlayResult = await new MutationEngine(this.projectRoot).selfPlay(log);
      } catch (e: any) {
        selfPlayResult = { attempted: false, survivors: 0, note: `errored: ${e?.message}` };
      }
    }

    // Deep dreams also re-attempt one real past task from the episode bundles (heavier:
    // spawns a full agent run, so it rides the same flag as build/test measurement).
    let historyResult: HistoryReplayReport | undefined;
    if (opts?.deep && opts?.practice !== false) {
      log('info', 'History replay: harvesting past verified episodes…');
      try {
        historyResult = await replayHistoryTask(this.projectRoot, undefined, log);
      } catch (e: any) {
        historyResult = { attempted: false, note: `errored: ${e?.message}` };
      }
    }

    const report: DreamReport = {
      at: new Date().toISOString(),
      deviations: deviating.map(d => `${d.label}: ${d.lastValue}`),
      lessons,
      habitsMined: habits.length,
      habitsCompiled: habits.filter(h => h.compiled).length,
      practice: practiceResult,
      selfPlay: selfPlayResult,
      history: historyResult,
    };
    this.appendJournal(report);
    return report;
  }
}

let _global: DreamEngine | null = null;
export function getDreamEngine(): DreamEngine {
  if (!_global) _global = new DreamEngine(mindSingletonRoot());
  return _global;
}
export function __setDreamEngine(e: DreamEngine | null): void { _global = e; }
