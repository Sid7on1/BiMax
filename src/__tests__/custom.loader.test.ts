import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseCommandFile, substituteArgs, loadCustomCommands } from '../engine/commands/custom.loader';
import { globalCommandRegistry } from '../engine/commands/registry';

// A1 — user-defined slash commands from .bimax/commands/*.md.
describe('parseCommandFile (A1, pure)', () => {
  it('parses front-matter + body', () => {
    const p = parseCommandFile('---\ndescription: Review diff\ncategory: Source Control\n---\nReview the staged diff.');
    expect(p.description).toBe('Review diff');
    expect(p.category).toBe('Source Control');
    expect(p.body).toBe('Review the staged diff.');
  });

  it('uses the first body line as description when no front-matter', () => {
    const p = parseCommandFile('Summarize the open PRs\nand list risks.');
    expect(p.description).toBe('Summarize the open PRs');
    expect(p.body).toBe('Summarize the open PRs\nand list risks.');
  });
});

describe('substituteArgs (A1, pure)', () => {
  it('substitutes $ARGUMENTS and positional $1..$9', () => {
    expect(substituteArgs('fix $1 in $2 — note: $ARGUMENTS', ['authBug', 'login.ts'])).toBe(
      'fix authBug in login.ts — note: authBug login.ts'
    );
  });
  it('replaces missing positionals with empty string', () => {
    expect(substituteArgs('a=$1 b=$2', ['x'])).toBe('a=x b=');
  });
});

describe('loadCustomCommands (A1, integration)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgw-cmd-'));
    fs.writeFileSync(path.join(dir, 'review.md'), '---\ndescription: Review the diff\n---\nReview $ARGUMENTS and report bugs.');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('registers a /command that renders its template on execute', async () => {
    const loaded = loadCustomCommands([dir]);
    expect(loaded).toContain('/review');

    const cmd = (globalCommandRegistry as any).commands.get('/review');
    expect(cmd).toBeDefined();
    expect(cmd.description).toBe('Review the diff');

    const res = await cmd.execute(['payments.ts'], {} as any);
    expect(res).toEqual({ type: 'redirect', command: 'Review payments.ts and report bugs.' });
  });

  it('first dir wins on name collision', () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bgw-cmd2-'));
    fs.writeFileSync(path.join(dir2, 'review.md'), 'SECOND version $ARGUMENTS');
    const loaded = loadCustomCommands([dir, dir2]);
    expect(loaded.filter(n => n === '/review')).toHaveLength(1);
    fs.rmSync(dir2, { recursive: true, force: true });
  });
});
