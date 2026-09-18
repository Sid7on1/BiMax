import { execFileSync } from 'child_process';
import { globalCommandRegistry } from './registry';
import { SwarmOrchestrator } from '../../evolution/swarm.orchestrator';
import { SpeculativeSolver } from '../../evolution/speculative.solver';
import { TestHealer } from '../../sandbox/test.healer';
import { globalSubAgentManager } from '../../core/subagent.manager';
import { globalCheckpointManager } from '../../sandbox/checkpoint.manager';
import { globalProjectMemory } from '../../memory/project.memory';
import { getGoalManager } from '../../memory/goal.manager';
import { buildAgentContextBlock } from '../../evolution/agent.context';
import { WorktreeManager } from '../../evolution/worktree.manager';
import { PipelineJournal } from '../../core/pipeline.journal';

function isGitRepo(cwd: string): boolean {
  try {
    return execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, encoding: 'utf-8' }).trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * /beast <goal> — the mega-pipeline. Choreographs the existing orchestrators end-to-end, autonomously,
 * leaving the result on a review branch (no auto-merge). Every sub-agent it spawns is graph-aware (via
 * buildAgentContextBlock — same enrichment that now flows through /swarm, /speculate, /heal).
 *
 * Chain: recall goals+memory → [optional speculate] → swarm (decompose+parallel worktrees) → heal the
 * integration branch → self-critic review pass → checkpoint → record a memory of the outcome.
 *
 * Flags: --speculate N  (propose N approaches first and refine the goal with the recommended one).
 */
