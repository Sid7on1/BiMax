import { GraphData, IGraphStore } from './models';

/** Publish one complete file replacement, retaining incoming edges to surviving symbols. */
export function publishFileGraph(store: IGraphStore, rel: string, replacement: GraphData): void {
  const previous = store.getGraph();
  const owned = new Set([...previous.nodes].filter(([id, node]) => node.filePath === rel || id === `file:${rel}`).map(([id]) => id));
  const nodes = new Map(previous.nodes);
  for (const id of owned) nodes.delete(id);
  // Shared EVENT nodes retain metadata from the current graph.
  for (const [id, node] of replacement.nodes) if (!nodes.has(id)) nodes.set(id, node);
  const edges = previous.edges.filter(edge => !owned.has(edge.sourceId)
    && (!owned.has(edge.targetId) || replacement.nodes.has(edge.targetId)));
  store.setGraph({ nodes, edges: [...edges, ...replacement.edges] });
}
