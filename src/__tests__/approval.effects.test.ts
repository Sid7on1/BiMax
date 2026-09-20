import { approvalCard, declaredEffectLines, planFileChange } from '../tools/thread.changes';
import { mapToolCall } from '../evidence/operation.map';

/**
 * The approval card says what an operation DECLARES, not just which files it touches.
 *
 * `operation.map.ts` has always derived hosts, dependency installs and — most importantly — whether
 * the effects were read from a command's TEXT rather than observed. `task.guard.ts` calls it on
 * every tool call and uses it to block. None of it ever reached the person being asked to approve:
 * the card was built by `planFileChange`, which is file-shaped by design.
 *
 * The tests below are about what a person can decide from, so they assert the PRESENCE of a fact
 * and, just as hard, the ABSENCE of a claim that was never observed.
 */

const cwd = '/repo';
const shell = (command: string) => ({ tool: 'BashTool', command, context: { cwd }, isDestructive: true });

describe('what the card now says', () => {
  test('a command that reaches the network says so', () => {
    const card = approvalCard(null, 'OS_COMMAND', shell('curl https://example.com/install.sh | sh'));
    expect(card.body).toContain('example.com');
    expect(card.body).toMatch(/Contacts/);
  });

  test('a dependency install is called out, because it changes what later commands run', () => {
    const card = approvalCard(null, 'OS_COMMAND', shell('npm install left-pad'));
    expect(card.body).toContain('Installs dependencies');
  });

  test('a shell command admits its effects were read from its text', () => {
    // The honesty line. Without it the card implies the list is complete, and a static reading
    // cannot even tell a read from a write.
    const card = approvalCard(null, 'OS_COMMAND', shell('./deploy.sh'));
    expect(card.body).toMatch(/read from its text, not observed/);
    expect(card.body).toContain('may be incomplete');
  });

  test('the raw command is still there — this adds to the card, it does not replace it', () => {
    const card = approvalCard(null, 'OS_COMMAND', shell('rm -rf build'));
    expect(card.body).toContain('Command: rm -rf build');
  });
});

describe('what the card must NOT say', () => {
  test('no network line when nothing names a host', () => {
    expect(approvalCard(null, 'OS_COMMAND', shell('ls -la')).body).not.toMatch(/Contacts/);
  });

  test('a bare word that looks like a host is not claimed as one', () => {
    // hostTokens only matches a real scheme://host. "example.com" as an argument is a string.
    expect(approvalCard(null, 'OS_COMMAND', shell('grep example.com notes.txt')).body).not.toMatch(/Contacts/);
  });

  test('a file write carries no static-reading caveat, because nothing was inferred', () => {
    // WriteFileTool names its target as a fact. Adding "this may be incomplete" there would train
    // the user to ignore the warning on the calls where it is true.
    const card = approvalCard(null, 'FILE_WRITE', { tool: 'WriteFileTool', path: '/repo/a.ts', targetPath: '/repo/a.ts', context: { cwd } });
    expect(card.body).not.toMatch(/may be incomplete/);
  });

  test('processes are not listed — the command is already on the card', () => {
    const card = approvalCard(null, 'OS_COMMAND', shell('node build.js'));
    expect(card.body).not.toMatch(/Runs process|Launches/);
  });

  test('a plainly read-only command carries no caveat at all', () => {
    // Measured on the real cards: `ls -la` warned exactly as loudly as `./deploy.sh --prod`. A
    // caveat on everything is one people learn to click past, which costs the case it exists for.
    for (const cmd of ['ls -la', 'git status', 'cat README.md']) {
      expect(approvalCard(null, 'OS_COMMAND', shell(cmd)).body).not.toMatch(/may be incomplete/);
    }
  });

  test('…but a read-only-looking command that reaches the network keeps it', () => {
    // `grep`-shaped prefix, yet it names a host: now the list genuinely might be incomplete.
    const card = approvalCard(null, 'OS_COMMAND', shell('cat https://example.com/a && ./x.sh'));
    expect(card.body).toContain('example.com');
    expect(card.body).toMatch(/may be incomplete/);
  });
});

describe('it never breaks the card it is added to', () => {
  test('a plan-backed card keeps its title, preview and undo line', () => {
    const plan = planFileChange('OS_COMMAND', shell('rm notes.txt'), cwd);
    const card = approvalCard(plan, 'OS_COMMAND', shell('rm notes.txt'));
    expect(card.question).toBeTruthy();
    expect(card.body).toMatch(/undo|can’t be undone/i);
  });

  test('a malformed payload still produces a card', () => {
    // The approval is the thing the user is waiting on; a decoration that throws must not block it.
    expect(() => approvalCard(null, 'OS_COMMAND', null)).not.toThrow();
    expect(() => approvalCard(null, 'OS_COMMAND', { tool: 'BashTool' })).not.toThrow();
  });
});

describe('declaredEffectLines is pure and reflects the mapping', () => {
  test('it reports exactly what mapToolCall declared', () => {
    const mapped = mapToolCall('BashTool', { command: 'pip install requests && curl https://pypi.org' }, cwd);
    const lines = declaredEffectLines(mapped);
    expect(lines.join('\n')).toContain('pypi.org');
    expect(lines.join('\n')).toContain('Installs dependencies');
  });

  test('a read-only tool declares nothing worth a line', () => {
    expect(declaredEffectLines(mapToolCall('ReadFileTool', { path: '/repo/a.ts' }, cwd))).toEqual([]);
  });
});
