import { buildTool, BuiltTool } from '../tool.factory';
import { IGovernor } from '../../core/interfaces';
import { ToolRegistry } from '../tool.registry';
import { globalMcpManager } from '../../mcp/manager';
import { engineEvents } from '../../engine/events';

/**
 * ToolSearchTool — bimax's deferred-tool loader (smart context mode).
 *
 * In smart mode only the core working-set of tools is sent to the model each turn; rarer/heavier
 * tools and every MCP tool are *deferred* — announced by name but not given full schemas. When a
 * task needs one, the model calls ToolSearchTool with a name or keyword; this resolves the matching
 * deferred tools, marks them discovered in the registry (so their real schemas are sent on the next
 * turn and become callable), and returns their definitions as text so the model sees the parameters.
 *
 * Loop prevention: when a model calls ToolSearchTool for a tool it already loaded (discovered),
 * the old response "No deferred tools matched" confused it into retrying with different keywords.
 * Now we detect this and explicitly tell the model the tool is already callable — do not retry.
 *
 * This tool is itself never deferred, and in 'full' context mode it is simply not sent.
 */
export function createToolSearchTool(governor: IGovernor, registry: ToolRegistry): BuiltTool {
  return buildTool({
    name: 'ToolSearchTool',
    description: `Load the full definition of a DEFERRED tool so you can call it.

Some tools are not sent to you up front to keep the context small — they appear by NAME only in the "LOAD-ON-DEMAND TOOLS" list (and all MCP tools are deferred). You cannot call a deferred tool until you load it here first.

Query forms:
- "select:GraphQueryTool,WebFetchTool" — load these exact tools by name.
- "search the web" / "mcp filesystem" — keyword search; the best-matching deferred tools are loaded.

After you call this, the matched tools' schemas are returned to you AND become available to call directly on your next step. Only load a deferred tool when a task actually needs it.

IMPORTANT: Do NOT call this tool more than once for the same capability. If a prior ToolSearchTool call already loaded a tool, call that tool directly — never call ToolSearchTool again for the same need.`,
    isDestructive: false,
    isConcurrencySafe: true,
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Tool name(s) via "select:Name1,Name2", or keywords describing the capability you need.' },
      },
      required: ['query'],
    },
    execute: async (args: { query: string }) => {
      const matched = registry.searchDeferred(args.query || '');

      if (matched.length > 0) {
        // Desktop/TUI snapshots expose the live ready/deferred counts. Discovery changes that
        // posture immediately, so publish once per successful load instead of leaving the shell
        // stale until an unrelated config/graph event happens.
        engineEvents.emit('tools_changed');
        const block = matched
          .map(s => `<function>${JSON.stringify({ name: s.name, description: s.description, input_schema: s.input_schema })}</function>`)
          .join('\n');
        return `Loaded ${matched.length} tool(s) — now callable directly:\n<functions>\n${block}\n</functions>`;
      }

      // Zero deferred matches. Before returning "not found", check two things that would
      // otherwise cause the model to loop endlessly with different query strings:

      // 1. Is the tool already loaded (discovered or in the core set)?
      const alreadyCallable = registry.findCallable(args.query || '');
      if (alreadyCallable.length > 0) {
        return [
          `These tools are already loaded and callable — do NOT call ToolSearchTool again for them:`,
          alreadyCallable.map(n => `  • ${n}`).join('\n'),
          ``,
          `Call one of them directly in your next step.`,
        ].join('\n');
      }

      // 2. Are there MCP servers still connecting that might provide the requested tool?
      const pending = globalMcpManager.getPendingServers();
      const pendingNote = pending.length > 0
        ? `\n\nNote: ${pending.length} MCP server(s) are still connecting (${pending.join(', ')}). If you need an MCP tool, wait one moment and try ToolSearchTool again.`
        : '';

      const available = registry.deferredSummary();
      if (available.length === 0) {
        return `No deferred tools matched "${args.query}", and none are currently deferred — the tools you already have are everything available.${pendingNote}`;
      }
      return `No deferred tools matched "${args.query}". Deferred tools you can load:\n` +
        available.map(t => `- ${t.name}: ${t.summary}`).join('\n') +
        pendingNote;
    },
  }, governor);
}
