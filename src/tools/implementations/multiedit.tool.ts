import * as fs from 'fs/promises';
import * as path from 'path';
import { resolvePath, countOccurrences, workspaceWriteBlock } from '../path.util';
import { IGovernor } from '../../core/interfaces';
import { buildTool } from '../tool.factory';
import { backupFile, unifiedDiff, compactDiff, capDiff } from '../../cli/fileEditor';
import { checkEditSyntax, shieldEdit } from '../syntax.check';
import { requestDiffApproval } from '../../cli/diffApproval';
import { checkBlastRadius } from '../../cli/blastGate';
import { globalTransactionManager } from '../../core/transaction.manager';
import { findFuzzyMatch, closestRegion } from './edit.tool';
import { outcomeOk, outcomeError, outcomeRejected } from '../outcome';

interface SingleEdit {
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

/**
 * MultiEditTool — applies a batch of string replacements across one or more files
 * atomically: every edit is validated first, and nothing is written unless all
 * edits would succeed. Edits to the same file are applied in order. Each touched
 * file is governed (FILE_WRITE) and backed up so /undo and /rewind still work.
 */
export const createMultiEditTool = (governor: IGovernor) => buildTool({
  name: 'MultiEditTool',
  description: `Applies a batch of exact-string replacements across one or more files in a single atomic operation. Either every edit applies or none do — use this for coordinated refactors (e.g. rename a symbol across files, change a signature and its callers) instead of many separate EditFileTool calls.

# Instructions
- Provide an \`edits\` array. Each entry: { path, oldString, newString, replaceAll? }.
- Each \`oldString\` must match its file exactly (whitespace included) and be unique unless \`replaceAll: true\`.
- Multiple edits to the same file are applied in array order; write later edits against the result of earlier ones.
- If ANY edit fails validation, the whole batch is rejected and no file is modified.`,
  // Governance is enforced per-file inside execute, so the factory wrapper stays out of the way.
  isDestructive: false,
  isConcurrencySafe: false,
  schema: {
    type: 'object',
    properties: {
      edits: {
        type: 'array',
        description: 'The list of edits to apply atomically.',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File to edit (supports ~/).' },
            oldString: { type: 'string', description: 'Exact text to replace.' },
            newString: { type: 'string', description: 'Replacement text.' },
            replaceAll: { type: 'boolean', description: 'Replace every occurrence (default false).' },
          },
          required: ['path', 'oldString', 'newString'],
        },
      },
    },
    required: ['edits'],
  },
  execute: async (args: { edits: SingleEdit[] }, context?: any) => {
    const cwd = context?.cwd || process.cwd();
    // Accept BOTH our camelCase schema and Claude-Code-style snake_case keys (file_path / old_string
    // / new_string / replace_all) — many models emit the latter, which previously arrived as undefined
    // fields ("edit #1 (undefined): newString must differ from oldString").
    const edits: SingleEdit[] = (args.edits || []).map((e: any) => ({
      path: e.path ?? e.file_path ?? e.filePath,
      oldString: e.oldString ?? e.old_string,
      newString: e.newString ?? e.new_string,
      replaceAll: e.replaceAll ?? e.replace_all,
    }));
    if (edits.length === 0) return outcomeError('invalid_args', 'Error: edits array is empty.');

    // Phase 1 — load each distinct file once and validate every edit in order against
    // an in-memory working copy. Nothing touches disk until all edits are proven valid.
    const working = new Map<string, string>(); // fullPath -> current (post-edits) content
    const originals = new Map<string, string>(); // fullPath -> on-disk content (for diff preview)
    const order: string[] = []; // distinct fullPaths in first-seen order

    for (let i = 0; i < edits.length; i++) {
      const e = edits[i];
      if (e.oldString === e.newString) return outcomeError('invalid_args', `Error: edit #${i + 1} (${e.path}): newString must differ from oldString.`);
      if (!e.oldString) return outcomeError('invalid_args', `Error: edit #${i + 1} (${e.path}): oldString cannot be empty.`);

      const full = resolvePath(e.path, cwd);
      const wsBlock = workspaceWriteBlock(full);
      if (wsBlock) return outcomeError('permission', `Error: edit #${i + 1} (${e.path}): ${wsBlock}`);
      if (!working.has(full)) {
        try {
          const disk = await fs.readFile(full, 'utf8');
          working.set(full, disk);
          originals.set(full, disk);
          order.push(full);
        } catch (err: any) {
          if (err.code === 'ENOENT') return outcomeError('not_found', `Error: edit #${i + 1}: file not found: ${e.path}. Use WriteFileTool to create files.`);
          throw err;
        }
      }
      const content = working.get(full)!;
      // Match exactly, then fall back to the same 9-step fuzzy chain EditFileTool uses — MultiEdit was
      // previously exact-only, so a single whitespace/indentation drift in one edit failed the entire
      // batch (the brittle "edit #1 not found" abort). resolvedOld is the ACTUAL file text to replace.
      let resolvedOld = e.oldString;
      let occ = countOccurrences(content, resolvedOld);
      if (occ === 0) {
        const fuzzy = findFuzzyMatch(content, e.oldString);
        if (!fuzzy) {
          const hint = closestRegion(content, e.oldString);
          return outcomeError('not_found', `Error: edit #${i + 1} (${e.path}): oldString not found (after preceding edits).` +
            (hint
              ? `\n\nThe closest region currently in the file is:\n\n${hint}\n\n` +
                `Copy oldString VERBATIM from there, or split this into smaller edits anchored on a single unique line.`
              : ` Re-read the file and match it exactly, including whitespace and indentation.`));
        }
        resolvedOld = fuzzy.resolvedOld;
        occ = countOccurrences(content, resolvedOld);
      }
      if (occ > 1 && !e.replaceAll) return outcomeError('ambiguous_match', `Error: edit #${i + 1} (${e.path}): oldString appears ${occ} times — add context or set replaceAll: true.`);
      // Replacer FUNCTION, not a string: avoids String.replace interpreting `$$`/`$&`/`` $` ``/`$'`
      // in newString (would corrupt Makefiles, shell `$$`, sed/regex code). See edit.tool.ts.
      const updated = e.replaceAll ? content.split(resolvedOld).join(e.newString) : content.replace(resolvedOld, () => e.newString);
      working.set(full, updated);
    }

    // Edit Shield — refuse the whole batch when any file would end up with NEW syntax errors,
    // before anything touches disk (keeps the all-or-nothing promise).
    for (const full of order) {
      const shield = shieldEdit(full, originals.get(full)!, working.get(full)!);
      if (shield) {
        return outcomeError('syntax', `MultiEdit refused by Edit Shield for ${path.relative(cwd, full)}: ${shield}`);
      }
    }

    // Blast-radius gate — check every distinct file; a decline anywhere aborts the whole batch.
    for (const full of order) {
      if (!(await checkBlastRadius(full))) {
        return outcomeRejected(`MultiEdit cancelled — declined at the blast-radius gate for ${path.relative(cwd, full)}. No changes were made.`);
      }
    }

    // Inline diff approval — show the whole batch as one diff; reject is all-or-nothing.
    const combinedDiff = order.map(f => unifiedDiff(originals.get(f)!, working.get(f)!, path.relative(cwd, f))).join('\n');
    const approved = await requestDiffApproval(`MultiEdit: ${edits.length} edit(s) across ${order.length} file(s)`, combinedDiff);
    if (!approved) return outcomeRejected(`MultiEdit rejected by user. No changes were made.`);

    // Phase 2 — governance approval for every distinct file BEFORE any write, so a
    // veto leaves the workspace untouched (keeps the operation atomic).
    for (const full of order) {
      await governor.approveTaskExecution('FILE_WRITE', { targetPath: full, isDestructive: true });
    }

    // Phase 3 — track (for /tx atomic rollback) and back up every file, then write them.
    for (const full of order) {
      await globalTransactionManager.trackEdit(full, working.get(full)!);
      await backupFile(full);
    }
    // If a write fails mid-batch, the files written before it are already changed. Restore each of
    // them to its original on-disk content (held in `originals`) so the batch is truly all-or-nothing
    // — the atomicity this tool promises. Previously only the failed file was addressed, leaving the
    // earlier files partially written (data corruption on a coordinated refactor).
    const written: string[] = [];
    for (const full of order) {
      try {
        await fs.writeFile(full, working.get(full)!, 'utf8');
        written.push(full);
      } catch (e: any) {
        const restoreErrors: string[] = [];
        for (const done of written) {
          try { await fs.writeFile(done, originals.get(done)!, 'utf8'); }
          catch (re: any) { restoreErrors.push(`${path.relative(cwd, done)}: ${re.message}`); }
        }
        // Keep an open /tx transaction's bookkeeping consistent with the rollback we just did.
        if (globalTransactionManager.isOpen()) {
          await globalTransactionManager.autoRollback(path.relative(cwd, full), `write failed: ${e.message}`);
        }
        const ok = written.length - restoreErrors.length;
        return outcomeError('io', `MultiEdit failed writing ${path.relative(cwd, full)}: ${e.message}. ` +
          `Rolled back ${ok} already-written file(s) to their original contents.` +
          (restoreErrors.length ? ` WARNING — could not restore: ${restoreErrors.join('; ')}.` : ''));
      }
    }

    const diff = capDiff(order.map(f => compactDiff(originals.get(f)!, working.get(f)!, path.relative(cwd, f))).join('\n'));
    const syntaxWarn = order.map(f => checkEditSyntax(f, working.get(f)!) || '').join('');
    return outcomeOk(`Applied ${edits.length} edit(s) across ${order.length} file(s):\n${diff}${syntaxWarn}`);
  },
}, governor);
