import { Logger } from '../utils';
import { SafetyPolicy } from './policy.engine';
import { GovernorVetoError } from '../core/errors';
import * as path from 'path';
import * as fs from 'fs/promises';

/**
 * Whether a canonical path falls under a forbidden path: `entry` must match whole path segments. It was a plain substring
 * test, so '/var' blocked ~/Documents/various and '/system' blocked ~/code/system-design — every edit in such a folder was
 * refused as "Forbidden path access" (found 2026-09-21 while testing F3). A folder literally named `var` or `.ssh` is
 * still refused, wherever it is, as before; case is ignored, as before.
 */
export function underForbiddenPath(normalized: string, entry: string): boolean {
  const target = normalized.toLowerCase().replace(/\/+$/, '');
  const forbidden = entry.toLowerCase().replace(/\/+$/, '');
  if (!forbidden) return false;
  return target === forbidden || target.endsWith(forbidden) || target.includes(`${forbidden}/`);
}

export class FileSystemVeto {
  async checkVeto(targetPath: string): Promise<void> {
    // Resolve the nearest existing ancestor, not just the immediate parent. A symlink
    // followed by two nonexistent directories must not turn into an unresolved allowed path.
    const canonical = async (input: string): Promise<string> => {
      let current = path.resolve(input);
      const missing: string[] = [];
      for (;;) {
        try { return path.join(await fs.realpath(current), ...missing.reverse()); }
        catch (error: any) {
          if (error?.code !== 'ENOENT') throw error;
          const entry = await fs.lstat(current).catch(() => null);
          if (entry?.isSymbolicLink()) throw new GovernorVetoError('Unresolvable symbolic link in target path.');
          const parent = path.dirname(current);
          if (parent === current) throw error;
          missing.push(path.basename(current));
          current = parent;
        }
      }
    };
    const realPath = await canonical(targetPath);
    // Preserve case: case-sensitive volumes must not admit a differently-cased sibling.
    const normalized = path.normalize(realPath);
    const canonicalWorkspace = await canonical(SafetyPolicy.allowedWorkspace);

    // 1. Must be inside workspace (separator-aware to prevent sibling-prefix escapes,
    //    e.g. /home/user/workspace-evil must NOT pass for workspace /home/user/workspace)
    const withSep = canonicalWorkspace.endsWith(path.sep) ? canonicalWorkspace : canonicalWorkspace + path.sep;
    if (normalized !== canonicalWorkspace && !normalized.startsWith(withSep)) {
      Logger.error(`[Governor: Veto] File operation blocked. Target is outside the allowed workspace: ${realPath}`);
      throw new GovernorVetoError('Path outside workspace boundary.');
    }

    // 2. Cannot touch forbidden system paths
    for (const forbidden of SafetyPolicy.forbiddenPaths) {
      if (underForbiddenPath(normalized, forbidden)) {
        Logger.error(`[Governor: Veto] File operation blocked. Target contains forbidden path: ${forbidden}`);
        throw new GovernorVetoError('Forbidden path access.');
      }
    }

    // 3. Sensitive filename pattern detection (e.g. id_rsa)
    for (const regex of SafetyPolicy.forbiddenRegex) {
      if (regex.test(normalized)) {
        Logger.error(`[Governor: Veto] File operation blocked. Target matches forbidden filename pattern: ${regex}`);
        throw new GovernorVetoError('Forbidden sensitive filename.');
      }
    }

    // 4. Cannot touch forbidden extensions
    const ext = path.extname(normalized);
    if (SafetyPolicy.forbiddenExtensions.includes(ext)) {
      Logger.error(`[Governor: Veto] File operation blocked. Extension is forbidden: ${ext}`);
      throw new GovernorVetoError('Forbidden file extension.');
    }
  }
}
