import { ToolDef, buildTool, BuiltTool } from '../tool.factory';
import { IGovernor } from '../../core/interfaces';
import type { CodeIndex } from '../../memory/code.index';

export type CodeIndexResolver = (cwd: string) => Promise<CodeIndex>;

export function createCodeSearchTool(
  governor: IGovernor,
  codeIndex: CodeIndex,
  resolveIndex: CodeIndexResolver = async () => codeIndex,
): BuiltTool {
  const def: ToolDef = {
    name: 'CodeSearchTool',
    description: `Intent search over the CURRENT repository's source code. Local BM25 is always available; optional user-enabled embeddings add semantic fusion and reranking. Finds exact identifiers locally and, when semantic search is enabled, can find where a BEHAVIOUR lives even when you don't know its name.

Prefer GrepTool when you know the exact token (error code, identifier, string literal) — lexical search is faster and exact. Use this when you know the INTENT but not the name.

# Instructions
- **Query in plain intent language.** The retriever ranks path, symbol name, and body together.
- **Read before editing:** results give you file + line ranges + symbol. Read that range, not the whole file.
- **Scope when useful:** \`pathPrefix\` (e.g. "src/memory") restricts to a subtree.`,
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the code does, in plain language (or an identifier you half-remember).' },
        limit: { type: 'number', description: 'Results to return (default 5).' },
        pathPrefix: { type: 'string', description: 'Optional subtree scope, e.g. "src/memory".' },
      },
      required: ['query'],
    },
    isDestructive: false,
    isConcurrencySafe: true,
    execute: async (args: { query: string; limit?: number; pathPrefix?: string }, context?: { cwd?: string }) => {
      const activeIndex = await resolveIndex(context?.cwd || process.cwd());
      const hits = await activeIndex.search(args.query, args.limit || 5, args.pathPrefix).catch(() => []);
      if (!hits.length) {
        return 'No matching code found. The index may still be syncing (first run trickles in over a minute) — try GrepTool for exact tokens.';
      }
      const mode = activeIndex.stats().lastMode;
      const pipeline = `lexical${mode.dense ? '+dense' : ''}${mode.reranked ? '+rerank' : ''}`;
      return hits
        .map((h) => {
          const related = h.related?.length
            ? `\nRelated by graph: ${h.related.join(' · ')}`
            : '';
          return `${h.path}:${h.startLine}-${h.endLine} · ${h.symbol}${related}\n\`\`\`\n${h.text.split('\n').slice(0, 12).join('\n')}\n\`\`\``;
        })
        .join('\n---\n') + `\n(${pipeline})`;
    },
  };
  return buildTool(def, governor);
}
