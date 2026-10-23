/**
 * Uniform synchronous SQLite handle across runtimes — the P0 fix for "packaged runtime lacks
 * node:sqlite, disabling graph persistence".
 *
 * The dev/CI host runs on Node, where `node:sqlite` (the Node ≥22 builtin `DatabaseSync`) exists.
 * The PACKAGED desktop engine is a `bun --compile` binary, where `node:sqlite` does NOT exist (it's
 * a Node builtin, not a Bun one) — but Bun ships its own `bun:sqlite`. Requiring only `node:sqlite`
 * therefore left the packaged app with no persistence: an empty graph + ledger on every launch.
 *
 * openSqlite() resolves whichever backend the current runtime provides and adapts both to the tiny
 * surface the stores actually use: `exec(sql)` and `prepare(sql).{get,all,run,iterate}`.
 * Returns null only when NEITHER is available, in which case callers degrade to best-effort/in-memory
 * exactly as before — nothing regresses, persistence simply turns on where it used to be dark.
 */

export interface SqliteStatement {
  get(...params: any[]): any;
  all(...params: any[]): any[];
  run(...params: any[]): any;
  iterate(...params: any[]): IterableIterator<any>;
}

export interface SqliteDB {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export type SqliteFlavor = 'node' | 'bun' | 'none';

let _flavor: SqliteFlavor | null = null;

/** Which backend openSqlite will use on this runtime — surfaced in diagnostics so a "no persistence"
 *  state is visible instead of silent. Cached: the runtime never changes mid-process. */
export function sqliteFlavor(): SqliteFlavor {
  if (_flavor) return _flavor;
  try { require('node:sqlite'); return (_flavor = 'node'); } catch { /* not Node, or Node < 22 */ }
  try { require('bun:sqlite'); return (_flavor = 'bun'); } catch { /* not Bun */ }
  return (_flavor = 'none');
}

/** Open (creating if needed) a SQLite database, or null if this runtime has no SQLite at all. */
export function openSqlite(dbPath: string): SqliteDB | null {
  // node:sqlite first — DatabaseSync already IS the SqliteDB surface (exec / prepare→{get,all,run} / close).
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite');
    return new DatabaseSync(dbPath) as SqliteDB;
  } catch { /* fall through to bun */ }

  // bun:sqlite — wrap Bun's Database so callers see the identical node:sqlite-shaped surface.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require('bun:sqlite');
    const db = new Database(dbPath);
    return {
      exec: (sql: string) => { db.exec(sql); },
      prepare: (sql: string): SqliteStatement => {
        const st = db.prepare(sql);
        return {
          get: (...p: any[]) => st.get(...p),
          all: (...p: any[]) => st.all(...p),
          run: (...p: any[]) => st.run(...p),
          // Bun exposes iterate() today, but using all() here keeps the adapter stable across Bun
          // versions and preserves the node:sqlite contract callers depend on.
          iterate: (...p: any[]) => st.all(...p)[Symbol.iterator](),
        };
      },
      close: () => { try { db.close(); } catch { /* already closing */ } },
    };
  } catch { /* neither backend available */ }

  return null;
}
