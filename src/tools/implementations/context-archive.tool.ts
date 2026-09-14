import { IGovernor } from '../../core/interfaces';
import { buildTool } from '../tool.factory';
import { outcomeError } from '../outcome';
import { sliceLineRange } from '../file-range';
import { readArchivedOutput } from '../../context/output.archive';

/**
 * ContextArchiveTool — reads back a tool result that compaction cleared or cut, by the handle left in its place.
 *
 * It takes a handle, never a path, so a folder-scoped thread can read its own cleared results even though the archive
 * lives outside the thread's folder, and nothing else outside that folder becomes readable through it.
 */
export const createContextArchiveTool = (governor: IGovernor) => buildTool({
  name: 'ContextArchiveTool',
  description: `Reads back a tool result that was cleared or cut from context to save space.

Cleared and cut results carry a handle such as \`archive:3f2a…\`. Pass it here to get that result exactly as it was when it was cleared; the handle is the result's content hash and is checked on every read.

# Instructions
- This returns the EARLIER output, not the current state of any file or command. Re-read the file or re-run the tool when you need what is true now.
- For a long result, pass startLine/endLine instead of reading it whole.
- To find lines in a long result, pass pattern: the lines containing it come back numbered, at most maxMatches of them.`,
  isDestructive: false,
  workflowReadOnly: true,
  isConcurrencySafe: true,
  schema: {
    type: 'object',
    properties: {
      handle: { type: 'string', description: 'The handle from the cleared result: "archive:" followed by 32 hex digits.' },
      startLine: { type: 'number', description: 'Optional. The 1-indexed first line to return.' },
      endLine: { type: 'number', description: 'Optional. The 1-indexed last line to return.' },
      pattern: { type: 'string', description: 'Optional. Return only the lines containing this text (case-insensitive), numbered.' },
      maxMatches: { type: 'number', description: 'Optional, with pattern. How many matching lines to return (default 50, at most 200).' },
    },
    required: ['handle'],
  },
  execute: async (args: { handle: string; startLine?: number; endLine?: number; pattern?: string; maxMatches?: number }) => {
    const read = readArchivedOutput(String(args.handle ?? ''));
    if (!read.ok) {
      if (read.reason === 'malformed') {
        return outcomeError('invalid_args', 'That is not an archive handle. Handles are "archive:" followed by 32 hex digits.');
      }
      if (read.reason === 'missing') {
        return outcomeError('not_found', 'That archived result is no longer available: the archive keeps a bounded number of results and evicts the oldest. Re-run the tool that produced it.');
      }
      if (read.reason === 'unsafe') {
        return outcomeError('io', 'That archived result is not a plain file in the archive, so it is not read. Re-run the tool that produced it.');
      }
      return outcomeError('io', 'That archived result no longer matches its hash, so it is not returned. Re-run the tool that produced it.');
    }
    // A question about a large output is answered by searching it, not by reading it whole (record 47 §3.6, benchmark A1).
    const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : '';
    if (pattern) {
      const needle = pattern.toLowerCase();
      const lines = read.text.split('\n');
      const cap = Math.min(Math.max(1, Math.floor(Number(args.maxMatches) || 50)), 200);
      const shown: string[] = [];
      let count = 0;
      lines.forEach((line, i) => {
        if (!line.toLowerCase().includes(needle)) return;
        count++;
        if (shown.length < cap) shown.push(`${i + 1}: ${line.length > 300 ? `${line.slice(0, 300)}…` : line}`);
      });
      if (!count) return `No line of the archived result contains "${pattern}" (${lines.length} lines searched).`;
      return `${count} of ${lines.length} lines contain "${pattern}"${count > shown.length ? `; the first ${shown.length} are shown` : ''}:\n${shown.join('\n')}`;
    }
    if (args.startLine === undefined && args.endLine === undefined) return read.text;
    const { text, error } = sliceLineRange(read.text, args.startLine, args.endLine);
    if (error) return outcomeError('invalid_args', `Error: ${error}`);
    return text ?? '';
  },
}, governor);
