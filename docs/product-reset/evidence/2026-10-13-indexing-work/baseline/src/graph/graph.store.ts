import * as fs from 'fs/promises';
import * as path from 'path';
import { GraphData, GraphNode, GraphEdge, IGraphStore } from './models';
import { Logger } from '../utils';

export class GraphStore implements IGraphStore {
  private revision = 0;

  /** Changes only when the store publishes a graph mutation; used by derived-data caches. */
  public getRevision(): number { return this.revision; }
  private data: GraphData = {
    nodes: new Map(),
    edges: []
  };

  // O(1) Adjacency Lists
  private edgesFrom: Map<string, GraphEdge[]> = new Map();
  private edgesTo: Map<string, GraphEdge[]> = new Map();

  constructor(private storagePath: string) {}

  public setStoragePath(newPath: string) {
    this.storagePath = newPath;
  }

  public clear() {
    this.revision++;
    this.data = { nodes: new Map(), edges: [] };
    this.edgesFrom.clear();
    this.edgesTo.clear();
  }

  public setGraph(graph: GraphData) {
    this.revision++;
    this.data = graph;
    this.rebuildIndices();
  }

  public getGraph(): GraphData {
    return this.data;
  }

  public getNode(id: string): GraphNode | undefined {
    return this.data.nodes.get(id);
  }

  public getEdgesFrom(sourceId: string): GraphEdge[] {
    return this.edgesFrom.get(sourceId) || [];
  }

  public getEdgesTo(targetId: string): GraphEdge[] {
    return this.edgesTo.get(targetId) || [];
  }

  public addNode(node: GraphNode) {
    if (!this.data.nodes.has(node.id)) {
      this.revision++;
      this.data.nodes.set(node.id, node);
    }
  }

  public addEdge(edge: GraphEdge) {
    this.revision++;
    this.data.edges.push(edge);
    
    if (!this.edgesFrom.has(edge.sourceId)) this.edgesFrom.set(edge.sourceId, []);
    this.edgesFrom.get(edge.sourceId)!.push(edge);

    if (!this.edgesTo.has(edge.targetId)) this.edgesTo.set(edge.targetId, []);
    this.edgesTo.get(edge.targetId)!.push(edge);
  }

  public removeNode(id: string) {
    this.removeNodes([id]);
  }

  /** Remove a file/batch with one edge scan and one adjacency rebuild. */
  public removeNodes(ids: Iterable<string>): void {
    const removed = new Set(ids);
    if (removed.size === 0) return;
    this.revision++;
    for (const id of removed) this.data.nodes.delete(id);
    
    // Remove touching edges
    this.data.edges = this.data.edges.filter(e => !removed.has(e.sourceId) && !removed.has(e.targetId));
    this.rebuildIndices();
  }

  private rebuildIndices() {
    this.edgesFrom.clear();
    this.edgesTo.clear();

    for (const edge of this.data.edges) {
      if (!this.edgesFrom.has(edge.sourceId)) this.edgesFrom.set(edge.sourceId, []);
      this.edgesFrom.get(edge.sourceId)!.push(edge);

      if (!this.edgesTo.has(edge.targetId)) this.edgesTo.set(edge.targetId, []);
      this.edgesTo.get(edge.targetId)!.push(edge);
    }
  }

  public async saveToDisk(): Promise<void> {
    const rawNodes = Array.from(this.data.nodes.values());
    const rawData = {
      nodes: rawNodes,
      edges: this.data.edges
    };

    if (this.storagePath === ':memory:') return;

    const dir = path.dirname(this.storagePath);
    await fs.mkdir(dir, { recursive: true });
    
    await fs.writeFile(this.storagePath, JSON.stringify(rawData, null, 2), 'utf-8');
    Logger.info(`[GraphStore] Graph saved successfully to ${this.storagePath}`);
  }

  public async loadFromDisk(): Promise<void> {
    if (this.storagePath === ':memory:') return;

    try {
      const fileContent = await fs.readFile(this.storagePath, 'utf-8');
      const rawData = JSON.parse(fileContent);
      
      const nodesMap = new Map<string, GraphNode>();
      for (const node of rawData.nodes) {
        nodesMap.set(node.id, node);
      }
      
      this.setGraph({
        nodes: nodesMap,
        edges: rawData.edges || []
      });
      Logger.info(`[GraphStore] Graph loaded from ${this.storagePath}. Nodes: ${this.data.nodes.size}, Edges: ${this.data.edges.length}`);
    } catch (e: any) {
      if (e.code === 'ENOENT') {
        Logger.info(`[GraphStore] No existing graph found at ${this.storagePath}. Starting fresh.`);
      } else {
        Logger.error(`[GraphStore] Failed to load graph: ${e.message}`);
      }
    }
  }
}
