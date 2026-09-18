import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseAtMentions, expandAtMentions, suggestAtSymbols } from '../engine/atMention';
import { StaticAnalyzer } from '../graph/static.analyzer';
import { GraphStore } from '../graph/graph.store';

// G4 — @symbol mentions. Parsing is pure; expansion layers the graph lookup + file read.
describe('parseAtMentions (G4, pure)', () => {
  it('extracts a single mention', () => {
    expect(parseAtMentions('please fix @handlePayment now')).toEqual(['handlePayment']);
  });

  it('extracts multiple, de-duplicated, in order', () => {
    expect(parseAtMentions('@a then @b then @a again')).toEqual(['a', 'b']);
  });

  it('supports dotted method mentions', () => {
    expect(parseAtMentions('look at @Widget.render here')).toEqual(['Widget.render']);
  });

  it('ignores email-like @ and bare text', () => {
    expect(parseAtMentions('mail me at user@example.com please')).toEqual([]);
    expect(parseAtMentions('no mentions here')).toEqual([]);
  });

  it('strips a trailing sentence dot', () => {
    expect(parseAtMentions('check @greet.')).toEqual(['greet']);
  });
});

describe('expandAtMentions (G4, integration)', () => {
  let proj: string;
  let store: GraphStore;

  beforeEach(() => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'bgw-atmention-'));
    fs.writeFileSync(path.join(proj, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'ES2020', module: 'CommonJS', strict: false },
      include: ['*.ts'],
    }));
    const src = [
      '',
      'export function greet(name: string): string {',
      '  return `hi ${name}`;',
      '}',
    ].join('\n');
    fs.writeFileSync(path.join(proj, 'sample.ts'), src);
    store = new GraphStore(':memory:');
    new StaticAnalyzer(proj, store).analyzeProject();
  });

  afterEach(() => {
    fs.rmSync(proj, { recursive: true, force: true });
  });

  it('appends resolved symbol source and preserves the original text', async () => {
    const out = await expandAtMentions('rename @greet', store, proj);
    expect(out.resolved).toContain('greet');
    expect(out.text).toContain('rename @greet');            // original preserved
    expect(out.text).toContain('return `hi ${name}`;');     // injected body
    expect(out.text).toContain('Referenced symbols');
  });

  it('leaves plain text untouched when there are no mentions', async () => {
    const out = await expandAtMentions('just some prose', store, proj);
    expect(out.text).toBe('just some prose');
    expect(out.resolved).toEqual([]);
  });

  it('reports unresolved mentions without altering the text', async () => {
    const out = await expandAtMentions('fix @nopeNotHere', store, proj);
    expect(out.resolved).toEqual([]);
    expect(out.unresolved).toContain('nopeNotHere');
    expect(out.text).toBe('fix @nopeNotHere');
  });

  it('suggests symbol names by prefix', () => {
    expect(suggestAtSymbols(store, 'gre')).toContain('greet');
    expect(suggestAtSymbols(store, 'zzz')).toEqual([]);
  });
});
