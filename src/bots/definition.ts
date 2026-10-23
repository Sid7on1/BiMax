import { z } from 'zod';
import { createHash } from 'node:crypto';

export const BotId = z.string().uuid();
export const BotDraft = z.object({
  name: z.string().trim().min(1).max(80),
  instructions: z.string().trim().min(1).max(16_000),
  requestedTools: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,99}$/)).max(32)
    .refine(tools => new Set(tools).size === tools.length, 'Duplicate requested tool.'),
  /** This limits delegated input, not the model's actual context window. */
  handoffTokenBudget: z.number().int().min(512).max(16_000).default(4_000),
}).strict();
export const BotDefinition = BotDraft.extend({ schemaVersion: z.literal(1), id: BotId, revision: z.number().int().positive() });
export type BotDefinition = z.infer<typeof BotDefinition>;
export type BotDraftInput = z.input<typeof BotDraft>;
export const definitionHash = (definition: BotDefinition): string => createHash('sha256').update(JSON.stringify(BotDefinition.parse(definition))).digest('hex');

/** V1 is manual, bounded research. Editing, shell, nested delegation and native action need later gates. */
export const FOUNDATION_BOT_TOOLS = new Set([
  'ReadFileTool', 'GrepTool', 'GlobTool', 'WebFetchTool', 'WebSearchTool', 'MemoryQueryTool', 'RememberTool',
]);
