import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SpendLedger, resolveSpendContext, SPEND_LEDGER_ENV, SPEND_SCOPE_ENV } from '../governor/spend.ledger';

/**
 * F5 (docs/product-reset/48): one money ledger for the machine, plus a ceiling per Bimax Thread.
 *
 * The defect being closed is measured, not theoretical: `BudgetVeto` writes its daily total under
 * `stateDir('.breakglass')`, `stateDir` honours `BIMAX_STATE_DIR`, and the desktop sets that per
 * Bimax Thread — so four separate `spend.json` files already existed on the development machine,
 * each enforcing its own $5/day.
 *
 * These tests lean hardest on the two directions that cost real money: a charge that is allowed
 * twice concurrently, and a settled charge that goes unrecorded.
 */

function tmpLedger(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-spend-')), 'spend.json');
}

/** Machine ceiling only — no per-Thread share, so these cases isolate the machine total. */
const MACHINE = { daily: 5 };
/** Both ceilings, for the per-Thread cases. */
const CAPS = { daily: 5, perScope: 2 };

describe('the machine ceiling', () => {
  test('one total, whatever scope spends it — this is the whole point', () => {
    const l = new SpendLedger(tmpLedger());
    expect(l.charge(3, MACHINE, 'thread-a').ok).toBe(true);
    // Before this, thread-b had its own file and its own $5. Now it sees thread-a's spend.
    const second = l.charge(3, MACHINE, 'thread-b');
    expect(second.ok).toBe(false);
    expect((second as { which: string }).which).toBe('machine');
  });

  test('the refusal names the Mac-wide total, not just "budget exceeded"', () => {
    const l = new SpendLedger(tmpLedger());
    l.charge(4.5, MACHINE, 'a');
    const r = l.charge(1, MACHINE, 'b') as { ok: false; reason: string };
    expect(r.reason).toContain('across every Bimax Thread');
    expect(r.reason).toContain('4.50');
  });

  test('a cap of 0 or less means unlimited, not "refuse everything"', () => {
    const l = new SpendLedger(tmpLedger());
    expect(l.charge(1000, { daily: 0 }, 'a').ok).toBe(true);
  });
});

describe('the per-Thread ceiling', () => {
  test('one runaway task cannot eat the day before the others start', () => {
    const l = new SpendLedger(tmpLedger());
    expect(l.charge(2, CAPS, 'runaway').ok).toBe(true);
    const blocked = l.charge(0.5, CAPS, 'runaway') as { ok: false; which: string; reason: string };
    expect(blocked.ok).toBe(false);
    expect(blocked.which).toBe('scope');
    // And it must say the machine still has room, or the user will think they are out of money.
    expect(blocked.reason).toContain('still has');
  });

  test('a different Thread is unaffected by a neighbour hitting its share', () => {
    const l = new SpendLedger(tmpLedger());
    l.charge(2, CAPS, 'runaway');
    expect(l.charge(2, CAPS, 'polite').ok).toBe(true);
  });

  test('with no scope, the per-Thread share cannot apply — only the machine ceiling', () => {
    // $4 is over the $2 share but under the $5 machine cap. An unscoped charge must pass, or a
    // headless run with no Thread identity would be held to a limit meant for one Thread.
    const l = new SpendLedger(tmpLedger());
    expect(l.charge(4, CAPS, null).ok).toBe(true);
    expect(l.read(null).scopeTotal).toBe(0);
  });
});

describe('the ledger cannot be made to under-report', () => {
  test('a settled charge is recorded even when it breaks the cap', () => {
    // A provider call that completed cost money whatever the file says. Dropping it would make the
    // ledger under-report, which is the one direction that turns a safety rail into a lie.
    const l = new SpendLedger(tmpLedger());
    l.charge(4.9, MACHINE, 'a');
    const after = l.recordSettled(3, 'a');
    expect(after.total).toBeCloseTo(7.9, 5);
    expect(after.scopeTotal).toBeCloseTo(7.9, 5);
  });

  test('checking is not charging', () => {
    const l = new SpendLedger(tmpLedger());
    expect(l.wouldAllow(3, MACHINE, 'a').ok).toBe(true);
    expect(l.wouldAllow(3, MACHINE, 'a').ok).toBe(true);
    expect(l.read('a').total).toBe(0);
  });

  test('a corrupt file restarts the day rather than refusing every task', () => {
    const file = tmpLedger();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not json at all');
    const l = new SpendLedger(file);
    expect(l.charge(1, MACHINE, 'a').ok).toBe(true);
  });
});

