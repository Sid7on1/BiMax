import * as net from 'net';
import { RedisAdapter, PostgresAdapter, assertReadOnly, SocketQueryError } from '../sockets/adapters';
import { SocketRegistry } from '../sockets/registry';
import { QueryTemplate, ConnectorConfig } from '../sockets/contract';

/**
 * The Open Socket against REAL servers.
 *
 * The gate tests prove what may be sent; the wire tests prove the framing against a scripted
 * socket. Neither proves the thing an operator actually cares about: that a real Redis and a real
 * PostgreSQL answer these templates, and that the read-only guarantee holds when the *server* is the
 * one enforcing it rather than our own checks.
 *
 * ## How this stays honest in CI
 *
 * These are SKIPPED, not failed, when no server is listening — CI has neither, and a suite that goes
 * red on a missing optional dependency trains people to ignore red. The skip is reported by name so
 * "0 live tests ran" can never be mistaken for "live tests passed", which is the failure mode this
 * repo has hit before with silently-degraded stages.
 *
 * ## To run them
 *
 *     brew install redis postgresql@16
 *     redis-server --daemonize yes
 *     brew services start postgresql@16
 *     bash scripts/seed-socket-fixtures.sh
 *
 * Overridable with BIMAX_TEST_REDIS_PORT / BIMAX_TEST_PG_* if your instances live elsewhere.
 */

const REDIS_PORT = Number(process.env.BIMAX_TEST_REDIS_PORT || 6379);
const REDIS_DB = Number(process.env.BIMAX_TEST_REDIS_DB || 9);
const PG_PORT = Number(process.env.BIMAX_TEST_PG_PORT || 5432);
const PG_DB = process.env.BIMAX_TEST_PG_DB || 'bimax_socket_test';
const PG_USER = process.env.BIMAX_TEST_PG_USER || process.env.USER || '';

/** Is something accepting connections on this port? Cheap, and never throws. */
function portOpen(port: number, timeoutMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
  });
}

let redisUp = false;
let pgUp = false;

beforeAll(async () => {
  redisUp = await portOpen(REDIS_PORT);
  pgUp = await portOpen(PG_PORT);
  if (!redisUp) console.warn(`[socket.live] SKIPPING Redis tests — nothing listening on 127.0.0.1:${REDIS_PORT}`);
  if (!pgUp) console.warn(`[socket.live] SKIPPING Postgres tests — nothing listening on 127.0.0.1:${PG_PORT}`);
});

const redisConnector: ConnectorConfig = {
  name: 'cache', kind: 'redis', host: '127.0.0.1', port: REDIS_PORT,
  // The seeded logical database. Exercising a NON-ZERO db on purpose: db 0 would have passed even
  // while `database` was being ignored entirely.
  database: String(REDIS_DB), timeoutMs: 5_000,
};
const pgConnector: ConnectorConfig = {
  name: 'historian', kind: 'postgres', host: '127.0.0.1', port: PG_PORT,
  database: PG_DB, user: PG_USER, timeoutMs: 8_000,
};

const template = (over: Partial<QueryTemplate>): QueryTemplate => ({
  name: 't', description: 'test', connector: 'cache', statement: '', params: [], ...over,
});

/** Redis templates must select the seeded database before reading it. */
const redisTemplate = (statement: string, over: Partial<QueryTemplate> = {}): QueryTemplate =>
  template({ statement, connector: 'cache', ...over });

describe('Redis, against a real server', () => {
  it('reads a hash the way a historian cache would store one', async () => {
    if (!redisUp) return;
    const adapter = new RedisAdapter({ ...redisConnector });
    const result = await adapter.query(
      redisTemplate('HGETALL reading:$1', {
        params: [{ name: 'tag', type: 'string', pattern: '^[A-Z]{2}-\\d{3}$' }],
      }),
      ['PT-101'],
    );
    // A real HGETALL returns a flat [field, value, field, value…] array.
    const flat = result.rows.map((row) => String(row.value));
    expect(flat.length).toBeGreaterThan(0);
    expect(flat).toContain('PT-101');
    expect(flat).toContain('4.2');
  });

  it('reads a list, in order', async () => {
    if (!redisUp) return;
    const adapter = new RedisAdapter({ ...redisConnector });
    const result = await adapter.query(
      redisTemplate('LRANGE history:$1 0 -1', {
        params: [{ name: 'tag', type: 'string', pattern: '^[A-Z]-\\d{3}$' }],
      }),
      ['E-204'],
    );
    expect(result.rows.map((row) => String(row.value))).toEqual(['8.6', '8.1', '7.8']);
  });

  it('reads a plain key and reports a missing one as no rows', async () => {
    if (!redisUp) return;
    const adapter = new RedisAdapter({ ...redisConnector });
    const spec = { name: 'tag', type: 'string' as const, pattern: '^[A-Z]-\\d{3}$' };

    const present = await adapter.query(redisTemplate('GET note:$1', { params: [spec] }), ['E-204']);
    expect(String(present.rows[0]?.value)).toContain('engineering assessment');

    // "no record" must be an empty result, not an empty string that reads like a real answer.
    const absent = await adapter.query(redisTemplate('GET note:$1', { params: [spec] }), ['V-999']);
    expect(absent.rows).toEqual([]);
    expect(absent.rowCount).toBe(0);
  });

  it('substitutes an embedded placeholder — the bug the scripted tests caught', async () => {
    if (!redisUp) return;
    // `reading:$1` is not a bare `$1` token. An earlier implementation only replaced a token equal
    // to the placeholder, so the literal text "reading:$1" went to the server and returned nothing.
    // Against a real Redis that failure looks exactly like "no such key".
    const adapter = new RedisAdapter({ ...redisConnector });
    const result = await adapter.query(
      redisTemplate('HGET reading:$1 pressure_bar', {
        params: [{ name: 'tag', type: 'string', pattern: '^[A-Z]{2}-\\d{3}$' }],
      }),
      ['PT-101'],
    );
    expect(String(result.rows[0]?.value)).toBe('4.2');
  });
});

