import { IGraphStore, GraphNode, GraphEdge } from './models';

export interface BlastRadiusReport {
  targetNodeId: string;
  totalImpactedNodes: number;
  impactedFiles: number;
  impactedFunctions: number;
  impactedClasses: number;
  highestRiskScore: number;
  criticalPath: string[]; // Just an example path showing the deepest connection
}

export interface IImpactEngine {
  getForwardDependencies(startNodeId: string, maxDepth?: number): GraphNode[];
  getReverseDependencies(startNodeId: string, maxDepth?: number): GraphNode[];
  calculateBlastRadius(targetNodeId: string): BlastRadiusReport;
  getAllPaths(startNodeId: string, endNodeId: string, maxDepth?: number): GraphNode[][];
  getDataFlow(variableId: string): GraphNode[];
  clearCache(): void;
}

export class ImpactEngine implements IImpactEngine {
  private blastRadiusCache: Map<string, BlastRadiusReport> = new Map();

  constructor(private store: IGraphStore) {}

  public clearCache(): void {
    this.blastRadiusCache.clear();
  }

  /**
   * Forward Dependency Lookup: "What does this node depend on?"
   * (Follow outgoing edges like CALLS, IMPORTS)
   */
  public getForwardDependencies(startNodeId: string, maxDepth: number = 3): GraphNode[] {
    return this.traverse(startNodeId, maxDepth, 'forward');
  }

  /**
   * Reverse Dependency Lookup: "Who depends on this node?"
   * (Follow incoming edges)
   */
  public getReverseDependencies(startNodeId: string, maxDepth: number = 3): GraphNode[] {
    return this.traverse(startNodeId, maxDepth, 'reverse');
  }

  /**
   * Calculate Blast Radius for modifying a specific node
   */
  public calculateBlastRadius(targetNodeId: string): BlastRadiusReport {
    const targetNode = this.store.getNode(targetNodeId);
    if (!targetNode) {
      throw new Error(`Node ${targetNodeId} not found in graph.`);
    }

    if (this.blastRadiusCache.has(targetNodeId)) {
      return this.blastRadiusCache.get(targetNodeId)!;
    }

    const impactedNodes = this.getReverseDependencies(targetNodeId, 5); // Default deep search

    let files = 0;
    let functions = 0;
    let classes = 0;
    let maxRisk = 0;

    for (const node of impactedNodes) {
      if (node.type === 'FILE') files++;
      if (node.type === 'FUNCTION') functions++;
      if (node.type === 'CLASS') classes++;
      
      // riskScore is a top-level GraphNode field (set by the semantic augmenter); the older
      // metadata.riskScore path was always undefined, so highestRiskScore was silently always 0.
      const riskScore = node.riskScore ?? (node as any).metadata?.riskScore ?? 0;
      if (riskScore > maxRisk) {
        maxRisk = riskScore;
      }
    }

    const report: BlastRadiusReport = {
      targetNodeId,
      totalImpactedNodes: impactedNodes.length,
      impactedFiles: files,
      impactedFunctions: functions,
      impactedClasses: classes,
      highestRiskScore: maxRisk,
      criticalPath: impactedNodes.map(n => n.id).slice(0, 3) // Simplified critical path for MVP
    };

    this.blastRadiusCache.set(targetNodeId, report);
    return report;
  }

  /**
   * Standard BFS Traversal
   */
  private traverse(startNodeId: string, maxDepth: number, direction: 'forward' | 'reverse'): GraphNode[] {
    const visited = new Set<string>();
    const result: GraphNode[] = [];
    const queue: { id: string, depth: number }[] = [{ id: startNodeId, depth: 0 }];

    visited.add(startNodeId);

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth) continue;

      const edges = direction === 'forward' 
        ? this.store.getEdgesFrom(current.id)
        : this.store.getEdgesTo(current.id);

      for (const edge of edges) {
        const nextId = direction === 'forward' ? edge.targetId : edge.sourceId;

        if (!visited.has(nextId)) {
          visited.add(nextId);
          const nextNode = this.store.getNode(nextId);
          if (nextNode) {
            result.push(nextNode);
            queue.push({ id: nextId, depth: current.depth + 1 });
          }
        }
      }
    }

    return result;
  }

  /**
   * SHOW_ALL_PATHS: Find all paths between two nodes using DFS
   */
  public getAllPaths(startNodeId: string, endNodeId: string, maxDepth: number = 5): GraphNode[][] {
    const paths: GraphNode[][] = [];
    
    const dfs = (currentId: string, currentPath: GraphNode[], depth: number, visited: Set<string>) => {
      if (depth > maxDepth) return;
      if (currentId === endNodeId) {
        paths.push([...currentPath]);
        return;
      }
      
      const edges = this.store.getEdgesFrom(currentId);
      for (const edge of edges) {
        if (!visited.has(edge.targetId)) {
          visited.add(edge.targetId);
          const nextNode = this.store.getNode(edge.targetId);
          if (nextNode) {
            currentPath.push(nextNode);
            dfs(edge.targetId, currentPath, depth + 1, visited);
            currentPath.pop();
          }
          visited.delete(edge.targetId);
        }
      }
    };

    const startNode = this.store.getNode(startNodeId);
    if (startNode) {
      dfs(startNodeId, [startNode], 0, new Set([startNodeId]));
    }
    
    return paths;
  }

  /**
   * SHOW_DATA_FLOW: Traces where a variable flows
   */
  public getDataFlow(variableId: string): GraphNode[] {
    const node = this.store.getNode(variableId);
    if (!node || node.type !== 'VARIABLE') {
      throw new Error(`Node ${variableId} is not a valid VARIABLE.`);
    }
    // We get all statements or blocks that USE this variable
    const edges = this.store.getEdgesTo(variableId).filter(e => e.type === 'USES_VARIABLE');
    const flowNodes = edges.map(e => this.store.getNode(e.sourceId)).filter(Boolean) as GraphNode[];
    return flowNodes;
  }
}
