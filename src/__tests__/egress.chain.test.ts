import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  recordEgress, readLedger, resetSessionEgress, verifyLedger, ledgerHead, entryDigest,
  EgressEntry,
} from '../security/egress.ledger';

/**
 * The ledger's header called itself "tamper-EVIDENT at the application level". It was not: the file
 * was independent NDJSON lines, so deleting the one line that recorded a leak, or rewriting a host,
 * left the file well-formed and the edit invisible. "Append-only" described how we wrote it, not
 * anything a reader could check.
 *
 * Chaining each entry to the digest of the one before it makes the claim checkable. These tests are
 * mostly attacks: the interesting question is not whether an untouched file verifies, it is whether
 * a touched one is caught and named.
 */

let dir: string;

function attempt(host: string, subsystem = 'LlmAdapter'): void {
  recordEgress({
    at: new Date().toISOString(),
    host,
    destination: host.startsWith('127.') ? 'loopback' : 'external',
    verdict: 'allowed',
    subsystem,
    sovereign: true,
  });
}

/** Rewrite the ledger file from entries, the way an editor with file access would. */
function writeRaw(entries: EgressEntry[]): void {
  fs.writeFileSync(
    process.env.BIMAX_EGRESS_LEDGER as string,
    entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''),
  );
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-egress-'));
  process.env.BIMAX_EGRESS_LEDGER = path.join(dir, 'egress.ledger');
  resetSessionEgress();
});

