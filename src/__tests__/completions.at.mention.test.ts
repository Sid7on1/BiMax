import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { completeInput } from '../protocol/completions';
import { IGraphStore } from '../graph/models';

/**
 * What the @-menu offers.
 *
 * Two capabilities existed and were advertised by nothing:
 *
 *   • `@diff`, `@staged`, `@selection` and `@url` have been expandable by
 *     `expandFileAtMentions` since it was written, and this suggester never returned them — the
 *     only way to discover them was to read the source.
 *   • files were offered only once the token already contained a slash, so `@Team` fell through
 *     to the symbol suggester and someone looking for "Team report.md" was shown a list of
 *     functions. That made the whole @-flow code-only.
 *
 * These grade what a person actually sees after typing `@`.
 */

let workdir: string;

const emptyStore = (names: string[] = []): IGraphStore => ({
  getGraph: () => ({
    nodes: new Map(names.map((name, i) => [String(i), { id: String(i), name, type: 'FUNCTION' }])),
  }),
} as unknown as IGraphStore);

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-complete-'));
  fs.writeFileSync(path.join(workdir, 'Team report.md'), 'x');
  fs.writeFileSync(path.join(workdir, 'notes.md'), 'x');
  fs.mkdirSync(path.join(workdir, 'src'));
  fs.writeFileSync(path.join(workdir, 'src', 'parser.ts'), 'x');
});

afterEach(() => fs.rmSync(workdir, { recursive: true, force: true }));

const values = (text: string, store = emptyStore()): string[] =>
  completeInput(text, store, workdir).map((item) => item.value);

describe('the @ menu offers everything the prompt expander understands', () => {
  it('offers a plain filename, not only a path that already has a slash', () => {
    // The gate was `looksLikePath(token)`; "Team" has no slash, so this returned symbols.
    expect(values('summarize @Team')).toContain('@Team report.md');
    expect(values('read @notes')).toContain('@notes.md');
  });

  it('offers the fixed context references', () => {
    expect(values('review @diff')).toContain('@diff');
    expect(values('review @d')).toContain('@diff');
    expect(values('check @st')).toContain('@staged');
    expect(values('explain @sel')).toContain('@selection');
    expect(values('read @url')).toContain('@url');
  });

  it('a bare @ shows what can be brought in at all, not just the first few functions', () => {
    const offered = values('bring in @', emptyStore(['handlePayment', 'renderTable']));
    expect(offered).toEqual(expect.arrayContaining(['@diff', '@staged']));
    expect(offered.some((value) => value.endsWith('.md') || value.endsWith('/'))).toBe(true);
  });

  it('still resolves symbols, and a slashed token is a path rather than a symbol name', () => {
    expect(values('call @handle', emptyStore(['handlePayment']))).toContain('@handlePayment');
    // `src/` contains a slash: it is a path by construction, so no symbol lookup is attempted.
    expect(values('open @src/par')).toContain('@src/parser.ts');
    expect(values('open @src/', emptyStore(['srcHelper']))).not.toContain('@srcHelper');
  });

  it('MUTANT — gating files behind a slash makes the non-code case unreachable', () => {
    // Reproduce the old behaviour exactly: files only when the token looks like a path.
    const oldBehaviour = (token: string): string[] =>
      token.includes('/') ? values(`@${token}`) : [];
    expect(oldBehaviour('Team')).toEqual([]);              // what a person saw before
    expect(values('@Team')).toContain('@Team report.md');  // what they see now
  });

  it('never returns more than the caller asked for, and never repeats a value', () => {
    const items = completeInput('@', emptyStore(['a', 'b', 'c', 'd']), workdir, 5);
    expect(items.length).toBeLessThanOrEqual(5);
    expect(new Set(items.map((item) => item.value)).size).toBe(items.length);
  });
});
