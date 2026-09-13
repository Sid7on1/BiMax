import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { resolvePath, workspaceWriteBlock } from '../path.util';
import * as crypto from 'crypto';
import { IGovernor } from '../../core/interfaces';
import { buildTool } from '../tool.factory';
import { backupFile, unifiedDiff, compactDiff, capDiff } from '../../cli/fileEditor';
import { checkEditSyntax, shieldEdit } from '../syntax.check';
import { requestDiffApproval } from '../../cli/diffApproval';
import { checkBlastRadius } from '../../cli/blastGate';
import { sliceLineRange } from '../file-range';
import { detectCorruptWrite } from '../write-guard';
import { fileStateCache } from '../../memory/file-state-cache';
import { globalTransactionManager } from '../../core/transaction.manager';
import { outcomeOk, outcomeError, outcomeRejected } from '../outcome';
import { moveToBin } from '../thread.bin';
import { recordTrash } from '../thread.journal';

// Files larger than this get truncated with a note. The full file content is written to
// a temp path for reference when the file is very large (>1MB).
const MAX_FILE_BYTES = 100 * 1024;        // 100 KB — read in full
const OFFLOAD_FILE_BYTES = 1024 * 1024;   // 1 MB — also write to /tmp for reference
const PREVIEW_LINES = 100;

