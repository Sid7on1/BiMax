import '../cli/commands/sovereign';
import { globalCommandRegistry } from '../cli/commands/registry';
import { setSovereignMode, resetSovereignMode, setSovereignAllowlist } from '../security/sovereign';
import { installEgressPerimeter, uninstallEgressPerimeter } from '../security/egress.perimeter';
import { resetSessionEgress } from '../security/egress.ledger';
import * as net from 'net';

const LEDGER = `${process.env.TMPDIR || '/tmp'}/bimax-sovereign-cmd-${process.pid}.ledger`;
const ctx = { cwd: process.cwd(), options: {} } as any;

/** Run `/sovereign <args>` through the real registry and return the message text it renders. */
async function run(...args: string[]): Promise<string> {
  const result = await globalCommandRegistry.execute(['/sovereign', ...args].join(' '), ctx);
  return result.type === 'message' ? result.content : JSON.stringify(result);
}

/** Open a socket and immediately tear it down; the assertion is about the ledger, not connectivity. */
function attempt(fn: () => unknown): void {
  try {
    const handle = fn() as { on?: (e: string, cb: () => void) => void; destroy?: () => void } | undefined;
    handle?.on?.('error', () => undefined);
    handle?.destroy?.();
  } catch { /* a refusal is the point of some of these */ }
}

beforeAll(() => { process.env.BIMAX_EGRESS_LEDGER = LEDGER; });
beforeEach(() => { resetSovereignMode(); resetSessionEgress(); installEgressPerimeter(); });
afterEach(() => { uninstallEgressPerimeter(); resetSovereignMode(); });
afterAll(() => {
  try { require('fs').unlinkSync(LEDGER); } catch { /* nothing to clean */ }
  delete process.env.BIMAX_EGRESS_LEDGER;
});

describe('/sovereign', () => {
  it('is registered and defaults to status', async () => {
    const out = await run();
    expect(out).toContain('Sovereign mode:');
    expect(out).toContain('Egress perimeter:');
    expect(out).toContain('Shell:');
  });

  it('reports the perimeter as installed, which is what makes the claim whole-process', async () => {
    expect(await run('status')).toContain('installed (fetch');
  });

  it('turns the mode on and off, and says egress is still recorded when off', async () => {
    expect(await run('on')).toContain('Sovereign mode ON');
    expect(await run('off')).toContain('still RECORDED');
  });

  it('report headlines the count an auditor reads first', async () => {
    setSovereignMode(true);
    attempt(() => net.connect(11434, '127.0.0.1'));
    const out = await run('report');
    expect(out).toContain('EGRESS REPORT');
    expect(out).toMatch(/This session: \d+ attempts?/);
    expect(out).toContain('loopback');
  });

  it('names every external host and who attempted it', async () => {
    setSovereignMode(true);
    attempt(() => net.connect(443, 'telemetry.vendor.io'));
    const out = await run('report');
    expect(out).toContain('telemetry.vendor.io');
    expect(out).toContain('1 refused');
  });

  it('states the subprocess limit rather than implying the ledger covers everything', async () => {
    const out = await run('report');
    expect(out).toContain('child process has its own network');
  });

  it('json export carries the fields an evaluator diffs against a packet capture', async () => {
    const parsed = JSON.parse(await run('json'));
    expect(parsed).toMatchObject({
      sovereign: expect.any(Boolean),
      perimeterInstalled: true,
      ledgerPath: expect.any(String),
    });
    expect(parsed.session).toHaveProperty('external');
    expect(parsed.disk).toHaveProperty('external');
    expect(parsed.unpatchableSurfaces).toEqual([]);
  });

  it('check classifies without resolving, and says so', async () => {
    setSovereignMode(true);
    const local = await run('check', 'http://127.0.0.1:11434/v1');
    expect(local).toContain('loopback');
    expect(local).toContain('allowed');
    const external = await run('check', 'https://api.openai.com/v1');
    expect(external).toContain('REFUSED');
    expect(external).toContain('Classified by name only');
  });

  it('check sees through the userinfo trap', async () => {
    setSovereignMode(true);
    // The string contains "localhost", but the connection would go to evil.example.
    const out = await run('check', 'https://localhost@evil.example/');
    expect(out).toContain('evil.example');
    expect(out).toContain('REFUSED');
  });

  it('allow records an operator assertion rather than claiming the host is local', async () => {
    setSovereignAllowlist([]);
    const out = await run('allow', 'models.corp.mrpl');
    expect(out).toContain('allowlisted');
    expect(out).toContain('BIMAX_SOVEREIGN_ALLOW');
    expect(await run('check', 'models.corp.mrpl')).toContain('allowed');
  });

  it('rejects an unknown subcommand with the usage line', async () => {
    expect(await run('nonsense')).toContain('Usage: /sovereign');
  });
});
