import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readIdeSelection, formatSelectionBlock } from '../engine/ideSelection';

// The IDE selection bridge is BiMax's portable, dependency-free answer to OpenCode's Zed-SQLite
// read: an editor writes the selected range to a handoff and `@selection` injects it. These
// tests cover the three producers, freshness, and that selected text is re-read fresh from disk.
describe('readIdeSelection — IDE selection bridge', () => {
  let cwd: string;
  const ENV = { ...process.env };

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-sel-'));
    fs.mkdirSync(path.join(cwd, '.bimax'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'app.ts'), ['a0', 'b1', 'c2', 'd3', 'e4'].join('\n'));
  });
  afterEach(() => {
    process.env = { ...ENV };
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('returns null when no bridge is configured', () => {
    delete process.env.BIMAX_IDE_SELECTION;
    delete process.env.BIMAX_IDE_FILE;
    expect(readIdeSelection(cwd)).toBeNull();
  });

  it('reads the .bimax/ide-selection.json drop file and slices the range fresh from disk', () => {
    fs.writeFileSync(
      path.join(cwd, '.bimax', 'ide-selection.json'),
      JSON.stringify({ file: 'app.ts', startLine: 2, endLine: 3 }),
    );
    const sel = readIdeSelection(cwd)!;
    expect(sel).not.toBeNull();
    expect([sel.startLine, sel.endLine]).toEqual([2, 3]);
    expect(sel.text).toBe('b1\nc2'); // lines 2-3, read from the file (not from the handoff)
    expect(path.isAbsolute(sel.file)).toBe(true);
  });

  it('accepts inline JSON via $BIMAX_IDE_SELECTION', () => {
    process.env.BIMAX_IDE_SELECTION = JSON.stringify({ path: 'app.ts', line: 1 });
    const sel = readIdeSelection(cwd)!;
    expect([sel.startLine, sel.endLine, sel.text]).toEqual([1, 1, 'a0']);
  });

  it('supports the minimal env-only bridge ($BIMAX_IDE_FILE + line vars)', () => {
    process.env.BIMAX_IDE_FILE = path.join(cwd, 'app.ts');
    process.env.BIMAX_IDE_START_LINE = '4';
    process.env.BIMAX_IDE_END_LINE = '5';
    const sel = readIdeSelection(cwd)!;
    expect(sel.text).toBe('d3\ne4');
  });

  it('clamps an out-of-range selection to the file bounds', () => {
    process.env.BIMAX_IDE_SELECTION = JSON.stringify({ file: 'app.ts', startLine: 4, endLine: 999 });
    const sel = readIdeSelection(cwd)!;
    expect([sel.startLine, sel.endLine]).toEqual([4, 5]);
  });

  it('ignores a stale handoff (ts older than the freshness window)', () => {
    process.env.BIMAX_IDE_SELECTION = JSON.stringify({
      file: 'app.ts', startLine: 1, endLine: 1, ts: Date.now() - 60 * 60 * 1000,
    });
    expect(readIdeSelection(cwd)).toBeNull();
  });

  it('ignores a handoff pointing at a non-existent file', () => {
    process.env.BIMAX_IDE_SELECTION = JSON.stringify({ file: 'does-not-exist.ts', line: 1 });
    expect(readIdeSelection(cwd)).toBeNull();
  });

  it('formats a labelled, range-stamped context block', () => {
    process.env.BIMAX_IDE_SELECTION = JSON.stringify({ file: 'app.ts', startLine: 2, endLine: 3 });
    const block = formatSelectionBlock(readIdeSelection(cwd)!, cwd);
    expect(block).toContain('@selection (app.ts:2-3');
    expect(block).toContain('b1\nc2');
  });
});
