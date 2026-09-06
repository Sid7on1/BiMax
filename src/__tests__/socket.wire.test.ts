import * as net from 'net';
import { RedisAdapter, PostgresAdapter, SocketQueryError } from '../sockets/adapters';
import { QueryTemplate, ConnectorConfig } from '../sockets/contract';

/**
 * The socket WIRE path, against a real TCP server.
 *
 * The gate tests (`socket.gate.test.ts`) prove what may be sent. These prove what actually goes on
 * the wire and comes back off it, which is a different risk: the RESP encoder and parser here are
 * hand-written, and a protocol reader that is subtly wrong fails in the worst way — it returns
 * plausible data for the wrong request.
 *
 * A real `net.Server` is used rather than a mocked socket, because the bugs worth catching in a
 * stream parser are the ones a mock hides: a reply split across two TCP packets, a bulk string
 * whose declared length spans a chunk boundary, a nested array. All three are exercised below.
 *
 * Postgres is a different case and is treated differently. Its wire protocol belongs to `pg`, not to
 * this codebase, so re-testing it would grade someone else's library. What IS ours — the read-only
 * connection options, the row cap, error mapping — is tested against an injected client.
 */

/**
 * A scriptable Redis server.
 *
 * It counts the RESP commands in what it receives and emits exactly one scripted reply per command,
 * because the adapter PIPELINES (it writes AUTH and the query back to back, and TCP is free to
 * deliver both in a single read). A server that answered per data-event rather than per command
 * would deadlock against correct client behaviour — which is a bug in the test, not the client.
 *
 * `chunkEvery` splits each reply into small writes with a tick between them, which is what forces
 * the stream parser to handle a value straddling a packet boundary instead of getting lucky.
 */
function respServer(replies: string[], chunkEvery?: number): Promise<{
  port: number; received: string[]; close: () => Promise<void>;
}> {
  const received: string[] = [];
  let sent = 0;
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        received.push(text);
        // Commands are RESP arrays; count the '*<n>\r\n' headers at the start of each.
        const commands = (text.match(/\*\d+\r\n/g) || []).length || 1;
        for (let i = 0; i < commands; i++) {
          const reply = replies[Math.min(sent++, replies.length - 1)];
          if (reply === undefined) continue;
          if (!chunkEvery) { socket.write(reply); continue; }
          let cursor = 0;
          const pump = (): void => {
            if (cursor >= reply.length) return;
            socket.write(reply.slice(cursor, cursor + chunkEvery));
            cursor += chunkEvery;
            setImmediate(pump);
          };
          pump();
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port, received,
        close: () => new Promise<void>((done) => { server.close(() => done()); }),
      });
    });
  });
}

const connector = (port: number, over: Partial<ConnectorConfig> = {}): ConnectorConfig => ({
  name: 'cache', kind: 'redis', host: '127.0.0.1', port, timeoutMs: 4_000, ...over,
});

const template = (statement: string, over: Partial<QueryTemplate> = {}): QueryTemplate => ({
  name: 'latest_reading', description: 'test', connector: 'cache', statement,
  params: [{ name: 'tag', type: 'string', pattern: '^[A-Z]{2}-\\d{3}$', maxLength: 8 }],
  ...over,
});