/** Whitespace-delimited count, matching the familiar `wc -w` behavior. */
export function countWords(content: string, excludeTitle = false): number {
  let counted = content;
  if (excludeTitle) {
    const lines = content.split(/\r?\n/);
    const titleLine = lines.findIndex(line => line.trim().length > 0);
    // A one-line story is not a title. Never erase the entire draft from the count.
    if (titleLine >= 0 && lines.slice(titleLine + 1).some(line => line.trim())) {
      counted = lines.slice(titleLine + 1).join('\n');
    }
  }
  const trimmed = counted.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

export const createReadFileTool = (governor: IGovernor) => buildTool({
  name: 'ReadFileTool',
  description: `Reads the contents of a file from the local file system.

Use this tool to inspect source code, configuration files, or logs. It natively handles truncation for massive files and is significantly more token-efficient than using \`cat\` in the BashTool.

# Instructions
- **Paths:** Absolute, or relative to the current working directory — both resolve. Prefer the path exactly as the user or a prior tool result gave it.
- **Line Ranges:** If you are working with a massive file (>1000 lines), do NOT attempt to read the entire file at once. Use the \`startLine\` and \`endLine\` parameters to read localized chunks.
- **Context Gathering:** When investigating a bug, do not read files blindly. First, use the \`GraphQueryTool\` to find the exact file paths and class names relevant to the feature.
- **No Directories:** This tool only works on files. If you need to see the contents of a directory, use the \`BashTool\` with \`ls -la\`.`,
  isDestructive: false, // Read-only
  workflowReadOnly: true,
  isConcurrencySafe: true,
  schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file (absolute, or relative to the current working directory).'
      },
      startLine: {
        type: 'number',
        description: 'Optional. The 1-indexed start line to read from.'
      },
      endLine: {
        type: 'number',
        description: 'Optional. The 1-indexed end line to read to.'
      }
    },
    required: ['path']
  },
  execute: async (args: any, context?: any) => {
    try {
      const currentCwd = context?.cwd || process.cwd();
      const fullPath = resolvePath(args.path, currentCwd);

      if (context?.workflowEvidence) {
        // Evidence must describe the returned bytes, not an mtime-cache entry from an older read.
        const rawContent = await context.workflowEvidence.readFile(fullPath);
        if (args.startLine === undefined && args.endLine === undefined) return rawContent;
        const { text, error } = sliceLineRange(rawContent, args.startLine, args.endLine);
        if (error) return outcomeError('invalid_args', `Error: ${error}`);
        return text ?? rawContent;
      }

      // Get mtime for cache lookup and stale detection
      const mtime = await fileStateCache.getMtime(fullPath);
      if (mtime === null) return outcomeError('not_found', `Error: File not found at ${args.path}`);

      // When a line range is requested, check the cache first
      if (args.startLine !== undefined || args.endLine !== undefined) {
        const cached = fileStateCache.get(fullPath, mtime, args.startLine, args.endLine);
        if (cached !== null) return cached;

        const rawContent = await fs.readFile(fullPath, 'utf8');
        const { text, error } = sliceLineRange(rawContent, args.startLine, args.endLine);
        if (error) return outcomeError('invalid_args', `Error: ${error}`);
        const slicedText = text ?? '';
        fileStateCache.set(fullPath, mtime, slicedText, args.startLine, args.endLine);
        return slicedText;
      }

      // Full-file read — check cache first
      const cached = fileStateCache.get(fullPath, mtime);
      if (cached !== null) return cached;

      // Size check before reading large files
      const stat = await fs.stat(fullPath);

      if (stat.size > MAX_FILE_BYTES) {
        const rawContent = await fs.readFile(fullPath, 'utf8');
        const allLines = rawContent.split('\n');
        const preview = allLines.slice(0, PREVIEW_LINES).join('\n');
        const sizeKB = Math.round(stat.size / 1024);
        const remaining = allLines.length - PREVIEW_LINES;

        let result: string;

        if (stat.size > OFFLOAD_FILE_BYTES) {
          // Very large file — write to /tmp so model can reference it
          const hash = crypto.createHash('sha256').update(fullPath).digest('hex').slice(0, 8);
          const tmpPath = path.join(os.tmpdir(), `bimax-file-${hash}.txt`);
          await fs.writeFile(tmpPath, rawContent, 'utf8');
          result =
            `[File too large: ${sizeKB}KB — full content offloaded to ${tmpPath}]\n` +
            `[Showing first ${PREVIEW_LINES} of ${allLines.length} lines. Use startLine/endLine to read specific sections.]\n\n` +
            preview +
            (remaining > 0 ? `\n\n[... ${remaining} more lines — read via startLine/endLine or open ${tmpPath}]` : '');
        } else {
          result =
            `[Large file: ${sizeKB}KB — showing first ${PREVIEW_LINES} of ${allLines.length} lines. Use startLine/endLine to read more.]\n\n` +
            preview +
            (remaining > 0 ? `\n\n[... ${remaining} more lines truncated]` : '');
        }

        // Cache the truncated result (the model only got the preview)
        fileStateCache.set(fullPath, mtime, result);
        return result;
      }

      const content = await fs.readFile(fullPath, 'utf8');
      fileStateCache.set(fullPath, mtime, content);
      return content;
    } catch (e: any) {
      if (e.code === 'ENOENT') {
        return outcomeError('not_found', `Error: File not found at ${args.path}`);
      }
      throw e;
    }
  }
}, governor);

