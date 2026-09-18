import * as fs from 'fs';
import * as path from 'path';

// IDE selection bridge. OpenCode reads Zed's SQLite to learn the user's current editor
// selection; that's powerful but editor-specific and needs a native SQLite dependency. This
// is the portable, dependency-free equivalent that fits BiMax's file-based storage: any
// editor, extension, or keybinding writes a tiny JSON handoff and the CLI reads it. The
// agent then gets the *exact* byte/line range the user is looking at — `@selection` injects
// it, range-precise, the same way `@symbol` injects a symbol's body.
//
// Producers, in resolution order:
//   1. $BIMAX_IDE_SELECTION — inline JSON, or a path to a JSON file (CI / scripted handoff).
//   2. <cwd>/.bimax/ide-selection.json — the conventional drop file an editor extension writes.
//   3. $BIMAX_IDE_FILE (+ optional $BIMAX_IDE_START_LINE / $BIMAX_IDE_END_LINE) — the simplest
//      possible bridge for an integrated terminal that can only export env vars.
//
// The handoff only needs to name a file + line range; the selected text is always re-read
// fresh from disk so it reflects the file's current contents, never a stale snapshot.

export interface IdeSelection {
  file: string;        // absolute path to the file
  startLine: number;   // 1-based, inclusive
  endLine: number;     // 1-based, inclusive
  text: string;        // the selected lines, read fresh from disk
  source: string;      // which producer supplied it (for /selection + diagnostics)
}

// A handoff older than this is assumed stale (the user moved on); ignored. Editors overwrite
// the file on every selection change, so a fresh selection always has a recent mtime/ts.
const MAX_AGE_MS = 10 * 60 * 1000;

interface RawSelection {
  file?: string;
  path?: string;            // accepted alias for `file`
  startLine?: number;
  endLine?: number;
  line?: number;            // single-line alias → start == end
  ts?: number;              // optional epoch-ms timestamp; used for staleness
}

function clampToFile(file: string, startLine: number, endLine: number):
  { startLine: number; endLine: number; text: string } | null {
  let content: string;
  try { content = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const lines = content.split('\n');
  const start = Math.max(1, Math.min(startLine, lines.length));
  const end = Math.max(start, Math.min(endLine, lines.length));
  return { startLine: start, endLine: end, text: lines.slice(start - 1, end).join('\n') };
}

function build(raw: RawSelection, cwd: string, source: string, mtimeMs?: number): IdeSelection | null {
  const rel = raw.file ?? raw.path;
  if (!rel) return null;
  const stamp = raw.ts ?? mtimeMs;
  if (stamp !== undefined && Date.now() - stamp > MAX_AGE_MS) return null; // stale handoff
  const file = path.isAbsolute(rel) ? rel : path.resolve(cwd, rel);
  const startLine = raw.startLine ?? raw.line ?? 1;
  const endLine = raw.endLine ?? raw.line ?? startLine;
  const clamped = clampToFile(file, startLine, endLine);
  if (!clamped) return null;
  return { file, ...clamped, source };
}

/**
 * Resolve the user's current IDE selection, or null if no bridge is configured / the handoff
 * is missing or stale. Never throws — every producer degrades to the next.
 */
export function readIdeSelection(cwd: string = process.cwd()): IdeSelection | null {
  // 1) $BIMAX_IDE_SELECTION — inline JSON or a path to a JSON file.
  const env = process.env.BIMAX_IDE_SELECTION?.trim();
  if (env) {
    try {
      if (env.startsWith('{')) {
        const sel = build(JSON.parse(env) as RawSelection, cwd, 'env:BIMAX_IDE_SELECTION');
        if (sel) return sel;
      } else {
        const st = fs.statSync(env);
        const sel = build(JSON.parse(fs.readFileSync(env, 'utf8')), cwd, `file:${env}`, st.mtimeMs);
        if (sel) return sel;
      }
    } catch { /* fall through */ }
  }

  // 2) <cwd>/.bimax/ide-selection.json — the conventional drop file.
  const dropFile = path.join(cwd, '.bimax', 'ide-selection.json');
  try {
    const st = fs.statSync(dropFile);
    const sel = build(JSON.parse(fs.readFileSync(dropFile, 'utf8')), cwd, '.bimax/ide-selection.json', st.mtimeMs);
    if (sel) return sel;
  } catch { /* fall through */ }

  // 3) $BIMAX_IDE_FILE (+ optional line env vars) — minimal env-only bridge.
  const file = process.env.BIMAX_IDE_FILE?.trim();
  if (file) {
    const start = Number(process.env.BIMAX_IDE_START_LINE) || 1;
    const end = Number(process.env.BIMAX_IDE_END_LINE) || start;
    const sel = build({ file, startLine: start, endLine: end }, cwd, 'env:BIMAX_IDE_FILE');
    if (sel) return sel;
  }

  return null;
}

/** A labelled context block for the selection, for injection into a turn. */
export function formatSelectionBlock(sel: IdeSelection, cwd: string = process.cwd()): string {
  const rel = path.relative(cwd, sel.file) || path.basename(sel.file);
  return `--- @selection (${rel}:${sel.startLine}-${sel.endLine}, from your editor) ---\n${sel.text}`;
}
