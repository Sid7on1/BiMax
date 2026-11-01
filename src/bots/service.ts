import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BotCatalog } from './catalog';
import { compileBotContext, type BotContextInput } from './context';
import { definitionHash } from './definition';
import { validateBotAssignment, type BotAssignment } from './worker.policy';
import { globalSubAgentManager, type SubAgentConfig, type SubAgentManager } from '../core/subagent.manager';
import { activeRunBudget, createRunBudget, inRunBudget } from '../core/run.budget';

export interface BotHostAuthority {
  workspace: string;
  /** Supplied by the trusted invoking host, never by a bot definition or retrieved text. */
  grantedTools: string[];
  parentMode: string;
  handoffTokenBudget: number;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}

/** Development kernel API; the app does not expose it to renderer/model tool calls yet. */
export class BotService {
  constructor(readonly catalog: BotCatalog, private readonly manager: Pick<SubAgentManager, 'spawnWorker' | 'killWorker'> = globalSubAgentManager) {}

  async prepare(id: string, context: BotContextInput, authority: BotHostAuthority): Promise<SubAgentConfig> {
    const definition = await this.catalog.get(id);
    const handoff = compileBotContext(definition, context, authority.handoffTokenBudget);
    const workspace = await fs.realpath(authority.workspace);
    const botRun: BotAssignment = await validateBotAssignment({
      schemaVersion: 1, runId: randomUUID(), definition, definitionHash: definitionHash(definition),
      task: context.task,
      grantedTools: [...authority.grantedTools], workspace, catalogDirectory: await fs.realpath(this.catalog.directory),
      handoff: { text: handoff.text, tokens: handoff.tokens, omitted: handoff.omitted },
    }, workspace);
    return freeze({ agentType: 'BiMax', prompt: handoff.text, cwd: workspace, parentMode: authority.parentMode,
      scope: workspace, depth: 1, botRun,
      // Desktop's machine ledger wins. The development API shares one catalog-wide fallback,
      // so choosing a different bot or workspace cannot allocate a fresh pool per profile.
      capacityPath: process.env.BIMAX_AGENT_CAPACITY_PATH || path.join(this.catalog.directory, 'worker-capacity.json'),
      capacityRunId: process.env.BIMAX_AGENT_RUN_ID || `bot-run-${botRun.runId}`,
    });
  }

  async run(id: string, context: BotContextInput, authority: BotHostAuthority, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const config = await this.prepare(id, context, authority);
    signal?.throwIfAborted();
    const taskId = `bot-run-${config.botRun!.runId}`;
    const abort = () => this.manager.killWorker(taskId);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      // Existing manager owns the machine CPU lease, shared run budget and worker lifetime.
      const budget = activeRunBudget() ?? createRunBudget();
      const result = await inRunBudget(budget, () => this.manager.spawnWorker(taskId, { ...config }));
      signal?.throwIfAborted();
      return { botId: id, revision: config.botRun!.definition.revision, runId: config.botRun!.runId, result };
    } catch (error) {
      signal?.throwIfAborted();
      throw error;
    } finally { signal?.removeEventListener('abort', abort); }
  }
}