export const createWriteFileTool = (governor: IGovernor) => buildTool({
  name: 'WriteFileTool',
  description: `Creates a new file, or fully replaces an existing one. To CHANGE part of an existing file, use EditFileTool instead — this tool always writes the complete content.

Use this tool to write new code, config files, or artifacts. It is significantly faster, safer, and more reliable than attempting to use \`echo\` or \`cat <<EOF\` via the BashTool.

# Instructions
- **Supports \`~/Desktop/...\` paths** — home directory is automatically resolved.
- **Directory Creation:** If the parent directories do not exist, the tool will automatically create them for you.
- **Do NOT create empty directories:** Do NOT use this tool if you only want to create a new folder/directory. This tool creates FILES. If you need to create an empty directory, use \`BashTool\` with \`mkdir\`.
- **Overwriting:** Writing to an existing file replaces it (a backup is kept for \`/undo\`). You do NOT need to pass anything special to overwrite.
- **Do NOT silently clobber:** When the user asks you to CREATE or ADD a *new* document (a story, note, draft, script, etc.) and a file already exists at the path you'd choose, pick a non-colliding name instead (e.g. \`story.txt\` → \`story-2.txt\`) rather than overwriting — an overwrite destroys their existing file. Overwrite an existing file only when the user clearly means to update/replace *that specific* file (e.g. "fix the bug in X", "rewrite X"). When unsure whether a destination exists, list the directory first.
- **Modifying existing code:** Do NOT rewrite a whole file to change part of it. Use \`EditFileTool\` for a surgical oldString→newString replacement — it is safer and avoids accidentally dropping newlines. A full-file overwrite that collapses a multi-line file to one line will be REFUSED.
- **Multi-line content:** Always emit real newline characters between lines. Never flatten code onto a single line.
- **Exact word counts:** When the user requests an exact length for prose, ALWAYS pass \`expectedWords\`. If the document starts with a title that should not count toward the requested story/article length, also pass \`excludeTitleFromWordCount: true\`. The tool validates the draft before touching disk, so revise a rejected draft instead of creating and then overwriting an approximate one.
- **Validation:** After writing a complex script or TypeScript file, immediately use the \`BashTool\` to run a syntax check (e.g., \`npx tsc --noEmit\`) to verify your write didn't introduce syntax errors.`,
  isDestructive: true,
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file (supports ~/ for home dir)' },
      content: { type: 'string', description: 'Content to write' },
      overwrite: { type: 'boolean', description: 'Deprecated/ignored — Write always creates or overwrites.' },
      expectedWords: {
        type: 'integer',
        minimum: 0,
        description: 'Exact required word count for prose. Set whenever the user requests a specific number of words.'
      },
      excludeTitleFromWordCount: {
        type: 'boolean',
        description: 'When true, excludes the first non-empty line (the title) from expectedWords validation.'
      }
    },
    required: ['path', 'content']
  },
  execute: async (args: {
    path: string,
    content: string,
    overwrite?: boolean,
    expectedWords?: number,
    excludeTitleFromWordCount?: boolean,
  }, context?: any) => {
    const currentCwd = context?.cwd || process.cwd();
    const fullPath = resolvePath(args.path, currentCwd);
    if (/\.(docx|xlsx|pptx|pdf)$/i.test(fullPath)) {
      return outcomeError('invalid_args', 'WriteFileTool writes text, not office documents. Use DocumentTool to create a valid document; no file was written.');
    }
    const wsBlock = workspaceWriteBlock(fullPath);
    if (wsBlock) return outcomeError('permission', `Error: ${wsBlock}`);

    // Exact-length prose is easy for a model to estimate but hard for it to count reliably. Reject
    // an approximate draft before approvals, backups, or disk mutation so the correction is a
    // retry—not a visible create-then-overwrite sequence that still may miss the requested count.
    let validatedWordCount: number | undefined;
    if (args.expectedWords !== undefined) {
      if (!Number.isInteger(args.expectedWords) || args.expectedWords < 0) {
        return outcomeError('invalid_args', 'Error: expectedWords must be a non-negative integer. Nothing was written.');
      }
      validatedWordCount = countWords(args.content, args.excludeTitleFromWordCount === true);
      if (validatedWordCount !== args.expectedWords) {
        const delta = args.expectedWords - validatedWordCount;
        const adjustment = delta > 0 ? `add ${delta}` : `remove ${Math.abs(delta)}`;
        const scope = args.excludeTitleFromWordCount ? 'body' : 'document';
        return outcomeError(
          'invalid_args',
          `Word-count validation failed: expected exactly ${args.expectedWords} ${scope} words, ` +
          `but received ${validatedWordCount}; ${adjustment} word${Math.abs(delta) === 1 ? '' : 's'} and retry. Nothing was written.`
        );
      }
    }
    const exists = await fs.access(fullPath).then(() => true).catch(() => false);
    // Write creates OR overwrites (standard agent behavior — models emit Write expecting it to
    // replace an existing file, and erroring "file already exists" just wedged them into a retry
    // loop). Accidental clobbering is already guarded against by the corrupt-write check (refuses a
    // flattened/newline-stripped overwrite), the blast-radius gate, the inline diff approval, and the
    // pre-write backup below — so the old hard `overwrite: true` requirement was redundant friction.
    // Blast-radius gate — only meaningful when overwriting an existing, indexed file.
    if (exists && !(await checkBlastRadius(fullPath))) {
      return outcomeRejected(`Write to ${args.path} cancelled — declined at the blast-radius gate. No changes were made.`);
    }
    // Inline diff approval (no-op unless enabled and an interactive approver is registered).
    const prior = exists ? await fs.readFile(fullPath, 'utf-8').catch(() => '') : '';
    const approved = await requestDiffApproval(
      exists ? `Overwrite ${args.path}` : `Create ${args.path}`,
      unifiedDiff(prior, args.content, args.path)
    );
    if (!approved) return outcomeRejected(`Write to ${args.path} rejected by user. No changes were made.`);
    // Guard against the "flattened file" corruption (model strips newlines on a full-file
    // overwrite). Refuse before touching disk and steer the model to a surgical edit.
    if (exists) {
      const flat = detectCorruptWrite(prior, args.content, fullPath);
      if (flat) {
        return outcomeError('syntax', `Write to ${args.path} refused: ${flat}. No changes were made. ` +
          `To modify an existing file use EditFileTool (surgical oldString→newString) and keep real newline characters in multi-line content.`);
      }
    }
    // Edit Shield: a write that would introduce NEW syntax errors (vs. what's on disk; a new file
    // must simply parse) never reaches disk — the error names the lines so the retry can fix it.
    const shield = shieldEdit(fullPath, prior, args.content);
    if (shield) {
      return outcomeError('syntax', `Write to ${args.path} refused by Edit Shield: ${shield}`);
    }
    // Track the pre-write state for atomic rollback when a /tx transaction is open, and declare the
    // content about to land so rollback can tell this write apart from a later external change.
    // Must run before the write so the snapshot is the pre-write state.
    await globalTransactionManager.trackEdit(fullPath, args.content);
    // Snapshot overwrites so /undo and /diff-file can restore the prior version.
    if (exists) await backupFile(fullPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    try {
      await fs.writeFile(fullPath, args.content, 'utf-8');
    } catch (e: any) {
      if (globalTransactionManager.isOpen()) {
        const rb = await globalTransactionManager.autoRollback(args.path, `write failed: ${e.message}`);
        return outcomeError('io', `Write to ${args.path} failed: ${e.message}.${rb ? `\n\n${rb}` : ''}`);
      }
      throw e;
    }
    // Invalidate read cache so post-compact restoration doesn't re-inject stale pre-write content.
    fileStateCache.invalidate(fullPath);
    const diff = capDiff(compactDiff(prior, args.content, args.path));
    const syntaxWarn = checkEditSyntax(fullPath, args.content) || '';
    const wordCountNote = validatedWordCount === undefined
      ? ''
      : `\nWord count verified: ${validatedWordCount}${args.excludeTitleFromWordCount ? ' (title excluded)' : ''}.`;
    return outcomeOk(`${exists ? 'Updated' : 'Created'} ${args.path}${diff ? `:\n${diff}` : ''}${wordCountNote}${syntaxWarn}`);
  }
}, governor);

