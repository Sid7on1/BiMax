import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { QuickAttachment, QuickContext } from '../shared/threads';
import { parseBrowserOutput, parseFinderOutput } from './quick.context';

const run = promisify(execFile);

// Fixed read-only scripts; none interpolates a prompt or a path. All run BEFORE the bar takes focus, so they read
// the app the person was in, never the bar itself.
export const FINDER_CONTEXT_SCRIPT = `tell application "Finder"
  if not frontmost then return ""
  set folderPath to ""
  if (count of windows) is 0 then
    set folderPath to POSIX path of (desktop as alias)
  else
    try
      set folderPath to POSIX path of (insertion location as alias)
    end try
  end if
  set out to folderPath
  try
    repeat with anItem in (get selection)
      set out to out & linefeed & POSIX path of (anItem as alias)
    end repeat
  end try
  return out
end tell`;

const BROWSERS: Record<string, { name: string; script: string }> = {
  'com.apple.Safari': { name: 'Safari', script: `tell application "Safari"
  if (count of windows) is 0 then return ""
  set theTab to current tab of front window
  return (URL of theTab) & linefeed & (name of theTab)
end tell` },
  'com.google.Chrome': { name: 'Chrome', script: `tell application "Google Chrome"
  if (count of windows) is 0 then return ""
  set theTab to active tab of front window
  return (URL of theTab) & linefeed & (title of theTab)
end tell` },
};

const PREVIEW_SCRIPT = `tell application "Preview"
  if (count of documents) is 0 then return ""
  return path of front document
end tell`;

async function osascript(script: string): Promise<string> {
  const { stdout } = await run('/usr/bin/osascript', ['-e', script], { timeout: 8000, maxBuffer: 256 * 1024 });
  return stdout;
}

/** The frontmost app's bundle id, read without any permission prompt. */
async function frontmostBundle(): Promise<string> {
  try {
    const { stdout: asn } = await run('/usr/bin/lsappinfo', ['front'], { timeout: 3000 });
    const { stdout } = await run('/usr/bin/lsappinfo', ['info', '-only', 'bundleid', asn.trim()], { timeout: 3000 });
    return /"CFBundleIdentifier"="([^"]+)"/.exec(stdout)?.[1] ?? '';
  } catch {
    return '';
  }
}

/**
 * What the person had open when they pressed ⌘2: the page in Safari or Chrome, the document in Preview, or the
 * Finder folder with its selected items. Each becomes context for the task; a folder becomes its workspace. A page
 * has no folder of its own, so its task starts in Downloads, which the folder chip shows and the person can change.
 */
export async function finderContext(): Promise<QuickContext> {
  if (process.platform !== 'darwin') return { root: null, source: 'Choose a folder' };
  const bundle = await frontmostBundle();
  const browser = BROWSERS[bundle];
  if (browser) {
    try {
      const page = parseBrowserOutput(await osascript(browser.script));
      if (page) {
        const downloads = await fs.realpath(path.join(os.homedir(), 'Downloads')).catch(() => null);
        return { root: downloads, source: `${browser.name} page`, attachments: [{ kind: 'page', label: page.title || page.url, url: page.url }] };
      }
    } catch { /* not allowed to ask the browser, or nothing open: fall back to Finder */ }
  }
  if (bundle === 'com.apple.Preview') {
    try {
      const file = (await osascript(PREVIEW_SCRIPT)).trim();
      if (file) {
        const real = await fs.realpath(file);
        return { root: path.dirname(real), source: 'Preview', attachments: [{ kind: 'document', label: path.basename(real), path: real }] };
      }
    } catch { /* fall back to Finder */ }
  }
  try {
    const { folder, selection } = parseFinderOutput(await osascript(FINDER_CONTEXT_SCRIPT));
    if (!folder) return { root: null, source: 'Choose a folder', error: 'No active Finder folder. Select the workspace for this thread.' };
    const root = await fs.realpath(folder);
    if (!(await fs.stat(root)).isDirectory()) throw new Error('Finder did not return a folder');
    const attachments: QuickAttachment[] = [];
    for (const item of selection) {
      try {
        const real = await fs.realpath(item);
        attachments.push({ kind: 'file', label: path.basename(real), path: real });
      } catch { /* moved since it was selected */ }
    }
    return { root, source: 'Finder', ...(attachments.length ? { attachments } : {}) };
  } catch {
    return { root: null, source: 'Choose a folder', error: 'Finder context is unavailable. Allow Bimax in macOS Automation settings, or choose a folder.' };
  }
}