describe('Redis: what actually goes on the wire', () => {
  it('sends a correctly framed RESP array and reads a bulk-string reply', async () => {
    const server = await respServer(['$5\r\n7.8mm\r\n']);
    try {
      const adapter = new RedisAdapter(connector(server.port));
      const result = await adapter.query(template('GET reading:$1'), ['PT-101']);
      expect(result.rows).toEqual([{ index: 0, value: '7.8mm' }]);

      // The command must be one RESP array of two bulk strings — not a plain-text command line.
      const sent = server.received.join('');
      expect(sent).toBe('*2\r\n$3\r\nGET\r\n$12\r\nreading:PT-101\r\n'.replace('$12', '$14'));
    } finally { await server.close(); }
  });

  it('substitutes a parameter into an ARGUMENT SLOT, so a space cannot become a second argument', async () => {
    // The injection shape for a text protocol: if `$1` were pasted into the command line as text,
    // a value with a space would split into extra argv entries and change the command.
    const server = await respServer(['$2\r\nok\r\n']);
    try {
      const adapter = new RedisAdapter(connector(server.port));
      const loose = template('GET reading:$1', {
        params: [{ name: 'tag', type: 'string', maxLength: 64 }],
      });
      await adapter.query(loose, ['A B']);
      const sent = server.received.join('');
      // Two arguments, and the second is the whole value including its space.
      expect(sent).toContain('*2\r\n');
      expect(sent).toContain('$11\r\nreading:A B\r\n');
    } finally { await server.close(); }
  });

  it('reads an array reply, including one split across TCP packets', async () => {
    // The bug a mocked socket hides: the parser must return "need more data" and resume, not
    // mis-parse the fragment it happens to have.
    const server = await respServer(['*3\r\n$5\r\nE-204\r\n$3\r\n7.8\r\n$2\r\nmm\r\n'], 4);
    try {
      const adapter = new RedisAdapter(connector(server.port));
      const result = await adapter.query(template('HGETALL equipment:$1'), ['PT-101']);
      expect(result.rows.map((row) => row.value)).toEqual(['E-204', '7.8', 'mm']);
    } finally { await server.close(); }
  });

  it('reads a nested array without losing structure', async () => {
    const server = await respServer(['*2\r\n*2\r\n$3\r\nfoo\r\n$3\r\nbar\r\n$1\r\nz\r\n']);
    try {
      const adapter = new RedisAdapter(connector(server.port));
      const result = await adapter.query(template('LRANGE list:$1 0 -1'), ['PT-101']);
      expect(result.rows[0].value).toEqual(['foo', 'bar']);
      expect(result.rows[1].value).toBe('z');
    } finally { await server.close(); }
  });

  it('treats a nil bulk string as no rows, not as an empty string', async () => {
    // "no record" and "a record containing nothing" are different answers to an engineer.
    const server = await respServer(['$-1\r\n']);
    try {
      const adapter = new RedisAdapter(connector(server.port));
      const result = await adapter.query(template('GET missing:$1'), ['PT-101']);
      expect(result.rows).toEqual([]);
      expect(result.rowCount).toBe(0);
    } finally { await server.close(); }
  });

  it('surfaces a server error instead of returning it as data', async () => {
    const server = await respServer(['-WRONGTYPE Operation against a key holding the wrong kind of value\r\n']);
    try {
      const adapter = new RedisAdapter(connector(server.port));
      await expect(adapter.query(template('GET reading:$1'), ['PT-101']))
        .rejects.toThrow(/WRONGTYPE/);
    } finally { await server.close(); }
  });

  it('sends AUTH before the query when a password env var is set, and never logs the secret', async () => {
    process.env.TEST_REDIS_PASSWORD = 'plant-secret';
    const server = await respServer(['+OK\r\n', '$3\r\nabc\r\n']);
    try {
      const adapter = new RedisAdapter(connector(server.port, { passwordEnv: 'TEST_REDIS_PASSWORD' }));
      const result = await adapter.query(template('GET reading:$1'), ['PT-101']);
      expect(result.rows[0].value).toBe('abc');
      const sent = server.received.join('');
      expect(sent).toContain('AUTH');
      expect(sent).toContain('plant-secret');   // it went to the server...
      expect(adapter.kind).toBe('redis');
    } finally {
      delete process.env.TEST_REDIS_PASSWORD;
      await server.close();
    }
  });

  it('caps rows at the template limit and says it truncated', async () => {
    const many = `*5\r\n${['a', 'b', 'c', 'd', 'e'].map((v) => `$1\r\n${v}\r\n`).join('')}`;
    const server = await respServer([many]);
    try {
      const adapter = new RedisAdapter(connector(server.port));
      const result = await adapter.query(template('LRANGE l:$1 0 -1', { maxRows: 2 }), ['PT-101']);
      expect(result.rowCount).toBe(2);
      expect(result.truncated).toBe(true);
    } finally { await server.close(); }
  });

  it('times out rather than hanging when the server never replies', async () => {
    const server = await respServer([]);  // accept, never answer
    try {
      const adapter = new RedisAdapter(connector(server.port, { timeoutMs: 300 }));
      await expect(adapter.query(template('GET reading:$1'), ['PT-101']))
        .rejects.toThrow(/timed out/);
    } finally { await server.close(); }
  });

  it('reports a refused connection as a socket failure, not as empty data', async () => {
    // Port 1 is reserved and nothing listens: an unreachable historian must not read as "no records".
    const adapter = new RedisAdapter(connector(1, { timeoutMs: 500 }));
    await expect(adapter.query(template('GET reading:$1'), ['PT-101']))
      .rejects.toThrow(SocketQueryError);
  });
});