export const createDeleteTool = (governor: IGovernor) => buildTool({
  name: 'DeleteTool',
  description: `Deletes files or directories from the local file system.

Use this tool whenever the user explicitly asks you to delete, remove, or trash a file or folder. Do NOT use the BashTool for this.

# Instructions
- **Supports \`~/\` paths** — home directory is automatically resolved.
- **Directories:** It will recursively delete the directory and all of its contents.`,
  isDestructive: true,
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative path to the file or directory to delete' }
    },
    required: ['path']
  },
  execute: async (args: { path: string }, context?: any) => {
    const currentCwd = context?.cwd || process.cwd();
    const fullPath = resolvePath(args.path, currentCwd);
    const wsBlock = workspaceWriteBlock(fullPath);
    if (wsBlock) return outcomeError('permission', `Error: ${wsBlock}`);
    // Verify the target actually exists BEFORE deleting. fs.rm with `force: true`
    // silently treats a missing path as success, which would let us report
    // "Successfully deleted" for a path that never existed (e.g. a bare name
    // resolved against the wrong cwd). Fail loudly instead so the caller can retry.
    const exists = await fs.access(fullPath).then(() => true).catch(() => false);
    if (!exists) {
      return outcomeError('not_found', `Error: Nothing to delete — no file or directory found at ${fullPath} (resolved from "${args.path}" relative to ${currentCwd}). Nothing was changed. If the target lives elsewhere, pass its absolute path.`);
    }
    // In a desktop thread the item goes to the Bin through the Bimax app, and the thread can undo it.
    if (process.env.BIMAX_THREAD_ROOT) {
      const kind = (await fs.stat(fullPath)).isDirectory() ? 'folder' : 'file';
      try {
        const { moved, error } = await moveToBin([fullPath], context?.signal);
        await recordTrash(`Move ${kind} “${path.basename(fullPath)}” to the Bin`, 'DeleteTool', moved);
        if (error || !moved.length) return outcomeError('io', `Could not move ${args.path} to the Bin: ${error || 'nothing was moved'}. Nothing was deleted.`);
        return outcomeOk(`Moved ${fullPath} to the Bin (the user can undo this from the thread in Bimax)`);
      } catch (e: any) {
        return outcomeError('io', `Could not move ${args.path} to the Bin: ${e.message}. Nothing was deleted.`);
      }
    }
    // Back up a file before deleting so /undo and /rewind can bring it back (parity with edit/write,
    // which always back up first). Best-effort: a directory can't be content-backed-up, and a failed
    // backup shouldn't block an explicitly-approved delete.
    try {
      const st = await fs.stat(fullPath);
      // `null` declares the intent: after this tool runs the path is gone, so an open /tx can
      // re-create it on rollback and still detect a file somebody else put back in the meantime.
      if (st.isFile()) { await globalTransactionManager.trackEdit(fullPath, null); await backupFile(fullPath); }
    } catch { /* best-effort */ }
    try {
      await fs.rm(fullPath, { recursive: true, force: true });
      return outcomeOk(`Successfully deleted ${fullPath}`);
    } catch (e: any) {
      return outcomeError('io', `Failed to delete ${args.path}: ${e.message}`);
    }
  }
}, governor);

