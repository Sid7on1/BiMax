import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  classifyDestination,
  hostOf,
  isSovereign,
  resetSovereignMode,
  setSovereignAllowlist,
  setSovereignMode,
} from '../security/sovereign';
import { checkEgress, assertEgressAllowed, EgressRefused } from '../security/egress.guard';
import {
  readLedger,
  resetSessionEgress,
  sessionEgress,
  summarize,
} from '../security/egress.ledger';

/**
 * "Nothing leaves the premises" is the claim the whole product rests on, so it is tested as a
 * property of the classifier rather than as a list of URLs someone remembered to add.
 *
 * The classification is syntactic on purpose (a DNS lookup is itself egress, and its answer can
 * change between the check and the connect), which means the interesting cases are the spellings
 * that LOOK local and are not.
 */
describe('sovereign destination classification', () => {
  beforeEach(() => {
    resetSovereignMode();
    setSovereignAllowlist([]);
  });

  test('loopback in every spelling that reaches this machine', () => {
    for (const target of [
      'http://localhost:11434/v1',
      'http://127.0.0.1:8000',
      'http://127.9.9.9/',           // the whole 127.0.0.0/8, not just .0.1
      'http://[::1]:1234/v1',
      'http://[::ffff:127.0.0.1]/',  // IPv4-mapped: the trailing quad decides
      'http://ollama.localhost/',
      'localhost',
      'localhost.',                  // one trailing dot is still the same host
    ]) {
      expect([target, classifyDestination(target)]).toEqual([target, 'loopback']);
    }
  });

  test('private networks — an on-premises GPU box is not external', () => {
    for (const target of [
      'http://10.0.0.5:8000/v1',
      'http://172.16.4.4/',
      'http://172.31.255.254/',
      'http://192.168.1.50:11434',
      'http://169.254.10.1/',
      'http://100.64.0.7/',          // CGNAT range used by mesh VPNs
      'http://[fd00::1]:8000/',      // unique-local
      'http://[fe80::1]/',           // link-local
      'http://gpu-server.local/',
      'http://models.internal/v1',
      'http://vllm.lan:8000',
    ]) {
      expect([target, classifyDestination(target)]).toEqual([target, 'private-lan']);
    }
  });

  test('the public internet is external, including the endpoint we ship with today', () => {
    for (const target of [
      'https://integrate.api.nvidia.com/v1',
      'https://api.openai.com/v1/chat/completions',
      'https://huggingface.co/api/models',
      'http://172.32.0.1/',          // just outside 172.16/12
      'http://11.0.0.1/',            // adjacent to 10/8, not in it
    ]) {
      expect([target, classifyDestination(target)]).toEqual([target, 'external']);
    }
  });

  test('a hostname that merely CONTAINS a local name is external', () => {
    // The substring check every naive implementation reaches for would pass all three of these.
    expect(classifyDestination('https://localhost@evil.example/steal')).toBe('external');
    expect(classifyDestination('https://127.0.0.1.evil.example/')).toBe('external');
    expect(classifyDestination('https://notlocalhost.example/')).toBe('external');
  });

  test('exotic address spellings are classified as the CONNECT will resolve them', () => {
    // These are the cases a hand-rolled dotted-quad check gets wrong. Each one is a real loopback
    // address to connect(2), so each must be classified loopback — refusing them would break a
    // local endpoint, and calling them external would be a lie about where the bytes went.
    expect(classifyDestination('http://2130706433/')).toBe('loopback');   // integer form
    expect(classifyDestination('http://0x7f.1/')).toBe('loopback');       // hex + short form
    expect(classifyDestination('http://127.1/')).toBe('loopback');        // short form

    // And the one that LOOKS private and is not: 010 is octal, so this is 8.0.0.1 — public.
    expect(classifyDestination('http://010.0.0.1/')).toBe('external');
  });

  test('a target with no network host at all is not mistaken for a local one', () => {
    for (const target of ['data:text/plain,secret', 'file:///etc/passwd', 'mailto:a@b.example']) {
      expect([target, classifyDestination(target)]).toEqual([target, 'external']);
    }
  });

  test('a bare single-label hostname is external — we cannot prove it is local', () => {
    expect(classifyDestination('http://gpu01:8000/v1')).toBe('external');
  });

  test('an unparseable or empty target is external, never silently safe', () => {
    expect(classifyDestination('')).toBe('external');
    expect(classifyDestination('   ')).toBe('external');
  });

  test('the operator allowlist covers an on-premises host with an ordinary name', () => {
    setSovereignAllowlist(['models.corp.mrpl', '.svc.cluster.internal']);
    expect(classifyDestination('https://models.corp.mrpl/v1')).toBe('allowlisted');
    expect(classifyDestination('https://vllm.svc.cluster.internal/v1')).toBe('private-lan'); // .internal wins first
    expect(classifyDestination('https://other.corp.mrpl/v1')).toBe('external');
  });

  test('hostOf normalises the forms the guard will actually be handed', () => {
    expect(hostOf('https://User:pw@Example.COM:8443/path')).toBe('example.com');
    expect(hostOf('[::1]:8080')).toBe('::1');
    expect(hostOf('gpu01:8000')).toBe('gpu01');
  });
});

