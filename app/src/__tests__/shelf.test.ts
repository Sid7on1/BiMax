import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AMBER_AFTER_MS, MAX_ACTIVE, Shelf, isTemporaryPath } from '../main/shelf';

/**
 * God's Land stage 2 (docs/product-reset/gods-land/03_PLAN.md): the shelf's rules — by reference, temporary files
 * copied, nothing deleted, amber after a day, the same thing twice is one card, it survives a restart.
 */

let dir: string;
let home: string;
let temp: string;
let now: number;
const clock = () => now;
const open = () => new Shelf(path.join(dir, 'shelf.json'), path.join(dir, 'copies'), clock, fs.existsSync, [temp]);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-shelf-'));
  home = path.join(dir, 'home');
  temp = path.join(dir, 'tmp');
  fs.mkdirSync(home);
  fs.mkdirSync(temp);
  now = 1_000_000;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test('files are kept by reference, and a file that is gone says so', () => {
  const report = path.join(home, 'report.pdf');
  fs.writeFileSync(report, 'pdf');
  const shelf = open();
  shelf.add([{ kind: 'file', path: report }]);
  expect(shelf.view().items).toEqual([expect.objectContaining({ kind: 'file', title: 'report.pdf', path: report, missing: false })]);
  fs.rmSync(report);
  expect(shelf.view().items[0]).toMatchObject({ path: report, missing: true });
});

test('a file in a temporary folder is copied, so it outlives the folder', () => {
  const shot = path.join(temp, 'Screenshot.png');
  fs.writeFileSync(shot, 'png');
  const shelf = open();
  shelf.add([{ kind: 'file', path: shot }]);
  const card = shelf.view().items[0];
  expect(card.path).not.toBe(shot);
  expect(card.path!.startsWith(path.join(dir, 'copies'))).toBe(true);
  fs.rmSync(shot);
  expect(shelf.view().items[0]).toMatchObject({ missing: false, title: 'Screenshot.png' });
  expect(fs.readFileSync(card.path!, 'utf8')).toBe('png');
  // Dropping the same temporary file again is the same card, not a second copy.
  fs.writeFileSync(shot, 'png');
  shelf.add([{ kind: 'file', path: shot }]);
  expect(shelf.view().items).toHaveLength(1);
});

test('the same file, link or text again is one card, brought to the front', () => {
  const a = path.join(home, 'a.txt');
  const b = path.join(home, 'b.txt');
  fs.writeFileSync(a, 'a');
  fs.writeFileSync(b, 'b');
  const shelf = open();
  shelf.add([{ kind: 'file', path: a }]);
  now += 10;
  shelf.add([{ kind: 'file', path: b }, { kind: 'url', url: 'https://example.com/x' }, { kind: 'text', text: 'hello\nworld' }]);
  now += 10;
  shelf.add([{ kind: 'file', path: a }, { kind: 'url', url: 'https://example.com/x' }]);
  const titles = shelf.view().items.map((c) => c.title);
  expect(titles).toHaveLength(4);
  expect(titles.slice(0, 2).sort()).toEqual(['a.txt', 'example.com/x']);
  expect(titles).toContain('hello');
});

test('what is not a file, an http(s) link or text is refused', () => {
  const shelf = open();
  expect(shelf.add([{ kind: 'file', path: 'relative/file' }, { kind: 'url', url: 'javascript:alert(1)' }, { kind: 'url', url: 'file:///etc/passwd' }, { kind: 'text', text: '   ' }])).toEqual([]);
  expect(shelf.view().items).toEqual([]);
});

test('after a day untouched a card turns amber and moves to the end; using it makes it fresh', () => {
  const shelf = open();
  const [old] = shelf.add([{ kind: 'text', text: 'old' }]);
  now += AMBER_AFTER_MS + 1;
  shelf.add([{ kind: 'text', text: 'new' }]);
  now += 1;
  const view = shelf.view().items;
  expect(view.map((c) => [c.title, c.amber])).toEqual([['new', false], ['old', true]]);
  shelf.touch(old);
  expect(shelf.view().items.find((c) => c.id === old)?.amber).toBe(false);
});

test('sweeping sends ambers to the archive — never away — and anything archived can be put back', () => {
  const shelf = open();
  const [old] = shelf.add([{ kind: 'text', text: 'old' }]);
  now += AMBER_AFTER_MS + 1;
  const [fresh] = shelf.add([{ kind: 'text', text: 'fresh' }]);
  expect(shelf.archive({ amber: true })).toBe(1);
  expect(shelf.view().items.map((c) => c.id)).toEqual([fresh]);
  expect(shelf.view().archived.map((c) => c.id)).toEqual([old]);
  expect(shelf.archive({ ids: [fresh] })).toBe(1);
  expect(shelf.restore(old)).toBe(true);
  expect(shelf.view().items.map((c) => c.id)).toEqual([old]);
  expect(shelf.view().archived.map((c) => c.id)).toEqual([fresh]);
});

test(`past ${MAX_ACTIVE} cards the least recently used go to the archive`, () => {
  const shelf = open();
  for (let i = 0; i <= MAX_ACTIVE; i++) { shelf.add([{ kind: 'text', text: `item ${i}` }]); now += 1; }
  const view = shelf.view();
  expect(view.items).toHaveLength(MAX_ACTIVE);
  expect(view.archived.map((c) => c.title)).toEqual(['item 0']);
});

test('the shelf survives a restart, and a damaged file starts an empty shelf instead of failing', () => {
  const shelf = open();
  shelf.add([{ kind: 'url', url: 'https://bimax.app/' }]);
  expect(open().view().items.map((c) => c.title)).toEqual(['bimax.app']);
  fs.writeFileSync(path.join(dir, 'shelf.json'), '{broken');
  expect(open().view().items).toEqual([]);
});

test('temporary folders are matched on whole path segments', () => {
  expect(isTemporaryPath('/private/tmp/x.png', ['/private/tmp'])).toBe(true);
  expect(isTemporaryPath('/private/tmpfiles/x.png', ['/private/tmp'])).toBe(false);
  expect(isTemporaryPath('/Users/me/Desktop/x.png', ['/private/tmp'])).toBe(false);
});