export const createMakeDirTool = (governor: IGovernor) => buildTool({
  name: 'CreateDirectoryTool',
  description: `Creates a new, empty directory (folder) on the local file system.

Use this tool whenever the user asks you to create, make, or add a new *folder* or *directory*. Do NOT use WriteFileTool for this — that tool writes FILES, not folders.

# Instructions
- **Supports \`~/\` and \`~/Desktop/...\` paths** — the home directory is resolved automatically.
- **Recursive:** Parent directories are created automatically if they are missing (like \`mkdir -p\`).
- **Idempotent:** If the directory already exists, this succeeds without error.`,
  isDestructive: true,
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path of the directory to create (supports ~/ for home dir)' }
    },
    required: ['path']
  },
  execute: async (args: { path: string }, context?: any) => {
    const currentCwd = context?.cwd || process.cwd();
    const fullPath = resolvePath(args.path, currentCwd);
    const stat = await fs.stat(fullPath).catch(() => null);
    if (stat && stat.isFile()) {
      return outcomeError('invalid_args', `Error: A file already exists at ${fullPath}, so a directory with that name cannot be created. Delete the file first if you meant to replace it with a folder.`);
    }
    const block = workspaceWriteBlock(fullPath);
    if (block) return outcomeError('permission', block);
    await fs.mkdir(fullPath, { recursive: true });
    if (!(await fs.stat(fullPath)).isDirectory()) return outcomeError('io', 'Directory creation could not be verified.');
    return outcomeOk(`Successfully created directory ${fullPath}`);
  }
}, governor);
