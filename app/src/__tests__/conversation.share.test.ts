import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Export and share (backlog N4), moved out of main/index.ts into conversation.share.ts (flaw list C13). Until the move
 * this code could only run inside the app; these tests drive it through a stand-in for Electron.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-share-test-'));
const showSaveDialog = jest.fn();
const showMessageBox = jest.fn(async () => ({ response: 0 }));
const showItemInFolder = jest.fn();
const popup = jest.fn();
const shareFiles: string[][] = [];

jest.mock('electron', () => ({
  app: { getPath: (name: string) => require('path').join(tmp, name) },
  dialog: { showSaveDialog: (...args: unknown[]) => showSaveDialog(...args), showMessageBox: (...args: unknown[]) => showMessageBox(...(args as [])) },
  shell: { showItemInFolder: (file: string) => showItemInFolder(file) },
  ShareMenu: class { constructor(options: { filePaths: string[] }) { shareFiles.push(options.filePaths); } popup(...args: unknown[]) { popup(...args); } },
  BrowserWindow: class {},
}));

import { exportMenuItems, sessionConversation, setConversationShareHost, threadConversation } from '../main/conversation.share';

const parent = { id: 'quick-bar' } as never;
const notes: Array<[string, string]> = [];

beforeAll(() => {
  for (const dir of ['documents', 'temp']) fs.mkdirSync(path.join(tmp, dir), { recursive: true });
  setConversationShareHost({
    parentWindow: () => parent,
    thread: (id) => {
      if (id !== 't1') throw new Error('no such thread');
      return {
        summary: { title: 'Fix the parser', root: '/work/parser' },
        items: [
          { kind: 'msg', msg: { id: 'u', role: 'user', content: 'Why does the parser drop the last line?', timestamp: '2026-09-29T10:00:00Z' } },
          { kind: 'msg', msg: { id: 'a', role: 'assistant', content: 'It stops at the final newline.', timestamp: '2026-09-29T10:00:05Z' } },
        ] as never,
      };
    },
    addNote: (id, text) => { notes.push([id, text]); },
    projectDir: () => path.join(tmp, 'project'),
  });
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => { jest.clearAllMocks(); notes.length = 0; shareFiles.length = 0; });

const click = async (label: string, load: Parameters<typeof exportMenuItems>[0]) => {
  const item = exportMenuItems(load).find((i) => i.label === label)!;
  (item.click as () => void)();
  await new Promise((resolve) => setTimeout(resolve, 20));
};

test('Export as Markdown writes the conversation where the person chose, notes it in the thread, and shows it', async () => {
  const chosen = path.join(tmp, 'documents', 'parser.md');
  showSaveDialog.mockResolvedValue({ canceled: false, filePath: chosen });
  await click('Export as Markdown…', () => threadConversation('t1'));

  expect(showSaveDialog).toHaveBeenCalledWith(parent, expect.objectContaining({ title: 'Export conversation' }));
  const text = fs.readFileSync(chosen, 'utf8');
  expect(text).toContain('Fix the parser');
  expect(text).toContain('It stops at the final newline.');
  expect(notes).toEqual([['t1', 'Exported this conversation to parser.md.']]);
  expect(showItemInFolder).toHaveBeenCalledWith(chosen);
});

test('a cancelled save writes nothing and adds no note', async () => {
  showSaveDialog.mockResolvedValue({ canceled: true });
  await click('Export as Markdown…', () => threadConversation('t1'));
  expect(notes).toEqual([]);
  expect(showItemInFolder).not.toHaveBeenCalled();
});

test('Share hands the share sheet a Markdown file of the conversation, over the right window', async () => {
  await click('Share…', () => threadConversation('t1'));
  expect(shareFiles).toHaveLength(1);
  const [file] = shareFiles[0]!;
  expect(path.dirname(file!)).toBe(path.join(tmp, 'temp', 'bimax-share'));
  expect(fs.readFileSync(file!, 'utf8')).toContain('Why does the parser drop the last line?');
  expect(popup).toHaveBeenCalledWith({ window: parent });
});

test('an id that is not a saved session is refused with a message, not a crash', async () => {
  await expect(sessionConversation('../../etc/passwd')).rejects.toThrow('That is not a saved session.');
  await click('Export as Markdown…', () => sessionConversation('../../etc/passwd'));
  expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ message: 'Bimax could not export this conversation' }));
  expect(showSaveDialog).not.toHaveBeenCalled();
});
