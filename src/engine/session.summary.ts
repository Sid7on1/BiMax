/**
 * What a session is FOR, as its name in Recents (fix list item 7).
 *
 * A session was named by its first user message, cut at 80 characters — so Recents read "hey can you
 * look at why the build is failing on main after the merge" or "ok", not what the work was. Two layers
 * now name it, and the list always shows the best one it has:
 *
 *   1. `headlineFromPrompt` — immediate, deterministic, free: the first request with its greeting,
 *      politeness and filler removed, cut at a word boundary. Used for every session, including those
 *      recorded before summaries existed, so the list never waits on a model.
 *   2. `startSessionSummaries` — after a session's first reply, the Quick model is asked for a 3–7 word
 *      title from the request and the reply. A title that fails `acceptTitle` (empty, a sentence, a
 *      refusal, quoted chatter) is dropped and the headline stands. It is one bounded call per session.
 */
import { engineEvents, type MessageEntry } from './events';
import { currentSessionMeta, recordSessionSummary } from '../db/session.meta';

const LEAD_INS = [
  /^(hey|hi|hello|yo|ok(ay)?|so|well|alright|right|um+|uh+|hmm+)\b[\s,!.:-]*/i,
  /^(bimax|claude|there)\b[\s,!.:-]*/i,
  /^(please|pls|kindly)\b[\s,]*/i,
  /^(can|could|would|will) (you|u)( please)?\b[\s,]*/i,
  /^(i (want|need|would like|'d like)( you)? to|i want|i need|help me( to)?|let'?s|lets)\b[\s,]*/i,
  /^(go ahead and|try to|quickly)\b[\s,]*/i,
];

/** The first request, stripped of greeting and filler, as a headline of at most `max` characters. */
export function headlineFromPrompt(text: string, max = 48): string {
  let s = String(text || '').replace(/\s+/g, ' ').trim();
  // Only the first sentence or line: later ones are detail, not the subject.
  s = s.split(/(?<=[.?!])\s|\n/)[0] ?? s;
  for (let changed = true; changed;) {
    changed = false;
    for (const re of LEAD_INS) {
      const next = s.replace(re, '');
      if (next !== s) { s = next.trim(); changed = true; }
    }
  }
  s = s.replace(/[\s.,;:!?]+$/, '').replace(/\s+(please|pls|thanks|thank you)$/i, '');
  if (!s) return 'Untitled';
  if (s.length > max) {
    const cut = s.slice(0, max + 1);
    const space = cut.lastIndexOf(' ');
    s = `${(space > max * 0.5 ? cut.slice(0, space) : cut.slice(0, max)).replace(/[\s,;:-]+$/, '')}…`;
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A model's title, cleaned — or null when it is not a title at all. */
export function acceptTitle(raw: string): string | null {
  let s = String(raw || '').trim().split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  s = s.replace(/^(title|name|topic)\s*[:\-–]\s*/i, '').replace(/^[#*_>`"'“”‘’\s]+|[#*_`"'“”‘’\s]+$/g, '').replace(/[.!]+$/, '').trim();
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 9 || s.length > 64) return null;
  if (/^(i |i'm |sorry|as an ai|i can(not|'t))/i.test(s)) return null;
  // Output that is still reasoning or markup is not a name.
  if (/[<>{}[\]]/.test(s)) return null;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const TITLE_SYSTEM =
  'You name conversations. Reply with only a title of 3 to 7 words saying what the conversation is for — the task or ' +
  'the question, never a greeting. No quotes, no trailing punctuation, no emoji.';

export interface TitleSource {
  quickText: (system: string, user: string, maxTokens?: number) => Promise<string>;
}

/** One title for one request/reply pair; null when the model gave nothing usable or failed. */
export async function summarizeSession(llm: TitleSource, request: string, reply: string, timeoutMs = 20_000): Promise<string | null> {
  const user = `Request: ${request.slice(0, 800)}\n\nReply: ${reply.slice(0, 600)}`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      llm.quickText(TITLE_SYSTEM, user, 48),
      new Promise<string>((_, reject) => { timer = setTimeout(() => reject(new Error('title timed out')), timeoutMs); }),
    ]);
    return acceptTitle(raw);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Name each session after its first reply. Listens to the same `message` stream the session recorder
 * does; one attempt per session, never blocking the turn. Returns a stop function.
 */
export function startSessionSummaries(llm: TitleSource | null | undefined): () => void {
  if (!llm || typeof llm.quickText !== 'function') return () => undefined;
  let request = '';
  const tried = new Set<string>();
  const onMessage = (msg: MessageEntry): void => {
    if (!msg || typeof msg.content !== 'string') return;
    const meta = currentSessionMeta();
    if (!meta || meta.summary || tried.has(meta.id)) return;
    if (msg.role === 'user') { if (!request) request = msg.content; return; }
    if (msg.role !== 'assistant' || !request || !msg.content.trim()) return;
    const id = meta.id;
    tried.add(id);
    const ask = request;
    request = '';
    void summarizeSession(llm, ask, msg.content).then((title) => {
      if (title && recordSessionSummary(id, title)) engineEvents.emit('session_changed');
    });
  };
  // A new or resumed session starts its own request; a half-seen one from before must not name it.
  const onSession = (): void => { request = ''; };
  engineEvents.on('message', onMessage);
  engineEvents.on('session_changed', onSession);
  return () => {
    engineEvents.off('message', onMessage);
    engineEvents.off('session_changed', onSession);
  };
}
