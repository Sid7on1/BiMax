import path from 'node:path';

/**
 * `bimax://task` links (backlog N2): Shortcuts, Raycast, Stream Deck or a Focus mode can open a ⌘2 task in a folder,
 * with a prompt.
 *
 *   bimax://task?folder=~/Downloads&prompt=Sort%20the%20PDFs%20by%20month
 *
 * A link never runs anything on its own. It is read here, checked, and shown in a confirmation whose default is Cancel;
 * the task starts only when the person clicks Start, and every action it then takes still asks as usual. Only `folder`
 * and `prompt` are read: anything else in a link is ignored, never acted on.
 */

/** Long enough for a real instruction, short enough that the confirmation always shows all of it. */
export const MAX_LINK_PROMPT = 2000;

export type TaskLink =
  | { ok: true; folder: string; prompt: string }
  | { ok: false; error: string };

export function parseTaskLink(raw: string, home: string): TaskLink {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: 'That is not a valid link.' };
  }
  if (url.protocol !== 'bimax:') return { ok: false, error: 'That is not a Bimax link.' };
  const action = url.hostname || url.pathname.replace(/^\/+/, '');
  if (action !== 'task') return { ok: false, error: 'Bimax links can only start a task: bimax://task?folder=…&prompt=…' };

  const rawFolder = url.searchParams.get('folder')?.trim() ?? '';
  if (!rawFolder) return { ok: false, error: 'The link does not say which folder the task works in.' };
  const expanded = rawFolder === '~' ? home : rawFolder.startsWith('~/') ? path.join(home, rawFolder.slice(2)) : rawFolder;
  if (!path.isAbsolute(expanded) || /[\u0000-\u001f\u007f]/.test(expanded)) return { ok: false, error: 'The folder in the link must be a full path, like ~/Downloads.' };
  const folder = path.resolve(expanded);
  if (folder === '/' || folder === path.resolve(home)) return { ok: false, error: 'Choose a specific folder rather than your whole home folder.' };

  const prompt = url.searchParams.get('prompt')?.trim() ?? '';
  if (prompt.length > MAX_LINK_PROMPT) return { ok: false, error: `The prompt in the link is longer than ${MAX_LINK_PROMPT} characters.` };
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(prompt)) return { ok: false, error: 'The prompt in the link contains control characters.' };
  return { ok: true, folder, prompt };
}

/** What the confirmation says. Cancel is the default and the Escape answer, so only a click on Start starts the task. */
export function linkConfirmation(folder: string, prompt: string): {
  options: { type: 'question'; message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number };
  startIndex: number;
} {
  const name = path.basename(folder) || folder;
  return {
    options: {
      type: 'question',
      message: prompt ? `Start a task in “${name}”?` : `Open a new ⌘2 task in “${name}”?`,
      detail: prompt
        ? `A link asked Bimax to start this task. Nothing runs until you click Start, and Bimax still asks before changing files.\n\nFolder: ${folder}\n\nPrompt:\n${prompt}`
        : `A link asked Bimax to open a task in this folder. Nothing runs until you send a message.\n\nFolder: ${folder}`,
      buttons: ['Start', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    },
    startIndex: 0,
  };
}
