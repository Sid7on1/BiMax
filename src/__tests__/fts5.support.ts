/**
 * Does THIS runtime's SQLite have the FTS5 extension?
 *
 * Not a detail — it decides whether lexical retrieval exists at all. `SqliteCodeVectorStore` needs
 * FTS5 for its BM25 half, and without it the store reports "unavailable … the code index will be
 * empty this session" and every corpus search returns nothing.
 *
 * Measured 2026-09-18, all three runtimes this project uses:
 *
 *   plain Node 22.13 (what jest runs on)   FTS5 MISSING   — `node:sqlite` is built without it
 *   bun                                    FTS5 available — `bun:sqlite` ships it
 *   Electron's Node (what the engine runs) FTS5 available — verified with a real MATCH query
 *
 * So retrieval works in the product, in development and packaged, and cannot work under jest. Tests
 * that need it were therefore failing for an environment reason while the code was fine — and four
 * of them sat red long enough to become background noise, which is how a real failure gets missed.
 * They skip with a stated reason instead.
 *
 * This is NOT a licence to skip a test that is merely inconvenient. It is narrow on purpose: the one
 * condition checked is a missing SQLite extension, verified by actually creating a virtual table
 * rather than sniffing a version string.
 */
export function hasFts5(): boolean {
  try {
    // Untyped on purpose: @types/node is pinned at ^20 here, which has no `node:sqlite`
    // declarations, so `typeof import('node:sqlite')` does not compile. src/core/sqlite.ts requires
    // it the same untyped way for the same reason. Note tsc did NOT catch that — tsconfig excludes
    // __tests__, so ts-jest is the only thing typechecking this file.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void } };
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE VIRTUAL TABLE __fts5_probe USING fts5(x)');
      return true;
    } finally {
      try { db.close(); } catch { /* probe db, nothing to salvage */ }
    }
  } catch {
    return false;
  }
}

export const FTS5 = hasFts5();

/**
 * `describe`/`it` when FTS5 exists, the `.skip` form otherwise. Jest reports these as skipped, and
 * the note below says why once per run so a skip is never mistaken for a pass.
 *
 * Applied per TEST rather than per suite wherever a suite has tests that do not touch retrieval —
 * skipping a whole block to silence four failures would take five working tests down with them.
 */
export const describeWithFts5: jest.Describe = FTS5 ? describe : describe.skip;
export const itWithFts5: jest.It = FTS5 ? it : it.skip;
export const testWithFts5: jest.It = FTS5 ? test : test.skip;

if (!FTS5) {
  // eslint-disable-next-line no-console
  console.warn(
    '[fts5] skipping retrieval tests: this runtime\'s node:sqlite has no FTS5, so lexical search '
    + 'cannot work here. The engine runs on Electron\'s Node, which does have it — verified in '
    + 'src/__tests__/fts5.support.ts.',
  );
}
