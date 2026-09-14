import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createEditFileTool } from '../tools/implementations/edit.tool';
import { countWords, createWriteFileTool } from '../tools/implementations/file.tool';
import { createGrepTool, createGlobTool } from '../tools/implementations/search.tool';
import { createTodoWriteTool, getActiveTodos, todosTouchedThisTurn, beginTodoTurn, clearActiveTodos, getTodoPromptBlock } from '../tools/implementations/todo.tool';
import { createBashTool } from '../tools/implementations/bash.tool';
import { detectDegenerateAsk } from '../tools/ask-guard';
import { IGovernor } from '../core/interfaces';

// Governor stub: approve everything so we exercise the tool logic itself.
const governor = { approveTaskExecution: jest.fn().mockResolvedValue(undefined) } as unknown as IGovernor;

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bimax-tools-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('EditFileTool', () => {
  const tool = createEditFileTool(governor);

  it('replaces a unique exact string', async () => {
    const file = path.join(dir, 'a.txt');
    await fs.writeFile(file, 'hello world\ngoodbye world\n');
    const res = await tool.execute({ path: file, oldString: 'hello world', newString: 'hi world' }, { cwd: dir });
    expect(res).toContain('Edited');
    expect(await fs.readFile(file, 'utf8')).toBe('hi world\ngoodbye world\n');
  });

  it('rejects ambiguous matches unless replaceAll', async () => {
    const file = path.join(dir, 'b.txt');
    await fs.writeFile(file, 'dup\ndup\n');
    const res = await tool.execute({ path: file, oldString: 'dup', newString: 'uniq' }, { cwd: dir });
    expect(res).toContain('appears 2 times');

    const all = await tool.execute({ path: file, oldString: 'dup', newString: 'uniq', replaceAll: true }, { cwd: dir });
    expect(all).toContain('2 replacements');
    expect(await fs.readFile(file, 'utf8')).toBe('uniq\nuniq\n');
  });

  it('errors cleanly on missing file and missing match', async () => {
    const missing = await tool.execute({ path: path.join(dir, 'nope.txt'), oldString: 'x', newString: 'y' }, { cwd: dir });
    expect(missing).toContain('File not found');

    const file = path.join(dir, 'c.txt');
    await fs.writeFile(file, 'content');
    const noMatch = await tool.execute({ path: file, oldString: 'absent', newString: 'y' }, { cwd: dir });
    expect(noMatch).toContain('not found in');
  });

  it('rejects identical oldString and newString', async () => {
    const res = await tool.execute({ path: 'whatever.txt', oldString: 'same', newString: 'same' }, { cwd: dir });
    expect(res).toContain('must be different');
  });
});

describe('GrepTool', () => {
  const tool = createGrepTool(governor);

  beforeEach(async () => {
    await fs.writeFile(path.join(dir, 'one.ts'), 'export function alpha() {}\nconst beta = 1;\n');
    await fs.mkdir(path.join(dir, 'sub'));
    await fs.writeFile(path.join(dir, 'sub', 'two.ts'), 'alpha();\nalpha();\n');
    await fs.mkdir(path.join(dir, 'node_modules'));
    await fs.writeFile(path.join(dir, 'node_modules', 'ignored.ts'), 'alpha everywhere');
  });

  it('finds matching lines with line numbers', async () => {
    const res = await tool.execute({ pattern: 'alpha', path: dir }, { cwd: dir });
    expect(res).toContain('one.ts:1:');
    expect(res).toContain('two.ts');
    expect(res).not.toContain('node_modules');
  });

  it('supports files and count output modes', async () => {
    const files = await tool.execute({ pattern: 'alpha', path: dir, outputMode: 'files' }, { cwd: dir });
    expect(files).toContain('2 file(s) matched');

    const count = await tool.execute({ pattern: 'alpha', path: dir, outputMode: 'count' }, { cwd: dir });
    expect(count).toContain('2\t');
  });

  it('filters with a glob and reports invalid regex', async () => {
    await fs.writeFile(path.join(dir, 'notes.md'), 'alpha note');
    const res = await tool.execute({ pattern: 'alpha', path: dir, glob: '**/*.md' }, { cwd: dir });
    expect(res).toContain('notes.md');
    expect(res).not.toContain('one.ts');

    const bad = await tool.execute({ pattern: '([', path: dir }, { cwd: dir });
    expect(bad).toContain('invalid regular expression');
  });
});

