import * as net from 'net';
import * as tls from 'tls';
import { ConnectorConfig, QueryTemplate, MAX_ROWS } from './contract';

/**
 * Datastore adapters for the Open Socket.
 *
 * Each adapter has exactly one job: run a *pre-declared, human-authored* statement with bound
 * parameters and return rows. None of them accept model-authored query text, so none of them need
 * to defend against injection — the shape of the query is fixed before the model is involved.
 *
 * The read-only property is enforced in three independent places, because one is not enough:
 *
 *  - the template author writes only read statements;
 *  - `assertReadOnly` below refuses a template whose statement is not a read, at LOAD time, so a
 *    mistake in config fails at startup rather than at 2 a.m. against production;
 *  - the connection itself is put in a read-only mode where the server supports it (Postgres gets
 *    `default_transaction_read_only=on`), so even a server-side function that tries to write fails
 *    at the database rather than being trusted not to.
 *
 * The third layer is the one that matters when the first two are wrong.
 */

export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  /** Bytes the process actually sent, for the ledger. */
  bytesOut: number;
  truncated: boolean;
}

export interface Adapter {
  readonly kind: string;
  query(template: QueryTemplate, bound: (string | number | boolean)[]): Promise<QueryResult>;
  close(): Promise<void>;
}

export class SocketQueryError extends Error {}

/**
 * Statement-level read-only check, run when config is LOADED, not per call.
 *
 * This is a config linter, not a security parser — the security comes from the model never writing
 * statements. Its job is to catch an operator who pastes an UPDATE into a template file, early and
 * loudly, instead of discovering it when an agent runs it.
 */
export function assertReadOnly(template: QueryTemplate, kind: ConnectorConfig['kind']): void {
  const statement = template.statement.trim();
  if (kind === 'postgres') {
    const head = statement.replace(/^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*/g, '').slice(0, 40).toUpperCase();
    if (!/^(SELECT|WITH|TABLE|VALUES|EXPLAIN|SHOW)\b/.test(head)) {
      throw new SocketQueryError(
        `template "${template.name}" is not a read: it begins "${head.slice(0, 20).trim()}". `
        + 'Open Socket templates may only SELECT/WITH/TABLE/VALUES/EXPLAIN/SHOW.',
      );
    }
    // A stacked statement is how a "SELECT" template smuggles a write. Templates are single
    // statements; a semicolon that is not the trailing one is refused.
    const withoutTrailing = statement.replace(/;\s*$/, '');
    if (withoutTrailing.includes(';')) {
      throw new SocketQueryError(
        `template "${template.name}" contains more than one statement. Templates must be a single query.`,
      );
    }
    if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|COPY|CALL|DO)\b/i.test(withoutTrailing)) {
      throw new SocketQueryError(
        `template "${template.name}" contains a write keyword. Even inside a CTE this is refused.`,
      );
    }
    return;
  }

  // Redis: the statement is a command line; only retrieval commands are permitted.
  const command = statement.trim().split(/\s+/)[0]?.toUpperCase() || '';
  const READ_COMMANDS = new Set([
    'GET', 'MGET', 'STRLEN', 'EXISTS', 'TYPE', 'TTL', 'PTTL',
    'HGET', 'HMGET', 'HGETALL', 'HKEYS', 'HVALS', 'HLEN', 'HEXISTS',
    'LRANGE', 'LLEN', 'LINDEX',
    'SMEMBERS', 'SCARD', 'SISMEMBER', 'SRANDMEMBER',
    'ZRANGE', 'ZREVRANGE', 'ZRANGEBYSCORE', 'ZSCORE', 'ZCARD', 'ZCOUNT', 'ZRANK',
    'SCAN', 'HSCAN', 'SSCAN', 'ZSCAN', 'KEYS',
    'JSON.GET', 'JSON.MGET', 'JSON.TYPE', 'JSON.OBJKEYS',
    'FT.SEARCH', 'FT.AGGREGATE', 'FT.INFO',
    'XRANGE', 'XREVRANGE', 'XLEN', 'GETRANGE', 'BITCOUNT', 'DBSIZE',
  ]);
  if (!READ_COMMANDS.has(command)) {
    throw new SocketQueryError(
      `template "${template.name}" uses Redis command "${command}", which is not a read. `
      + `Permitted: ${[...READ_COMMANDS].slice(0, 12).join(', ')}, …`,
    );
  }
}

function password(config: ConnectorConfig): string | undefined {
  // The secret is read from the environment at connect time and never stored in config or logged.
  return config.passwordEnv ? process.env[config.passwordEnv] : undefined;
}

/* ------------------------------------------------------------------ Postgres */

