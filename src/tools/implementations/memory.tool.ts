import { ToolDef, buildTool, BuiltTool } from '../tool.factory';
import { IGovernor } from '../../core/interfaces';
import { VectorStore } from '../../memory/vector.store';

export function createMemoryQueryTool(governor: IGovernor, vectorStore: VectorStore): BuiltTool {
  const def: ToolDef = {
    name: 'MemoryQueryTool',
    description: `Searches your long-term memory with the full hybrid pipeline: BM25 (exact tokens) fused with dense embeddings (paraphrase), then cross-encoder rerank. Exact identifiers AND loosely-worded concepts both match.

Use this tool when you encounter an unfamiliar error, a weird architectural pattern, or need to know how a specific problem was solved in the past.

# Instructions
- **Query Formulation:** Lead with the salient terms of the problem (e.g., \`query: "FreeCreditsTracker async-mutex race condition"\`). Exact tokens are matched lexically; paraphrases are matched semantically — plain prose works too.
- **Token Budgeting:** The memories returned by this tool are injected directly into your context window. Only query memory if you are genuinely stuck, to avoid exhausting your Short-Term Memory budget.
- **Applying Past Solutions:** If a historical memory suggests a fix, adapt it to the *current* codebase context. Do not blindly copy-paste outdated paths.`,
    schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query or concept to look for.'
        },
        limit: {
          type: 'number',
          description: 'Number of results to return (default 3).'
        }
      },
      required: ['query']
    },
    isDestructive: false,
    isConcurrencySafe: true,
    execute: async (args: { query: string; limit?: number }) => {
      const results = await vectorStore.semanticSearch(args.query, args.limit || 3);
      if (results.length === 0) {
        return "No relevant memories found in the VectorStore.";
      }
      return results.map(r => `Memory ID (Path): ${r.id}\nTags: ${r.metadata.tags.join(', ')}\nContent:\n${r.metadata.content}\n---`).join('\n');
    }
  };

  return buildTool(def, governor);
}