describe('GlobTool', () => {
  const tool = createGlobTool(governor);

  it('matches by pattern and excludes ignored dirs', async () => {
    await fs.writeFile(path.join(dir, 'x.ts'), '');
    await fs.mkdir(path.join(dir, 'src'));
    await fs.writeFile(path.join(dir, 'src', 'y.ts'), '');
    await fs.writeFile(path.join(dir, 'z.md'), '');
    await fs.mkdir(path.join(dir, 'node_modules'));
    await fs.writeFile(path.join(dir, 'node_modules', 'dep.ts'), '');

    const res = await tool.execute({ pattern: '**/*.ts', path: dir }, { cwd: dir });
    expect(res).toContain('2 file(s) matched');
    expect(res).toContain('x.ts');
    expect(res).toContain(path.join('src', 'y.ts'));
    expect(res).not.toContain('node_modules');
  });

  it('reports when nothing matches', async () => {
    const res = await tool.execute({ pattern: '**/*.xyz', path: dir }, { cwd: dir });
    expect(res).toContain('No files matched');
  });

  // Defense against parameter-dropping + path-fabrication (report bugs G/K): the result must state
  // WHERE it searched, so a model that dropped a user-specified `path` can see it scanned the wrong
  // place instead of silently scanning cwd and then claiming "the path doesn't exist".
  it('reports the search root it actually used', async () => {
    await fs.mkdir(path.join(dir, 'engine'));
    await fs.writeFile(path.join(dir, 'engine', 'a.ts'), '');
    await fs.writeFile(path.join(dir, 'top.ts'), '');

    const scoped = await tool.execute({ pattern: '**/*.ts', path: 'engine' }, { cwd: dir });
    expect(scoped).toContain('under engine');
    expect(scoped).not.toContain('top.ts');

    // Path omitted → defaults to cwd, and the output says so (not silently misleading).
    const dropped = await tool.execute({ pattern: '**/*.ts' }, { cwd: dir });
    expect(dropped).toContain('under the current directory');
    expect(dropped).toContain('top.ts');
  });
});

describe('TodoWriteTool', () => {
  const tool = createTodoWriteTool(governor);

  it('renders the checklist with progress', async () => {
    const res = await tool.execute({
      todos: [
        { content: 'first', status: 'completed' },
        { content: 'second', status: 'in_progress' },
        { content: 'third', status: 'pending' },
      ],
    });
    expect(res).toContain('1/3 done');
    expect(res).toContain('[x] first');
    expect(res).toContain('[~] second');
    expect(res).toContain('[ ] third');
  });

  it('drops malformed entries', async () => {
    const res = await tool.execute({
      todos: [
        { content: 'ok', status: 'pending' },
        { content: '', status: 'pending' },
        { content: 'bad-status', status: 'wat' } as any,
      ],
    });
    expect(res).toContain('0/1 done');
    expect(res).not.toContain('bad-status');
  });

  // Regression: the model forgot its own phases ("what phases are you talking about?") because the
  // list was UI-only. It must now (a) survive a turn boundary and be re-injectable into the prompt,
  // and (b) only trigger persistence auto-continue on the turn that actually touched it.
  it('persists across turn boundaries and gates the persistence flag', async () => {
    clearActiveTodos();
    await tool.execute({
      todos: [
        { content: 'Phase 1', status: 'completed' },
        { content: 'Phase 2', status: 'in_progress' },
        { content: 'Phase 3', status: 'pending' },
      ],
    });
    expect(todosTouchedThisTurn()).toBe(true);

    // A new user turn begins: the touched flag resets but the list itself is retained as task memory.
    beginTodoTurn();
    expect(todosTouchedThisTurn()).toBe(false);
    expect(getActiveTodos()).toHaveLength(3);

    const block = getTodoPromptBlock();
    expect(block).toContain('Phase 2');
    expect(block).toContain('1/3 done');
    expect(block).toMatch(/phases|tasks|plan/i); // steers the model to answer from the list

    clearActiveTodos();
    expect(getTodoPromptBlock()).toBe('');
  });

});

