import fs from 'fs';
import os from 'os';
import path from 'path';
import { folderGlance } from '../engine/personas/folder.glance';
import { BiMaxPersona } from '../engine/personas/implementations';
import { ToolRegistry } from '../tools/tool.registry';
import { LlmAdapter } from '../core/llm.adapter';

/**
 * Owner report, 2026-09-30: in a folder holding one lab brief, "check what to do ?" got "What would you like me to
 * check?" — the prompt named the folder but never what was in it.
 */

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-glance-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
const touch = (...names: string[]) => { for (const name of names) fs.writeFileSync(path.join(dir, name), 'x'); };

test('the brief is named first, folders are marked, and noise is left out', () => {
  touch('zeta.py', 'TODO_lab1.md', '.env', '.DS_Store');
  fs.mkdirSync(path.join(dir, 'data'));
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.mkdirSync(path.join(dir, '.git'));
  const block = folderGlance(dir);
  expect(block.split('\n').filter((line) => line.startsWith('- '))).toEqual(['- TODO_lab1.md', '- data/', '- zeta.py']);
  expect(block).toContain('`TODO_lab1.md` looks like the brief for this folder.');
  expect(block).toMatch(/vague message .* is about these files/);
});

test('readmes and numbered lab or assignment sheets count as a brief; ordinary files do not', () => {
  touch('README.md', 'lab2.pdf', 'Assignment_3.docx', 'notes.txt', 'main.py');
  const block = folderGlance(dir);
  expect(block).toContain('`Assignment_3.docx`, `README.md`, `lab2.pdf` look like the brief');
  expect(block).not.toMatch(/`(notes\.txt|main\.py)`/);
});

test('a big folder is cut at the limit and says how many more there are; an empty one says so', () => {
  touch(...Array.from({ length: 12 }, (_, i) => `file${String(i).padStart(2, '0')}.txt`));
  const block = folderGlance(dir, 5);
  expect(block.split('\n').filter((line) => line.startsWith('- ') && !line.startsWith('- …'))).toHaveLength(5);
  expect(block).toContain('- … and 7 more');
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-glance-empty-'));
  try { expect(folderGlance(empty)).toContain('(empty — no files yet)'); } finally { fs.rmSync(empty, { recursive: true }); }
});

test('the listing rides in the per-turn context, fresh each turn, and never in the cached system prompt', () => {
  touch('TODO_lab1.md');
  const persona = new BiMaxPersona(new ToolRegistry(), {} as LlmAdapter);
  persona.cwd = dir;
  const first = persona.getSystemPromptParts({});
  expect(first.turnContext).toContain('- TODO_lab1.md');
  expect(`${first.staticPrefix}\n${first.dynamicSuffix}`).not.toContain('TODO_lab1.md');
  touch('lab1_student.py');
  const next = persona.getSystemPromptParts({});
  expect(next.turnContext).toContain('- lab1_student.py');
  expect(next.dynamicSuffix).toBe(first.dynamicSuffix);
});
