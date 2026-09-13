import path from 'node:path';
import { insideFolder } from './quick.context';

/**
 * A folder's rules as the Bimax app keeps them (settings.folderRules, keyed by the folder's real path): free text the
 * model follows, and protected items the engine refuses to change (src/tools/thread.rules.ts). Kept in Bimax's own
 * settings, never written into the folder.
 */
export interface FolderRules { text: string; protect: string[] }

const MAX_TEXT = 4000;

/** What the bar sends back is re-checked: text trimmed and capped, protected items absolute paths inside the folder. */
export function cleanRules(root: string, raw: unknown): FolderRules {
  const value = (raw && typeof raw === 'object' ? raw : {}) as { text?: unknown; protect?: unknown };
  const text = typeof value.text === 'string' ? value.text.trim().slice(0, MAX_TEXT) : '';
  const folder = path.resolve(root);
  const protect = Array.isArray(value.protect)
    ? [...new Set(value.protect.filter((p): p is string => typeof p === 'string' && path.isAbsolute(p)).map((p) => path.resolve(p)))]
      .filter((p) => p !== folder && insideFolder(folder, p))
      .slice(0, 100)
    : [];
  return { text, protect };
}

/** The engine reads a folder's rules from its environment when it starts. */
export function rulesEnvironment(rules: FolderRules | undefined): Record<string, string> {
  if (!rules) return {};
  return {
    ...(rules.text ? { BIMAX_THREAD_RULES: rules.text } : {}),
    ...(rules.protect.length ? { BIMAX_THREAD_PROTECTED: JSON.stringify(rules.protect) } : {}),
  };
}
