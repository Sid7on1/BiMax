/**
 * Talk mode's view, shared by the main process (main/talk.session.ts) and the ⌘2 bar that draws it.
 *
 * starting: the helper is loading · listening: the microphone is open · thinking: the task is answering ·
 * speaking: a reply is being read aloud · waiting: the task needs a click on screen before it can go on.
 */
export type TalkState = 'off' | 'starting' | 'listening' | 'thinking' | 'speaking' | 'waiting';

export interface TalkView {
  state: TalkState;
  /** What the user is saying, or last said. */
  heard: string;
  /** 0–1 microphone level while listening. */
  level: number;
  /** The voice replies are read in. Quality "default" is the Mac's basic voice. */
  voice: { name: string; quality: string } | null;
  error: string | null;
  threadId: string | null;
}

/**
 * Goes to the engine with every spoken turn, never onto the screen. With the system prompt's spoken section alone,
 * gpt-oss-20b answered "What files are in this folder?" with a bare list; with this line it said "You have budget.csv
 * and notes.txt in this folder." (one run each through the real engine, 2026-09-14).
 */
export const TALK_TURN_HINT = '[Said out loud; your reply is read aloud. Answer in one to three short spoken sentences, no lists.]';

/** A turn as the person said it. The engine echoes and saves the words with TALK_TURN_HINT, which is never shown. */
export function withoutTalkHint(text: string): string {
  return text.endsWith(TALK_TURN_HINT) ? text.slice(0, -TALK_TURN_HINT.length).trimEnd() : text;
}
