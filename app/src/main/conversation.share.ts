import { app, BrowserWindow, dialog, shell, ShareMenu } from 'electron';
import fsp from 'node:fs/promises';
import * as path from 'path';
import type { TranscriptItem } from '../renderer/src/engine.state';
import { conversationHtml, conversationMarkdown, exportFileName, sessionFile, sessionItems } from './thread.export';
import { readSessionMeta } from './files';

/** What exporting needs from the app: moved out of main/index.ts (flaw list C13), which owns this state. */
export interface ConversationShareHost {
  /** The window a save dialog or share sheet belongs to: the ⌘2 bar while it is showing, else the main window. */
  parentWindow(): BrowserWindow | null;
  /** A live Bimax Thread's summary and transcript. */
  thread(id: string): { summary: Conversation['summary']; items: readonly TranscriptItem[] };
  addNote(threadId: string, text: string): void;
  /** The open project, where saved sessions live. */
  projectDir(): string;
}

let host: ConversationShareHost = {
  parentWindow: () => null,
  thread: () => { throw new Error('Conversation export is not set up yet.'); },
  addNote: () => undefined,
  projectDir: () => '',
};
export function setConversationShareHost(next: ConversationShareHost): void { host = next; }

/**
 * Export a conversation (backlog N4). The PDF is printed from a hidden window with JavaScript off, no pop-ups and no
 * navigation, loading a page whose policy allows no script and no network load (thread.export.ts), so nothing in a
 * conversation can act while it is drawn.
 */
async function conversationPdf(markdown: string, title: string): Promise<Buffer> {
  const dir = await fsp.mkdtemp(path.join(app.getPath('temp'), 'bimax-export-'));
  const page = path.join(dir, 'conversation.html');
  const printer = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    printer.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await fsp.writeFile(page, conversationHtml(markdown, title), 'utf8');
    await printer.loadFile(page);
    printer.webContents.on('will-navigate', (event) => event.preventDefault());
    return await printer.webContents.printToPDF({ pageSize: 'A4', printBackground: true });
  } finally {
    printer.destroy();
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** What an export reads: a live thread, or a session saved by the engine and listed in the Sessions gallery. */
export type Conversation = { summary: { title: string; root: string; model?: string }; items: readonly TranscriptItem[]; threadId?: string };

export function threadConversation(id: string): Conversation {
  return { ...host.thread(id), threadId: id };
}

export async function sessionConversation(id: string): Promise<Conversation> {
  const root = host.projectDir();
  const file = sessionFile(root, id);
  if (!file) throw new Error('That is not a saved session.');
  const meta = (await readSessionMeta(root)).find((m) => m.id === id);
  const title = meta?.title && meta.title !== '(no messages yet)' ? meta.title : `Session ${id}`;
  return { summary: { title, root: meta?.cwd || root }, items: sessionItems(await fsp.readFile(file, 'utf8')) };
}

async function exportConversation(load: () => Conversation | Promise<Conversation>, format: 'md' | 'pdf'): Promise<void> {
  try {
    const { summary, items, threadId } = await load();
    const markdown = conversationMarkdown(summary, items);
    const parent = host.parentWindow();
    const options: Electron.SaveDialogOptions = {
      title: 'Export conversation',
      defaultPath: path.join(app.getPath('documents'), exportFileName(summary.title, format)),
      filters: format === 'md' ? [{ name: 'Markdown', extensions: ['md'] }] : [{ name: 'PDF', extensions: ['pdf'] }],
    };
    const chosen = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
    if (chosen.canceled || !chosen.filePath) return;
    await fsp.writeFile(chosen.filePath, format === 'md' ? markdown : await conversationPdf(markdown, summary.title));
    if (threadId) host.addNote(threadId, `Exported this conversation to ${path.basename(chosen.filePath)}.`);
    shell.showItemInFolder(chosen.filePath);
  } catch (error) {
    void dialog.showMessageBox({ type: 'warning', message: 'Bimax could not export this conversation', detail: (error as Error).message });
  }
}

/** The share sheet (AirDrop, Mail, Messages…) with the conversation as a Markdown file. */
async function shareConversation(load: () => Conversation | Promise<Conversation>): Promise<void> {
  try {
    const { summary, items } = await load();
    const dir = path.join(app.getPath('temp'), 'bimax-share');
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, exportFileName(summary.title, 'md'));
    await fsp.writeFile(file, conversationMarkdown(summary, items), 'utf8');
    const parent = host.parentWindow();
    new ShareMenu({ filePaths: [file] }).popup(parent ? { window: parent } : {});
  } catch (error) {
    void dialog.showMessageBox({ type: 'warning', message: 'Bimax could not share this conversation', detail: (error as Error).message });
  }
}

export function exportMenuItems(load: () => Conversation | Promise<Conversation>): Electron.MenuItemConstructorOptions[] {
  return [
    { label: 'Export as Markdown…', click: () => void exportConversation(load, 'md') },
    { label: 'Export as PDF…', click: () => void exportConversation(load, 'pdf') },
    { label: 'Share…', click: () => void shareConversation(load) },
  ];
}
