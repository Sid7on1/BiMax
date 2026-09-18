import { globalCommandRegistry } from './registry';
import { globalSubAgentBlackboard, SubAgentClaim } from '../../core/subagent.blackboard';
import { engineEvents } from '../events';
import { formatSubAgentResult } from '../../core/subagent.result';

const ICON: Record<SubAgentClaim['status'], string> = { running: '◍', done: '✓', failed: '✗' };

function fmtAge(c: SubAgentClaim): string {
  const ms = (c.endedAt ?? Date.now()) - c.startedAt;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
}

export function renderSubagents(claims: SubAgentClaim[]): string {
  if (claims.length === 0) return '● **Sub-agents**\n\n  None spawned this session.';
  const running = claims.filter(c => c.status === 'running').length;
  const lines = ['● **Sub-agents** — ' + `${running} running · ${claims.length} total`, ''];
  for (const c of claims) {
    lines.push(`  ${ICON[c.status]} **${c.agentType}** · \`${c.scope}\` · ${c.toolCalls} tool calls · ${fmtAge(c)}`);
    lines.push(`     ${c.prompt}`);
    if (c.status === 'failed' && c.error) lines.push(`     ✗ ${c.error.slice(0, 160)}`);
  }
  return lines.join('\n');
}

globalCommandRegistry.register({
  name: '/subagents',
  description: 'Live sub-agent coverage — who is running, their scope, and status. `timings` shows boot vs model latency; `resume` respawns a crashed session\'s agents.',
  category: 'Code & Intelligence',
  execute: async (args) => {
    // Deferred requires keep command registration free of core-module init order concerns.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ckpt = require('../../core/agent.checkpoint') as typeof import('../../core/agent.checkpoint');

    if ((args[0] || '').toLowerCase() === 'timings') {
      // WS2 measurement view: where do the seconds go — boot overhead (ours) vs the model's
      // time-to-first-action vs the tool loop. Folded from the lifecycle journal in the ledger.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { foldSubagentRuns, summarizeRun } = require('../../core/subagent.journal') as typeof import('../../core/subagent.journal');
      const runs = foldSubagentRuns();
      if (runs.length === 0) {
        return { type: 'message', level: 'info', content: 'No sub-agent runs recorded yet (journal is empty).' };
      }
      const boots = runs.map(r => r.msToReady).filter((n): n is number => n !== undefined).sort((a, b) => a - b);
      const median = boots.length ? boots[Math.floor(boots.length / 2)] : undefined;
      const lines = [`● **Sub-agent timings** — ${runs.length} run(s)`, ''];
      if (median !== undefined) lines.push(`  Median boot overhead: **${median}ms**  (key pool · config · graph load · tool registration · persona)`, '');
      for (const r of runs.slice(-20)) lines.push(`  ${summarizeRun(r)}`);
      return { type: 'message', level: 'info', content: lines.join('\n') };
    }

    if ((args[0] || '').toLowerCase() === 'resume') {
      const recoverable = ckpt.crashedAgents();
      if (recoverable.length === 0) {
        return { type: 'message', level: 'info', content: 'No crashed sub-agents to resume.' };
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { globalSubAgentManager } = require('../../core/subagent.manager') as typeof import('../../core/subagent.manager');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getOutcomeManager } = require('../../outcome/outcome.manager') as typeof import('../../outcome/outcome.manager');
      const { randomUUID } = require('crypto') as typeof import('crypto');
      let outcomeManager: ReturnType<typeof getOutcomeManager> | null = null;
      try { outcomeManager = getOutcomeManager(); } catch { /* uncoordinated legacy recovery */ }

      const coordinated = recoverable.filter(agent => agent.config.outcomeTaskId);
      const missingSession = coordinated.find(agent => !agent.config.outcomeSessionId);
      if (missingSession) {
        return { type: 'message', level: 'error', content: 'A crashed coordinated agent predates session-bound recovery and cannot be resumed safely. Requeue its outcome task from the original session.' };
      }
      const sessions = [...new Set(coordinated.map(agent => agent.config.outcomeSessionId).filter(Boolean))];
      if (sessions.length > 1) {
        return { type: 'message', level: 'error', content: `The crash snapshot contains agents from multiple outcome sessions (${sessions.join(', ')}). Resume and recover each session separately.` };
      }
      const outcomeTaskIds = coordinated.map(agent => agent.config.outcomeTaskId!);
      const duplicateTask = outcomeTaskIds.find((id, index) => outcomeTaskIds.indexOf(id) !== index);
      if (duplicateTask) {
        return { type: 'message', level: 'error', content: `The crash snapshot contains multiple workers for outcome task ${duplicateTask}. The checkpoint was preserved for manual review.` };
      }
      const requiredSession = sessions[0] || '';
      if (requiredSession && outcomeManager?.activeSessionId() !== requiredSession) {
        return { type: 'message', level: 'error', content: `These agents belong to outcome session ${requiredSession}. Run \`/resume ${requiredSession}\` first, then \`/subagents resume\`.` };
      }

      // Validate the entire coordinated snapshot before consuming it. A stale owner or an
      // ineligible task must leave every checkpoint intact for inspection and manual repair.
      if (outcomeManager) {
        try {
          for (const agent of coordinated) {
            outcomeManager.assertAssignmentRecoverable(agent.config.outcomeTaskId!, agent.claim.taskId);
          }
        } catch (error: any) {
          return {
            type: 'message', level: 'error',
            content: `Recovery validation failed; the crash checkpoint was preserved. ${error?.message || error}`,
          };
        }
      }

      // Consume the dead snapshot BEFORE registering replacement workers. Clearing it afterwards
      // would delete the brand-new checkpoint written by the first resumed agent.
      const crashed = ckpt.consumeCrashedAgents();
      const lines = [`Respawning ${crashed.length} sub-agent(s) from the crashed session:`];
      for (const a of crashed) {
        const taskId = `subagent-${randomUUID()}`;
        const config = ckpt.resumeConfigFor(a);
        if (a.config.outcomeTaskId && outcomeManager) {
          try { outcomeManager.resumeAssignment(a.config.outcomeTaskId, a.claim.taskId, taskId); }
          catch (error: any) {
            lines.push(`  ✗ ${a.claim.agentType} · \`${a.claim.scope}\` · ${error?.message || error}`);
            continue;
          }
        }
        // Fire-and-forget like SpawnSubagentTool — results surface as system messages via the board.
        globalSubAgentManager.spawnWorker(taskId, config).then(result => {
          const text = formatSubAgentResult(result);
          if (config.outcomeTaskId && config.outcomeSessionId && outcomeManager) {
            try { outcomeManager.settleAssignmentForSession(config.outcomeSessionId, config.outcomeTaskId, taskId, true, result); } catch { /* task remains inspectable */ }
          }
          engineEvents.emit('message', {
            id: `subagent-result-${taskId}`, role: 'system', level: 'success',
            content: `✓ Resumed sub-agent ${config.agentType} (${taskId}) finished:\n\n${text.slice(0, 4000)}`,
            timestamp: new Date(),
          });
        }).catch(error => {
          if (config.outcomeTaskId && config.outcomeSessionId && outcomeManager) {
            try { outcomeManager.settleAssignmentForSession(config.outcomeSessionId, config.outcomeTaskId, taskId, false, error?.message || String(error)); } catch { /* task remains inspectable */ }
          }
        });
        lines.push(`  ◍ ${a.claim.agentType} · \`${a.claim.scope}\` · ${a.claim.prompt}`);
      }
      return { type: 'message', level: 'success', content: lines.join('\n') };
    }

    globalSubAgentBlackboard.prune();
    let out = renderSubagents(globalSubAgentBlackboard.all());
    const crashed = ckpt.crashedAgents();
    if (crashed.length > 0) {
      out += `\n\n  ⚠ ${crashed.length} agent(s) from a CRASHED session are recoverable — \`/subagents resume\` respawns them:`;
      for (const a of crashed) out += `\n     ◍ ${a.claim.agentType} · \`${a.claim.scope}\` · ${a.claim.prompt}`;
    }
    return { type: 'message', level: 'info', content: out };
  },
});
