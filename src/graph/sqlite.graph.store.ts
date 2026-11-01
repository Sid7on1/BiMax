import { stateDir } from '../utils/state.dir';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { GraphStore } from './graph.store';
import { GraphNode, GraphEdge, IGraphStore } from './models';
import { Logger } from '../utils';
import { openSqlite } from '../core/sqlite';

/**
 * SQLite-backed graph store (v2 §3.9, honest-minimal tier).
 *
 * Queries stay in memory (the GraphStore adjacency maps — that part was never the
 * problem); what moves to SQLite is PERSISTENCE and STALENESS:
 *
 *   - `saveToDisk` writes nodes/edges in ONE transaction (atomic — a crash mid-save
 *     can no longer truncate the graph the way a half-written 10MB JSON could) and
 *     records a content hash per indexed file.
 *   - `staleFiles` compares those hashes against the working tree (mtime+size fast
 *     path, hash on suspicion), so the indexer re-parses ONLY what changed — the
 *     plan's per-file invalidation, with a flat hash table standing in for the
 *     merkle tree until repo scale demands sharding.
 *   - One-time migration: an empty DB sitting next to a legacy `playground.json`
 *     imports it on first load, then the JSON is left untouched as a fossil.
 *
 * Where node:sqlite is unavailable the caller falls back to the JSON GraphStore via
 * `createGraphStore` — same API, older durability story.
 */

interface FileState { hash: string; mtimeMs: number; ctimeMs: number; size: number }

export class SqliteGraphStore extends GraphStore implements IGraphStore {
  private db: any | null = null;
  private available = false;
  private dbPath: string;

