import * as fs from 'fs/promises';
import * as path from 'path';
import { resolvePath } from '../path.util';
import { minimatch } from 'minimatch';
import { IGovernor } from '../../core/interfaces';
import { buildTool } from '../tool.factory';
import { walkFiles } from '../../utils/fsWalk';
import { outcomeError } from '../outcome';
import { WorkflowEvidence } from '../../core/workflow.evidence';

/**
 * Human-readable label for where a search actually ran, relative to cwd. Surfacing this in the
 * result is the defense against a model that DROPPED a user-specified `path` arg: instead of
 * silently scanning the whole cwd and then (sometimes) claiming "the path doesn't exist", the
 * output now states the directory it searched, so the discrepancy is visible to model and user.
 */
function describeRoot(root: string, cwd: string): string {
  const rel = path.relative(cwd, root);
  if (rel === '') return 'the current directory';
  if (rel.startsWith('..')) return root; // outside cwd → show absolute
  return rel;
}

/** Cheap binary sniff: a NUL byte in the first chunk means "don't grep this". */
function looksBinary(sample: string): boolean {
  return sample.includes('\u0000');
}

const MAX_FILE_BYTES = 5 * 1024 * 1024; // skip files larger than 5MB

interface GrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  caseInsensitive?: boolean;
  outputMode?: 'content' | 'files' | 'count';
  contextLines?: number;
  maxResults?: number;
}

export const createGrepTool = (governor: IGovernor) => buildTool({
  name: 'GrepTool',
  description: `Searches file contents across the workspace using a regular expression. This is the right tool for "where is X used / defined / referenced" questions — far faster and more token-efficient than reading files one by one or piping to \`grep\` via BashTool.

# Instructions
- **pattern** is a JavaScript regular expression (e.g. \`function\\s+\\w+\`, \`TODO|FIXME\`). Escape special characters you mean literally.
- Use **glob** to restrict the file set (e.g. \`**/*.ts\`, \`src/**/*.tsx\`).
- **outputMode**: \`content\` returns matching lines with line numbers (default), \`files\` returns just the file paths that contain a match, \`count\` returns the number of matches per file.
- High-traffic directories (node_modules, .git, dist, build, coverage) are skipped automatically.`,
  isDestructive: false,
  workflowReadOnly: true,
  isConcurrencySafe: true,
  schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'The regular expression to search for.' },
      path: { type: 'string', description: 'File or directory to search (default: current working directory).' },
      glob: { type: 'string', description: 'Optional glob to filter files, e.g. "**/*.ts".' },
      caseInsensitive: { type: 'boolean', description: 'Case-insensitive matching (default false).' },
      outputMode: { type: 'string', enum: ['content', 'files', 'count'], description: 'content | files | count. Default content.' },
      contextLines: { type: 'number', description: 'Lines of context to show before/after each match (content mode only).' },
      maxResults: { type: 'number', description: 'Maximum matching lines or files to return (default 200).' },
    },
    required: ['pattern'],
  },
  execute: async (args: GrepArgs, context?: any) => {
    const evidence: WorkflowEvidence | undefined = context?.workflowEvidence;
    const signal: AbortSignal | undefined = context?.signal;
    signal?.throwIfAborted();
    const cwd = context?.cwd || process.cwd();
    const root = resolvePath(args.path || '.', cwd);
    const outputMode = args.outputMode || 'content';
    const maxResults = args.maxResults ?? 200;
    const ctx = Math.max(0, args.contextLines ?? 0);

    let regex: RegExp;
    try {
      regex = new RegExp(args.pattern, args.caseInsensitive ? 'i' : undefined);
    } catch (e: any) {
      return outcomeError('invalid_args', `Error: invalid regular expression: ${e.message}`);
    }

    // Build the candidate file list (a single file path is allowed too).
    const rootStat = await fs.stat(root).catch(() => null);
    if (!rootStat) return outcomeError('not_found', `Error: path not found: ${args.path || '.'}`);

    const files: string[] = [];
    if (rootStat.isFile()) {
      files.push(root);
    } else {
      for await (const f of walkFiles(root, {
        signal, onDirectory: (p, entries) => evidence?.directory(p, entries),
        onIncomplete: reason => evidence?.incomplete(reason),
      })) {
        if (args.glob) {
          const rel = path.relative(root, f);
          if (!minimatch(rel, args.glob, { dot: true })) continue;
        }
        files.push(f);
      }
    }

    const contentLines: string[] = [];
    const matchedFiles: string[] = [];
    const counts: { file: string; n: number }[] = [];
    let total = 0;

    // Grep→Read fusion: when ≤5 matches found in content mode with no explicit contextLines,
    // we auto-expand each to ±20 lines so the model sees real context without a separate ReadFile call.
    // Collect raw match records during the walk; decide rendering at the end once total is known.
    const fusionRecords: { rel: string; allLines: string[]; matchIdx: number }[] = [];
    const collectFusion = outputMode === 'content' && args.contextLines === undefined;

    outer: for (const file of files) {
      signal?.throwIfAborted();
      const stat = await fs.stat(file).catch(() => null);
      if (!stat || stat.size > MAX_FILE_BYTES) { evidence?.incomplete('Unreadable or oversized file skipped'); continue; }
      let text: string;
      try {
        text = evidence ? await evidence.readFile(file) : await fs.readFile(file, { encoding: 'utf8', signal });
      } catch {
        signal?.throwIfAborted();
        evidence?.incomplete('File could not be read');
        continue;
      }
      if (looksBinary(text.slice(0, 1024))) { evidence?.incomplete('Binary file skipped'); continue; }

      const lines = text.split('\n');
      let fileMatches = 0;
      for (let i = 0; i < lines.length; i++) {
        // Reset lastIndex defensively in case a global flag is ever added.
        regex.lastIndex = 0;
        if (!regex.test(lines[i])) continue;
        fileMatches++;
        total++;

        if (outputMode === 'content') {
          const rel = path.relative(cwd, file) || path.basename(file);
          if (collectFusion) {
            // Store enough to re-render with ±20 lines later; allLines is the already-read content
            fusionRecords.push({ rel, allLines: lines, matchIdx: i });
          }
          const from = Math.max(0, i - ctx);
          const to = Math.min(lines.length - 1, i + ctx);
          for (let j = from; j <= to; j++) {
            const marker = j === i ? ':' : '-';
            contentLines.push(`${rel}${marker}${j + 1}${marker}${lines[j]}`);
          }
          if (ctx > 0) contentLines.push('--');
          if (contentLines.length >= maxResults) { evidence?.incomplete('Result limit reached'); break outer; }
        } else if (outputMode === 'files') {
          break; // one match is enough to include the file
        }
      }

      if (fileMatches > 0) {
        if (outputMode === 'files') {
          matchedFiles.push(path.relative(cwd, file) || file);
          if (matchedFiles.length >= maxResults) { evidence?.incomplete('Result limit reached'); break; }
        } else if (outputMode === 'count') {
          counts.push({ file: path.relative(cwd, file) || file, n: fileMatches });
        }
      }
    }

    const where = rootStat.isFile() ? (path.relative(cwd, root) || path.basename(root)) : describeRoot(root, cwd);
    if (outputMode === 'files') {
      if (matchedFiles.length === 0) return `No files matched /${args.pattern}/ in ${where}.`;
      return `${matchedFiles.length} file(s) matched in ${where}:\n${matchedFiles.sort().join('\n')}`;
    }
    if (outputMode === 'count') {
      if (counts.length === 0) return `No matches for /${args.pattern}/ in ${where}.`;
      counts.sort((a, b) => b.n - a.n);
      return counts.map(c => `${c.n}\t${c.file}`).join('\n');
    }
    if (contentLines.length === 0) return `No matches for /${args.pattern}/ in ${where}.`;

    // Grep→Read fusion: ≤5 matches and user didn't specify contextLines → auto-expand to ±20
    if (collectFusion && total <= 5 && fusionRecords.length === total) {
      const fusedLines: string[] = [];
      for (const m of fusionRecords) {
        const from = Math.max(0, m.matchIdx - 20);
        const to = Math.min(m.allLines.length - 1, m.matchIdx + 20);
        fusedLines.push(`\n--- ${m.rel}:${m.matchIdx + 1} [±20 lines] ---`);
        for (let j = from; j <= to; j++) {
          const marker = j === m.matchIdx ? ':' : '-';
          fusedLines.push(`${m.rel}${marker}${j + 1}${marker}${m.allLines[j]}`);
        }
        fusedLines.push('--');
      }
      return `Found ${total} match(es) in ${where} [auto-expanded ±20 lines]:\n${fusedLines.join('\n')}`;
    }

    const header = `Found ${total} match(es) in ${where}${total > maxResults ? ` (showing first ${maxResults})` : ''}:`;
    return `${header}\n${contentLines.join('\n')}`;
  },
}, governor);

