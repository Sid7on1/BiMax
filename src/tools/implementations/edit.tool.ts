import * as fs from 'fs/promises';
import * as path from 'path';
import { resolvePath, countOccurrences, workspaceWriteBlock } from '../path.util';
import { IGovernor } from '../../core/interfaces';
import { buildTool } from '../tool.factory';
import { backupFile, unifiedDiff, compactDiff, capDiff } from '../../cli/fileEditor';
import { checkEditSyntax, shieldEdit } from '../syntax.check';
import { requestDiffApproval } from '../../cli/diffApproval';
import { checkBlastRadius } from '../../cli/blastGate';
import { detectCorruptWrite } from '../write-guard';
import { fileStateCache } from '../../memory/file-state-cache';
import { globalTransactionManager } from '../../core/transaction.manager';
import { outcomeOk, outcomeError, outcomeRejected } from '../outcome';

interface FallbackMatch {
  resolvedOld: string; // the actual text in the file that will be replaced
  method: string;      // which of the 9 steps succeeded (shown in diff-approval + result)
}

/**
 * 9-step fuzzy edit fallback chain (KiloCode-style).
 * Called only when exact match fails. Each step applies a progressively looser
 * normalization, finds a unique match in the file content, then returns the
 * ACTUAL text from the file (resolvedOld) so the replacement is exact on disk.
 *
 * Steps:
 *   2. TrimmedBoundary     — strip leading/trailing blank lines from oldString
 *   3. LineTrimmed         — trim trailing whitespace from each line
 *   4. WhitespaceNormalized — collapse internal whitespace runs per line
 *   5. IndentationFlexible — strip leading whitespace from each line
 *   6. EscapeNormalized    — resolve \\n, \\t literals in oldString
 *   7. BlockAnchor         — match by first + last non-empty line
 *   8. ContextAware        — anchor on the most distinctive line, extract expected-length block
 *   9. MultiOccurrence     — take the first match when multiple exist (last resort)
 */
export function findFuzzyMatch(content: string, oldString: string): FallbackMatch | null {
  // Try: transform oldString into something that appears verbatim in content (character-level)
  const tryCharTransform = (transform: (s: string) => string, method: string): FallbackMatch | null => {
    const t = transform(oldString);
    if (t === oldString) return null; // transform produced no change
    const n = countOccurrences(content, t);
    if (n === 1) return { resolvedOld: t, method };
    return null;
  };

  // Try: normalize each line of oldString and content, sliding-window match, map back to original
  const tryLineNorm = (normLine: (l: string) => string, method: string): FallbackMatch | null => {
    const oldLines = oldString.split('\n');
    const contentLines = content.split('\n');
    const normOld = oldLines.map(normLine);
    const normContent = contentLines.map(normLine);

    if (normOld.every((l, i) => l === oldLines[i])) return null; // no change from normalization

    const target = normOld.join('\n');
    const n = normOld.length;
    const hits: number[] = [];

    for (let i = 0; i <= normContent.length - n; i++) {
      if (normContent.slice(i, i + n).join('\n') === target) hits.push(i);
    }

    if (hits.length === 1) {
      return { resolvedOld: contentLines.slice(hits[0], hits[0] + n).join('\n'), method };
    }
    if (hits.length > 1) {
      // Multiple matches — take first, note it (Step 9 handles this intentionally)
      return {
        resolvedOld: contentLines.slice(hits[0], hits[0] + n).join('\n'),
        method: `${method} (${hits.length} matches, first used)`,
      };
    }
    return null;
  };

  // Step 2: TrimmedBoundary
  const s2 = tryCharTransform(s => s.replace(/^\n+/, '').replace(/\n+$/, ''), 'TrimmedBoundary');
  if (s2) return s2;

  // Step 3: LineTrimmed
  const s3 = tryLineNorm(l => l.trimEnd(), 'LineTrimmed');
  if (s3) return s3;

  // Step 4: WhitespaceNormalized
  const s4 = tryLineNorm(l => l.replace(/[ \t]+/g, ' ').trimEnd(), 'WhitespaceNormalized');
  if (s4) return s4;

  // Step 5: IndentationFlexible
  const s5 = tryLineNorm(l => l.trimStart(), 'IndentationFlexible');
  if (s5) return s5;

  // Step 6: EscapeNormalized
  const s6 = tryCharTransform(
    s => s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\'),
    'EscapeNormalized'
  );
  if (s6) return s6;

  // Step 7: BlockAnchor — match by first + last non-empty lines
  {
    const oldLines = oldString.split('\n');
    const nonEmpty = oldLines.filter(l => l.trim().length > 0);
    if (nonEmpty.length >= 2) {
      const firstTrim = nonEmpty[0].trim();
      const lastTrim = nonEmpty[nonEmpty.length - 1].trim();
      const cLines = content.split('\n');
      const expectedLen = oldLines.length;
      for (let i = 0; i < cLines.length; i++) {
        if (cLines[i].trim() !== firstTrim) continue;
        const maxJ = Math.min(cLines.length - 1, i + expectedLen + 3);
        for (let j = i + 1; j <= maxJ; j++) {
          if (cLines[j].trim() === lastTrim) {
            return { resolvedOld: cLines.slice(i, j + 1).join('\n'), method: 'BlockAnchor' };
          }
        }
      }
    }
  }

  // Step 8: ContextAware — anchor on the most distinctive line, extract expected-length block
  {
    const oldLines = oldString.split('\n');
    const anchor = oldLines
      .map((l, i) => ({ trimmed: l.trim(), idx: i }))
      .filter(x => x.trimmed.length > 15)
      .sort((a, b) => b.trimmed.length - a.trimmed.length)[0];

    if (anchor) {
      const cLines = content.split('\n');
      for (let ci = 0; ci < cLines.length; ci++) {
        if (cLines[ci].trim() !== anchor.trimmed) continue;
        const blockStart = ci - anchor.idx;
        if (blockStart >= 0 && blockStart + oldLines.length <= cLines.length) {
          return {
            resolvedOld: cLines.slice(blockStart, blockStart + oldLines.length).join('\n'),
            method: 'ContextAware',
          };
        }
      }
    }
  }

  // Step 9: MultiOccurrence — WhitespaceNormalized allowing multiple matches (last resort)
  {
    const s9 = tryLineNorm(l => l.replace(/[ \t]+/g, ' ').trimEnd(), 'MultiOccurrence');
    if (s9) return s9;
  }

  return null;
}

