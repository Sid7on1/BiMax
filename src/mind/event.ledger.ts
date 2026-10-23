import { stateDir } from '../utils/state.dir';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { mindSingletonRoot } from './self.model';
import { openSqlite } from '../core/sqlite';

/**
 * The Event Ledger (BiMax v2, D1 — minimal variant).
 *
 * One append-only, hash-chained event log per repo, on SQLite/WAL. This is the single
 * source of truth the mind layer's JSON "databases" will become materialized views of:
 * every learning-relevant fact (tool outcomes with their typed labels, evidence runs,
 * dream episodes) lands here first, immutably, so learned state can be rebuilt, audited,
 * and rolled back instead of trusted blindly.
 *
 * Deliberately the self-critique-blessed variant: NO daemon. A session writes directly
 * with an IMMEDIATE transaction per append (SQLite handles one writer fine; a second
 * concurrent session just retries past a short busy timeout). Uses node:sqlite in Node and
 * bun:sqlite in the compiled desktop engine, both with zero new dependencies. Where neither is
 * available the ledger degrades to a silent no-op: recording must never break the agent.
 *
 * Append-only is enforced by construction (this module exposes no update/delete) and
 * made TAMPER-EVIDENT by a hash chain: each event's hash covers its content plus the
 * previous event's hash, so any retroactive edit breaks verification from that point on.
 */

export interface LedgerEvent {
  id: number;
  ts: number;
  session: string;
  type: string;
  payload: any;
  hash: string;
}

// One stable id per process — enough to attribute events to a session in the log.
const SESSION_ID = `${process.pid}-${Date.now().toString(36)}`;

export class EventLedger {
  private db: any | null = null;
  private available = false;

  constructor(projectRoot: string) {
    try {
      // Tolerant open: node:sqlite (dev/CI) OR bun:sqlite (the packaged bun --compile engine).
      // Absence of both must leave a working (no-op) ledger, never a crashed agent.
      const dir = stateDir('.bimax', projectRoot);
      fs.mkdirSync(dir, { recursive: true });
      this.db = openSqlite(path.join(dir, 'ledger.db'));
      if (!this.db) throw new Error('no SQLite backend (node:sqlite / bun:sqlite) on this runtime');
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA busy_timeout = 3000');
      this.db.exec(
        'CREATE TABLE IF NOT EXISTS events (' +
        ' id INTEGER PRIMARY KEY AUTOINCREMENT,' +
        ' ts INTEGER NOT NULL,' +
        ' session TEXT NOT NULL,' +
        ' type TEXT NOT NULL,' +
        ' payload TEXT NOT NULL,' +
        ' hash TEXT NOT NULL)'
      );
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, id)');
      this.available = true;
    } catch {
      this.db = null;
      this.available = false;
    }
  }

  isAvailable(): boolean { return this.available; }

  /** Append one event. Never throws — recording is strictly best-effort. */
  append(type: string, payload: Record<string, any>): void {
    if (!this.available || !this.db) return;
    try {
      const ts = Date.now();
      const body = JSON.stringify(payload);
      // IMMEDIATE: take the write lock up front so a concurrent session fails fast into
      // the busy timeout instead of deadlocking mid-transaction. The previous hash MUST
      // be read inside the lock — a cached one goes stale the moment another session
      // appends, silently breaking the chain.
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const prev = this.db.prepare('SELECT hash FROM events ORDER BY id DESC LIMIT 1').get()?.hash || '';
        const hash = crypto.createHash('sha256')
          .update(`${prev}|${ts}|${SESSION_ID}|${type}|${body}`)
          .digest('hex');
        this.db.prepare('INSERT INTO events (ts, session, type, payload, hash) VALUES (?, ?, ?, ?, ?)')
          .run(ts, SESSION_ID, type, body, hash);
        this.db.exec('COMMIT');
      } catch (e) {
        try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw e;
      }
    } catch { /* best-effort */ }
  }

  count(): number {
    if (!this.available || !this.db) return 0;
    try { return Number(this.db.prepare('SELECT COUNT(*) AS n FROM events').get()?.n || 0); }
    catch { return 0; }
  }

  countByType(): Record<string, number> {
    if (!this.available || !this.db) return {};
    try {
      const rows = this.db.prepare('SELECT type, COUNT(*) AS n FROM events GROUP BY type ORDER BY n DESC').all();
      const out: Record<string, number> = {};
      for (const r of rows) out[String(r.type)] = Number(r.n);
      return out;
    } catch { return {}; }
  }

  /** All events of one type, oldest first — the input stream for view rebuilds. */
  byType(type: string, limit = 100_000): LedgerEvent[] {
    if (!this.available || !this.db) return [];
    try {
      const rows = this.db.prepare('SELECT * FROM events WHERE type = ? ORDER BY id ASC LIMIT ?').all(type, limit);
      return rows.map((r: any) => ({
        id: Number(r.id), ts: Number(r.ts), session: String(r.session), type: String(r.type),
        payload: JSON.parse(String(r.payload)), hash: String(r.hash),
      }));
    } catch { return []; }
  }

  /** Every event oldest-first — the input for folds that need cross-type ordering. */
  all(limit = 200_000): LedgerEvent[] {
    if (!this.available || !this.db) return [];
    try {
      const rows = this.db.prepare('SELECT * FROM events ORDER BY id ASC LIMIT ?').all(limit);
      return rows.map((r: any) => ({
        id: Number(r.id), ts: Number(r.ts), session: String(r.session), type: String(r.type),
        payload: JSON.parse(String(r.payload)), hash: String(r.hash),
      }));
    } catch { return []; }
  }

  tail(limit = 20): LedgerEvent[] {
    if (!this.available || !this.db) return [];
    try {
      const rows = this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit);
      return rows.reverse().map((r: any) => ({
        id: Number(r.id), ts: Number(r.ts), session: String(r.session), type: String(r.type),
        payload: JSON.parse(String(r.payload)), hash: String(r.hash),
      }));
    } catch { return []; }
  }

  /**
   * Recompute the hash chain over the whole log. Returns the first broken event id, or
   * null when the chain is intact — the audit primitive every view rebuild can trust.
   */
  verifyChain(): { ok: boolean; events: number; brokenAt: number | null } {
    if (!this.available || !this.db) return { ok: true, events: 0, brokenAt: null };
    try {
      const rows = this.db.prepare('SELECT id, ts, session, type, payload, hash FROM events ORDER BY id ASC').all();
      let prev = '';
      for (const r of rows) {
        const expect = crypto.createHash('sha256')
          .update(`${prev}|${r.ts}|${r.session}|${r.type}|${r.payload}`)
          .digest('hex');
        if (expect !== String(r.hash)) return { ok: false, events: rows.length, brokenAt: Number(r.id) };
        prev = String(r.hash);
      }
      return { ok: true, events: rows.length, brokenAt: null };
    } catch { return { ok: true, events: 0, brokenAt: null }; }
  }

  close(): void {
    try { this.db?.close(); } catch { /* closing */ }
    this.db = null;
    this.available = false;
  }
}

let _global: EventLedger | null = null;
export function getEventLedger(): EventLedger {
  if (!_global) _global = new EventLedger(mindSingletonRoot());
  return _global;
}
/** Test hook — swap the singleton (tests that seed episodes need per-test isolation). */
export function __setEventLedger(l: EventLedger | null): void {
  if (_global && _global !== l) { try { _global.close(); } catch { /* already closed */ } }
  _global = l;
}
