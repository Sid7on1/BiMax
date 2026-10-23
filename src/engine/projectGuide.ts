import * as fs from 'fs';
import * as path from 'path';

// Project instruction files, in priority order. These let a repo teach the agent its build/test/
// lint commands and conventions — the single biggest cure for "the agent guesses and gets it wrong".
// Mirrors OpenCode's AGENTS.md and Claude Code's CLAUDE.md.
const GUIDE_FILES = ['AGENTS.md', 'CLAUDE.md', '.bimax/AGENTS.md', '.agents/AGENTS.md'];

// Cap so a giant doc can't dominate the prompt (we keep the head — the useful "how to work here" part).
const MAX_CHARS = 6000;

/**
 * Load the project guide for a directory: the first of AGENTS.md / CLAUDE.md / .bimax/AGENTS.md found,
 * searching `dir` and walking up to 4 parents (so it works from a subdirectory too). Returns the file's
 * content (capped) or '' if none. Best-effort and synchronous — it's read once per turn during prompt
 * assembly, which is cheap.
 */
export function loadProjectGuide(dir: string): { path: string; content: string } | null {
  let cur = dir;
  for (let depth = 0; depth < 5; depth++) {
    for (const rel of GUIDE_FILES) {
      const full = path.join(cur, rel);
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          let content = fs.readFileSync(full, 'utf8').trim();
          if (!content) continue;
          if (content.length > MAX_CHARS) content = content.slice(0, MAX_CHARS) + '\n…(truncated)';
          return { path: full, content };
        }
      } catch { /* unreadable — keep looking */ }
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}
