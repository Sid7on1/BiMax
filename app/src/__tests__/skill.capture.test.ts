import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { saveSkill, skillDraft, skillMarkdown, skillName } from '../main/skill.capture';

/** Backlog FL6: a task that worked and passed its check becomes a skill — from what it actually did. */

const tool = (toolName: string, input: object, status = 'success', parentId?: string) =>
  ({ kind: 'tool', call: { id: Math.random().toString(), toolName, input: JSON.stringify(input), output: '', status, startTime: '', ...(parentId ? { parentId } : {}) } }) as any;
const items = [
  { kind: 'msg', msg: { id: 'u', role: 'user', content: 'Rename the receipts by date: vendor', timestamp: '' } },
  tool('GlobTool', { pattern: '*.pdf' }),
  tool('ReadFileTool', { path: 'a.pdf' }),
  tool('BashTool', { command: 'pdftotext a.pdf -' }),
  tool('BashTool', { command: 'pdftotext a.pdf -' }),
  tool('OrganizePlanTool', { title: 'Rename receipts', moves: [{}, {}, {}] }),
  tool('BashTool', { command: 'rm -rf /' }, 'error'),
  tool('BashTool', { command: 'helper step' }, 'success', 'parent-1'),
  tool('CompletionCheckTool', { action: 'set', checks: [{ kind: 'command', command: 'ls 2026-*.pdf' }, { kind: 'file', path: 'index.md', contains: 'Total' }, { kind: 'json', path: 'out.json' }] }),
] as any[];

test('the draft keeps what the task did, not how it looked around, and how it was checked', () => {
  const draft = skillDraft({ title: 'Rename the receipts by date', request: 'Rename the receipts by date: vendor', items, touched: ['/r/2026-09-01 Cafe.pdf', '/r/2026-09-02 Bus.PDF', '/r/index.md'] });
  expect(draft).toEqual({
    name: 'rename-the-receipts-by-date',
    description: 'Use for: Rename the receipts by date: vendor',
    inputs: ['files like *.md, *.pdf'],
    steps: ['Bash: pdftotext a.pdf -', 'OrganizePlan: Rename receipts: 3 moves'],
    checks: ['run `ls 2026-*.pdf` — it must succeed', 'index.md contains “Total”', 'out.json is valid JSON'],
    samples: ['2026-09-01 Cafe.pdf', '2026-09-02 Bus.PDF', 'index.md'],
  });
});

test('the file the engine reads: valid frontmatter even with ": " in the request, and "check first"', () => {
  const draft = skillDraft({ title: 'Receipts', request: 'Rename: date: vendor', items, touched: ['/r/a.pdf'] });
  const text = skillMarkdown(draft, 2, new Date('2026-09-22T10:00:00Z'));
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text)![1]!;
  expect(yaml.load(front)).toEqual({ name: 'receipts', description: 'Use for: Rename: date: vendor', version: 2 });
  expect(text).toContain('## Check first');
  expect(text).toContain('do NOT follow them: work the task out afresh');
  expect(text).toContain('1. Bash: pdftotext a.pdf -');
  expect(text).toContain('Register these with CompletionCheckTool');
  expect(skillMarkdown({ ...draft, inputs: [], samples: [], steps: [], checks: [] }, 1, new Date())).not.toContain('## How to check it worked');
});

test('names are safe folder names', () => {
  expect(skillName('Sort ~/Downloads by Type!')).toBe('sort-downloads-by-type');
  expect(skillName('!!!')).toBe('saved-task');
  expect(skillName('x'.repeat(80))).toHaveLength(48);
});

test('saving again keeps the earlier version beside the new one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-skills-'));
  try {
    const draft = skillDraft({ title: 'Receipts', request: 'Rename receipts', items, touched: [] });
    expect(await saveSkill(dir, draft, new Date())).toEqual({ file: path.join(dir, 'receipts', 'SKILL.md'), version: 1 });
    const second = await saveSkill(dir, { ...draft, description: 'Use for: v2' }, new Date());
    expect(second.version).toBe(2);
    expect(fs.readFileSync(path.join(dir, 'receipts', 'versions', 'v1.md'), 'utf8')).toContain('version: 1');
    expect(fs.readFileSync(second.file, 'utf8')).toContain('"Use for: v2"');
    await saveSkill(dir, draft, new Date());
    expect(fs.readdirSync(path.join(dir, 'receipts', 'versions')).sort()).toEqual(['v1.md', 'v2.md']);
    await expect(saveSkill(dir, { ...draft, name: '../evil' }, new Date())).rejects.toThrow('lowercase letters');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
