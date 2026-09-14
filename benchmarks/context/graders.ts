/**
 * Graders for the context benchmark.
 *
 * Every grade is a pure function of the text that would reach the model, so no grade depends on a model's
 * own answer. Before a run may score anything, each grader must pass its controls: the expected state
 * passes, an empty observation fails, a wrong target fails, stale content is caught
 * (06_HEAD_TO_HEAD_EVALS, grader requirements). A run whose self-check fails is invalid, not failed.
 */

export const GRADER_VERSION = 'context-graders@1';

const WORD_CHAR = /[\p{L}\p{M}\p{N}]/u;

function normalizeSpace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether `span` appears in `text` as a whole run of words, compared with whitespace collapsed. A span
 * that starts or ends with a letter, mark or digit must not continue into a neighbouring one, so
 * `30 seconds` does not match `130 seconds` and `wanted` does not match `wantedExtra`.
 */
export function hasSpan(text: string, span: string): boolean {
  const needle = normalizeSpace(span);
  if (!needle) return false;
  const chars = Array.from(needle);
  const before = WORD_CHAR.test(chars[0]) ? '(?<![\\p{L}\\p{M}\\p{N}])' : '';
  const after = WORD_CHAR.test(chars[chars.length - 1]) ? '(?![\\p{L}\\p{M}\\p{N}])' : '';
  return new RegExp(`${before}${escapeRegExp(needle)}${after}`, 'u').test(normalizeSpace(text));
}

export function hasAll(text: string, spans: string[]): boolean {
  return spans.length > 0 && spans.every((span) => hasSpan(text, span));
}

export function hasNone(text: string, spans: string[]): boolean {
  return spans.every((span) => !hasSpan(text, span));
}

/** The fraction of `spans` present in `text`. */
export function spanRecall(text: string, spans: string[]): number {
  if (!spans.length) return 0;
  return spans.filter((span) => hasSpan(text, span)).length / spans.length;
}

export interface GraderCheck {
  name: string;
  ok: boolean;
}

/** The controls every grader must pass before a run may score anything. */
export function graderSelfCheck(): GraderCheck[] {
  const check = (name: string, ok: boolean): GraderCheck => ({ name, ok });
  return [
    check('the expected state passes', hasAll('The orchid launch passphrase is VIOLET-SENTINEL.', ['VIOLET-SENTINEL'])),
    check('an empty observation fails', !hasAll('', ['VIOLET-SENTINEL'])),
    check('no required spans is never a pass', !hasAll('anything at all', [])),
    check('a wrong target fails', !hasAll('The passphrase is VIOLET-SENTRY.', ['VIOLET-SENTINEL'])),
    check('a longer number is not the expected number', !hasSpan('the timeout is 130 seconds', '30 seconds')),
    check('every required span is needed', !hasAll('src/net/retry.ts', ['src/net/retry.ts', 'src/net/cancel.ts'])),
    check('a sibling directory is not the scoped one', !hasSpan('src/wantedExtra/leak.ts', 'wanted')),
    check('stale content is detected', !hasNone('the timeout is 30 seconds', ['30 seconds'])),
    check('absent stale content passes', hasNone('the timeout is 60 seconds', ['30 seconds'])),
    check('a non-Latin span matches the whole word', hasSpan('मासिक भुगतान की अंतिम तिथि 15 तारीख है', '15 तारीख')),
    check('a non-Latin prefix is not the word', !hasSpan('भुगतानों का सारांश', 'भुगतान')),
    check('a partial recall scores as partial', spanRecall('retry.ts and cancel.ts', ['retry.ts', 'cancel.ts', 'retry.test.ts']) === 2 / 3),
    check('an error message does not satisfy an expected span', !hasAll('Error: provider unavailable', ['VIOLET-SENTINEL'])),
  ];
}
