import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import type { QuickContext } from '../shared/threads';

// Fixed read-only script, never interpolates a prompt/path. Invoked BEFORE the bar takes focus.
export const FINDER_CONTEXT_SCRIPT = `tell application "Finder"
  if not frontmost then return ""
  if (count of windows) is 0 then return POSIX path of (desktop as alias)
  try
    return POSIX path of (insertion location as alias)
  on error
    return ""
  end try
end tell`;

export async function finderContext(): Promise<QuickContext> {
  if (process.platform !== 'darwin') return { root:null, source:'Choose a folder' };
  try {
    const { stdout } = await promisify(execFile)('/usr/bin/osascript',['-e',FINDER_CONTEXT_SCRIPT], { timeout:8000, maxBuffer:8192 });
    const value = stdout.trim();
    if (!value) return { root:null, source:'Choose a folder', error:'No active Finder folder. Select the workspace for this thread.' };
    const root = await fs.realpath(value);
    if (!(await fs.stat(root)).isDirectory()) throw new Error('Finder did not return a folder');
    return { root, source:'Finder' };
  } catch {
    return { root:null, source:'Choose a folder', error:'Finder context is unavailable. Allow Bimax in macOS Automation settings, or choose a folder.' };
  }
}
