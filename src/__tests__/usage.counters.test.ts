import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { UsageCounters } from '../mind/usage.counters';

/**
 * W1 (docs/product-reset/58): counters that make the NEXT retirement pass a measurement.
 *
 * The properties that matter are about HONESTY, not arithmetic: a counter that silently loses a
 * write, or that reports a registered-but-uncalled tool the same way as one that was never
 * registered, would send someone deleting live code. So the never-used direction is asserted in
 * both directions, and recording is asserted never to throw.
 */

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-usage-'));
}

describe('UsageCounters', () => {
  test('counts by canonical name and survives a flush/reload', () => {
    const root = tmpRoot();
    let now = 1_000;
    const a = new UsageCounters(root, () => now);
    a.record('command', '/self');
    now = 2_000;
    a.record('command', '/self');
    a.record('tool', 'BashTool');
    a.flush();

    const b = new UsageCounters(root, () => now);
    const snap = b.snapshot();
    expect(snap.commands['/self']).toEqual({ n: 2, last: 2_000 });
    expect(snap.tools['BashTool']).toEqual({ n: 1, last: 2_000 });
  });

  test('never-used is reported against what is REGISTERED, not against what is known', () => {
    const root = tmpRoot();
    const c = new UsageCounters(root, () => 1);
    c.record('tool', 'BashTool');

    // Registered and called → not unused. Registered and never called → unused.
    expect(c.neverUsed('tool', ['BashTool', 'GrepTool'])).toEqual(['GrepTool']);
    // A tool nobody registered is absent from the answer entirely — it cannot be "unused", because
    // it does not exist. Reporting it would be an invitation to delete something already gone.
    expect(c.neverUsed('tool', ['BashTool'])).toEqual([]);
  });

  test('an empty history makes everything unused — which is why callers must show the window', () => {
    // Guarding the exact misreading this feature invites: a fresh counter file is not evidence of
    // death. /usage prints the observation window and a warning under seven days for this reason.
    const c = new UsageCounters(tmpRoot(), () => 1);
    expect(c.neverUsed('command', ['/a', '/b'])).toEqual(['/a', '/b']);
    expect(c.snapshot().since).toBe(1);
  });

  test('a corrupt file restarts counting instead of throwing', () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, '.bimax'), { recursive: true });
    fs.writeFileSync(path.join(root, '.bimax', 'usage.json'), '{ this is not json');
    const c = new UsageCounters(root, () => 7);
    expect(() => c.record('command', '/self')).not.toThrow();
    expect(c.snapshot().commands['/self'].n).toBe(1);
  });

  test('recording never throws, whatever it is handed', () => {
    // Counting sits inside the tool-execution path. A throw here would fail a real turn, which is
    // a spectacularly bad trade for a statistic.
    const c = new UsageCounters(path.join(path.sep, 'proc', 'nonexistent-and-unwritable'), () => 1);
    expect(() => c.record('tool', 'BashTool')).not.toThrow();
    expect(() => c.flush()).not.toThrow();
    expect(() => c.record('command', '')).not.toThrow();
    expect(c.snapshot().commands['']).toBeUndefined();
  });

  test('names only — the counter has nowhere to put an argument', () => {
    const c = new UsageCounters(tmpRoot(), () => 1);
    c.record('command', '/remember');
    const stored = JSON.stringify(c.snapshot());
    expect(stored).toContain('/remember');
    // The shape is {n, last}. There is no field a prompt, path or argument could occupy.
    expect(Object.keys(c.snapshot().commands['/remember']).sort()).toEqual(['last', 'n']);
  });
});