/**
 * How a Postgres client is constructed. Injectable so a test can drive the adapter without a server
 * AND without module mocking — `jest.doMock('pg', …)` is defeated as soon as anything else in the
 * same worker has already loaded the real driver, which is exactly what happens once the live
 * integration tests run alongside these. A seam is deterministic where a mock is order-dependent.
 */
export type PgClientFactory = (options: Record<string, unknown>) => {
  connect(): Promise<void>;
  query(config: { text: string; values: unknown[] }): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
};

export class PostgresAdapter implements Adapter {
  readonly kind = 'postgres';
  private client: any = null;

  constructor(
    private readonly config: ConnectorConfig,
    private readonly clientFactory?: PgClientFactory,
  ) {}

  private async connect(): Promise<any> {
    if (this.client) return this.client;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Client = this.clientFactory ?? ((options: Record<string, unknown>) => new (require('pg').Client)(options));
    const client = Client({
      host: this.config.host,
      port: this.config.port,
      database: this.config.database,
      user: this.config.user,
      password: password(this.config),
      ssl: this.config.tls ? { rejectUnauthorized: false } : undefined,
      connectionTimeoutMillis: this.config.timeoutMs ?? 10_000,
      statement_timeout: this.config.timeoutMs ?? 10_000,
      // Server-enforced read-only. If a template or a server-side function attempts a write, the
      // DATABASE refuses it — we are not relying on our own checks having been correct.
      options: '-c default_transaction_read_only=on',
      application_name: 'bimax-open-socket',
    });
    await client.connect();
    this.client = client;
    return client;
  }

  async query(template: QueryTemplate, bound: (string | number | boolean)[]): Promise<QueryResult> {
    const client = await this.connect();
    const limit = Math.min(template.maxRows ?? MAX_ROWS, MAX_ROWS);
    // Parameters ride the driver's binary bind path — they are never concatenated into SQL, so a
    // value cannot alter the statement's shape whatever it contains.
    const bytesOut = Buffer.byteLength(template.statement, 'utf8')
      + bound.reduce<number>((sum, value) => sum + Buffer.byteLength(String(value), 'utf8'), 0);
    let result: any;
    try {
      result = await client.query({ text: template.statement, values: bound, rowMode: undefined });
    } catch (error) {
      throw new SocketQueryError(`postgres refused the query: ${(error as Error).message}`);
    }
    const rows = (result.rows || []).slice(0, limit);
    return { rows, rowCount: rows.length, bytesOut, truncated: (result.rows || []).length > limit };
  }

  async close(): Promise<void> {
    if (this.client) { try { await this.client.end(); } catch { /* already gone */ } this.client = null; }
  }
}

/* --------------------------------------------------------------------- Redis */

/** Encode a Redis command as a RESP array — the only thing we ever write to the socket. */
function encodeCommand(parts: string[]): Buffer {
  const head = `*${parts.length}\r\n`;
  const body = parts.map((part) => `$${Buffer.byteLength(part, 'utf8')}\r\n${part}\r\n`).join('');
  return Buffer.from(head + body, 'utf8');
}

type RespValue = string | number | null | RespValue[];

/** Minimal RESP2 reader. Returns [value, bytesConsumed] or null when more data is needed. */
function parseResp(buffer: Buffer, offset: number): [RespValue, number] | null {
  if (offset >= buffer.length) return null;
  const type = buffer[offset];
  const lineEnd = buffer.indexOf('\r\n', offset);
  if (lineEnd === -1) return null;
  const line = buffer.toString('utf8', offset + 1, lineEnd);
  const next = lineEnd + 2;

  switch (type) {
    case 0x2b: return [line, next];                       // +simple
    case 0x3a: return [Number(line), next];               // :integer
    case 0x2d: throw new SocketQueryError(`redis error: ${line}`); // -error
    case 0x24: {                                          // $bulk
      const length = Number(line);
      if (length === -1) return [null, next];
      if (buffer.length < next + length + 2) return null;
      return [buffer.toString('utf8', next, next + length), next + length + 2];
    }
    case 0x2a: {                                          // *array
      const count = Number(line);
      if (count === -1) return [null, next];
      const items: RespValue[] = [];
      let cursor = next;
      for (let i = 0; i < count; i++) {
        const parsed = parseResp(buffer, cursor);
        if (!parsed) return null;
        items.push(parsed[0]);
        cursor = parsed[1];
      }
      return [items, cursor];
    }
    default:
      throw new SocketQueryError(`unrecognised RESP type byte 0x${type.toString(16)}`);
  }
}

export class RedisAdapter implements Adapter {
  readonly kind = 'redis';

  constructor(private readonly config: ConnectorConfig) {}

