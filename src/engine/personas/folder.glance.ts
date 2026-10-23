import * as fs from 'fs';
import * as path from 'path';

/**
 * What is in the folder the task works in, told to the model with every user message.
 *
 * The prompt used to give only the folder's PATH. Owner report, 2026-09-30: a folder holding one lab brief
 * (`TODO_lab1.md`) was opened and the first message was "check what to do ?" — the model answered "What would you like
 * me to check?", and only after "do you see any file ?" did it run `ls -la` and find the brief. It could not know the
 * file was there. This block is the folder's top level, read fresh each turn (it rides in the per-turn context, so a
 * file created mid-task shows up next turn and the cached system prompt is untouched), with the files that are most
 * likely the person's brief named first.
 */

/** At most this many entries are listed; a folder like ~/Desktop has hundreds. */
export const FOLDER_GLANCE_LIMIT = 40;

/** Never worth listing: version control, installed packages, caches, and Bimax's own state. */
const NOISE = new Set(['.git', 'node_modules', '__pycache__', '.DS_Store', '.bimax', '.breakglass', '.venv', 'venv', '.idea', '.vscode', '.next', '.cache']);

/** A file that is probably what the person means by "this" or "what to do": a readme, a to-do, a brief, a lab sheet. */
// Not `\b`: an underscore is a word character, so `\b` missed exactly "TODO_lab1.md", the file in the report.
const BRIEF = /^(readme|todo|instructions?|assignment|brief|tasks?|spec|lab|hw|homework)(?=$|[^a-z])/i;

export function folderGlance(dir: string, limit = FOLDER_GLANCE_LIMIT): string {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !NOISE.has(entry.name) && !entry.name.startsWith('.'));
  const briefs = entries.filter((entry) => !entry.isDirectory() && BRIEF.test(entry.name));
  const rank = (entry: fs.Dirent): number => (briefs.includes(entry) ? 0 : entry.isDirectory() ? 1 : 2);
  const ordered = [...entries].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const shown = ordered.slice(0, limit).map((entry) => `- ${entry.name.slice(0, 120)}${entry.isDirectory() ? '/' : ''}`);
  const more = ordered.length > shown.length ? `\n- … and ${ordered.length - shown.length} more` : '';
  const listing = entries.length ? `${shown.join('\n')}${more}` : '(empty — no files yet)';
  const start = briefs.length
    ? `\n${briefs.length === 1 ? `\`${briefs[0]!.name}\` looks like` : `${briefs.slice(0, 3).map((b) => `\`${b.name}\``).join(', ')} look like`} the brief for this folder.`
    : '';
  return `### THIS FOLDER — ${path.basename(dir) || dir} (what is in it now)\n${listing}${start}\n`
    + 'The person opened this folder to work on what is in it. A short or vague message — "check what to do", "what does '
    + 'it mean?", "explain this", "start" — is about these files: read the one it most likely means (a readme, to-do or '
    + 'brief first) and answer from it, instead of asking what they mean. Ask only when several files fit equally well.';
}