afterEach(() => {
  delete process.env.BIMAX_EGRESS_LEDGER;
  resetSessionEgress();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('every entry is linked to the one before it', () => {
  it('the first entry starts a chain and each next one names its predecessor', () => {
    attempt('127.0.0.1');
    attempt('127.0.0.2');
    attempt('127.0.0.3');

    const { entries } = readLedger();
    expect(entries).toHaveLength(3);
    expect(entries[0].prev).toBeNull();
    expect(entries[1].prev).toBe(entries[0].digest);
    expect(entries[2].prev).toBe(entries[1].digest);
    expect(ledgerHead()).toBe(entries[2].digest);
  });

  it('an untouched chain verifies', () => {
    attempt('127.0.0.1');
    attempt('127.0.0.2');
    const v = verifyLedger();
    expect(v).toMatchObject({ intact: true, checked: 2, unchained: 0 });
  });

  it('a caller cannot forge a link — supplied prev/digest are discarded', () => {
    recordEgress({
      at: new Date().toISOString(), host: 'evil.example', destination: 'external',
      verdict: 'allowed', subsystem: 'x', sovereign: true,
      prev: 'deadbeef', digest: 'cafebabe',
    });
    const { entries } = readLedger();
    expect(entries[0].prev).toBeNull();
    expect(entries[0].digest).not.toBe('cafebabe');
    expect(verifyLedger().intact).toBe(true);
  });

  it('a restart continues the existing chain instead of starting a second one', () => {
    attempt('127.0.0.1');
    const headBefore = ledgerHead();

    // A new process: the in-memory mirror is empty but the file is not.
    resetSessionEgress();
    attempt('127.0.0.2');

    const { entries } = readLedger();
    expect(entries).toHaveLength(2);
    expect(entries[1].prev).toBe(headBefore);
    expect(verifyLedger()).toMatchObject({ intact: true, checked: 2 });
  });
});

describe('tampering is caught and named', () => {
  it('editing an entry breaks it at that entry', () => {
    attempt('127.0.0.1');
    attempt('telemetry.vendor.example');
    attempt('127.0.0.3');

    const { entries } = readLedger();
    entries[1].host = '127.0.0.9';        // make the leak look local
    writeRaw(entries);

    const v = verifyLedger();
    expect(v.intact).toBe(false);
    expect(v.brokenAt).toBe(1);
    expect(v.reason).toContain('does not match its own digest');
  });

  it('deleting the entry that recorded a leak breaks the link after it', () => {
    attempt('127.0.0.1');
    attempt('telemetry.vendor.example');
    attempt('127.0.0.3');

    const { entries } = readLedger();
    writeRaw([entries[0], entries[2]]);   // drop the middle

    const v = verifyLedger();
    expect(v.intact).toBe(false);
    expect(v.brokenAt).toBe(1);
    expect(v.reason).toContain('removed or inserted');
  });

  it('inserting a fabricated entry breaks the chain', () => {
    attempt('127.0.0.1');
    attempt('127.0.0.2');

    const { entries } = readLedger();
    const forged: EgressEntry = {
      at: new Date().toISOString(), host: '127.0.0.5', destination: 'loopback',
      verdict: 'allowed', subsystem: 'LlmAdapter', sovereign: true, prev: entries[0].digest,
    };
    forged.digest = entryDigest(forged);  // internally consistent, but it is not what followed
    writeRaw([entries[0], forged, entries[1]]);

    const v = verifyLedger();
    expect(v.intact).toBe(false);
    expect(v.brokenAt).toBe(2);
  });

  it('truncating the tail is NOT a break — that is what a head recorded elsewhere is for', () => {
    attempt('127.0.0.1');
    attempt('telemetry.vendor.example');
    const { entries } = readLedger();
    const headBefore = entries[1].digest;

    writeRaw([entries[0]]);

    // Honest: a prefix of a valid chain is itself a valid chain. Only a head the evaluator wrote
    // down elsewhere reveals that the file is now shorter than the history it claims to be.
    const v = verifyLedger();
    expect(v.intact).toBe(true);
    expect(v.head).not.toBe(headBefore);
  });
});

describe('the report never reads green for the wrong reason', () => {
  it('entries written before chaining are reported as unchained, not as verified', () => {
    writeRaw([
      { at: 'x', host: 'a.example', destination: 'external', verdict: 'allowed', subsystem: 's', sovereign: false },
      { at: 'y', host: 'b.example', destination: 'external', verdict: 'allowed', subsystem: 's', sovereign: false },
    ]);
    const v = verifyLedger();
    expect(v).toMatchObject({ intact: true, checked: 0, unchained: 2 });
    // `checked: 0` is what the command turns into "NOT VERIFIABLE" rather than a success.
  });

  it('an unchained line appended after chaining began is a break, not a legacy prefix', () => {
    attempt('127.0.0.1');
    const { entries } = readLedger();
    writeRaw([
      entries[0],
      { at: 'z', host: 'leak.example', destination: 'external', verdict: 'allowed', subsystem: 's', sovereign: false },
    ]);
    const v = verifyLedger();
    expect(v.intact).toBe(false);
    expect(v.brokenAt).toBe(1);
    expect(v.reason).toContain('no digest');
  });

  it('an empty ledger verifies nothing and says so', () => {
    expect(verifyLedger()).toMatchObject({ intact: true, checked: 0, unchained: 0, head: null });
  });

  it('DOCUMENTS THE LIMIT — a wholesale rewrite verifies clean', () => {
    attempt('127.0.0.1');
    attempt('telemetry.vendor.example');

    // Someone with write access recomputes the whole chain over a censored history. Nothing inside
    // the file can detect this, which is exactly why `/sovereign verify` prints the head and tells
    // the evaluator to record it somewhere Bimax cannot reach.
    const rebuilt: EgressEntry[] = [];
    let prev: string | null = null;
    for (const host of ['127.0.0.1', '127.0.0.2']) {
      const e: EgressEntry = {
        at: 'x', host, destination: 'loopback', verdict: 'allowed',
        subsystem: 'LlmAdapter', sovereign: true, prev,
      };
      e.digest = entryDigest(e);
      prev = e.digest;
      rebuilt.push(e);
    }
    writeRaw(rebuilt);

    expect(verifyLedger()).toMatchObject({ intact: true, checked: 2 });
  });
});
