/**
 * Correct once, teach deliberately (backlog N10). When a message to a ⌘2 task corrects how it works — "No, use ACME for
 * this client", "From now on, name the files by date" — the bar offers to keep it as one of the folder's rules, which
 * every later task in that folder follows. The person sees the rule, can edit it, and sees earlier requests in the
 * folder it would have applied to, before anything is saved. Nothing is learned without that click; the rules stay
 * visible and editable under ⋯ → Rules for this folder, and apply only to that folder.
 *
 * A one-off correction ("no, the other file") is not a rule, so only an instruction — a message that starts, after
 * "no" or "actually", with a verb such as use, name, put, keep, never or always — is offered.
 */

const OPENER = /^\s*(?:(?:no|nope|nah|wrong|actually|not quite|instead|that'?s (?:wrong|not right|not it))\b[\s,.!:;—–-]*)+/i;
const STANDING = /\s*,?\s*\b(?:from now on|going forward|in (?:the )?future|next time|for future (?:tasks|runs))\b\s*,?\s*/gi;
const INSTRUCTION = /^(?:please\s+)?(?:use|don'?t|do not|never|always|call|name|put|keep|save|send|write|make|prefer|avoid|stop|remember|only|skip|ask|leave|move|sort|file|rename|include|exclude)\b/i;

/** The rule a message teaches, as it would be written in the folder's rules; null when it teaches nothing lasting. */
export function correctionRule(message: string): string | null {
  const first = (message || '').trim().split('\n')[0]!.trim();
  // "No thanks" or "no worries" never passes: after "no", what is left must start with an instruction.
  if (first.length < 8 || first.length > 240 || first.endsWith('?')) return null;
  const corrected = OPENER.test(first);
  const standing = STANDING.test(first);
  STANDING.lastIndex = 0;
  if (!corrected && !standing) return null;
  const instruction = first.replace(OPENER, '').replace(STANDING, ' ').replace(/^[\s,.;:—–-]+/, '').replace(/\s+/g, ' ').trim();
  STANDING.lastIndex = 0;
  if (!INSTRUCTION.test(instruction) || instruction.length < 6) return null;
  const sentence = instruction.replace(/^please\s+/i, '').replace(/[\s,;:—–-]+$/, '');
  return `${sentence[0]!.toUpperCase()}${sentence.slice(1)}${/[.!]$/.test(sentence) ? '' : '.'}`;
}

/** Whether the folder's rules already say this, ignoring case, spacing and final punctuation. */
export function alreadyARule(rules: string, rule: string): boolean {
  const norm = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const wanted = norm(rule);
  return rules.split('\n').some((line) => norm(line.replace(/^\s*[-*]\s*/, '')) === wanted);
}

/** The folder's rules with this one added as its own line. */
export function withRule(rules: string, rule: string): string {
  const text = rules.trimEnd();
  return alreadyARule(text, rule) ? text : `${text ? `${text}\n` : ''}- ${rule.trim()}`;
}

const COMMON = new Set(['this', 'that', 'these', 'those', 'with', 'from', 'into', 'your', 'when', 'then', 'them', 'they',
  'always', 'never', 'dont', 'don’t', 'please', 'instead', 'every', 'each', 'files', 'file', 'folder', 'use', 'name',
  'make', 'keep', 'the', 'and', 'for', 'only', 'before', 'after', 'what', 'have', 'will', 'would', 'should', 'about']);
const words = (text: string): string[] => text.toLowerCase().match(/[a-z0-9][a-z0-9._-]{3,}/g) ?? [];

/**
 * Earlier requests in the folder the rule would have applied to: those naming one of its less common words (ACME,
 * invoices, dates…), newest first, at most three. They are shown before saving so the person can see its reach.
 */
export function sampleApplications(rule: string, earlier: readonly string[], limit = 3): string[] {
  const keys = new Set(words(rule).filter((word) => !COMMON.has(word)));
  if (!keys.size) return [];
  const out: string[] = [];
  for (const request of earlier) {
    const flat = request.replace(/\s+/g, ' ').trim();
    if (!flat || out.includes(flat) || !words(flat).some((word) => keys.has(word))) continue;
    out.push(flat.length > 140 ? `${flat.slice(0, 139)}…` : flat);
    if (out.length >= limit) break;
  }
  return out;
}