globalCommandRegistry.register({
  name: '/beast',
  description: 'Autonomous mega-pipeline: graph-aware swarm → heal → self-critic → checkpoint, on a review branch',
  category: 'Code & Intelligence',
  execute: async (args, context) => {
    // Parse --speculate N out of the args, rest is the goal.
    let speculateN = 0;
    const rest: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--speculate') { speculateN = Math.max(2, Math.min(parseInt(args[++i] || '3', 10) || 3, 5)); continue; }
      rest.push(args[i]);
    }
    const goal = rest.join(' ').trim();
    if (!goal) {
      return { type: 'message', level: 'error', content: 'Usage: /beast <goal> [--speculate N]. Example: /beast add rate limiting to the API' };
    }
    if (!isGitRepo(context.cwd)) {
      return { type: 'message', level: 'error', content: 'Beast needs a git repository (sub-agents work in isolated worktrees). Run `git init` first.' };
    }
    const llmAdapter = context.options.llmAdapter;
    if (!llmAdapter) return { type: 'message', level: 'error', content: 'LLM adapter unavailable in this context.' };
    const mode = context.options.governor?.mode || 'interactive';
    const log = (level: 'info' | 'success' | 'error' | 'warn', msg: string) =>
      context.addSystemMessage(level === 'warn' ? 'info' : level, msg);

    const sections: string[] = [];
    context.addSystemMessage('info', `🦾 Beast engaged for: "${goal}"`);

    // Durable pipeline (v2 §3.10): every step transition is a ledger event; a crashed or
    // failed run re-invoked with the SAME goal resumes after its last completed step —
    // the worktrees/branches it created are still on disk, and the journal knows which
    // steps banked them.
    const journal = PipelineJournal.open('beast', goal.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60));
    if (journal.resumed) {
      log('info', `♻ Resuming incomplete beast run \`${journal.run}\` — completed steps are served from the journal.`);
      sections.push(`♻ Resumed run \`${journal.run}\` (crash/failure recovery — completed steps not re-executed).`);
    }

    try {
      // 1. Recall standing context (for the header + to confirm the loop is memory-fed).
      try {
        const activeGoals = getGoalManager().getActiveGoals();
        if (activeGoals.length) log('info', `Aligning with ${activeGoals.length} active goal(s).`);
      } catch { /* goals optional */ }

      // 2. Optional speculate — propose distinct approaches, adopt the recommended one.
      let workingGoal = goal;
      if (speculateN > 0) {
        const spec = await journal.step('speculate', async () => {
          log('info', `🔭 Speculating ${speculateN} approaches…`);
          const solver = new SpeculativeSolver(context.cwd, llmAdapter, mode, log);
          const s = await solver.run(goal, { count: speculateN });
          const pick = s.recommended != null ? s.arms[s.recommended] : undefined;
          return pick
            ? { workingGoal: `${goal}\n\nPreferred approach (from speculation): ${pick.approach}`, section: `🔭 Speculation: ${s.arms.length} approaches tried; adopted #${pick.index + 1}${pick.testsPassed ? ' (tests passed)' : ''}.` }
            : { workingGoal: goal, section: `🔭 Speculation: no clearly-better approach; proceeding with the raw goal.` };
        });
        workingGoal = spec.workingGoal;
        sections.push(spec.section);
      }

      // 3. Swarm — decompose + parallel graph-aware sub-agents → integration branch.
      const swarmed = await journal.step('swarm', async () => {
        log('info', '🐝 Swarming…');
        const swarm = new SwarmOrchestrator(context.cwd, llmAdapter, mode, log);
        const report = await swarm.run(workingGoal, { autoMerge: false });
        const okCount = report.nodes.filter(n => n.status === 'completed').length;
        const nodeLines = report.nodes.map(n => {
          const icon = n.status === 'completed' ? '✔' : n.status === 'conflict' ? '⚠' : n.status === 'skipped' ? '·' : '✖';
          return `  ${icon} ${n.id} — ${n.status}${n.detail ? ` (${n.detail})` : ''}`;
        });
        return { branch: report.integrationBranch, ok: okCount, total: report.nodes.length, nodeSummary: nodeLines.join('\n') };
      });
      sections.push(`🐝 Swarm: ${swarmed.ok}/${swarmed.total} task(s) succeeded.\n${swarmed.nodeSummary}`);
      const branch = swarmed.branch;
      const ok = swarmed.ok;

      // 4. Heal — run the test suite against the integration branch; auto-fix in a worktree if red.
      const heal = await journal.step('heal', async () => {
        log('info', '🩺 Healing the integration branch…');
        const healer = new TestHealer(context.cwd, mode, log);
        const h = await healer.heal({ baseRef: branch, goal: `make tests pass for: ${goal}` });
        return { initiallyGreen: h.initiallyGreen, healed: h.healed, branch: h.branch };
      });
      sections.push(
        heal.initiallyGreen ? '🩺 Heal: tests already green.'
        : heal.healed ? `🩺 Heal: tests were red, auto-fixed on \`${heal.branch}\` (merge that into the integration branch).`
        : '🩺 Heal: tests red and not fully fixed — review needed.',
      );

      // 5. Self-critic — one review/fix pass over the integration diff in its own worktree.
      const critic = await journal.step('critic', async () => {
        log('info', '🔎 Self-critic review pass…');
        try {
          const wm = new WorktreeManager(context.cwd);
          const critBranch = `beast/critic/${Date.now().toString(36)}`;
          const { worktreePath } = await wm.createWorktree(critBranch, branch);
          const ctx = await buildAgentContextBlock({ goal, subtask: `review the changes for goal: ${goal}` });
          const prompt = `${ctx}Review the work done toward this goal and FIX any real problems you find — correctness bugs, missed cases, inconsistencies with the codebase. Do NOT add new scope.\n\nGoal: ${goal}\n\nInspect the diff with git/BashTool, then fix in place. Work only inside this worktree; do not commit.`;
          await globalSubAgentManager.spawnWorker(`beast-critic-${Date.now().toString(36)}`, { agentType: 'OpenClaw', prompt, cwd: worktreePath, parentMode: mode });
          const changed = await wm.hasChanges(worktreePath);
          if (changed) {
            await wm.commitChanges(worktreePath, 'beast: self-critic fixes');
            return `🔎 Self-critic: applied fixes on \`${critBranch}\` (merge into the integration branch if you want them).`;
          }
          await wm.removeWorktree(critBranch, true).catch(() => {});
          return '🔎 Self-critic: no issues found.';
        } catch (e: any) {
          return `🔎 Self-critic: skipped (${(e.message || 'error').slice(0, 60)}).`;
        }
      });
      sections.push(critic);

      // 6. Checkpoint — lightweight snapshot so the run is anchored in the time machine.
      const cp = globalCheckpointManager.create(`beast: ${goal.slice(0, 60)}`, false);
      if (cp) sections.push(`📌 Checkpoint ${cp.id} recorded.`);

      // 7. Memory-fed close — record the outcome so the next run/session carries it forward.
      try {
        await globalProjectMemory.remember(
          `Beast run for "${goal}": swarm ${ok}/${swarmed.total} ok on ${branch}; heal ${heal.initiallyGreen ? 'green' : heal.healed ? 'fixed' : 'needs review'}.`,
          'note', ['beast'],
        );
      } catch { /* memory optional */ }

      journal.finish(true);
      const summary =
        `🦾 Beast complete for: "${goal}"\n\n` +
        sections.join('\n\n') +
        `\n\nResult is on branch \`${branch}\`. Review it, then merge with:\n  git merge ${branch}`;
      return { type: 'message', level: ok === swarmed.total ? 'success' : 'info', content: summary };
    } catch (e: any) {
      // Deliberately NOT finished: the journal keeps the run incomplete, so re-running
      // `/beast <same goal>` resumes after the last banked step instead of starting over.
      return { type: 'message', level: 'error', content: `Beast failed: ${e.message}\n\n♻ Progress is journaled — run the same /beast command again to resume after the last completed step (\`/pipelines\` shows incomplete runs).` };
    }
  },
});
