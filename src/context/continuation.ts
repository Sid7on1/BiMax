import type { Message } from '../core/llm.provider';
import { contentToText } from '../core/multimodal';

/**
 * The continuation state: what a long task must not lose when compaction removes the messages that said it
 * (record 47 §3.5, record 50 step 6).
 *
 * Compaction left one narrative summary as the only record of everything it removed. A summarizer that dropped a line,
 * or failed, erased the user's constraint, the tested revision and the approach that had already failed (context
 * benchmark cases L1–L3). This state is kept by the engine from the messages compaction removes, and rendered into every
 * compacted window. It does not interpret what it keeps:
 * - the user's messages are quoted exactly;
 * - commands are what the engine ran, with the exit status it observed and a handle to the whole output;
 * - sentences in which the assistant reported an outcome or an attempt are quoted and labelled as claims, never as
 *   verified facts.
 * Decisions and next steps still come from the summary and the task list.
 *
 * Bounded: each kind keeps its newest entries, and the user's first message (the task) is always kept. The user's
 * messages that fall out are archived together under one handle rather than silently lost. One handle each cost more
 * tokens than the messages: sixteen of them were 40% of a block (measured on the long-session fixture).
 */

export const CONTINUATION_PREFIX = '[Continuation State]';

const MAX_QUOTE_CHARS = 300;
const MAX_INSTRUCTIONS = 10;
const MAX_CLAIMS = 8;
const MAX_COMMANDS = 6;
/** How much of the user's evicted messages the archived list keeps, oldest dropped first. */
const MAX_EVICTED_CHARS = 64 * 1024;

/** A sentence in which the assistant reports an outcome or an attempt. */
const OUTCOME = /\b(?:pass(?:ed|es)?|fail(?:ed|s|ing|ure)?|did not|didn't|does not|doesn't|broke|broken|fixed|reverted|tried|attempted|succeeded|regress(?:ed|ion)?)\b/i;
/** A user-role message the engine wrote (a screenshot, a nudge), not something the user said. */
const ENGINE_TAG = /^\[[A-Za-z][\w -]*\]/;
const HANDLE = /archive:[0-9a-f]{32}/;

interface Quote {
  text: string;
  /** The whole original's archive handle, when the quote had to be cut. */
  handle?: string;
  order: number;
}

interface Command {
  tool: string;
  command: string;
  status: string;
  lastLine: string;
  handle?: string;
  order: number;
}

export type Archiver = (text: string) => string | null;

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

function quote(text: string, archive: Archiver): Omit<Quote, 'order'> {
  const flat = normalize(text);
  if (flat.length <= MAX_QUOTE_CHARS) return { text: flat };
  const handle = archive(text);
  return { text: `${flat.slice(0, MAX_QUOTE_CHARS).trimEnd()}…`, ...(handle ? { handle } : {}) };
}

/** The sentences of `text` that report an outcome or an attempt. */
function outcomeSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map(normalize)
    .filter((sentence) => sentence.length >= 12 && sentence.length <= MAX_QUOTE_CHARS && OUTCOME.test(sentence));
}

/** The exit status a command's tool result shows, and its last meaningful line. */
function commandOutcome(content: string): { status: string; lastLine: string } {
  if (content.startsWith('Tool Error:')) return { status: 'failed to run', lastLine: normalize(content.split('\n')[0]).slice(0, 200) };
  let body = content;
  let status = 'ran';
  try {
    const parsed = JSON.parse(content) as { stdout?: string; stderr?: string };
    const code = /\[command exited with code (\d+)\]/.exec(parsed.stderr ?? '')?.[1];
    status = code ? `exit ${code}` : 'exit 0';
    body = `${parsed.stdout ?? ''}\n${(parsed.stderr ?? '').replace(/\[command exited with code \d+\]/, '')}`;
  } catch { /* not a shell payload: a stub or plain text */ }
  const lines = body.split('\n').map(normalize).filter(Boolean);
  return { status, lastLine: (lines[lines.length - 1] ?? '').slice(0, 200) };
}

export class ContinuationState {
  private instructions: Quote[] = [];
  private claims: Quote[] = [];
  private commands: Command[] = [];
  /** The user's messages that fell out of `instructions`, oldest first, bounded by MAX_EVICTED_CHARS. */
  private evicted: string[] = [];
  private evictedTotal = 0;
  private order = 0;

  /** Keep what `removed` said. `archive` saves a long original and returns its handle, or null when it cannot. */
  absorb(removed: readonly Message[], archive: Archiver): void {
    const calls = new Map<string, { name: string; args: string }>();
    for (const message of removed) {
      for (const call of (message as { tool_calls?: Array<{ id: string; function?: { name?: string; arguments?: string } }> }).tool_calls ?? []) {
        calls.set(call.id, { name: call.function?.name ?? '', args: call.function?.arguments ?? '' });
      }
    }
    for (const message of removed) {
      const text = contentToText(message.content ?? '').trim();
      if (!text) continue;
      if (message.role === 'user' && !ENGINE_TAG.test(text)) this.addInstruction(text, archive);
      else if (message.role === 'assistant') for (const sentence of outcomeSentences(text)) this.addClaim(sentence);
      else if (message.role === 'tool') {
        const call = calls.get((message as { tool_call_id?: string }).tool_call_id ?? '');
        if (call && /bash|shell|command|test/i.test(call.name)) this.addCommand(call, text, archive);
      }
    }
  }

