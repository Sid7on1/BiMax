import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openSqlite, sqliteFlavor } from '../core/sqlite';
import { createGraphStore } from '../graph/sqlite.graph.store';
import { GraphNode, GraphData } from '../graph/models';
import { EventLedger } from '../mind/event.ledger';

// P0.3 — the packaged desktop engine (bun --compile) lacked node:sqlite, so the graph + ledger
// never persisted. openSqlite() adds a bun:sqlite fallback. These tests prove (on the Node backend
// jest runs under) that persistence round-trips a "restart": write, drop the handle, reopen.

describe('openSqlite adapter', () => {
  it('resolves a real SQLite backend in this (Node) runtime', () => {
    expect(sqliteFlavor()).toBe('node'); // jest runs on Node ≥22 → node:sqlite
  });

  it('exec/prepare/get/all/run/iterate round-trip and survive reopen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgw-sqlite-'));
    const dbPath = path.join(dir, 'x.db');
    try {
      const db = openSqlite(dbPath)!;
      expect(db).toBeTruthy();
      db.exec('CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)');
      db.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').run('a', '1');
      db.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').run('b', '2');
      expect(db.prepare('SELECT v FROM kv WHERE k = ?').get('a').v).toBe('1');
      expect(db.prepare('SELECT COUNT(*) AS n FROM kv').get().n).toBe(2);
      expect([...db.prepare('SELECT k FROM kv ORDER BY k').iterate()].map((r) => r.k)).toEqual(['a', 'b']);
      db.close();

      // "Restart": a brand-new handle on the same file must see the committed rows.
      const db2 = openSqlite(dbPath)!;
      expect(db2.prepare('SELECT v FROM kv WHERE k = ?').get('b').v).toBe('2');
      expect(db2.prepare('SELECT COUNT(*) AS n FROM kv').get().n).toBe(2);
      db2.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('graph store persistence across restart', () => {
  it('saveToDisk → new store → loadFromDisk recovers nodes and edges', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bgw-graphstore-'));
    try {
      const nodes = new Map<string, GraphNode>([
        ['a.ts#Foo', { id: 'a.ts#Foo', name: 'Foo', type: 'CLASS', filePath: 'a.ts' }],
        ['a.ts#bar', { id: 'a.ts#bar', name: 'bar', type: 'FUNCTION', filePath: 'a.ts' }],
      ]);
      const store = createGraphStore(root);
      store.setGraph({ nodes, edges: [{ sourceId: 'a.ts#Foo', targetId: 'a.ts#bar', type: 'CONTAINS' }] } as GraphData);
      await store.saveToDisk();
      (store as any).close?.();

      // Fresh store on the same project root — simulates an app restart.
      const reopened = createGraphStore(root);
      await reopened.loadFromDisk();
      const g = reopened.getGraph();
      expect(g.nodes.size).toBe(2);
      expect(g.nodes.get('a.ts#Foo')?.name).toBe('Foo');
      expect(g.edges.length).toBe(1);
      expect(g.edges[0].type).toBe('CONTAINS');
      (reopened as any).close?.();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('event ledger persistence across restart', () => {
  it('reopens the hash chain with all events intact', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bgw-ledger-'));
    try {
      const ledger = new EventLedger(root);
      expect(ledger.isAvailable()).toBe(true);
      ledger.append('tool.outcome', { tool: 'Edit', ok: true });
      ledger.append('verification', { suite: 'desktop', passed: 17 });
      expect(ledger.count()).toBe(2);
      expect(ledger.verifyChain()).toEqual({ ok: true, events: 2, brokenAt: null });
      ledger.close();

      const reopened = new EventLedger(root);
      expect(reopened.count()).toBe(2);
      expect(reopened.byType('verification')[0]?.payload).toEqual({ suite: 'desktop', passed: 17 });
      expect(reopened.verifyChain()).toEqual({ ok: true, events: 2, brokenAt: null });
      reopened.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
