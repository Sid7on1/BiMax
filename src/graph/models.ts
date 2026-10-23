export type NodeType = 'PROJECT' | 'DIRECTORY' | 'FILE' | 'CLASS' | 'FUNCTION' | 'INTERFACE' | 'UNKNOWN' | 'FOLDER' | 'BLOCK' | 'STATEMENT' | 'VARIABLE' | 'EVENT' | 'GOAL' | 'TASK' | 'SUBTASK' | 'CAPABILITY';
export type EdgeType = 'CONTAINS' | 'IMPORTS' | 'CALLS' | 'IMPLEMENTS' | 'EXTENDS' | 'USES_VARIABLE' | 'DECLARES_VARIABLE' | 'SUBSCRIBES_TO' | 'PUBLISHES_TO' | 'SPAWNS' | 'SATISFIES' | 'REQUIRES';

export interface GraphNode {
  id: string; // Unique identifier, typically absolute path + symbol name
  name: string;
  type: NodeType;
  filePath?: string; // Where this node lives

  // Source location (1-based, inclusive). Populated by the static analyzers so the agent
  // can read just this symbol's source instead of the whole file. Optional for backward
  // compatibility: graphs serialized before this existed simply lack the fields until
  // they are re-indexed.
  startLine?: number;
  endLine?: number;
  signature?: string; // The declaration's first line (e.g. `function foo(a: number): void`)

  // Semantic Metadata (Populated by LLM in Phase 2)
  purpose?: string;
  criticality?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  riskScore?: number; // 0-100
}

export interface GraphEdge {
  sourceId: string;
  targetId: string;
  type: EdgeType;
  metadata?: Record<string, any>;
}

export interface GraphData {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[]; // Keeping raw edges for serialization
}

export interface IGraphStore {
  /** Monotonic local mutation revision, when supported by the store. */
  getRevision?(): number;
  setGraph(graph: GraphData): void;
  getGraph(): GraphData;
  getNode(id: string): GraphNode | undefined;
  getEdgesFrom(nodeId: string): GraphEdge[];
  getEdgesTo(nodeId: string): GraphEdge[];
  addNode(node: GraphNode): void;
  removeNode(id: string): void;
  addEdge(edge: GraphEdge): void;
  saveToDisk(): Promise<void>;
  loadFromDisk(): Promise<void>;
  clear(): void;
  setStoragePath(newPath: string): void;
}
