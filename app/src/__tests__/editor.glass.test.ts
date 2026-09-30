import fs from 'node:fs';
import path from 'node:path';

/**
 * Owner reports, 2026-09-30: an open file was "the black again" in a glass window, code in the chat was "just white
 * text", and the composer's Brief was no longer wanted. check:glass-contrast holds the code colours to AA, but it
 * cannot notice an opaque ground coming back — black under light code passes contrast — so these pin the structure.
 */

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const editor = read('renderer/src/components/EditorPane.tsx');
const css = read('renderer/src/styles.css');
// The theme and the syntax colours, without their comments (which quote the old hex values on purpose).
const theme = editor.slice(editor.indexOf('const workbenchTheme'), editor.indexOf('function langFor'))
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the editor paints no ground of its own and takes every colour from a token', () => {
  expect(theme).toMatch(/'&': \{ backgroundColor: 'transparent'/);
  expect(theme).toMatch(/'\.cm-gutters': \{ backgroundColor: 'transparent'/);
  expect(theme.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
  expect(theme).not.toMatch(/dark: true/);
});

test('both themes define every code colour the editor and the chat use', () => {
  const used = new Set([...`${theme}\n${css}`.matchAll(/var\((--code-[\w-]+)\)/g)].map((m) => m[1]));
  expect(used.size).toBeGreaterThan(15);
  const block = (selector: string) => {
    const at = css.indexOf(`${selector} {\n  --code-ink`);
    expect(at).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf('\n}', at));
  };
  for (const selector of [':root,\n.theme-moonlight', '.theme-starlight']) {
    const defined = block(selector);
    expect([...used].filter((token) => !defined.includes(`${token}:`))).toEqual([]);
  }
});

test('code in the chat is coloured with the same tokens, not the monochrome greys', () => {
  const hljs = css.split('\n').filter((line) => /^\s*\.hljs-/.test(line) && /color:/.test(line));
  expect(hljs.length).toBeGreaterThan(10);
  expect(hljs.filter((line) => !/var\(--code-/.test(line))).toEqual([]);
  expect(read('renderer/src/markdown.tsx')).toMatch(/<pre className="[^"]*bg-\[var\(--code-block\)\]/);
});

test('the composer has no Brief', () => {
  const composer = read('renderer/src/components/Composer.tsx');
  expect(composer).not.toMatch(/Brief|composer-brief|draft\.constraints|draft\.checks/);
});