  constructor(dbPath: string) {
    super(':memory:'); // the JSON path is never used; SQLite owns persistence
    this.dbPath = dbPath;
    try {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      // openSqlite → node:sqlite (dev/CI) or bun:sqlite (the packaged bun --compile engine). Both
      // expose the same exec/prepare surface used below; null means no SQLite on this runtime.
      this.db = openSqlite(dbPath);
      if (!this.db) throw new Error('no SQLite backend (node:sqlite / bun:sqlite) on this runtime');
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA busy_timeout = 3000');
      this.db.exec('CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, json TEXT NOT NULL)');
      this.db.exec('CREATE TABLE IF NOT EXISTS edges (source TEXT NOT NULL, target TEXT NOT NULL, type TEXT NOT NULL, json TEXT NOT NULL)');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source)');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target)');
      this.db.exec('CREATE TABLE IF NOT EXISTS file_hashes (path TEXT PRIMARY KEY, hash TEXT NOT NULL, mtime REAL NOT NULL, size INTEGER NOT NULL)');
      // Serialize the old-schema check and migration across engines sharing this database.
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (!this.db.prepare('PRAGMA table_info(file_hashes)').all().some((column: any) => column.name === 'ctime')) {
          // NULL forces one hash check for rows written by older builds.
          this.db.exec('ALTER TABLE file_hashes ADD COLUMN ctime REAL');
        }
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
      this.available = true;
    } catch (e: any) {
      Logger.warn(`[SqliteGraphStore] no compatible SQLite backend (${e?.message}); persistence disabled.`);
      this.db = null;
      this.available = false;
    }
  }

  isAvailable(): boolean { return this.available; }

  public async loadFromDisk(): Promise<void> {
    if (!this.available || !this.db) return;
    try {
      const nodeRows = this.db.prepare('SELECT json FROM nodes').all();
      if (nodeRows.length === 0 && this.importLegacyJson()) return; // migration already populated + saved
      const nodes = new Map<string, GraphNode>();
      for (const r of nodeRows) {
        const n = JSON.parse(String(r.json)) as GraphNode;
        nodes.set(n.id, n);
      }
      const edges = this.db.prepare('SELECT json FROM edges').all().map((r: any) => JSON.parse(String(r.json)) as GraphEdge);
      this.setGraph({ nodes, edges });
      Logger.info(`[SqliteGraphStore] Graph loaded from ${this.dbPath}. Nodes: ${nodes.size}, Edges: ${edges.length}`);
    } catch (e: any) {
      Logger.error(`[SqliteGraphStore] load failed: ${e.message}`);
    }
  }

  public async saveToDisk(): Promise<void> {
    if (!this.available || !this.db) return;
    try {
      const g = this.getGraph();
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec('DELETE FROM nodes');
        this.db.exec('DELETE FROM edges');
        const insN = this.db.prepare('INSERT OR REPLACE INTO nodes (id, json) VALUES (?, ?)');
        for (const n of g.nodes.values()) insN.run(n.id, JSON.stringify(n));
        const insE = this.db.prepare('INSERT INTO edges (source, target, type, json) VALUES (?, ?, ?, ?)');
        for (const e of g.edges) insE.run(e.sourceId, e.targetId, e.type, JSON.stringify(e));
        this.db.exec('COMMIT');
      } catch (e) {
        try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw e;
      }
      Logger.info(`[SqliteGraphStore] Graph saved to ${this.dbPath} (${g.nodes.size} nodes, ${g.edges.length} edges, one transaction).`);
    } catch (e: any) {
      Logger.error(`[SqliteGraphStore] save failed: ${e.message}`);
      throw e; // callers must not advance hash baselines after a failed graph commit
    }
  }

  /** The legacy JSON import (one-time): true when a playground.json was migrated in. */
  private importLegacyJson(): boolean {
    try {
      const legacy = path.join(path.dirname(this.dbPath), 'playground.json');
      if (!fs.existsSync(legacy)) return false;
      const raw = JSON.parse(fs.readFileSync(legacy, 'utf-8'));
      if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) return false;
      const nodes = new Map<string, GraphNode>();
      for (const n of raw.nodes) nodes.set(n.id, n);
      this.setGraph({ nodes, edges: raw.edges || [] });
      void this.saveToDisk();
      Logger.info(`[SqliteGraphStore] Imported legacy playground.json (${nodes.size} nodes) into ${this.dbPath}.`);
      return true;
    } catch { return false; }
  }

  private hashFile(abs: string): FileState | null {
    try {
      const st = fs.statSync(abs);
      const hash = crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex');
      const after = fs.statSync(abs);
      if (st.mtimeMs !== after.mtimeMs || st.ctimeMs !== after.ctimeMs || st.size !== after.size || st.ino !== after.ino) return null;
      return { hash, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size };
    } catch { return null; }
  }

  captureFileState(projectRoot: string, rel: string): FileState | null {
    return this.hashFile(path.isAbsolute(rel) ? rel : path.join(projectRoot, rel));
  }

  recordedFiles(): Set<string> {
    if (!this.available || !this.db) return new Set();
    return new Set(this.db.prepare('SELECT path FROM file_hashes').all().map((row: any) => String(row.path)));
  }

  /**
   * Record the content hash of every file the graph currently indexes — the staleness
   * baseline. Call after a full or partial (re)index.
   */
  recordFileHashes(projectRoot: string, onlyPaths?: string[], expected?: ReadonlyMap<string, FileState>, deleted: readonly string[] = []): number {
    if (!this.available || !this.db) return 0;
    const paths = new Set<string>();
    if (onlyPaths) {
      for (const p of onlyPaths) paths.add(p.replace(/\\/g, '/'));
    } else {
      for (const n of this.getGraph().nodes.values()) {
        if (n.filePath) paths.add(n.filePath.replace(/\\/g, '/'));
      }
    }
    let recorded = 0;
    try {
      const ins = this.db.prepare('INSERT OR REPLACE INTO file_hashes (path, hash, mtime, size, ctime) VALUES (?, ?, ?, ?, ?)');
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (!onlyPaths) this.db.exec('DELETE FROM file_hashes');
        for (const rel of deleted) this.db.prepare('DELETE FROM file_hashes WHERE path = ?').run(rel);
        for (const rel of paths) {
          const st = this.hashFile(path.isAbsolute(rel) ? rel : path.join(projectRoot, rel));
          if (expected) {
            const parsed = expected.get(rel);
            if (!st || !parsed || st.hash !== parsed.hash || st.mtimeMs !== parsed.mtimeMs || st.ctimeMs !== parsed.ctimeMs || st.size !== parsed.size) continue;
          }
          if (st) { ins.run(rel, st.hash, st.mtimeMs, st.size, st.ctimeMs); recorded++; }
        }
        this.db.exec('COMMIT');
      } catch (e) {
        try { this.db.exec('ROLLBACK'); } catch { /* rolled back */ }
        throw e;
      }
    } catch { /* staleness degrades, queries don't */ }
    return recorded;
  }

  /**
   * Which indexed files changed since their recorded hash? mtime+size short-circuits
   * the untouched majority; only suspects get re-hashed. Deleted files are reported
   * separately so the indexer can prune their nodes.
   */
  staleFiles(projectRoot: string): { changed: string[]; deleted: string[] } {
    const changed: string[] = [];
    const deleted: string[] = [];
    if (!this.available || !this.db) return { changed, deleted };
    try {
      for (const r of this.db.prepare('SELECT path, hash, mtime, size, ctime FROM file_hashes').all()) {
        const rel = String(r.path);
        const abs = path.isAbsolute(rel) ? rel : path.join(projectRoot, rel);
        let st: fs.Stats;
        try { st = fs.statSync(abs); } catch (error: any) {
          if (error.code === 'ENOENT' || error.code === 'ENOTDIR') deleted.push(rel);
          else changed.push(rel); // unavailable is not proof of deletion
          continue;
        }
        if (r.ctime !== null && st.ctimeMs === Number(r.ctime) && st.mtimeMs === Number(r.mtime) && st.size === Number(r.size)) continue;
        const now = this.hashFile(abs);
        if (!now) { changed.push(rel); continue; }
        if (now.hash !== String(r.hash)) changed.push(rel);
        else {
          // touched but identical — refresh the stat baseline so it stays a fast path
          try { this.db.prepare('UPDATE file_hashes SET mtime = ?, size = ?, ctime = ? WHERE path = ?').run(now.mtimeMs, now.size, now.ctimeMs, rel); } catch { /* cosmetic */ }
        }
      }
    } catch { /* staleness degrades, queries don't */ }
    return { changed, deleted };
  }

  /** Drop every node (and its edges) belonging to one file — the per-file invalidation. */
  removeFileNodes(relPath: string, preserveHash = false): number {
    const rel = relPath.replace(/\\/g, '/');
    const toRemove: string[] = [];
    for (const [id, n] of this.getGraph().nodes.entries()) {
      const np = (n.filePath || '').replace(/\\/g, '/');
      if (np === rel || id === `file:${rel}` || (!np && (id.endsWith(`:${rel}`) || id.startsWith(`func:${rel}:`) || id.startsWith(`class:${rel}:`)))) toRemove.push(id);
    }
    this.removeNodes(toRemove);
    if (!preserveHash && this.available && this.db) {
      try { this.db.prepare('DELETE FROM file_hashes WHERE path = ?').run(rel); } catch { /* cosmetic */ }
    }
    return toRemove.length;
  }

  close(): void {
    try { this.db?.close(); } catch { /* closing */ }
    this.db = null;
    this.available = false;
  }
}

/**
 * The factory every boot path uses: SQLite store when node:sqlite or bun:sqlite exists, legacy
 * JSON store otherwise. Same directory family, same IGraphStore, zero caller changes.
 */
export function createGraphStore(projectRoot: string): GraphStore {
  const dir = path.join(stateDir('.breakglass', projectRoot), 'graph');
  const sq = new SqliteGraphStore(path.join(dir, 'graph.db'));
  if (sq.isAvailable()) return sq;
  return new GraphStore(path.join(dir, 'playground.json'));
}