describe('BashTool — timeout coercion', () => {
  const tool = createBashTool(governor);

  // The model frequently emits `timeout` as a string / float / negative / out-of-range
  // value; before coercion these threw ERR_OUT_OF_RANGE in Node's exec and derailed the
  // whole task. Each of these must run cleanly and return the command's stdout.
  it.each([
    ['string', '300000' as any],
    ['float', 300000.5 as any],
    ['negative', -5 as any],
    ['huge (> 2^31)', 9e12 as any],
    ['undefined', undefined],
  ])('runs the command when timeout is a %s value', async (_label, timeout) => {
    const res: any = await tool.execute({ command: 'echo coerced_ok', timeout }, { cwd: dir });
    expect(String(res)).toContain('coerced_ok');
  });
});

describe('WriteFileTool — exact word counts', () => {
  const tool = createWriteFileTool(governor);

  it('counts a titled document with or without its title', () => {
    const content = 'A Short Title\n\none two\nthree four five';
    expect(countWords(content)).toBe(8);
    expect(countWords(content, true)).toBe(5);
  });

  it('rejects an approximate draft before creating the file', async () => {
    const file = path.join(dir, 'story.txt');
    const res = await tool.execute({
      path: file,
      content: 'The Story\n\none two three four',
      expectedWords: 5,
      excludeTitleFromWordCount: true,
    }, { cwd: dir });

    expect(String(res)).toContain('expected exactly 5 body words, but received 4');
    await expect(fs.access(file)).rejects.toThrow();
  });

  it('writes once the body has the exact requested length', async () => {
    const file = path.join(dir, 'story.txt');
    const content = 'The Story\n\none two three four five';
    const res = await tool.execute({
      path: file,
      content,
      expectedWords: 5,
      excludeTitleFromWordCount: true,
    }, { cwd: dir });

    expect(String(res)).toContain('Word count verified: 5 (title excluded)');
    expect(await fs.readFile(file, 'utf8')).toBe(content);
  });
});

