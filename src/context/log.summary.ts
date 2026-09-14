import { ERROR_LINE, looksLikeCode } from '../memory/headroom.compress';

/**
 * A log's shape in one line: how many lines it had, how many reported a failure, and where the first ones were
 * (record 47 §3.5, record 50 step 6d).
 *
 * Compression collapses similar lines and clearing replaces a result with a stub, so what stood in a log's place said
 * neither how long it was nor where it failed (context benchmark case N6). The summary is taken from the whole output
 * before anything is cut, and travels with every smaller form of it next to the archive handle of the raw text. It
 * answers only what it states: a line count and failure lines are not percentiles or event order. For those, read the
 * raw output back through its handle.
 */

export const LOG_SUMMARY_PREFIX = '[log:';

const MIN_LOG_LINES = 20;
const MAX_FAILURES_SHOWN = 3;
const MAX_LINE_CHARS = 160;

/** A shell result's text: its stdout and stderr when it is BashTool's JSON payload, else the text itself. */
function outputText(text: string): string {
  if (!text.startsWith('{')) return text;
  try {
    const parsed = JSON.parse(text) as { stdout?: unknown; stderr?: unknown };
    if (typeof parsed.stdout === 'string' || typeof parsed.stderr === 'string') {
      return [parsed.stdout, parsed.stderr].filter((part) => typeof part === 'string' && part).join('\n');
    }
  } catch { /* not JSON */ }
  return text;
}

/** The one-line summary of a log-like output, or null for code, short output, or anything that is not a log. */
export function summarizeLog(text: string): string | null {
  const body = outputText(text);
  if (looksLikeCode(body)) return null;
  const lines = body.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  if (lines.length < MIN_LOG_LINES) return null;

  let failureCount = 0;
  const shown: string[] = [];
  const kinds = new Set<string>();
  lines.forEach((line, i) => {
    if (!ERROR_LINE.test(line)) return;
    failureCount++;
    // Different kinds of failure first: lines that differ only in their numbers are one kind.
    const kind = line.replace(/\d+/g, '#').trim();
    if (shown.length < MAX_FAILURES_SHOWN && !kinds.has(kind)) {
      kinds.add(kind);
      shown.push(`line ${i + 1} "${line.trim().slice(0, MAX_LINE_CHARS)}"`);
    }
  });
  const failures = failureCount
    ? `${failureCount} failure line${failureCount === 1 ? '' : 's'}; first of each kind: ${shown.join(', ')}`
    : 'no failure lines';
  return `${LOG_SUMMARY_PREFIX} ${lines.length} lines, ${failures}]`;
}

/** The summary line a smaller form of a log already carries, when it starts with one. */
export function carriedSummary(content: string): string | null {
  return content.startsWith(LOG_SUMMARY_PREFIX) ? content.slice(0, content.indexOf('\n') < 0 ? undefined : content.indexOf('\n')) : null;
}
