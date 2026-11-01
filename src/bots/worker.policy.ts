import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { countTokens } from '../context/request.budget';
import type { ToolRegistry } from '../tools/tool.registry';
import { BotDefinition, BotId, definitionHash, FOUNDATION_BOT_TOOLS } from './definition';

const Assignment = z.object({
  schemaVersion: z.literal(1), runId: BotId, definition: BotDefinition,
  definitionHash: z.string().regex(/^[0-9a-f]{64}$/),
  grantedTools: z.array(z.string()).max(32),
  task: z.string().min(1).max(128_000),
  workspace: z.string(), catalogDirectory: z.string(),
  handoff: z.object({ text: z.string(), tokens: z.number().int().nonnegative(), omitted: z.number().int().nonnegative() }).strict(),
}).strict();
export type BotAssignment = z.infer<typeof Assignment>;
const inside = (root: string, file: string) => file === root || file.startsWith(root + path.sep);

export async function validateBotAssignment(input: unknown, cwd: string): Promise<BotAssignment> {
  const run = Assignment.parse(input);
  if (definitionHash(run.definition) !== run.definitionHash) throw new Error('Bot definition snapshot changed.');
  if (!path.isAbsolute(run.workspace) || !path.isAbsolute(run.catalogDirectory)) throw new Error('Bot paths must be host-owned absolute paths.');
  const workspace = await fs.realpath(run.workspace), catalog = await fs.realpath(run.catalogDirectory);
  if (await fs.realpath(cwd) !== workspace) throw new Error('Bot workspace ownership mismatch.');
  if (inside(workspace, catalog) || inside(catalog, workspace)) throw new Error('Bot workspace and private catalog must not overlap.');
  if (countTokens(run.handoff.text) !== run.handoff.tokens || run.handoff.tokens > run.definition.handoffTokenBudget) throw new Error('Bot context accounting mismatch.');
  const denied = run.definition.requestedTools.filter(name => !FOUNDATION_BOT_TOOLS.has(name) || !run.grantedTools.includes(name));
  if (denied.length) throw new Error(`Bot tools are not granted in this foundation: ${denied.join(', ')}`);
  return run;
}

export const botMemoryFile = (run: BotAssignment): string => path.join(run.catalogDirectory, 'memory', run.definition.id, 'vectors.json');

/** Narrow actual executable registry entries, not merely the advertised prompt schemas. */
export async function applyBotWorkerPolicy(run: BotAssignment, registry: ToolRegistry): Promise<void> {
  const allowed = new Set(run.definition.requestedTools);
  const missing = [...allowed].filter(name => !registry.getToolNames().includes(name));
  if (missing.length) throw new Error(`Bot requested unavailable tools: ${missing.join(', ')}`);
  for (const name of registry.getToolNames()) if (!allowed.has(name)) registry.unregister(name);
  const root = await fs.realpath(run.workspace);
  const privateRoot = await fs.realpath(run.catalogDirectory);
  for (const name of ['ReadFileTool', 'GrepTool', 'GlobTool']) {
    if (!allowed.has(name)) continue;
    const original = registry.getTool(name)!;
    registry.register({ ...original, execute: async (args: Record<string, unknown>, context?: Record<string, unknown>) => {
      const requested = args.path ?? '.';
      if (typeof requested !== 'string') throw new Error('Bot file path must be a string.');
      const target = await fs.realpath(path.resolve(root, requested));
      if (!inside(root, target) || inside(privateRoot, target)) throw new Error('Bot file request is outside its granted workspace or targets private bot storage.');
      return original.execute({ ...args, path: target }, { ...context, cwd: root });
    } });
  }
}
