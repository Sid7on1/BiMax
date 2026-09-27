import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';

/**
 * Sign-in for hosted MCP servers (OAuth 2.1, as the MCP authorization spec requires).
 *
 * THE GAP. Most hosted MCP servers — GitHub, Linear, Notion, Atlassian, Sentry, Stripe — answer an
 * unauthenticated connect with 401 and expect the client to run the OAuth flow: discover the
 * authorization server, register itself, send the person to a browser, take the code back on a
 * local redirect, and refresh the token later. Bimax had none of it, so every such server failed
 * with a bare "Unauthorized" and could only be used by pasting a personal token into `headers`.
 *
 * WHAT LIVES HERE. The MCP SDK performs the protocol (discovery, dynamic client registration,
 * PKCE, token exchange and refresh). This file supplies the three things the SDK leaves to the
 * client: where the credentials are kept, the loopback redirect listener, and opening the browser.
 *
 * STORAGE. One file per server URL under `~/.breakglass/mcp-auth/` (relocated with
 * BIMAX_BREAKGLASS_DIR), mode 0600 in a 0700 directory — the same protection `~/.breakglass/.env`
 * gets. Keyed by a hash of the URL, so renaming a server keeps its sign-in and a different server
 * can never read another's tokens.
 *
 * NEVER A SURPRISE BROWSER. A connect that needs sign-in fails with `McpSignInRequired`; only an
 * explicit `/mcp login <name>` (or the agent's `McpManageTool` login action, which is approval-
 * gated) opens the browser.
 */

export const OAUTH_CALLBACK_PATH = '/mcp/oauth/callback';

/**
 * One fixed loopback port. The redirect URI is registered with each authorization server once, and
 * a later sign-in must present the same URI, so the port cannot be random.
 */
export function oauthCallbackPort(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.BIMAX_MCP_OAUTH_PORT);
  return Number.isInteger(n) && n > 1023 && n < 65536 ? n : 33418;
}

export function oauthRedirectUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `http://127.0.0.1:${oauthCallbackPort(env)}${OAUTH_CALLBACK_PATH}`;
}

/** A connect that needs the person to sign in first. Carries the server name for the message. */
export class McpSignInRequired extends Error {
  constructor(readonly serverName: string) {
    super(`MCP '${serverName}' needs you to sign in. Run /mcp login ${serverName} to open the sign-in page.`);
    this.name = 'McpSignInRequired';
  }
}

interface StoredAuth {
  serverUrl: string;
  clientInformation?: unknown;
  tokens?: unknown;
  codeVerifier?: string;
  state?: string;
  discoveryState?: unknown;
}

function authDir(): string {
  return path.join(process.env.BIMAX_BREAKGLASS_DIR || path.join(os.homedir(), '.breakglass'), 'mcp-auth');
}

export function authFileFor(serverUrl: string): string {
  const id = crypto.createHash('sha256').update(new URL(serverUrl).href).digest('hex').slice(0, 24);
  return path.join(authDir(), `${id}.json`);
}

function read(serverUrl: string): StoredAuth {
  try {
    const parsed = JSON.parse(fs.readFileSync(authFileFor(serverUrl), 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.serverUrl === new URL(serverUrl).href) return parsed;
  } catch { /* none yet */ }
  return { serverUrl: new URL(serverUrl).href };
}

function write(serverUrl: string, data: StoredAuth): void {
  const file = authFileFor(serverUrl);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(file), 0o700); } catch { /* best effort */ }
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** True once a sign-in has stored tokens for this server. */
export function hasStoredTokens(serverUrl: string): boolean {
  return !!read(serverUrl).tokens;
}

/** Forget a server's sign-in (tokens, registration, everything). */
export function forgetSignIn(serverUrl: string): void {
  try { fs.unlinkSync(authFileFor(serverUrl)); } catch { /* nothing stored */ }
}

/**
 * The SDK's `OAuthClientProvider`, backed by the per-server file. `onAuthorizationUrl` decides what
 * a needed sign-in does: record it (boot), or open the browser (an explicit login).
 */
