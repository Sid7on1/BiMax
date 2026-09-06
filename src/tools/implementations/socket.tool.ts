import { ToolDef, buildTool, BuiltTool } from '../tool.factory';
import { IGovernor } from '../../core/interfaces';
import { SocketRegistry, renderRows } from '../../sockets/registry';

/**
 * The model's view of the Open Socket.
 *
 * Note what this tool does NOT expose: there is no `sql`, `command` or `query` string parameter.
 * The model chooses a declared template by name and supplies typed parameters. That is the entire
 * interface, and it is why the read-only guarantee holds without a query parser — nothing the model
 * writes is ever sent as a statement.
 *
 * `isDestructive: false` is a factual claim here, not an optimistic one: every template was checked
 * to be a read at config-load time, and the Postgres connection additionally runs with
 * `default_transaction_read_only=on`, so the database itself would refuse a write.
 */
export function createSocketQueryTool(governor: IGovernor, registry: SocketRegistry): BuiltTool {
  const def: ToolDef = {
    name: 'SocketQueryTool',
    description: `Reads live records from the organisation's connected datastores (historian, maintenance database, key-value store) through pre-declared, read-only query templates.

This is retrieval only. You cannot write a query — you choose a template your operator has declared and supply its parameters. Nothing you send can modify the datastore.

# Instructions
- **Discover before you guess.** Call with \`action: "list"\` to see the available templates and their exact parameters. Inventing a template name fails; so does inventing a parameter.
- **Parameters are identifiers, not prose.** They are length-capped and often pattern-constrained (an equipment tag like \`E-204\`, a date, an enum). If a parameter is refused for length or pattern, you are trying to pass content where a key belongs — rethink which template you need.
- **Live records beat documents when they disagree.** A historian reading is what the plant actually measured; a document is what someone wrote down. If they conflict, report the conflict rather than silently preferring one.
- **No rows is an answer.** Report "no record found" plainly. Never substitute a plausible value for a missing one — a fabricated thickness reading in an engineering assessment is a safety issue.
- **Cite the source.** Say which template and datastore a figure came from, the same way you cite a document page.`,
    schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'query'],
          description: 'Use "list" to see declared templates and their parameters. Default "query".',
        },
        template: { type: 'string', description: 'Name of the declared template to run.' },
        params: {
          type: 'object',
          description: 'Parameters for the template, as declared by "list". Keys must match exactly.',
          additionalProperties: true,
        },
      },
      required: [],
    },
    isDestructive: false,
    isConcurrencySafe: true,
    execute: async (args: { action?: string; template?: string; params?: Record<string, unknown> }) => {
      if ((args.action || 'query') === 'list') {
        return await registry.describe();
      }
      if (!args.template) {
        return 'SocketQueryTool needs `template`. Call with action:"list" to see the declared templates and their parameters.';
      }
      if (!(await registry.available())) {
        return await registry.describe();
      }
      try {
        const result = await registry.call(args.template, args.params || {});
        return renderRows(result);
      } catch (error) {
        // The refusal states the actual cause. A message that only says "invalid parameter" makes a
        // model retry the same shape; one that names the constraint makes it pick another template.
        return `Socket refused: ${(error as Error).message}`;
      }
    },
  };
  return buildTool(def, governor);
}