interface GlobArgs {
  pattern: string;
  path?: string;
  maxResults?: number;
}

export const createGlobTool = (governor: IGovernor) => buildTool({
  name: 'GlobTool',
  description: `Finds files by glob pattern, returned newest-first (by modification time). Use this to locate files by name or extension when you don't know their exact path — e.g. "all test files", "every tsx component".

# Instructions
- **pattern** is a glob such as \`**/*.ts\`, \`src/**/*.tsx\`, or \`**/index.*\`.
- Results are relative to the search directory and exclude node_modules/.git/dist by default.`,
  isDestructive: false,
  workflowReadOnly: true,
  isConcurrencySafe: true,
  schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.ts".' },
      path: { type: 'string', description: 'Directory to search from (default: current working directory).' },
      maxResults: { type: 'number', description: 'Maximum file paths to return (default 500).' },
    },
    required: ['pattern'],
  },
  execute: async (args: GlobArgs, context?: any) => {
    const evidence: WorkflowEvidence | undefined = context?.workflowEvidence;
    const signal: AbortSignal | undefined = context?.signal;
    signal?.throwIfAborted();
    const cwd = context?.cwd || process.cwd();
    const root = resolvePath(args.path || '.', cwd);
    const maxResults = args.maxResults ?? 500;

    const matches: { file: string; mtime: number }[] = [];
    for await (const f of walkFiles(root, {
      signal, onDirectory: (p, entries) => evidence?.directory(p, entries),
      onIncomplete: reason => evidence?.incomplete(reason),
    })) {
      const rel = path.relative(root, f);
      if (!minimatch(rel, args.pattern, { dot: true })) continue;
      const stat = await fs.stat(f).catch(() => null);
      if (stat) evidence?.stat(f, stat);
      else evidence?.incomplete('File metadata unavailable');
      matches.push({ file: path.relative(cwd, f) || f, mtime: stat ? stat.mtimeMs : 0 });
    }

    const where = describeRoot(root, cwd);
    if (matches.length === 0) return `No files matched ${args.pattern} under ${where}.`;
    matches.sort((a, b) => b.mtime - a.mtime);
    const shown = matches.slice(0, maxResults);
    if (shown.length < matches.length) evidence?.incomplete('Result limit reached');
    const suffix = matches.length > maxResults ? `\n...and ${matches.length - maxResults} more` : '';
    return `${matches.length} file(s) matched ${args.pattern} under ${where}:\n${shown.map(m => m.file).join('\n')}${suffix}`;
  },
}, governor);
