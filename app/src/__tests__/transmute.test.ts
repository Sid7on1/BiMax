import { countUse, envExample, familyOf, isTransmutation, transmutationsFor } from '../main/transmute';

/** God's Land stage 7: what each file can become, in what order, and the one local transform done in the app. */

test('families by name', () => {
  expect(['/a/shot.PNG', '/a/b.pdf', '/a/x.tsx', '/a/d.csv', '/a/n.md', '/a/.env.local', '/a/prod.env', '/a/app.zip'].map(familyOf))
    .toEqual(['image', 'pdf', 'code', 'data', 'notes', 'env', 'env', 'other']);
});

test('images are local only, and WebP is not offered (the Mac cannot write it)', () => {
  const actions = transmutationsFor('/a/hero.png');
  expect(actions.every((a) => a.kind === 'local')).toBe(true);
  expect(actions.map((a) => a.id)).toEqual(['compress', 'avif', 'heic', 'png', 'jpeg', 'remove-background', 'ocr', 'base64']);
  expect(actions.some((a) => /webp/i.test(a.label))).toBe(false);
});

test('code, data and notes become ⌘2 tasks with the request written; other files have nothing', () => {
  const tests = transmutationsFor('/w/parser.ts')[0]!;
  expect(tests).toMatchObject({ id: 'task:tests', kind: 'task' });
  expect(tests.prompt).toMatch(/unit tests/);
  expect(transmutationsFor('/w/notes.md').map((a) => a.label)).toEqual(['Make Concise', 'Fix Grammar', 'Summarise']);
  expect(transmutationsFor('/w/app.zip')).toEqual([]);
});

test('the order is learned per file type: the most used first, the rest keep their order', () => {
  let counts = {};
  counts = countUse(counts, '/a/x.png', 'ocr');
  counts = countUse(counts, '/b/y.jpg', 'ocr');
  counts = countUse(counts, '/c/z.png', 'base64');
  expect(counts).toEqual({ 'image:ocr': 2, 'image:base64': 1 });
  expect(transmutationsFor('/d/w.heic', counts).map((a) => a.id)).toEqual(['ocr', 'base64', 'compress', 'avif', 'heic', 'png', 'jpeg', 'remove-background']);
  // Another family is not affected.
  expect(transmutationsFor('/d/w.pdf', counts)[0]!.id).toBe('pdf-compress');
});

test('a request from the helper is checked against the file\'s own actions', () => {
  expect(isTransmutation('/a/x.png', 'compress')?.kind).toBe('local');
  expect(isTransmutation('/a/x.png', 'pdf-page1')).toBeNull();
  expect(isTransmutation('/a/x.txt', 'rm -rf')).toBeNull();
  // An image action on a text file, a PDF action on code: another family's actions are refused too.
  expect(isTransmutation('/a/notes.txt', 'compress')).toBeNull();
  expect(isTransmutation('/w/parser.ts', 'pdf-page1')).toBeNull();
});

test('.env.example keeps the layout and every harmless value, and replaces anything that could be a secret', () => {
  const env = [
    '# Shop settings',
    'PORT=3000',
    'export NODE_ENV=production',
    'STRIPE_KEY=sk_live_51H8xQ2rTvKp9WmZa3BnYc7D',
    'DATABASE_URL="postgres://app:s3cret@localhost:5432/shop"',
    'SESSION_SECRET=abc123',
    '',
    'FEATURE_FLAG=true # comment',
  ].join('\n');
  expect(envExample(env)).toBe([
    '# Shop settings',
    'PORT=3000',
    'export NODE_ENV=production',
    'STRIPE_KEY=<stripe_key>',
    'DATABASE_URL=<database_url>',
    'SESSION_SECRET=<session_secret>',
    '',
    'FEATURE_FLAG=true',
  ].join('\n'));
  expect(envExample(env)).not.toContain('51H8xQ2r');
  expect(envExample(env)).not.toContain('s3cret');
});