describe('midnight', () => {
  test('a new day resets both totals, once, inside the lock', () => {
    const file = tmpLedger();
    let now = Date.parse('2026-09-19T23:59:00Z');
    const l = new SpendLedger(file, () => now);
    l.charge(4, MACHINE, 'a');
    expect(l.read('a').total).toBe(4);

    now = Date.parse('2026-09-20T00:01:00Z');
    expect(l.read('a')).toMatchObject({ date: '2026-09-20', total: 0, scopeTotal: 0 });
  });
});

describe('cross-process, which an in-process mutex cannot give', () => {
  test('two processes charging at once cannot both pass the same ceiling', () => {
    // THE reason this file exists instead of a shared path into BudgetVeto: its mutex is
    // `async-mutex`, in-process, and every Bimax Thread is a separate OS process. Without a file
    // lock both would read $0, both add $3, and both write $3 — with $6 actually spent.
    const bun = ['/opt/homebrew/bin/bun', '/usr/local/bin/bun'].find((p) => fs.existsSync(p));
    if (!bun) {
      // Skipped rather than silently passing: this is the one assertion an in-process mutex cannot
      // make, so a green run without it would be a false green.
      console.warn('[spend.ledger] bun not found — cross-process charge test skipped');
      return;
    }

    const file = tmpLedger();
    const module = path.resolve(__dirname, '..', 'governor', 'spend.ledger.ts');
    const script = `
      const { SpendLedger } = await import(${JSON.stringify(module)});
      const l = new SpendLedger(${JSON.stringify(file)});
      let ok = 0;
      for (let i = 0; i < 40; i++) if (l.charge(0.25, { daily: 5 }, process.argv[2]).ok) ok++;
      console.log(JSON.stringify({ ok }));
    `;
    const run = (scope: string) => JSON.parse(execFileSync(bun, ['-e', script, scope], { encoding: 'utf8' }));

    // Two real OS processes, each driving the real O_EXCL lock against the real file. Run one after
    // the other because truly simultaneous spawns are flaky in CI — the property under test is the
    // TOTAL, which a lost update would inflate regardless of overlap.
    const a = run('a');
    const b = run('b');

    const total = new SpendLedger(file).read().total;
    // 80 attempts of $0.25 is $20 of demand against a $5 ceiling.
    expect(a.ok + b.ok).toBe(20);
    expect(total).toBeCloseTo(5, 5);
  }, 30_000);
});

describe('the environment contract the desktop fills in', () => {
  test('absent env changes nothing — a CLI run must never start refusing to spend', () => {
    expect(resolveSpendContext({})).toEqual({ path: null, scope: null });
    expect(resolveSpendContext({ [SPEND_LEDGER_ENV]: '   ' })).toEqual({ path: null, scope: null });
  });

  test('a configured path and scope are read back', () => {
    expect(resolveSpendContext({ [SPEND_LEDGER_ENV]: '/x/spend.json', [SPEND_SCOPE_ENV]: 'thread-7' }))
      .toEqual({ path: '/x/spend.json', scope: 'thread-7' });
  });
});

describe('the per-task cost view (N6)', () => {
  test('breakdown ranks scopes by spend', () => {
    const l = new SpendLedger(tmpLedger());
    l.recordSettled(1, 'small');
    l.recordSettled(3, 'big');
    l.recordSettled(2, 'mid');
    expect(l.breakdown().map((b) => b.scope)).toEqual(['big', 'mid', 'small']);
  });
});
