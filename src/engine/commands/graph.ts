import { globalCommandRegistry } from './registry';
import { ImpactEngine } from '../../graph/impact.engine';
import { GraphNode } from '../../graph/models';
import { summarizeGraph } from '../../graph/graph.summary';

function fmtNode(n: GraphNode): string {
  const crit = n.criticality ? ` [${n.criticality}]` : '';
  const where = n.filePath ? ` (${n.filePath})` : '';
  return `${n.type} ${n.name}${crit}${where}`;
}

function search(store: any, kw: string, limit = 8): GraphNode[] {
  const q = kw.toLowerCase();
  const hits: GraphNode[] = [];
  for (const n of store.getGraph().nodes.values()) {
    if (`${n.name} ${n.id} ${n.purpose || ''} ${n.filePath || ''}`.toLowerCase().includes(q)) hits.push(n);
  }
  return hits.slice(0, limit);
}

globalCommandRegistry.register({
  name: '/impact',
  description: 'Blast-radius preview for a symbol/file',
  category: 'Code & Intelligence',
  isEnabled: (ctx) => {
    if (!ctx.graphStore || ctx.graphStore.getGraph().nodes.size === 0) {
      return { enabled: false, reason: 'Requires AST Index — run /index first' };
    }
    return { enabled: true };
  },
  execute: async (args, context) => {
    const store = context.graphStore;
    if (!store || store.getGraph().nodes.size === 0) {
      return { type: 'message', level: 'error', content: 'Dependency graph is empty. Run /index first.' };
    }
    const target = args.join(' ').trim();
    if (!target) return { type: 'message', level: 'error', content: 'Usage: /impact <symbol or node id>' };

    let id = store.getNode(target) ? target : undefined;
    if (!id) {
      const hits = search(store, target);
      if (hits.length === 0) return { type: 'message', level: 'info', content: `No graph node matches "${target}".` };
      if (hits.length > 1) {
        return { type: 'message', level: 'info', content: `"${target}" is ambiguous:\n${hits.map(n => '- ' + fmtNode(n)).join('\n')}\nRe-run /impact with a node id.` };
      }
      id = hits[0].id;
    }

    const engine = new ImpactEngine(store);
    const r = engine.calculateBlastRadius(id!);
    const sev = r.totalImpactedNodes > 20 || r.highestRiskScore >= 70 ? '🔴 LARGE'
      : r.totalImpactedNodes > 5 ? '🟡 MODERATE' : '🟢 SMALL';
    return {
      type: 'message',
      level: 'info',
      content: `Blast radius for ${id} — ${sev}\n- Impacted nodes: ${r.totalImpactedNodes} (files ${r.impactedFiles}, functions ${r.impactedFunctions}, classes ${r.impactedClasses})\n- Highest downstream criticality: ${r.highestRiskScore}`
    };
  }
});

globalCommandRegistry.register({
  name: '/map',
  description: 'Top-level codebase map overview',
  category: 'Code & Intelligence',
  isEnabled: (ctx) => {
    if (!ctx.graphStore || ctx.graphStore.getGraph().nodes.size === 0) {
      return { enabled: false, reason: 'Requires AST Index — run /index first' };
    }
    return { enabled: true };
  },
  execute: async (args, context) => {
    const store = context.graphStore;
    if (!store || store.getGraph().nodes.size === 0) {
      return { type: 'message', level: 'error', content: 'Dependency graph is empty. Run /index first.' };
    }
    // The UI handles /map by displaying an interactive overlay panel.
    // This is a no-op so the engine doesn't print static text into the chat transcript.
    return { type: 'message', level: 'info', content: '' };
  }
});



globalCommandRegistry.register({
  name: '/ask',
  description: 'Ask the architecture (answered from the graph)',
  category: 'Code & Intelligence',
  isEnabled: (ctx) => {
    if (!ctx.graphStore || ctx.graphStore.getGraph().nodes.size === 0) {
      return { enabled: false, reason: 'Requires AST Index — run /index first' };
    }
    return { enabled: true };
  },
  execute: async (args, context) => {
    const store = context.graphStore;
    if (!store || store.getGraph().nodes.size === 0) {
      return { type: 'message', level: 'error', content: 'Dependency graph is empty. Run /index first.' };
    }
    const question = args.join(' ').trim();
    if (!question) return { type: 'message', level: 'error', content: 'Usage: /ask <question about the codebase architecture>' };
    // Re-enter as an agent turn, steering it to answer from the dependency graph.
    return {
      type: 'redirect',
      command: `Answer this question about the codebase architecture using GraphQueryTool (verbs: SEARCH_NODES, GET_DEPENDENTS, GET_DEPENDENCIES, BLAST_RADIUS) instead of reading files blindly. Question: ${question}`
    };
  }
});
