import { stateDir } from '../utils/state.dir';
import * as fs from 'fs/promises';
import * as path from 'path';
import { execSync } from 'child_process';
import { structuredPatch } from 'diff';

const BACKUP_DIR = path.join(stateDir('.breakglass'), 'backups');

/**
 * A compact, context-limited unified diff (git-style: 3 lines of context around each change) with
 * ABSOLUTE line numbers in the @@ hunk headers. Unlike unifiedDiff() below — which emits the whole
 * file as context — this stays small even for a one-line change in a large file, so it's cheap to
 * put in tool output and clean to render with line numbers. Used by the edit/write tools.
 */
export function compactDiff(oldText: string, newText: string, label: string, context = 3): string {
  const patch = structuredPatch(label, label, oldText, newText, '', '', { context });
  if (patch.hunks.length === 0) return '';
  const out: string[] = [];
  for (const h of patch.hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    out.push(...h.lines);
  }
  return out.join('\n');
}

/** Truncate a diff to a sane number of lines for tool output / display. */
export function capDiff(diff: string, maxLines = 80): string {
  const lines = diff.split('\n');
  if (lines.length <= maxLines) return diff;
  return lines.slice(0, maxLines).join('\n') + `\n…(${lines.length - maxLines} more diff lines)`;
}

export interface BackupEntry {
  file: string;
  backupPath: string;
  timestamp: number;
}

function ensureBackupDir() {
  return fs.mkdir(BACKUP_DIR, { recursive: true });
}

export async function backupFile(filePath: string): Promise<string | null> {
  try {
    await ensureBackupDir();
    const absPath = path.resolve(filePath);
    const content = await fs.readFile(absPath, 'utf-8');
    const backupName = `${Date.now()}_${path.basename(filePath)}`;
    const backupPath = path.join(BACKUP_DIR, backupName);
    await fs.writeFile(backupPath, content, 'utf-8');
    return backupPath;
  } catch { return null; }
}

export async function getBackups(filePath?: string): Promise<BackupEntry[]> {
  try {
    await ensureBackupDir();
    const files = await fs.readdir(BACKUP_DIR);
    const entries: BackupEntry[] = [];
    for (const f of files) {
      const stat = await fs.stat(path.join(BACKUP_DIR, f));
      entries.push({ file: f, backupPath: path.join(BACKUP_DIR, f), timestamp: stat.mtimeMs });
    }
    entries.sort((a, b) => b.timestamp - a.timestamp);
    if (filePath) {
      const basename = path.basename(filePath);
      return entries.filter(e => e.file.endsWith(basename));
    }
    return entries;
  } catch { return []; }
}

export async function undoLast(filePath: string): Promise<boolean> {
  const backups = await getBackups(filePath);
  if (backups.length === 0) return false;
  try {
    const content = await fs.readFile(backups[0].backupPath, 'utf-8');
    await fs.writeFile(path.resolve(filePath), content, 'utf-8');
    return true;
  } catch { return false; }
}

export async function previewDiff(filePath: string): Promise<string> {
  try {
    const absPath = path.resolve(filePath);
    const backups = await getBackups(filePath);
    if (backups.length === 0) return '(no backup to diff against)';
    const original = await fs.readFile(backups[0].backupPath, 'utf-8');
    const current = await fs.readFile(absPath, 'utf-8');
    return generateDiff(original, current, filePath);
  } catch (e: any) { return `(diff failed: ${e.message})`; }
}

/** Public unified-diff helper used for inline diff approval previews. */
export function unifiedDiff(oldText: string, newText: string, label: string): string {
  return generateDiff(oldText, newText, label);
}

function generateDiff(oldText: string, newText: string, label: string): string {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const result: string[] = [`--- a/${label}`, `+++ b/${label}`];
  let i = 0, j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      result.push(` ${oldLines[i]}`);
      i++; j++;
    } else {
      const startI = i, startJ = j;
      while (i < oldLines.length && (j >= newLines.length || oldLines[i] !== newLines[j])) i++;
      while (j < newLines.length && (i >= oldLines.length || oldLines[i] !== newLines[j])) j++;
      result.push(`@@ -${startI + 1},${i - startI} +${startJ + 1},${j - startJ} @@`);
      for (let k = startI; k < i; k++) result.push(`-${oldLines[k]}`);
      for (let k = startJ; k < j; k++) result.push(`+${newLines[k]}`);
    }
  }
  return result.join('\n');
}

export async function writeWithBackup(filePath: string, content: string): Promise<string | null> {
  const absPath = path.resolve(filePath);
  const exists = await fs.access(absPath).then(() => true).catch(() => false);
  if (exists) {
    const backupPath = await backupFile(filePath);
    await fs.writeFile(absPath, content, 'utf-8');
    return backupPath;
  } else {
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content, 'utf-8');
    return null;
  }
}

export async function editFileLines(filePath: string, search: string, replace: string): Promise<boolean> {
  try {
    const absPath = path.resolve(filePath);
    const content = await fs.readFile(absPath, 'utf-8');
    if (!content.includes(search)) return false;
    await backupFile(filePath);
    // Replacer function so `$$`/`$&`/`` $` ``/`$'` in the replacement text aren't interpreted by
    // String.replace and silently corrupt the write (e.g. `$$` → `$`). See edit.tool.ts.
    const updated = content.replace(search, () => replace);
    await fs.writeFile(absPath, updated, 'utf-8');
    return true;
  } catch { return false; }
}
