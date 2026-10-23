import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { expandSpecVars, loadMcpServers, normalizeTransportType } from '../mcp/config';
import { connectAndRegister, connectTimeoutMs, openClient } from '../mcp/client';
import * as oauth from '../mcp/oauth';
import { McpManager } from '../mcp/manager';
import { ToolRegistry } from '../tools/tool.registry';
import { IGovernor } from '../core/interfaces';

/* eslint-disable @typescript-eslint/no-require-imports */
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * "It must support all the MCPs": the config every other client writes, secrets by reference, tools
 * that change after the handshake, resources, roots, and hosted servers that require sign-in.
 */

const governor = { approveTaskExecution: jest.fn().mockResolvedValue(undefined) } as unknown as IGovernor;
const RICH = path.join(__dirname, 'fixtures', 'mcp-rich-server.js');

function tmpProject(config: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-mcp-all-'));
  fs.mkdirSync(path.join(dir, '.bimax'));
  fs.writeFileSync(path.join(dir, '.bimax', 'mcp.json'), JSON.stringify(config));
  return dir;
}

describe('every common MCP config shape loads', () => {
  test('VS Code: `servers` as an object (used to load nothing, silently)', () => {
    const dir = tmpProject({ servers: { fs: { type: 'stdio', command: 'npx', args: ['-y', 'pkg'] }, web: { type: 'http', url: 'https://x.example/mcp' } } });
    const specs = loadMcpServers(dir);
    expect(specs.map((s) => s.name).sort()).toEqual(['fs', 'web']);
    expect(specs.find((s) => s.name === 'web')).toMatchObject({ url: 'https://x.example/mcp', type: 'http' });
  });

  test('Windsurf `serverUrl`, Gemini CLI `httpUrl`, a `transport` field, and `enabled: false`', () => {
    const dir = tmpProject({ mcpServers: {
      a: { serverUrl: 'https://a.example/mcp' },
      b: { httpUrl: 'https://b.example/mcp' },
      c: { url: 'https://c.example/sse', transport: 'SSE' },
      d: { url: 'https://d.example/mcp', type: 'streamable-http', enabled: false },
    } });
    const byName = Object.fromEntries(loadMcpServers(dir).map((s) => [s.name, s]));
    expect(byName.a.url).toBe('https://a.example/mcp');
    expect(byName.b).toMatchObject({ url: 'https://b.example/mcp', type: 'http' });
    expect(byName.c.type).toBe('sse');
    expect(byName.d).toMatchObject({ type: 'http', disabled: true });
  });

  test('transport spellings normalise', () => {
    for (const t of ['http', 'streamable-http', 'streamableHttp', 'streamable_http']) expect(normalizeTransportType(t)).toBe('http');
    expect(normalizeTransportType('SSE')).toBe('sse');
    expect(normalizeTransportType('stdio')).toBe('stdio');
    expect(normalizeTransportType('carrier-pigeon')).toBeUndefined();
  });
});

describe('secrets by reference', () => {
  test('${VAR}, ${VAR:-default} and ${env:VAR} resolve at connect time', () => {
    const { spec, missing } = expandSpecVars({
      name: 'gh',
      url: 'https://${HOST:-api.example.com}/mcp',
      headers: { Authorization: 'Bearer ${GH_TOKEN}' },
      env: { KEY: '${env:OTHER}' },
      args: ['--team', '${TEAM:-core}'],
    }, { GH_TOKEN: 't0k', OTHER: 'o' });
    expect(missing).toEqual([]);
    expect(spec.url).toBe('https://api.example.com/mcp');
    expect(spec.headers).toEqual({ Authorization: 'Bearer t0k' });
    expect(spec.env).toEqual({ KEY: 'o' });
    expect(spec.args).toEqual(['--team', 'core']);
  });

  test('a missing variable fails the connect with its name, before anything is launched', async () => {
    await expect(openClient({ name: 'gh', command: 'node', args: [RICH], env: { TOKEN: '${DEFINITELY_NOT_SET_123}' } }))
      .rejects.toThrow(/needs DEFINITELY_NOT_SET_123.*\.breakglass\/\.env/);
  });

  test('rewriting the config keeps the reference, never the secret', async () => {
    process.env.BIMAX_TEST_SECRET_XYZ = 'super-secret-value';
    const dir = tmpProject({ mcpServers: { gh: { url: 'https://x.example/mcp', headers: { Authorization: 'Bearer ${BIMAX_TEST_SECRET_XYZ}' } } } });
    await new McpManager().setEnabled('gh', false, undefined, dir);
    const text = fs.readFileSync(path.join(dir, '.bimax', 'mcp.json'), 'utf8');
    expect(text).toContain('${BIMAX_TEST_SECRET_XYZ}');
    expect(text).not.toContain('super-secret-value');
    delete process.env.BIMAX_TEST_SECRET_XYZ;
  });

  test('downloading launchers get longer to start; an explicit setting wins', () => {
    expect(connectTimeoutMs({ name: 'x', command: 'npx' }, {})).toBe(90_000);
    expect(connectTimeoutMs({ name: 'x', command: '/opt/homebrew/bin/uvx' }, {})).toBe(90_000);
    expect(connectTimeoutMs({ name: 'x', command: 'node' }, {})).toBe(30_000);
    expect(connectTimeoutMs({ name: 'x', command: 'npx' }, { BIMAX_MCP_CONNECT_TIMEOUT_MS: '5000' })).toBe(5000);
  });
});

