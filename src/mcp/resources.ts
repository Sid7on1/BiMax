import { IGovernor } from '../core/interfaces';
import { buildTool, BuiltTool } from '../tools/tool.factory';
import { outcomeError, outcomeOk } from '../tools/outcome';
import { withRequestDeadline } from '../utils/request.deadline';

/** Resource adapters share the same deadline and Stop behavior as advertised MCP tools. */
export function buildMcpResourceTools(
  client: any,
  name: string,
  governor: IGovernor,
  timeoutMs: () => number,
  signalFor: (context: any) => AbortSignal,
): BuiltTool[] {
  const listName = `mcp__${name}__list_resources`;
  const readName = `mcp__${name}__read_resource`;
  const run = <T>(operation: string, context: any,
    body: (signal: AbortSignal, remainingMs: () => number) => Promise<T>) => {
    const budget = timeoutMs();
    return withRequestDeadline(budget, signalFor(context),
      () => new Error(`MCP '${name}' ${operation} timed out after ${budget}ms`), body);
  };
  return [
    buildTool({
      name: listName,
      description: `[MCP:${name}] List the resources (documents, files, records) this server can provide, with their URIs. Read one with ${readName}.`,
      schema: { type: 'object', properties: { cursor: { type: 'string', description: 'Pagination cursor from a previous call' } } },
      isDestructive: true,
      execute: async (args: any, context?: any) => run('resources/list', context, async (signal, remainingMs) => {
        const res = await client.listResources(args?.cursor ? { cursor: String(args.cursor) } : undefined,
          { signal, timeout: remainingMs() });
        remainingMs();
        const lines = (res?.resources || []).map((r: any) => `${r.uri} — ${r.name || r.title || ''}${r.mimeType ? ` (${r.mimeType})` : ''}${r.description ? ` — ${r.description}` : ''}`);
        let templates: string[] = [];
        try {
          const budget = Math.min(10_000, remainingMs());
          const listed = await withRequestDeadline<any>(budget, signal,
            () => new Error(`MCP '${name}' resources/templates/list timed out after ${budget}ms`),
            (templateSignal, templateRemaining) => client.listResourceTemplates(undefined,
              { signal: templateSignal, timeout: templateRemaining() }));
          templates = (listed?.resourceTemplates || []).map((r: any) => `${r.uriTemplate} — ${r.name || ''}${r.description ? ` — ${r.description}` : ''}`);
        } catch {
          // Templates are optional; Stop and the enclosing deadline are never optional.
          remainingMs();
        }
        remainingMs();
        return outcomeOk([
          lines.length ? lines.join('\n') : 'No resources listed.',
          templates.length ? `\nURI templates (fill in the {placeholders}):\n${templates.join('\n')}` : '',
          res?.nextCursor ? `\nMore: call again with cursor "${res.nextCursor}".` : '',
        ].join(''));
      }),
    }, governor),
    buildTool({
      name: readName,
      description: `[MCP:${name}] Read one resource by its URI (from ${listName}).`,
      schema: { type: 'object', properties: { uri: { type: 'string', description: 'The resource URI' } }, required: ['uri'] },
      isDestructive: true,
      execute: async (args: any, context?: any) => {
        const uri = String(args?.uri || '');
        if (!uri) return outcomeError('invalid_args', 'uri is required');
        return run('resources/read', context, async (signal, remainingMs) => {
          const res = await client.readResource({ uri }, { signal, timeout: remainingMs() });
          remainingMs();
          const parts = (res?.contents || []).map((c: any) => typeof c.text === 'string'
            ? c.text
            : `[binary ${c.mimeType || 'content'}, ${Math.round(String(c.blob || '').length * 0.75)} bytes — not shown as text]`);
          return outcomeOk(parts.join('\n') || '(empty resource)');
        });
      },
    }, governor),
  ];
}