describe('Flattened-file corruption guard', () => {
  const writeTool = createWriteFileTool(governor);
  const editTool = createEditFileTool(governor);

  // A realistic multi-line source file (>5 lines) and the corrupted one-line version a weak
  // model produces by dropping every newline. Same code, no line breaks → breaks compile.
  const multiline = [
    'export class JWTRule {',
    "  private static readonly PATTERNS = ['jwt.sign', 'jwt.verify', 'jwt.decode'];",
    '  public evaluate(graph) {',
    '    const verdicts = [];',
    '    for (const node of graph.nodes()) { verdicts.push(node); }',
    '    return verdicts;',
    '  }',
    '}',
    '',
  ].join('\n');
  const flattened = multiline.replace(/\n/g, ' ');

  it('WriteFileTool refuses a flattened full-file overwrite and leaves the file intact', async () => {
    const file = path.join(dir, 'rule.ts');
    await fs.writeFile(file, multiline);
    const res = await writeTool.execute({ path: file, content: flattened, overwrite: true }, { cwd: dir });
    expect(res).toContain('refused');
    expect(await fs.readFile(file, 'utf8')).toBe(multiline); // unchanged
  });

  it('WriteFileTool refuses a truncating overwrite that drops most of the file', async () => {
    // The exact corruption seen against ArchMind: a 9-line file overwritten with a tiny stub
    // (JSDoc + first line) carrying a literal "\n" instead of a real newline.
    const file = path.join(dir, 'rule2.ts');
    await fs.writeFile(file, multiline);
    const truncated = '/** Detects competing JWT impls. */\\nexport class JWTRule {';
    const res = await writeTool.execute({ path: file, content: truncated, overwrite: true }, { cwd: dir });
    expect(res).toContain('refused');
    expect(await fs.readFile(file, 'utf8')).toBe(multiline); // unchanged
  });

  it('EditFileTool refuses a whole-file oldString→flattened newString', async () => {
    const file = path.join(dir, 'rule3.ts');
    await fs.writeFile(file, multiline);
    const res = await editTool.execute({ path: file, oldString: multiline, newString: flattened }, { cwd: dir });
    expect(res).toContain('refused');
    expect(await fs.readFile(file, 'utf8')).toBe(multiline); // unchanged
  });

  it('does NOT block a legitimate multi-line overwrite (the correct edit)', async () => {
    const file = path.join(dir, 'rule4.ts');
    await fs.writeFile(file, multiline);
    const next = '/** JWT rule. */\n' + multiline; // add a real JSDoc line, keep structure
    const res = await writeTool.execute({ path: file, content: next, overwrite: true }, { cwd: dir });
    expect(res).toContain('Updated');
    expect(res).not.toContain('refused');
    expect(await fs.readFile(file, 'utf8')).toBe(next);
  });

  it('does NOT block a genuinely small file (< 6 lines) being replaced', async () => {
    const file = path.join(dir, 'small.ts');
    await fs.writeFile(file, 'export const a = 1;\nexport const b = 2;\n'); // 2 lines, short
    const stub = 'export const a = 1;\n';
    const res = await writeTool.execute({ path: file, content: stub, overwrite: true }, { cwd: dir });
    expect(res).toContain('Updated');
    expect(res).not.toContain('refused');
  });

  it('overwrites an existing file WITHOUT overwrite:true (no more "file already exists" wedge)', async () => {
    const file = path.join(dir, 'exists.ts');
    await fs.writeFile(file, 'export const a = 1;\nexport const b = 2;\n');
    const next = 'export const a = 1;\nexport const c = 3;\n';
    const res = await writeTool.execute({ path: file, content: next }, { cwd: dir });
    expect(String(res)).not.toMatch(/already exists/i);
    expect(String(res)).toContain('Updated');
    expect(await fs.readFile(file, 'utf8')).toBe(next);
  });
});

describe('Degenerate AskUserTool guard', () => {
  it('refuses the "who are you?" case (garbage question, no valid options)', () => {
    // Exact shape seen in the wild: question "I", options missing → rendered as Ask(I).
    expect(detectDegenerateAsk('I', undefined)).not.toBeNull();
  });

  it('refuses a greeting with a single trivial option', () => {
    // "hi" → Ask(...) with one option ["Continue"]: not a real either/or decision.
    expect(detectDegenerateAsk('Hey! What are we building today?', ['Continue'])).not.toBeNull();
  });

  it('refuses an empty question even with valid options', () => {
    expect(detectDegenerateAsk('', ['Overwrite', 'Cancel'])).not.toBeNull();
  });

  it('refuses when options collapse to fewer than 2 distinct values', () => {
    expect(detectDegenerateAsk('Overwrite the file?', ['Yes', 'yes', ' Yes '])).not.toBeNull();
  });

  it('refuses a non-array options value', () => {
    expect(detectDegenerateAsk('Proceed?', 'Yes' as any)).not.toBeNull();
  });

  it('ALLOWS a genuine collision decision (clear question + 2+ distinct options)', () => {
    expect(detectDegenerateAsk("The folder 'math' already exists. What should I do?", ['Overwrite', 'Cancel', 'Tell me what else to do'])).toBeNull();
  });
});


it('does not write when cancellation arrives during approval', async () => {
  const controller = new AbortController();
  const approval = { approveTaskExecution: jest.fn(async () => { controller.abort(); }) } as unknown as IGovernor;
  const tool = createWriteFileTool(approval);
  const target = path.join(dir, 'cancelled.txt');
  await expect(tool.execute({ path: target, content: 'must not land' }, {
    cwd: dir, signal: controller.signal,
  })).rejects.toThrow();
  await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
});
