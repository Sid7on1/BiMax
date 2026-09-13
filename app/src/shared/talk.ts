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