export class FileOAuthProvider {
  constructor(
    private readonly serverUrl: string,
    private readonly onAuthorizationUrl: (url: URL) => void | Promise<void>,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  get redirectUrl(): string { return oauthRedirectUrl(this.env); }

  get clientMetadata() {
    return {
      client_name: 'Bimax',
      client_uri: 'https://bimax.app',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // A desktop app cannot keep a client secret; PKCE protects the code exchange instead.
      token_endpoint_auth_method: 'none',
    };
  }

  state(): string {
    const data = read(this.serverUrl);
    data.state = crypto.randomBytes(16).toString('hex');
    write(this.serverUrl, data);
    return data.state;
  }

  expectedState(): string | undefined { return read(this.serverUrl).state; }

  clientInformation(): any { return read(this.serverUrl).clientInformation; }
  saveClientInformation(info: unknown): void { write(this.serverUrl, { ...read(this.serverUrl), clientInformation: info }); }

  tokens(): any { return read(this.serverUrl).tokens; }
  saveTokens(tokens: unknown): void { write(this.serverUrl, { ...read(this.serverUrl), tokens }); }

  async redirectToAuthorization(url: URL): Promise<void> { await this.onAuthorizationUrl(url); }

  saveCodeVerifier(codeVerifier: string): void { write(this.serverUrl, { ...read(this.serverUrl), codeVerifier }); }
  codeVerifier(): string {
    const v = read(this.serverUrl).codeVerifier;
    if (!v) throw new Error('No sign-in is in progress for this server.');
    return v;
  }

  saveDiscoveryState(state: unknown): void { write(this.serverUrl, { ...read(this.serverUrl), discoveryState: state }); }
  discoveryState(): any { return read(this.serverUrl).discoveryState; }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all') { forgetSignIn(this.serverUrl); return; }
    const data = read(this.serverUrl);
    if (scope === 'client') delete data.clientInformation;
    if (scope === 'tokens') delete data.tokens;
    if (scope === 'verifier') delete data.codeVerifier;
    if (scope === 'discovery') delete data.discoveryState;
    write(this.serverUrl, data);
  }
}

/**
 * Listen on the loopback redirect for ONE authorization response. Resolves with the code when the
 * `state` matches (CSRF protection), rejects on an error response, a mismatched state or the
 * timeout. Binds 127.0.0.1 only, and closes after the first valid response.
 */
export function waitForAuthorizationCode(
  expectedState: () => string | undefined,
  options: { port?: number; timeoutMs?: number } = {},
): { ready: Promise<void>; code: Promise<string>; close: () => void } {
  const port = options.port ?? oauthCallbackPort();
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  let settle!: { resolve: (c: string) => void; reject: (e: Error) => void };
  const code = new Promise<string>((resolve, reject) => { settle = { resolve, reject }; });
  const close = () => { clearTimeout(timer); try { server.close(); } catch { /* closed */ } };
  const page = (title: string, body: string) =>
    `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:15px -apple-system,system-ui;padding:48px;max-width:520px;margin:auto"><h2>${title}</h2><p>${body}</p></body>`;

  const server: http.Server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    if (url.pathname !== OAUTH_CALLBACK_PATH) { res.writeHead(404).end(); return; }
    const error = url.searchParams.get('error');
    const got = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const want = expectedState();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (error) {
      res.writeHead(400).end(page('Sign-in was not completed', `The server said: ${error.replace(/[<>&]/g, '')}. You can close this window.`));
      close();
      settle.reject(new Error(`Sign-in was refused: ${error}`));
      return;
    }
    if (!got || (want && state !== want)) {
      res.writeHead(400).end(page('Sign-in link did not match', 'Start the sign-in again from Bimax.'));
      return; // keep listening: a stray or forged request must not end a real sign-in
    }
    res.writeHead(200).end(page('Signed in to Bimax', 'You can close this window and go back to Bimax.'));
    close();
    settle.resolve(got);
  });
  const ready = new Promise<void>((resolve, reject) => {
    server.once('error', (e: any) => {
      const err = new Error(e?.code === 'EADDRINUSE'
        ? `Port ${port} is in use, so the sign-in page cannot return to Bimax. Close whatever uses it or set BIMAX_MCP_OAUTH_PORT.`
        : `Could not start the sign-in listener: ${e?.message || e}`);
      settle.reject(err);
      reject(err);
    });
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const timer = setTimeout(() => { close(); settle.reject(new Error('Sign-in timed out after 5 minutes.')); }, timeoutMs);
  timer.unref?.();
  return { ready, code, close };
}

/** Open a URL in the default browser. Only http(s) URLs, passed as one argument, never through a shell. */
export function openInBrowser(url: URL): Promise<void> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return Promise.reject(new Error(`Refusing to open a ${url.protocol} sign-in link.`));
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  return new Promise((resolve, reject) => execFile(opener, [url.href], (err) => (err ? reject(err) : resolve())));
}
