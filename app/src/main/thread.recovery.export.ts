import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ThreadStorage } from './thread.storage';

/** User-selected local export of retained bytes. Never parse an oversized/corrupt source. */
export async function exportRecoveryCopy(source: string, destination: string, storageRoot: string): Promise<void> {
  const root = await fs.realpath(storageRoot);
  const target = path.join(await fs.realpath(path.dirname(destination)), path.basename(destination));
  if (target === root || target.startsWith(root + path.sep)) throw new Error('Choose a location outside saved conversation storage. The original must remain unchanged.');
  const input = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const temporary = `${target}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const before = await input.stat();
    if (!before.isFile() || before.nlink !== 1) throw new Error('Recovery source is not a regular private file.');
    const output = await fs.open(temporary, 'wx', 0o600);
    created = true;
    const digest = createHash('sha256');
    try {
      // Fixed I/O buffering bounds memory independently of retained snapshot size.
      const buffer = Buffer.alloc(64 * 1024);
      let position = 0;
      while (position < before.size) {
        const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
        if (!bytesRead) throw new Error('Recovery source changed during export. Try again.');
        digest.update(buffer.subarray(0, bytesRead));
        let written = 0;
        while (written < bytesRead) {
          const result = await output.write(buffer, written, bytesRead - written, position + written);
          if (!result.bytesWritten) throw new Error('Recovery export could not write the complete copy.');
          written += result.bytesWritten;
        }
        position += bytesRead;
      }
      await output.sync();
    } finally { await output.close(); }
    const copy = createHash('sha256');
    const check = await fs.open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { for await (const chunk of check.createReadStream({ autoClose: false })) copy.update(chunk); }
    finally { await check.close(); }
    if (copy.digest('hex') !== digest.digest('hex')) throw new Error('Recovery copy verification failed. Nothing was replaced.');
    const after = await input.stat(), current = await fs.lstat(source);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
        current.ino !== before.ino || current.dev !== before.dev || current.isSymbolicLink())
      throw new Error('Recovery source changed during export. Try again.');
    await fs.rename(temporary, target);
  } finally { await input.close(); if (created) await fs.rm(temporary, { force: true }); }
}

/** Shared production action: renderer-controlled ids are resolved before showing the native picker. */
export function recoveryExportAction(storage: ThreadStorage, choose: (id: string) => Promise<string | null>) {
  return async (id: unknown, archived: unknown, backup: unknown = false): Promise<{ ok: boolean; cancelled?: boolean; error?: string }> => {
    try {
      if (typeof id !== 'string' || typeof archived !== 'boolean' || typeof backup !== 'boolean') throw new Error('Choose a retained recovery copy.');
      const source = storage.recoveryFile(id, archived, backup);
      const destination = await choose(id);
      if (!destination) return { ok: false, cancelled: true };
      await exportRecoveryCopy(source, destination, storage.recoveryRoot());
      return { ok: true };
    } catch (error) { return { ok: false, error: (error as Error).message }; }
  };
}