/**
 * When an edit can't be located (exact + 9-step fuzzy both failed), find the file region that most
 * resembles oldString and return it with line numbers. Surfacing the ACTUAL current text in the
 * error turns blind "not found" retries — the loop where a model re-emits the same near-miss
 * oldString over and over — into informed ones: it can copy the real text verbatim or anchor a
 * smaller edit. Anchors on the most distinctive line of oldString; scores file lines by word
 * overlap (cheap, robust to indentation/punctuation drift). Returns null if nothing is close enough.
 */
export function closestRegion(content: string, oldString: string): string | null {
  const oldLines = oldString.split('\n').map(l => l.trim()).filter(l => l.length > 3);
  if (oldLines.length === 0) return null;

  const cLines = content.split('\n');
  let bestIdx = -1;
  let bestScore = 0;
  // Score every oldString line against every file line by word overlap and keep the single best
  // pairing — robust to indentation, punctuation, and the surrounding lines being slightly off.
  for (const ol of oldLines) {
    const olTokens = new Set(ol.split(/\s+/).filter(Boolean));
    if (olTokens.size === 0) continue;
    for (let i = 0; i < cLines.length; i++) {
      const toks = cLines[i].trim().split(/\s+/).filter(Boolean);
      if (toks.length === 0) continue;
      let shared = 0;
      for (const tok of toks) if (olTokens.has(tok)) shared++;
      const symmetricScore = shared / Math.max(olTokens.size, toks.length);
      // Models sometimes flatten a multiline oldString into one long line. In that case the
      // symmetric score is tiny even when a short file line is fully contained in the request.
      // This asymmetric diagnostic score only improves the hint; it never authorizes an edit.
      const containmentScore = shared >= 2
        ? shared / Math.min(olTokens.size, toks.length)
        : 0;
      const score = Math.max(symmetricScore, containmentScore * 0.8);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
  }
  if (bestIdx < 0 || bestScore < 0.34) return null; // nothing resembles it — a hint would mislead

  const start = Math.max(0, bestIdx - 3);
  const end = Math.min(cLines.length, bestIdx + 4);
  return cLines
    .slice(start, end)
    .map((l, k) => `${String(start + k + 1).padStart(5)}  ${l}`)
    .join('\n');
}

function lineNumberedMatch(content: string, matched: string, maxLines = 12): string {
  const offset = content.indexOf(matched);
  const firstLine = offset >= 0 ? content.slice(0, offset).split('\n').length : 1;
  const lines = matched.split('\n');
  const shown = lines.slice(0, maxLines)
    .map((line, index) => `${String(firstLine + index).padStart(5)}  ${line}`);
  if (lines.length > maxLines) shown.push(`      … ${lines.length - maxLines} more matched line(s)`);
  return shown.join('\n');
}

/** Render a compact unified-style preview of the change for the transcript. */

interface EditArgs {
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

export const createEditFileTool = (governor: IGovernor) => buildTool({
  name: 'EditFileTool',
  description: `Performs an exact string replacement inside an existing file. This is the correct tool for modifying code: it is surgical, reviewable, and never rewrites the rest of the file. Prefer it over WriteFileTool (full overwrite) and over \`sed\` via BashTool.

# Instructions
- **oldString** must match the file content EXACTLY, including indentation and line breaks.
- **Keep oldString SMALL** — prefer one line, or a few lines, anchored on a single unique line. Large multi-line blocks with deep indentation are error-prone to reproduce verbatim and are the #1 cause of failed edits. Make several small edits instead of one big one.
- **oldString must be unique** in the file, or the edit fails — include just enough surrounding context to disambiguate. Alternatively pass \`replaceAll: true\` to replace every occurrence.
- **newString** must differ from oldString.
- The file must already exist; use WriteFileTool to create new files.`,
  isDestructive: true,
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to edit (supports ~/ for home dir).' },
      oldString: { type: 'string', description: 'The exact text to replace (must match the file verbatim).' },
      newString: { type: 'string', description: 'The replacement text.' },
      replaceAll: { type: 'boolean', description: 'Replace every occurrence instead of requiring uniqueness (default false).' },
    },
    required: ['path', 'oldString', 'newString'],
  },
  execute: async (rawArgs: any, context?: any) => {
    // Accept Claude-Code-style snake_case keys (file_path / old_string / new_string / replace_all)
    // as well as our camelCase schema — many models emit the former.
    const args: EditArgs = {
      path: rawArgs.path ?? rawArgs.file_path ?? rawArgs.filePath,
      oldString: rawArgs.oldString ?? rawArgs.old_string,
      newString: rawArgs.newString ?? rawArgs.new_string,
      replaceAll: rawArgs.replaceAll ?? rawArgs.replace_all,
    };
    const cwd = context?.cwd || process.cwd();
    const fullPath = resolvePath(args.path, cwd);

    const wsBlock = workspaceWriteBlock(fullPath);
    if (wsBlock) return outcomeError('permission', `Error: ${wsBlock}`);

    if (args.oldString === args.newString) {
      return outcomeError('invalid_args', 'Error: newString must be different from oldString.');
    }
    if (!args.oldString) {
      return outcomeError('invalid_args', 'Error: oldString cannot be empty. To create a file, use WriteFileTool.');
    }

    let content: string;
    try {
      content = await fs.readFile(fullPath, 'utf8');
    } catch (e: any) {
      if (e.code === 'ENOENT') {
        return outcomeError('not_found', `Error: File not found: ${args.path}. Use WriteFileTool to create new files.`);
      }
      throw e;
    }

    // When a transaction is open, ANY failure after we've committed to attempting this edit must
    // roll the whole transaction back — that is the atomicity guarantee /tx promises. Outside a
    // transaction this just returns the message unchanged.
    const fail = async (msg: string, reason: string): Promise<string> => {
      if (globalTransactionManager.isOpen()) {
        const rbMsg = await globalTransactionManager.autoRollback(args.path, reason);
        return rbMsg ? `${msg}\n\n${rbMsg}` : msg;
      }
      return msg;
    };

    const occurrences = countOccurrences(content, args.oldString);

    // Resolve the old text to replace: prefer exact match, fall back to 9-step fuzzy chain.
    let resolvedOld = args.oldString;
    let matchMethod: string | null = null;

    if (occurrences === 0) {
      const fuzzy = findFuzzyMatch(content, args.oldString);
      if (!fuzzy) {
        const hint = closestRegion(content, args.oldString);
        return outcomeError('not_found', await fail(
          `Error: oldString not found in ${args.path}. The 9-step fuzzy fallback also failed ` +
          `(TrimmedBoundary → LineTrimmed → WhitespaceNormalized → IndentationFlexible → ` +
          `EscapeNormalized → BlockAnchor → ContextAware → MultiOccurrence).` +
          (hint
            ? `\n\nThe closest region currently in the file is:\n\n${hint}\n\n` +
              `Copy oldString VERBATIM from there (exact whitespace and indentation), or make a ` +
              `smaller edit anchored on a single unique line. Do NOT re-send the same oldString.`
            : ` Re-read the file and copy oldString exactly, including whitespace and indentation.`),
          'oldString not found',
        ));
      }
      resolvedOld = fuzzy.resolvedOld;
      matchMethod = fuzzy.method;
    }

    const resolvedCount = countOccurrences(content, resolvedOld);
    if (resolvedCount > 1 && !args.replaceAll) {
      return outcomeError('ambiguous_match', await fail(
        `Error: oldString appears ${resolvedCount} times in ${args.path}${matchMethod ? ` (matched via ${matchMethod})` : ''}. Add more surrounding context to make it unique, or pass replaceAll: true.`,
        'ambiguous oldString',
      ));
    }

    // Use a replacer FUNCTION, not a string: String.replace interprets `$$`, `$&`, `` $` ``, `$'`
    // in a string replacement even when the pattern is a plain string, so a newString containing
    // e.g. `$$` (Makefiles, shell PID/`$$`) or `$&` (regex/sed code) would be silently corrupted.
    // A function return value is inserted verbatim. (split/join for replaceAll is already literal.)
    const updated = args.replaceAll
      ? content.split(resolvedOld).join(args.newString)
      : content.replace(resolvedOld, () => args.newString);

    // Guard against the "flattened file" corruption (e.g. a whole-file oldString replaced by a
    // newline-stripped newString). Refuse before touching disk.
    const flat = detectCorruptWrite(content, updated, fullPath);
    if (flat) {
      return outcomeError('syntax', await fail(
        `Edit to ${args.path} refused: ${flat}. No changes were made. ` +
        `Make a smaller, surgical edit and keep newline characters intact in newString.`,
        'corrupt-write refused',
      ));
    }

    // Edit Shield: refuse an edit that would introduce NEW syntax errors — the broken file never
    // reaches disk, and the error names the exact lines so the very next attempt can fix it.
    const shield = shieldEdit(fullPath, content, updated);
    if (shield) {
      const approximateMatchDiagnostic = matchMethod
        ? `\n\nImportant: oldString was not an exact match. The fuzzy matcher selected this ` +
          `current region via ${matchMethod}:\n\n${lineNumberedMatch(content, resolvedOld)}\n\n` +
          `The syntax failure may be caused by replacing the wrong or incomplete region, not by ` +
          `newString itself. Retry EditFileTool with a smaller oldString copied verbatim from the ` +
          `region above; do not switch write mechanisms.`
        : '';
      return outcomeError('syntax', await fail(
        `Edit to ${args.path} refused by Edit Shield: ${shield}${approximateMatchDiagnostic}`,
        'edit-shield refused',
      ));
    }

    // Blast-radius gate (no-op unless enabled + interactive + the file owns a HIGH/CRITICAL symbol).
    if (!(await checkBlastRadius(fullPath))) {
      return outcomeRejected(await fail(`Edit to ${args.path} cancelled — declined at the blast-radius gate. No changes were made.`, 'blast-radius declined'));
    }

    // Inline diff approval. When a fuzzy match was used, surface the match method in the summary
    // so the user can see exactly how the approximate match was resolved before approving.
    const approvalSummary = matchMethod
      ? `Edit ${args.path} [APPROXIMATE MATCH via ${matchMethod}]`
      : `Edit ${args.path}`;
    const approved = await requestDiffApproval(approvalSummary, unifiedDiff(content, updated, args.path));
    if (!approved) return outcomeRejected(await fail(`Edit to ${args.path} rejected by user. No changes were made.`, 'rejected by user'));

    // Track the pre-edit state for atomic rollback before touching disk, and declare exactly what
    // this edit is about to leave there — that is what lets rollback tell our own write apart from
    // a change somebody else made afterwards, instead of silently overwriting it.
    await globalTransactionManager.trackEdit(fullPath, updated);
    // Snapshot first so /undo and /diff-file work on every agent edit.
    await backupFile(fullPath);
    try {
      await fs.writeFile(fullPath, updated, 'utf8');
    } catch (e: any) {
      return outcomeError('io', await fail(`Edit to ${args.path} failed while writing: ${e.message}. No changes were applied.`, `write failed: ${e.message}`));
    }
    // Invalidate the read cache so post-compact restoration doesn't re-inject stale content.
    fileStateCache.invalidate(fullPath);

    const n = args.replaceAll ? resolvedCount : 1;
    const matchNote = matchMethod ? ` [matched via ${matchMethod}]` : '';
    const syntaxWarn = checkEditSyntax(fullPath, updated) || '';
    return outcomeOk(`Edited ${args.path} (${n} replacement${n === 1 ? '' : 's'}${matchNote}):\n${capDiff(compactDiff(content, updated, args.path))}${syntaxWarn}`);
  },
}, governor);
