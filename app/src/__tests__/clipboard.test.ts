import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ClipHistory, classify, cleanUrl, codeLanguage, jsonToTypeScript, looksSecret, MAX_CLIPS, nearestTailwind, oneLine, parseColor,
  toHex, toHsl, toRgb, toSwiftUI,
} from '../main/clipboard';

/**
 * God's Land stage 5: what a copy is and what it can become. Expected values are known-correct references (CSS colour
 * maths, Tailwind v3.4.17's palette), not whatever the code happens to print.
 */

describe('colours', () => {
  test('the owner\'s example: #3B82F6 is Tailwind blue-500, exactly', () => {
    const c = parseColor('#3B82F6')!;
    expect(c).toEqual({ r: 59, g: 130, b: 246, a: 1 });
    expect(toHex(c)).toBe('#3b82f6');
    expect(toRgb(c)).toBe('rgb(59, 130, 246)');
    expect(toHsl(c)).toBe('hsl(217 91% 60%)');
    expect(toSwiftUI(c)).toBe('Color(red: 0.231, green: 0.51, blue: 0.965)');
    expect(nearestTailwind(c)).toEqual({ name: 'blue-500', exact: true });
  });

  test('short hex, rgb(), rgba(), hsl() and alpha all parse to the same colour model', () => {
    expect(toHex(parseColor('#fff')!)).toBe('#ffffff');
    expect(toHex(parseColor('rgb(255, 0, 0)')!)).toBe('#ff0000');
    expect(toHex(parseColor('rgba(0 0 0 / 50%)')!)).toBe('#00000080');
    expect(toHex(parseColor('hsl(120, 100%, 50%)')!)).toBe('#00ff00');
    expect(toHex(parseColor('hsl(0deg 0% 100%)')!)).toBe('#ffffff');
    expect(toRgb(parseColor('#ff000080')!)).toBe('rgb(255 0 0 / 0.5)');
  });

  test('what is not a colour stays text', () => {
    for (const text of ['123456', 'rgb(300, 0, 0)', '#12', 'fff', 'blue']) expect(parseColor(text)).toBeNull();
  });

  test('a colour off the palette gets the nearest class, marked approximate', () => {
    const near = nearestTailwind(parseColor('#3b83f7')!);
    expect(near).toEqual({ name: 'blue-500', exact: false });
    expect(classify('#3b83f7').detail).toBe('≈ blue-500');
    expect(classify('#3b83f7').actions.map((a) => a.label)).toEqual(['HEX', 'RGB', 'HSL', 'Swift', 'Tailwind ≈']);
  });
});

describe('links', () => {
  test('tracking parameters go, everything else stays', () => {
    expect(cleanUrl('https://shop.example/p/42?utm_source=x&utm_medium=y&color=red&fbclid=abc#reviews')).toBe('https://shop.example/p/42?color=red#reviews');
    expect(cleanUrl('https://youtu.be/dQw4w9WgXcQ?si=Tr4ck3r')).toBe('https://youtu.be/dQw4w9WgXcQ');
    expect(cleanUrl('https://example.com/search?q=utm_source')).toBeNull();
    expect(cleanUrl('https://example.com/')).toBeNull();
    expect(cleanUrl('mailto:me@example.com?utm_source=x')).toBeNull();
  });

  test('a link card offers the clean link only when there was something to clean', () => {
    expect(classify('https://a.example/x?gclid=1').actions).toEqual([{ label: 'Clean link', value: 'https://a.example/x' }]);
    expect(classify('https://a.example/x?gclid=1').detail).toBe('a.example · tracking removed');
    expect(classify('https://a.example/x').actions).toEqual([]);
  });
});

describe('JSON', () => {
  test('a TypeScript type with nested interfaces, optional keys merged from an array, and quoted odd keys', () => {
    const value = { id: 7, name: 'Ana', active: true, tags: ['a', 'b'], address: { city: 'Pune', zip: null }, orders: [{ total: 9.5, note: 'x' }, { total: 3 }], 'x-trace': 'q' };
    expect(jsonToTypeScript(value)).toBe([
      'export interface Address {\n  city: string;\n  zip: null;\n}',
      'export interface Order {\n  total: number;\n  note?: string;\n}',
      'export interface Root {\n  id: number;\n  name: string;\n  active: boolean;\n  tags: string[];\n  address: Address;\n  orders: Order[];\n  "x-trace": string;\n}',
    ].join('\n\n'));
    expect(jsonToTypeScript([1, 'a'])).toBe('export type Root = (number | string)[];');
  });

  test('a JSON card minifies, prettifies and types', () => {
    const card = classify('{\n  "a": 1,\n  "b": [true]\n}');
    expect(card.kind).toBe('json');
    expect(card.detail).toBe('JSON · 2 keys');
    expect(card.actions.find((a) => a.label === 'Minify')?.value).toBe('{"a":1,"b":[true]}');
    expect(card.actions.find((a) => a.label === 'TS type')?.value).toContain('b: boolean[];');
    expect(classify('{not json').kind).toBe('text');
  });
});