describe('a server whose tools change, with resources and roots', () => {
  test('tools/list_changed adds new tools and removes gone ones; resources and roots work', async () => {
    const registry = new ToolRegistry();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-roots-'));
    const conn = await connectAndRegister({ name: 'rich', command: process.execPath, args: [RICH] }, registry, governor, undefined, undefined, { root });
    expect(conn).not.toBeNull();
    try {
      expect(conn!.toolNames).toEqual(expect.arrayContaining(['mcp__rich__unlock', 'mcp__rich__temporary', 'mcp__rich__list_resources', 'mcp__rich__read_resource']));
      expect(registry.getTool('mcp__rich__secret')).toBeUndefined();

      expect(await registry.getTool('mcp__rich__unlock')!.execute({}, {})).toBe('unlocked');
      // The notification is handled asynchronously; wait for the registry to reconcile.
      for (let i = 0; i < 50 && !registry.getTool('mcp__rich__secret'); i++) await new Promise((r) => setTimeout(r, 50));
      expect(registry.getTool('mcp__rich__secret')).toBeDefined();
      expect(registry.getTool('mcp__rich__temporary')).toBeUndefined();
      expect(conn!.toolNames).toContain('mcp__rich__secret');
      expect(conn!.toolNames).toContain('mcp__rich__read_resource'); // resource tools survive the refresh

      expect(await registry.getTool('mcp__rich__list_resources')!.execute({}, {})).toContain('memo://readme');
      expect(await registry.getTool('mcp__rich__read_resource')!.execute({ uri: 'memo://readme' }, {})).toBe('Hello from a resource');

      expect(await registry.getTool('mcp__rich__roots')!.execute({}, {})).toBe(pathToFileURL(root).href);
    } finally {
      await conn!.client.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});

// ---------------------------------------------------------------------------------------------
// A hosted MCP server that requires OAuth, with its own tiny authorization server.

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function startOAuthMcpServer() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const issued = new Set<string>();
  const seen = { registrations: 0, tokenExchanges: 0, unauthorized: 0 };

  const readBody = (req: http.IncomingMessage) => new Promise<string>((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
  });
  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', base);
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      { json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] }); return; }
    }
    if (url.pathname === '/.well-known/oauth-authorization-server' || url.pathname === '/.well-known/openid-configuration') {
      json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
      return;
    }
    if (url.pathname === '/register' && req.method === 'POST') {
      seen.registrations++;
      const meta = JSON.parse(await readBody(req));
      { json(res, 201, { ...meta, client_id: 'client-1' }); return; }
    }
    if (url.pathname === '/authorize') {
      const code = crypto.randomBytes(8).toString('hex');
      codes.set(code, { challenge: url.searchParams.get('code_challenge') || '', redirect: url.searchParams.get('redirect_uri') || '' });
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state') || '');
      res.writeHead(302, { Location: back.href }).end();
      return;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      seen.tokenExchanges++;
      const form = new URLSearchParams(await readBody(req));
      const entry = codes.get(form.get('code') || '');
      const verifier = form.get('code_verifier') || '';
      if (!entry || b64url(crypto.createHash('sha256').update(verifier).digest()) !== entry.challenge) {
        { json(res, 400, { error: 'invalid_grant' }); return; }
      }
      codes.delete(form.get('code')!);
      const token = crypto.randomBytes(8).toString('hex');
      issued.add(token);
      { json(res, 200, { access_token: token, token_type: 'Bearer', expires_in: 3600, refresh_token: 'refresh-1' }); return; }
    }
    if (url.pathname === '/mcp') {
      const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!issued.has(bearer)) {
        seen.unauthorized++;
        res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` }).end();
        return;
      }
      const mcp = new Server({ name: 'hosted', version: '1.0.0' }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'whoami', description: 'who', inputSchema: { type: 'object', properties: {} } }] }));
      mcp.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'signed-in user' }] }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcp.connect(transport);
      const body = req.method === 'POST' ? JSON.parse(await readBody(req) || 'null') : undefined;
      await transport.handleRequest(req, res, body);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
  return { url: `${base}/mcp`, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe('hosted servers that require sign-in (OAuth)', () => {
  let hosted: Awaited<ReturnType<typeof startOAuthMcpServer>>;
  const previousPort = process.env.BIMAX_MCP_OAUTH_PORT;

  beforeEach(async () => {
    hosted = await startOAuthMcpServer();
    process.env.BIMAX_MCP_OAUTH_PORT = String(await freePort());
    oauth.forgetSignIn(hosted.url);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    oauth.forgetSignIn(hosted.url);
    await hosted.close();
    if (previousPort === undefined) delete process.env.BIMAX_MCP_OAUTH_PORT;
    else process.env.BIMAX_MCP_OAUTH_PORT = previousPort;
  });

  test('an automatic connect never opens a browser; it says how to sign in', async () => {
    const opened = jest.spyOn(oauth, 'openInBrowser');
    await expect(openClient({ name: 'hosted', url: hosted.url })).rejects.toThrow(/needs you to sign in.*\/mcp login hosted/);
    expect(opened).not.toHaveBeenCalled();
  }, 20000);

  test('an explicit login runs the browser round trip, stores the tokens privately, and later connects need no browser', async () => {
    // The "browser": follow the authorization redirect back to Bimax's loopback listener.
    const opened = jest.spyOn(oauth, 'openInBrowser').mockImplementation(async (authUrl: URL) => {
      const r = await fetch(authUrl, { redirect: 'manual' });
      void fetch(r.headers.get('location')!);
    });
    const registry = new ToolRegistry();
    const manager = new McpManager();
    const conn = await manager.connectSpec({ name: 'hosted', url: hosted.url }, registry, governor, { interactiveSignIn: true });
    expect(conn).not.toBeNull();
    expect(opened).toHaveBeenCalledTimes(1);
    expect(hosted.seen.registrations).toBe(1);
    expect(hosted.seen.tokenExchanges).toBe(1);
    expect(await registry.getTool('mcp__hosted__whoami')!.execute({}, {})).toBe('signed-in user');
    await conn!.client.close();

    const file = oauth.authFileFor(hosted.url);
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
    expect(oauth.hasStoredTokens(hosted.url)).toBe(true);

    // Next launch: the stored token is used, no browser, no new registration.
    const again = await openClient({ name: 'hosted', url: hosted.url });
    expect(opened).toHaveBeenCalledTimes(1);
    expect(hosted.seen.registrations).toBe(1);
    await again.close();
  }, 30000);

  test('a forged or mismatched sign-in response is ignored until the real one arrives', async () => {
    const listener = oauth.waitForAuthorizationCode(() => 'expected-state', { port: Number(process.env.BIMAX_MCP_OAUTH_PORT), timeoutMs: 10_000 });
    await listener.ready;
    const base = `http://127.0.0.1:${process.env.BIMAX_MCP_OAUTH_PORT}${oauth.OAUTH_CALLBACK_PATH}`;
    expect((await fetch(`${base}?code=evil&state=wrong`)).status).toBe(400);
    expect((await fetch(`${base}?code=good&state=expected-state`)).status).toBe(200);
    await expect(listener.code).resolves.toBe('good');
  });

  test('a server with its own Authorization header is not put through OAuth', async () => {
    const opened = jest.spyOn(oauth, 'openInBrowser');
    await expect(openClient({ name: 'hosted', url: hosted.url, headers: { Authorization: 'Bearer wrong' } }, { interactiveSignIn: true }))
      .rejects.toThrow();
    expect(opened).not.toHaveBeenCalled();
    expect(hosted.seen.registrations).toBe(0);
  }, 20000);

  test('signing out forgets the tokens', async () => {
    fs.mkdirSync(path.dirname(oauth.authFileFor(hosted.url)), { recursive: true });
    fs.writeFileSync(oauth.authFileFor(hosted.url), JSON.stringify({ serverUrl: new URL(hosted.url).href, tokens: { access_token: 'x', token_type: 'Bearer' } }));
    expect(oauth.hasStoredTokens(hosted.url)).toBe(true);
    const dir = tmpProject({ mcpServers: { hosted: { url: hosted.url } } });
    const manager = new McpManager();
    (manager as any).configRoot = () => dir;
    expect(await manager.logout('hosted')).toBe(true);
    expect(oauth.hasStoredTokens(hosted.url)).toBe(false);
  });
});