describe('sovereign mode resolution', () => {
  const saved = process.env.BIMAX_SOVEREIGN;
  afterEach(() => {
    if (saved === undefined) delete process.env.BIMAX_SOVEREIGN;
    else process.env.BIMAX_SOVEREIGN = saved;
    resetSovereignMode();
  });

  test('off by default, on by env, and a runtime override beats the env', () => {
    delete process.env.BIMAX_SOVEREIGN;
    resetSovereignMode();
    expect(isSovereign()).toBe(false);

    process.env.BIMAX_SOVEREIGN = '1';
    expect(isSovereign()).toBe(true);

    setSovereignMode(false);
    expect(isSovereign()).toBe(false);
  });
});

describe('the egress guard', () => {
  let ledgerFile: string;

  beforeEach(() => {
    ledgerFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'egress-')), 'egress.ledger');
    process.env.BIMAX_EGRESS_LEDGER = ledgerFile;
    resetSessionEgress();
    resetSovereignMode();
    setSovereignAllowlist([]);
  });

  afterEach(() => {
    delete process.env.BIMAX_EGRESS_LEDGER;
    resetSovereignMode();
  });

  test('sovereign mode refuses an external host and says so in the model-visible message', () => {
    setSovereignMode(true);
    const refusal = checkEgress({
      target: 'https://integrate.api.nvidia.com/v1',
      subsystem: 'LlmAdapter',
      purpose: 'chat completion',
    });
    expect(refusal).toMatch(/integrate\.api\.nvidia\.com/);
    expect(refusal).toMatch(/BIMAX_SOVEREIGN_ALLOW/);
  });

  test('sovereign mode permits the local model server', () => {
    setSovereignMode(true);
    expect(checkEgress({ target: 'http://localhost:11434/v1', subsystem: 'LlmAdapter' })).toBeNull();
  });

  test('ALLOWED calls are recorded too — a refusal-only ledger proves nothing about what was sent', () => {
    setSovereignMode(true);
    checkEgress({ target: 'http://localhost:11434/v1', subsystem: 'LlmAdapter' });
    checkEgress({ target: 'https://api.openai.com/v1', subsystem: 'WebFetchTool' });

    const summary = summarize();
    expect(summary).toMatchObject({
      attempts: 2,
      loopback: 1,
      external: 1,
      refused: 1,
      externalHosts: ['api.openai.com'],
    });
  });

  test('outside sovereign mode nothing is refused, but everything is still recorded', () => {
    setSovereignMode(false);
    expect(checkEgress({ target: 'https://api.openai.com/v1', subsystem: 'WebFetchTool' })).toBeNull();
    expect(summarize()).toMatchObject({ attempts: 1, external: 1, refused: 0 });
  });

  test('the ledger is NDJSON on disk and survives a malformed line', () => {
    setSovereignMode(true);
    checkEgress({ target: 'http://127.0.0.1:8000', subsystem: 'RemoteEmbeddingBackend', purpose: 'embed' });
    fs.appendFileSync(ledgerFile, 'not json\n');
    checkEgress({ target: 'https://evil.example', subsystem: 'WebFetchTool' });

    const { entries, skipped } = readLedger(ledgerFile);
    expect(skipped).toBe(1);
    expect(entries.map(e => e.verdict)).toEqual(['allowed', 'refused']);
    expect(entries[0]).toMatchObject({ subsystem: 'RemoteEmbeddingBackend', destination: 'loopback', sovereign: true });
  });

  test('the throwing form carries the same refusal for seams that cannot return one', () => {
    setSovereignMode(true);
    expect(() => assertEgressAllowed({ target: 'https://api.openai.com', subsystem: 'LlmAdapter' }))
      .toThrow(EgressRefused);
    expect(sessionEgress()).toHaveLength(1);
  });

  test('an unwritable ledger degrades to memory instead of crashing the turn it audits', () => {
    process.env.BIMAX_EGRESS_LEDGER = path.join(os.tmpdir(), 'egress-nonexistent-\0bad', 'x.ledger');
    setSovereignMode(true);
    expect(() => checkEgress({ target: 'http://localhost:11434', subsystem: 'LlmAdapter' })).not.toThrow();
    expect(summarize().writeFailures).toBeGreaterThan(0);
  });
});
