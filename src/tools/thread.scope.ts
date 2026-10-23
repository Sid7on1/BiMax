import * as fs from 'fs/promises';
import * as path from 'path';
import { resolvePath } from './path.util';
import { classifiedError } from './outcome';

/** Resolve every existing ancestor, including symlinks above several not-yet-created directories. */
export async function canonicalTarget(value: string): Promise<string> {
  let cursor = value;
  const missing: string[] = [];
  for (;;) {
    try { return path.join(await fs.realpath(cursor), ...missing.reverse()); }
    catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(path.basename(cursor)); cursor = parent;
    }
  }
}
export function within(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}
export async function enforceThreadScope(args: any, cwd: string): Promise<void> {
  const configured = process.env.BIMAX_THREAD_ROOT;
  if (!configured) return;
  const root = await fs.realpath(configured);
  const check = async (value: unknown) => {
    if (typeof value !== 'string' || !value) return;
    const target = await canonicalTarget(resolvePath(value,cwd));
    if (!within(root,target)) throw classifiedError(`This thread is scoped to ${root}. ${target} is outside it. Create a thread in the destination folder; do not retry via Bash.`, 'permission','blocked');
  };
  await check(cwd);
  for (const key of ['path','file','filePath','directory','cwd','source','destination','targetPath']) await check(args?.[key]);
  for (const edit of args?.edits ?? []) await check(edit.path);
  for (const block of args?.spec?.blocks ?? []) if (block.kind === 'image') await check(block.path);
  for (const slide of args?.spec?.slides ?? []) if (slide.image) await check(slide.image.path);
}
