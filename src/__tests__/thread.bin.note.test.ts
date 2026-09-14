import { createBashTool } from '../tools/implementations/bash.tool';
import { binLookNote, movedToBinText } from '../tools/thread.bin';
import { IGovernor } from '../core/interfaces';

/**
 * Bimax cannot read the Bin, and `ls ~/.Trash 2>/dev/null` prints "total 0" for a full one. On 2026-09-14 a talk-mode
 * thread moved Agents.docx to the Bin, was asked to bring it back, read that "total 0" as an empty Bin, and told the
 * user the file could not be restored. It was sitting in iCloud Drive's Bin the whole time.
 */
const governor = { approveTaskExecution: jest.fn().mockResolvedValue(undefined) } as unknown as IGovernor;
const savedRoot = process.env.BIMAX_THREAD_ROOT;

afterEach(() => {
  if (savedRoot === undefined) delete process.env.BIMAX_THREAD_ROOT;
  else process.env.BIMAX_THREAD_ROOT = savedRoot;
});

test('a listing of the Bin that looks empty says the Bin cannot be read, and a thread is pointed at Undo', async () => {
  delete process.env.BIMAX_THREAD_ROOT;
  const res = String(await createBashTool(governor).execute({ command: 'echo "total 0" # ls -la ~/.Trash/ 2>/dev/null' }, { cwd: process.cwd() }));
  expect(res).toContain('total 0');
  expect(res).toContain('Bimax cannot see inside the Bin');
  expect(res).toContain('does not mean the Bin is empty');
  expect(res).toContain('Put Back');
  expect(res).not.toContain('press Undo');

  process.env.BIMAX_THREAD_ROOT = process.cwd();
  expect(binLookNote('ls "/Users/me/Library/Mobile Documents/.Trash"')).toContain('press Undo in this thread');
});

test('the permission error of a Bin listing carries the note too', async () => {
  delete process.env.BIMAX_THREAD_ROOT;
  const res = String(await createBashTool(governor).execute(
    { command: 'echo "ls: /Users/me/.Trash/: Operation not permitted" 1>&2; exit 1' },
    { cwd: process.cwd() },
  ));
  expect(res).toMatch(/exited with code 1/);
  expect(res).toContain('Bimax cannot see inside the Bin');
});

test('a command that does not touch the Bin is unchanged', async () => {
  delete process.env.BIMAX_THREAD_ROOT;
  const res = String(await createBashTool(governor).execute({ command: 'echo hello' }, { cwd: process.cwd() }));
  expect(JSON.parse(res)).toEqual({ stdout: 'hello', stderr: '' });
});

test('after a move to the Bin the model is told how the item comes back, and that it cannot do that itself', () => {
  expect(movedToBinText(['/Users/me/Desktop/Agents.docx'])).toBe(
    'Moved to the Bin:\n/Users/me/Desktop/Agents.docx\nTo bring it back, the user presses Undo in this thread in Bimax. You cannot look inside the Bin or put it back yourself.',
  );
  expect(movedToBinText(['/a', '/b'])).toContain('To bring them back');
});
