import * as path from 'path';
import { Message } from '../core/llm.provider';

const EXACT_WORDS = /\b(\d{1,5})\s*(?:words?|wrds?|wds?)\b/i;
const RELAXES_PRIOR_LENGTH = /\b(?:longer|shorter|expand|condense|abridge|double|halve)\b/i;
const PROSE_EXTENSIONS = new Set(['.txt', '.md', '.rtf', '.doc', '.docx', '.odt']);

/** Find the active prose-length constraint, carrying it across a follow-up such as "make it horror". */
export function inferExactWordTarget(messages: Message[]): number | undefined {
  let userTurns = 0;
  for (let i = messages.length - 1; i >= 0 && userTurns < 8; i--) {
    const message = messages[i];
    if (message.role !== 'user' || typeof message.content !== 'string') continue;
    userTurns++;
    const match = message.content.match(EXACT_WORDS);
    if (match) {
      const target = Number(match[1]);
      if (Number.isInteger(target) && target >= 0) return target;
    }
    // "Make it longer" deliberately supersedes an older exact count even without naming a new one.
    if (userTurns === 1 && RELAXES_PRIOR_LENGTH.test(message.content)) return undefined;
  }
  return undefined;
}
function looksLikeTitledProse(content: string): boolean {
  const lines = content.split(/\r?\n/);
  const first = lines.findIndex(line => line.trim().length > 0);
  if (first < 0 || first + 1 >= lines.length || lines[first + 1].trim() !== '') return false;
  const titleWords = lines[first].trim().split(/\s+/).length;
  return titleWords > 0 && titleWords <= 12;
}

/** Add deterministic validation args to a WriteFileTool call before it enters provider history. */
export function applyImplicitWriteConstraints(rawArgs: string, messages: Message[]): string {
  let args: any;
  try { args = JSON.parse(rawArgs || '{}'); } catch { return rawArgs; }
  if (!args || typeof args !== 'object' || typeof args.content !== 'string' || typeof args.path !== 'string') return rawArgs;
  if (args.expectedWords !== undefined) return JSON.stringify(args);
  if (!PROSE_EXTENSIONS.has(path.extname(args.path).toLowerCase())) return JSON.stringify(args);

  const target = inferExactWordTarget(messages);
  if (target === undefined) return JSON.stringify(args);
  args.expectedWords = target;
  if (args.excludeTitleFromWordCount === undefined) {
    args.excludeTitleFromWordCount = looksLikeTitledProse(args.content);
  }
  return JSON.stringify(args);
}

/** Apply the same prose-length contract to PDF/Word output, including incremental drafts. */
export function applyImplicitDocumentConstraints(rawArgs: string, messages: Message[]): string {
  let args: any;
  try { args = JSON.parse(rawArgs); } catch { return rawArgs; }
  if (!args || !['pdf', 'docx'].includes(args.format)) return rawArgs;
  const target = inferExactWordTarget(messages);
  if (target !== undefined && args.expectedWords === undefined) args.expectedWords = target;
  return JSON.stringify(args);
}
