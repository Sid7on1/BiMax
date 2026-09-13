import { createContext } from 'react';

/**
 * Paths in an answer are links: click to preview with Quick Look, ⌘-click to show the item in Finder. Provided by
 * the ⌘2 bar (ThreadSurfaces); absent elsewhere, where inline code stays plain.
 */
export interface PathLinks {
  open(raw: string, mode: 'preview' | 'reveal'): void;
}

export const PathLinkContext = createContext<PathLinks | null>(null);

/** Whether inline code reads as a file or folder path rather than a command, URL, glob or code snippet. */
export function looksLikePath(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 300 || /[\n\r`]/.test(t)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return false;
  if (/[=(){}<>|;$*?"]/.test(t)) return false;
  if (/^(~\/|\/|\.{1,2}\/)/.test(t)) return true;
  if (t.includes('/')) return !t.startsWith('-') && !/\s-{1,2}[a-z]/i.test(t);
  return /^[^\s/]+\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(t);
}
