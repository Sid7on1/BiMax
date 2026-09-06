import * as http from 'http';
import * as net from 'net';
import * as dns from 'dns';
import {
  installEgressPerimeter, uninstallEgressPerimeter, isEgressPerimeterInstalled,
  _resetPerimeterDedupeForTests,
} from '../security/egress.perimeter';
import { EgressRefused } from '../security/egress.guard';
import { setSovereignMode, setSovereignAllowlist, resetSovereignMode } from '../security/sovereign';
import { resetSessionEgress, sessionEgress, summarize } from '../security/egress.ledger';

// The ledger writes NDJSON beside the workspace; point it at a temp file so the suite never
// appends to the real audit trail.
const LEDGER = `${process.env.TMPDIR || '/tmp'}/bimax-perimeter-test-${process.pid}.ledger`;

/**
 * Call a connect-style primitive and immediately tear down whatever it returns.
 *
 * These assertions are about whether the PERIMETER refuses, not about whether anything is
 * listening. Without this the socket that is allowed through really does try to connect, and its
 * unhandled 'error' event (ECONNREFUSED, or ENOENT for a docker socket that is not running) takes
 * down the Jest worker.
 */
function attempt(fn: () => unknown): void {
  const handle = fn() as { on?: (e: string, cb: () => void) => void; destroy?: () => void } | undefined;
  handle?.on?.('error', () => undefined);
  handle?.destroy?.();
}

beforeAll(() => { process.env.BIMAX_EGRESS_LEDGER = LEDGER; });
beforeEach(() => {
  resetSovereignMode();
  resetSessionEgress();
  _resetPerimeterDedupeForTests();
  installEgressPerimeter();
});
afterEach(() => {
  uninstallEgressPerimeter();
  resetSovereignMode();
});
afterAll(() => {
  try { require('fs').unlinkSync(LEDGER); } catch { /* nothing to clean */ }
  delete process.env.BIMAX_EGRESS_LEDGER;
});

describe('installEgressPerimeter', () => {
  it('is idempotent — a second install does not double-wrap', () => {
    const once = (globalThis as any).fetch;
    installEgressPerimeter();
    expect((globalThis as any).fetch).toBe(once);
    expect(isEgressPerimeterInstalled()).toBe(true);
  });

  it('restores every primitive on uninstall', () => {
    const patched = { fetch: (globalThis as any).fetch, request: http.request, connect: net.connect, lookup: dns.lookup };
    uninstallEgressPerimeter();
    expect((globalThis as any).fetch).not.toBe(patched.fetch);
    expect(http.request).not.toBe(patched.request);
    expect(net.connect).not.toBe(patched.connect);
    expect(dns.lookup).not.toBe(patched.lookup);
    installEgressPerimeter(); // afterEach expects it installed
  });
});

describe('refusal in sovereign mode', () => {
  beforeEach(() => setSovereignMode(true));

  it('refuses an external fetch and never reaches the network', async () => {
    await expect((globalThis as any).fetch('https://api.openai.com/v1/models')).rejects.toThrow(EgressRefused);
  });

  it('refuses an external http.request synchronously', () => {
    expect(() => http.request('http://example.com/x')).toThrow(EgressRefused);
  });

  it('refuses a raw socket to an external host — the bypass the old guard could not see', () => {
    // browser.runtime.ts, mcp/client.ts and the embedding backend all reached the network this way
    // without ever touching checkEgress.
    expect(() => net.connect(443, 'api.openai.com')).toThrow(EgressRefused);
  });

  it('refuses a name lookup, because resolving a hostname already leaks it', () => {
    // telemetry/netprobe.ts did exactly this to the provider origin on every stalled turn.
    expect(() => dns.lookup('secret-project.example.com', () => undefined)).toThrow(EgressRefused);
  });

  it('names the host and the setting that would legitimately permit it', () => {
    try {
      net.connect(8443, 'models.corp.mrpl');
      throw new Error('should have refused');
    } catch (e: any) {
      expect(e).toBeInstanceOf(EgressRefused);
      expect(e.message).toContain('models.corp.mrpl');
      expect(e.message).toContain('BIMAX_SOVEREIGN_ALLOW');
      expect(e.message).toContain('No data left the premises');
    }
  });
});

describe('what sovereign mode must NOT break', () => {
  beforeEach(() => setSovereignMode(true));

  it('permits loopback, so a local model server still serves', () => {
    expect(() => attempt(() => http.request('http://127.0.0.1:11434/v1/chat/completions'))).not.toThrow();
    expect(() => attempt(() => http.request('http://localhost:8000/v1/models'))).not.toThrow();
  });

  it('permits a private-LAN GPU box', () => {
    expect(() => attempt(() => net.connect(8000, '10.4.1.20'))).not.toThrow();
  });

  it('permits an operator-allowlisted on-premises host', () => {
    setSovereignAllowlist(['models.corp.mrpl']);
    expect(() => attempt(() => net.connect(8443, 'models.corp.mrpl'))).not.toThrow();
  });

  it('ignores a Unix domain socket — it is not a network hop', () => {
    // dockerode talks to /var/run/docker.sock. Treating a filesystem path as an unresolvable
    // hostname would classify it external and break local tooling the moment the mode came on.
    expect(() => attempt(() => net.connect('/var/run/docker.sock'))).not.toThrow();
    expect(() => attempt(() => http.request({ socketPath: '/var/run/docker.sock', path: '/info' }))).not.toThrow();
  });

  it('treats a port with no host as localhost rather than as an empty target', () => {
    expect(() => attempt(() => net.connect({ port: 11434 }))).not.toThrow();
  });
});

describe('the ledger the audit reads', () => {
  it('records allowed loopback traffic, not only refusals', () => {
    setSovereignMode(true);
    attempt(() => http.request('http://127.0.0.1:11434/v1/models'));
    const summary = summarize(sessionEgress());
    expect(summary.attempts).toBeGreaterThan(0);
    expect(summary.loopback).toBeGreaterThan(0);
    expect(summary.external).toBe(0);
    expect(summary.refused).toBe(0);
  });

  it('records a refusal with the external host named', () => {
    setSovereignMode(true);
    expect(() => net.connect(443, 'telemetry.vendor.io')).toThrow(EgressRefused);
    const summary = summarize(sessionEgress());
    expect(summary.external).toBe(1);
    expect(summary.refused).toBe(1);
    expect(summary.externalHosts).toEqual(['telemetry.vendor.io']);
  });

  it('records outside sovereign mode too, so "what did it contact?" is always answerable', () => {
    setSovereignMode(false);
    expect(() => attempt(() => net.connect(443, 'api.openai.com'))).not.toThrow();
    const entries = sessionEgress();
    expect(entries).toHaveLength(1);
    expect(entries[0].verdict).toBe('allowed');
    expect(entries[0].destination).toBe('external');
    expect(entries[0].sovereign).toBe(false);
  });

  it('records one line per request, not one per layer', () => {
    setSovereignMode(false);
    attempt(() => net.connect(443, 'example.com'));
    dns.lookup('example.com', () => undefined);   // the inner layer of the same logical request
    expect(sessionEgress()).toHaveLength(1);
  });

  it('attributes the entry to the calling module, not to the primitive', () => {
    setSovereignMode(false);
    attempt(() => net.connect(443, 'example.com'));
    // This test file is the caller, so the subsystem is read off the stack rather than being
    // the generic layer name.
    expect(sessionEgress()[0].subsystem).toContain('egress.perimeter.test');
    expect(sessionEgress()[0].purpose).toBe('via net.connect');
  });
});