  isEmpty(): boolean {
    return !this.instructions.length && !this.claims.length && !this.commands.length && !this.evicted.length;
  }

  /**
   * The state as a system message's text, or null when there is nothing to carry. `archive` saves the list of the
   * user's earlier messages. Past `maxChars`, the oldest claims and commands are left out first, then the user's
   * messages after the first go into the archived list, so the task and the newest entries stay. Rendering small
   * changes nothing: the state keeps every entry for the next render.
   */
  render(archive: Archiver, maxChars = Number.POSITIVE_INFINITY): string | null {
    if (this.isEmpty()) return null;
    const instructions = [...this.instructions];
    const evicted = [...this.evicted];
    let evictedTotal = this.evictedTotal;
    let claims = [...this.claims];
    let commands = [...this.commands];
    let omitted = 0;
    const placeholder = (): string => `archive:${'0'.repeat(32)}`;
    const build = (listHandle: (list: string) => string | null): string => {
      const lines = [
        `${CONTINUATION_PREFIX} — kept from messages that compaction removed. It is not a summary: the user's messages are quoted exactly, commands are what the engine ran, and what the assistant said is a claim, not a verified fact.`,
      ];
      if (instructions.length || evicted.length) {
        lines.push('', '## What the user said');
        for (const entry of instructions) lines.push(`- "${entry.text}"${entry.handle ? ` (whole message: ${entry.handle})` : ''}`);
        if (evicted.length) {
          const handle = listHandle(`Earlier messages from the user, oldest first:\n${evicted.map((text) => `- ${text}`).join('\n')}`);
          const dropped = evictedTotal - evicted.length;
          const where = handle ? `archived together as ${handle} (read with ContextArchiveTool)` : 'not shown here, and could not be archived';
          lines.push(`- ${evictedTotal} earlier message${evictedTotal === 1 ? '' : 's'} from the user, ${where}${dropped ? `; the oldest ${dropped} are no longer kept` : ''}.`);
        }
      }
      if (commands.length) {
        lines.push('', '## Commands the engine ran');
        for (const entry of commands) {
          lines.push(`- ${entry.tool} \`${entry.command}\` → ${entry.status}${entry.lastLine ? `; last line: ${entry.lastLine}` : ''}${entry.handle ? ` (whole output: ${entry.handle})` : ''}`);
        }
      }
      if (claims.length) {
        lines.push('', '## What the assistant said (claims, not verified)');
        for (const entry of claims) lines.push(`- "${entry.text}"`);
      }
      if (omitted) lines.push('', `(${omitted} older command and claim entr${omitted === 1 ? 'y was' : 'ies were'} left out to fit the request.)`);
      return lines.join('\n');
    };
    // Trim against a placeholder handle of the real length, so the list is archived once, at the end.
    while (build(placeholder).length > maxChars) {
      if (claims.length) { claims = claims.slice(1); omitted++; }
      else if (commands.length) { commands = commands.slice(1); omitted++; }
      else if (instructions.length > 1) {
        const [moved] = instructions.splice(1, 1);
        evicted.push(moved.handle ? `${moved.text} (whole message: ${moved.handle})` : moved.text);
        evictedTotal++;
      } else break;
    }
    return build(archive);
  }

  private addInstruction(text: string, archive: Archiver): void {
    const kept = quote(text, archive);
    this.instructions = this.instructions.filter((entry) => entry.text !== kept.text);
    this.instructions.push({ ...kept, order: this.order++ });
    // The first message is the task: it stays. Past the cap the oldest of the rest is archived and named.
    while (this.instructions.length > MAX_INSTRUCTIONS) {
      const [evicted] = this.instructions.splice(1, 1);
      this.evicted.push(evicted.handle ? `${evicted.text} (whole message: ${evicted.handle})` : evicted.text);
      this.evictedTotal++;
      let chars = this.evicted.reduce((sum, text) => sum + text.length, 0);
      while (chars > MAX_EVICTED_CHARS && this.evicted.length > 1) chars -= this.evicted.shift()!.length;
    }
  }

  private addClaim(sentence: string): void {
    this.claims = this.claims.filter((entry) => entry.text !== sentence);
    this.claims.push({ text: sentence, order: this.order++ });
    if (this.claims.length > MAX_CLAIMS) this.claims.shift();
  }

  private addCommand(call: { name: string; args: string }, content: string, archive: Archiver): void {
    let command = '';
    try { command = String((JSON.parse(call.args) as { command?: unknown }).command ?? ''); } catch { /* unparsable arguments */ }
    const { status, lastLine } = commandOutcome(content);
    const handle = HANDLE.exec(content)?.[0] ?? (content.length >= 512 ? archive(content) ?? undefined : undefined);
    this.commands.push({
      tool: call.name, command: normalize(command).slice(0, 160) || '(no command recorded)', status, lastLine,
      ...(handle ? { handle } : {}), order: this.order++,
    });
    if (this.commands.length > MAX_COMMANDS) this.commands.shift();
  }
}

/** Whether a message is a rendered continuation state. */
export function isContinuationMessage(message: { role: string; content?: unknown }): boolean {
  return message.role === 'system' && typeof message.content === 'string' && message.content.startsWith(CONTINUATION_PREFIX);
}