describe('Postgres: the parts that are ours, not the driver’s', () => {
  /** Stand in for `pg.Client`, recording how the adapter configured and called it. */
  class FakeClient {
    static lastOptions: Record<string, unknown> | null = null;
    static lastQuery: { text: string; values: unknown[] } | null = null;
    static rows: Record<string, unknown>[] = [];
    static failWith: string | null = null;
    constructor(options: Record<string, unknown>) { FakeClient.lastOptions = options; }
    async connect(): Promise<void> { /* connected */ }
    async query(config: { text: string; values: unknown[] }): Promise<{ rows: Record<string, unknown>[] }> {
      FakeClient.lastQuery = config;
      if (FakeClient.failWith) throw new Error(FakeClient.failWith);
      return { rows: FakeClient.rows };
    }
    async end(): Promise<void> { /* closed */ }
  }

  const pgTemplate = (over: Partial<QueryTemplate> = {}): QueryTemplate => ({
    name: 'equipment_history', description: 'test', connector: 'historian',
    statement: 'SELECT tag, thickness_mm FROM inspections WHERE tag = $1',
    params: [{ name: 'tag', type: 'string', pattern: '^[A-Z]-\\d{3}$' }],
    ...over,
  });

  const pgConnector: ConnectorConfig = {
    name: 'historian', kind: 'postgres', host: '10.0.0.9', port: 5432,
    database: 'plant', user: 'ro', timeoutMs: 7_000,
  };

  beforeEach(() => {
    FakeClient.lastOptions = null; FakeClient.lastQuery = null;
    FakeClient.rows = []; FakeClient.failWith = null;
  });

  /**
   * Injected, not module-mocked. `jest.doMock('pg', …)` stops working the moment anything else in
   * the worker has loaded the real driver — which socket.live.test.ts does — so the mock silently
   * fell through to a REAL connection and these tests began failing for a reason that had nothing
   * to do with the code under test.
   */
  const withFake = (config: ConnectorConfig): PostgresAdapter =>
    new PostgresAdapter(config, (options) => new FakeClient(options) as never);

  it('opens the connection READ-ONLY at the server, not merely by our own checking', async () => {
    FakeClient.rows = [{ tag: 'E-204', thickness_mm: 7.8 }];
    await withFake(pgConnector).query(pgTemplate(), ['E-204']);
    // This is the layer that still holds when our statement linter is wrong.
    expect(String(FakeClient.lastOptions?.options)).toContain('default_transaction_read_only=on');
    expect(FakeClient.lastOptions?.statement_timeout).toBe(7_000);
    expect(FakeClient.lastOptions?.application_name).toBe('bimax-open-socket');
  });

  it('passes parameters through the driver’s bind path, never concatenated into SQL', async () => {
    FakeClient.rows = [];
    await withFake(pgConnector).query(pgTemplate(), ['E-204']);
    expect(FakeClient.lastQuery?.text).toBe('SELECT tag, thickness_mm FROM inspections WHERE tag = $1');
    expect(FakeClient.lastQuery?.values).toEqual(['E-204']);
    // The value must not appear in the statement text — that would mean interpolation.
    expect(FakeClient.lastQuery?.text).not.toContain('E-204');
  });

  it('caps rows and reports truncation', async () => {
    FakeClient.rows = Array.from({ length: 10 }, (_, i) => ({ n: i }));
    const result = await withFake(pgConnector).query(pgTemplate({ maxRows: 3 }), ['E-204']);
    expect(result.rowCount).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it('maps a driver error to a socket refusal that names the cause', async () => {
    FakeClient.failWith = 'permission denied for table inspections';
    await expect(withFake(pgConnector).query(pgTemplate(), ['E-204']))
      .rejects.toThrow(/permission denied for table inspections/);
  });
});