  /** One connection per call, closed immediately. A retrieval window holds nothing open. */
  private async send(commands: string[][]): Promise<{ replies: RespValue[]; bytesOut: number }> {
    const timeout = this.config.timeoutMs ?? 10_000;
    const payloads = commands.map(encodeCommand);
    const bytesOut = payloads.reduce((sum, part) => sum + part.length, 0);

    return new Promise((resolve, reject) => {
      const options = { host: this.config.host, port: this.config.port };
      const socket: net.Socket = this.config.tls
        ? tls.connect({ ...options, rejectUnauthorized: false })
        : net.connect(options);

      let chunks = Buffer.alloc(0);
      const replies: RespValue[] = [];
      const done = (error?: Error) => {
        socket.destroy();
        if (error) reject(error); else resolve({ replies, bytesOut });
      };

      socket.setTimeout(timeout, () => done(new SocketQueryError(`redis timed out after ${timeout}ms`)));
      socket.on('error', (error) => done(new SocketQueryError(`redis connection failed: ${error.message}`)));
      socket.on('connect', () => { for (const payload of payloads) socket.write(payload); });
      socket.on('data', (part) => {
        chunks = Buffer.concat([chunks, part]);
        try {
          let offset = 0;
          for (;;) {
            const parsed = parseResp(chunks, offset);
            if (!parsed) break;
            replies.push(parsed[0]);
            offset = parsed[1];
            if (replies.length === commands.length) { done(); return; }
          }
          chunks = chunks.subarray(offset);
        } catch (error) { done(error as Error); }
      });
    });
  }

  async query(template: QueryTemplate, bound: (string | number | boolean)[]): Promise<QueryResult> {
    // `$1`-style placeholders are substituted into ARGUMENT SLOTS, never into the command line as
    // text: the command is tokenised first, then each token that is exactly a placeholder is
    // replaced by its bound value. A value containing a space therefore stays one argument and
    // cannot become a second command.
    const tokens = template.statement.trim().split(/\s+/);
    const argv = tokens.map((token) => token.replace(/\$(\d+)/g, (_whole, digits: string) => {
      // Substitution happens WITHIN a token, because the useful Redis forms embed the parameter in
      // a key: `GET reading:$1`, `HGETALL equipment:$1`. An earlier version only replaced a token
      // that was exactly `$1`, so those templates sent the literal text "reading:$1" to the server
      // and quietly returned nothing — the failure looked like "no such key" rather than a bug.
      //
      // Tokenising FIRST and substituting after is what keeps this safe: the argv boundaries are
      // fixed by the template's own whitespace before any value is seen, so a parameter containing
      // a space lands inside one argument and cannot become a second one.
      const index = Number(digits) - 1;
      if (index < 0 || index >= bound.length) {
        throw new SocketQueryError(`template "${template.name}" references $${digits} with no such parameter`);
      }
      return String(bound[index]);
    }));

    const preamble: string[][] = [];
    const secret = password(this.config);
    if (secret) preamble.push(this.config.user ? ['AUTH', this.config.user, secret] : ['AUTH', secret]);
    // `database` was honoured by the Postgres adapter and silently IGNORED here, so a connector
    // pointing at any Redis logical database other than 0 read from the wrong one and returned
    // "no such key" — indistinguishable from a genuinely absent record, which is the worst way for
    // a retrieval surface to be wrong. Found by running against a real server rather than a script.
    const database = (this.config.database ?? '').trim();
    if (database) {
      if (!/^\d{1,3}$/.test(database)) {
        throw new SocketQueryError(
          `connector "${this.config.name}": Redis database must be a number, got "${database}"`,
        );
      }
      preamble.push(['SELECT', database]);
    }

    const { replies, bytesOut } = await this.send([...preamble, argv]);
    const reply = replies[replies.length - 1];
    const limit = Math.min(template.maxRows ?? MAX_ROWS, MAX_ROWS);

    // Flatten RESP into rows so the caller renders one shape regardless of datastore.
    let rows: Record<string, unknown>[];
    if (Array.isArray(reply)) {
      rows = reply.slice(0, limit).map((value, index) => ({ index, value: Array.isArray(value) ? value : value }));
    } else {
      rows = reply === null ? [] : [{ index: 0, value: reply }];
    }
    return {
      rows, rowCount: rows.length, bytesOut,
      truncated: Array.isArray(reply) && reply.length > limit,
    };
  }

  async close(): Promise<void> { /* connections are per-call */ }
}

export function createAdapter(config: ConnectorConfig): Adapter {
  if (config.kind === 'postgres') return new PostgresAdapter(config);
  if (config.kind === 'redis') return new RedisAdapter(config);
  throw new SocketQueryError(`unsupported connector kind: ${(config as ConnectorConfig).kind}`);
}