describe('PostgreSQL, against a real server', () => {
  const historyTemplate = template({
    name: 'equipment_history',
    connector: 'historian',
    statement: 'SELECT equipment_tag, thickness_mm, inspected_on FROM inspections '
      + 'WHERE equipment_tag = $1 ORDER BY inspected_on DESC',
    params: [{ name: 'tag', type: 'string', pattern: '^[A-Z]{1,2}-\\d{3}[A-Z]?$' }],
  });

  it('runs a parameterised read and returns typed rows', async () => {
    if (!pgUp) return;
    const adapter = new PostgresAdapter(pgConnector);
    try {
      const result = await adapter.query(historyTemplate, ['E-204']);
      expect(result.rowCount).toBe(3);
      // Newest first, and the numbers survive the wire as comparable values.
      expect(result.rows.map((row) => Number(row.thickness_mm))).toEqual([7.8, 8.1, 8.6]);
      expect(result.rows.every((row) => row.equipment_tag === 'E-204')).toBe(true);
    } finally { await adapter.close(); }
  });

  it('binds the parameter rather than interpolating it', async () => {
    if (!pgUp) return;
    const adapter = new PostgresAdapter(pgConnector);
    try {
      // A value that would be catastrophic if concatenated. It must simply match nothing.
      const result = await adapter.query(historyTemplate, ["E-204' OR '1'='1"]);
      expect(result.rowCount).toBe(0);
      // And the table is still intact afterwards.
      const after = await adapter.query(historyTemplate, ['E-204']);
      expect(after.rowCount).toBe(3);
    } finally { await adapter.close(); }
  });

  it('the SERVER refuses a write, not merely our own checks', async () => {
    if (!pgUp) return;
    // The layer that matters when the statement linter is wrong. The connection is opened with
    // default_transaction_read_only=on, so PostgreSQL itself rejects this even though the adapter
    // was handed a write it would normally never receive.
    const adapter = new PostgresAdapter(pgConnector);
    try {
      const write = template({
        name: 'malicious', connector: 'historian',
        statement: "INSERT INTO inspections (equipment_tag, thickness_mm, inspected_on) VALUES ($1, 1.0, '2026-01-01')",
        params: [{ name: 'tag', type: 'string' }],
      });
      await expect(adapter.query(write, ['X-001'])).rejects.toThrow(/read-only|cannot execute/i);
    } finally { await adapter.close(); }
  });

  it('enforces the row cap against a real result set', async () => {
    if (!pgUp) return;
    const adapter = new PostgresAdapter(pgConnector);
    try {
      const all = template({
        name: 'all', connector: 'historian',
        statement: 'SELECT equipment_tag, thickness_mm FROM inspections ORDER BY id',
        params: [], maxRows: 2,
      });
      const result = await adapter.query(all, []);
      expect(result.rowCount).toBe(2);
      expect(result.truncated).toBe(true);
    } finally { await adapter.close(); }
  });

  it('the config linter still refuses that write before it could ever run', () => {
    // Defence in depth, stated as a test: the server refusal above is the LAST line, not the first.
    const write = template({
      name: 'malicious', connector: 'historian',
      statement: 'INSERT INTO inspections VALUES (1)', params: [],
    });
    expect(() => assertReadOnly(write, 'postgres')).toThrow(SocketQueryError);
  });
});

describe('end to end through the registry, with the ledger', () => {
  it('runs a declared template and records the call', async () => {
    if (!pgUp) return;
    const { readFileSync, writeFileSync, mkdtempSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const dir = mkdtempSync(join(tmpdir(), 'socket-live-'));
    const configPath = join(dir, 'sockets.json');
    writeFileSync(configPath, JSON.stringify({
      connectors: [{
        name: 'historian', kind: 'postgres', host: '127.0.0.1', port: PG_PORT,
        database: PG_DB, user: PG_USER, timeoutMs: 8000,
      }],
      templates: [{
        name: 'equipment_history',
        description: 'Inspection history for one equipment tag',
        connector: 'historian',
        statement: 'SELECT equipment_tag, thickness_mm, inspected_on FROM inspections WHERE equipment_tag = $1 ORDER BY inspected_on DESC',
        params: [{ name: 'tag', type: 'string', pattern: '^[A-Z]{1,2}-\\d{3}[A-Z]?$', maxLength: 8 }],
        maxRows: 50,
      }],
    }));

    const ledger = join(dir, 'egress.ledger');
    const previous = process.env.BIMAX_EGRESS_LEDGER;
    process.env.BIMAX_EGRESS_LEDGER = ledger;

    const registry = new SocketRegistry(configPath);
    try {
      const result = await registry.call('equipment_history', { tag: 'E-204' });
      expect(result.rowCount).toBe(3);

      // "What did this thing ever send?" must be answerable exactly.
      const written = readFileSync(ledger, 'utf8');
      expect(written).toContain('OpenSocket');
      expect(written).toContain('equipment_history');
      expect(written).toContain('E-204');

      // An undeclared template is refused before any connection is opened.
      await expect(registry.call('drop_everything', {})).rejects.toThrow(/no such query template/);
      // And a parameter that breaks its pattern never reaches the server.
      await expect(registry.call('equipment_history', { tag: 'not a tag at all' }))
        .rejects.toThrow(/permitted form|characters/);
    } finally {
      await registry.close();
      if (previous === undefined) delete process.env.BIMAX_EGRESS_LEDGER;
      else process.env.BIMAX_EGRESS_LEDGER = previous;
    }
  });
});
