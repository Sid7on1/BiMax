import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

/**
 * Which build is running (record 65 stage 5, build → run → prove): the executable a process was started from, and the
 * SHA-256 of that file now. A task that built an app and then looks at it can compare this with the hash of what it
 * built, and the receipt of a press names the build that was pressed — so "the clicked binary contains the patch" is
 * evidence, not a claim. Read by the app, never by the model, from the process id the driver reported.
 */
export interface ProcessIdentity { path: string; sha256: string }

export async function identifyProcess(pid: number): Promise<ProcessIdentity | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const run = (file: string, args: string[]) => new Promise<string>((resolve) => {
    execFile(file, args, { timeout: 5_000 }, (error, stdout) => resolve(error ? '' : String(stdout)));
  });
  // `comm=` is the full executable path for an app macOS opened from its bundle; a program started by name (`node`)
  // shows only that name, so the first text mapping lsof reports — the executable itself — is asked for then.
  let path = (await run('/bin/ps', ['-o', 'comm=', '-p', String(pid)])).trim();
  if (!path.startsWith('/')) {
    path = (await run('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'])).split('\n').find((line) => line.startsWith('n/'))?.slice(1) ?? '';
  }
  if (!path.startsWith('/')) return null;
  try {
    return { path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') };
  } catch {
    return null;
  }
}