describe('code', () => {
  test('languages', () => {
    expect(codeLanguage('SELECT id FROM users WHERE x = 1')).toBe('SQL');
    expect(codeLanguage('npm install\nnpm test')).toBe('Shell');
    expect(codeLanguage('def add(a, b):\n    return a + b')).toBe('Python');
    expect(codeLanguage('fn main() { let mut x = 1; }')).toBe('Rust');
    expect(codeLanguage('const x = () => { return 1 }')).toBe('JavaScript');
    expect(codeLanguage('interface A { b: string }')).toBe('TypeScript');
    expect(codeLanguage('Remember to buy milk')).toBeNull();
  });

  test('one line for shell and SQL only', () => {
    expect(oneLine('$ cd app \\\n  && ls\nnpm test', 'Shell')).toBe('cd app && ls && npm test');
    expect(oneLine('SELECT a\nFROM b\n  WHERE c', 'SQL')).toBe('SELECT a FROM b WHERE c');
    expect(oneLine('def f():\n  pass', 'Python')).toBeNull();
    expect(oneLine('npm test', 'Shell')).toBeNull();
  });
});

// Real-shaped keys (random, as gitleaks makes its test keys); secrets.test.ts covers every rule.
const AWS_KEY = 'AKIAQYLPMN5HHTRWFE6Z';
const STRIPE_KEY = 'sk_live_51H8xQ2rTvKp9WmZa3BnYc7D';
const GITHUB_KEY = 'ghp_R8mZ2kQ7xP4vN9tB6wL3yH5cJ1fD0sGaE2uK';

describe('secrets: one definition for the notch (secrets.ts, gitleaks\' rules)', () => {
  test.each([
    ['AWS', AWS_KEY], ['Stripe', STRIPE_KEY], ['GitHub', GITHUB_KEY],
    ['password in a URL', 'postgres://user:hunter2@localhost:5432/db'],
  ])('%s', (_name, text) => expect(looksSecret(text)).toBe(true));
  test('ordinary text, ordinary links, and documentation placeholders are not secrets', () => {
    for (const text of ['sk_other', 'https://user@example.com/x', 'hello world', '#3b82f6', 'AKIAIOSFODNN7EXAMPLE', 'ghp_' + 'a'.repeat(36)]) expect(looksSecret(text)).toBe(false);
  });
});

describe('the history', () => {
  let dir: string;
  let now: number;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-clips-')); now = 1_000; });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const open = () => new ClipHistory(path.join(dir, 'clipboard.json'), () => now);

  test('newest first; the same copy again moves to the front; secrets and huge copies are refused', () => {
    const history = open();
    history.add('first', 'Safari');
    now++;
    history.add('#3b82f6');
    now++;
    history.add('first');
    expect(history.add(AWS_KEY)).toBe(false); // no sealer: a secret is not kept at all
    expect(history.add('x'.repeat(20_001))).toBe(false);
    expect(history.view(true).items.map((c) => [c.preview, c.kind, c.source])).toEqual([['first', 'text', 'Safari'], ['#3b82f6', 'color', undefined]]);
    expect(fs.readFileSync(path.join(dir, 'clipboard.json'), 'utf8')).not.toContain('AKIA');
  });

  test('stage 6: a secret is kept SEALED — no plain text on disk or in the view — and opens only for reveal', () => {
    // A stand-in for safeStorage: reversible, and visibly not the plain text.
    const sealer = { seal: (t: string) => Buffer.from(t).toString('base64').split('').reverse().join(''), open: (s: string) => Buffer.from(s.split('').reverse().join(''), 'base64').toString() };
    const history = new ClipHistory(path.join(dir, 'clipboard.json'), () => now, sealer);
    expect(history.add(STRIPE_KEY, 'Terminal')).toBe(true);
    now++;
    expect(history.add(STRIPE_KEY)).toBe(true); // the same secret again is the same entry
    const file = fs.readFileSync(path.join(dir, 'clipboard.json'), 'utf8');
    expect(file).not.toContain(STRIPE_KEY);
    expect(file).not.toContain('51H8xQ2r');
    const [card] = history.view(true).items;
    expect(history.view(true).items).toHaveLength(1);
    expect(card).toMatchObject({ kind: 'secret', preview: 'sk_live_••••Yc7D', text: '', detail: 'Stripe key', actions: [], source: 'Terminal' });
    expect(JSON.stringify(history.view(true))).not.toContain('51H8xQ2r');
    expect(history.reveal(card!.id)).toBe(STRIPE_KEY);
    expect(new ClipHistory(path.join(dir, 'clipboard.json'), () => now, sealer).reveal(card!.id)).toBe(STRIPE_KEY);
    expect(history.reveal('no-such-id')).toBeNull();
  });

  test('a sealer that fails keeps nothing, rather than keeping the secret in plain text', () => {
    const broken = { seal: () => { throw new Error('Keychain locked'); }, open: () => '' };
    const history = new ClipHistory(path.join(dir, 'clipboard.json'), () => now, broken);
    expect(history.add(GITHUB_KEY)).toBe(false);
    expect(history.view(true).items).toEqual([]);
  });

  test(`past ${MAX_CLIPS} the oldest unpinned copy makes room; pinned ones stay first and are never dropped`, () => {
    const history = open();
    history.add('keep me');
    const id = history.view(true).items[0]!.id;
    history.pin(id, true);
    for (let i = 0; i < MAX_CLIPS + 5; i++) { now++; history.add(`copy ${i}`); }
    const view = history.view(true);
    expect(view.items[0]).toMatchObject({ preview: 'keep me', pinned: true });
    const reloaded = open();
    expect(reloaded.view(true).items[0]).toMatchObject({ preview: 'keep me', pinned: true });
    expect(reloaded.remove(id)).toBe(true);
    expect(reloaded.view(true).items.some((c) => c.preview === 'keep me')).toBe(false);
  });
});
