import type { TalkView } from '../shared/talk';
import { SpokenReply, speakable } from './speech.text';
import type { VoiceEvent } from './voice';

export type { TalkState, TalkView } from '../shared/talk';

/**
 * Talk mode in the ⌘2 bar: listen → the words go to a spoken-style thread → its reply is read aloud sentence by
 * sentence as it streams → listen again.
 *
 * The on-device helper (native/voice, --talk) hears when a turn ends and speaks what it is given. The thread's engine
 * (BIMAX_THREAD_VOICE) answers with Bimax's tools, and a change still waits for a click on its approval card: talk
 * mode reads the card out but never answers it. A question the task asks is answered by voice, unless it wants a
 * secret or a checklist.
 */
export const DEFAULT_TALK_MODEL = 'openai/gpt-oss-20b';
/**
 * Goes to the engine with every spoken turn, never onto the screen. With the system prompt's spoken section alone,
 * gpt-oss-20b answered "What files are in this folder?" with a bare list; with this line it said "You have budget.csv
 * and notes.txt in this folder." (one run each through the real engine, 2026-09-14).
 */
export const TALK_TURN_HINT = '[Said out loud; your reply is read aloud. Answer in one to three short spoken sentences, no lists.]';
/** Listening this long with nothing heard ends talk mode, so a forgotten conversation does not keep the microphone on. */
export const QUIET_END_MS = 120_000;

/**
 * The model a talk-mode task answers with. A conversation needs a quick first sentence: through the full engine on
 * this Mac, gpt-oss-20b began answering "hi" after about 2s where Bimax's work model took 8–21s. It is used when the
 * provider serves it, or while the model list is not known yet; otherwise the ⌘2 default, then Bimax's own.
 */
export function talkModel(catalog: ReadonlyArray<{ id: string; served: boolean }>, quickDefault?: string): string | undefined {
  if (!catalog.length || catalog.some((m) => m.id === DEFAULT_TALK_MODEL && m.served)) return DEFAULT_TALK_MODEL;
  return quickDefault || undefined;
}

/** A question's choices the way a person reads them out: "Q1 or Q2?", "Q1, Q2 or Q3?". */
export function spokenChoices(options: readonly string[]): string {
  const said = options.map((option) => speakable(option)).filter(Boolean);
  if (!said.length) return '';
  return `${said.length > 1 ? `${said.slice(0, -1).join(', ')} or ` : ''}${said[said.length - 1]}?`;
}

const sentence = (text: string): string => (!text || /[.!?…]$/.test(text) ? text : `${text}.`);

export interface TalkHelper {
  send(command: Record<string, unknown>): void;
  end(): void;
}

export interface TalkDeps {
  spawn(onEvent: (event: VoiceEvent & Record<string, unknown>) => void, onExit: () => void): TalkHelper;
  /** The bar's spoken-style thread, started now so its engine warms up while the user speaks. */
  openThread(): string;
  /** `words` are what the user said, as shown; `engineText` is what the engine gets (the words and TALK_TURN_HINT). */
  submit(threadId: string, words: string, engineText: string): void;
  answer(threadId: string, requestId: number, text: string): void;
  interrupt(threadId: string): void;
  show(view: TalkView): void;
  /** Talk mode ended, however it ended, in this thread (null when it never opened one). */
  closed?(threadId: string | null): void;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

interface ThreadMessage {
  t: string;
  name?: string;
  args?: any[];
  id?: number;
  kind?: string;
  question?: string;
  options?: string[];
  isAsk?: boolean;
  isMulti?: boolean;
  masked?: boolean;
}

export class TalkSession {
  private view: TalkView = { state: 'off', heard: '', level: 0, voice: null, error: null, threadId: null };
  private helper: TalkHelper | null = null;
  private reply = new SpokenReply();
  /** Tokens streamed since the last complete assistant message (that message is then already spoken). */
  private streamed = false;
  /** The thread is still answering the last utterance. */
  private turnOpen = false;
  /** A question the task asked; the next utterance answers it. */
  private ask: number | null = null;
  private quiet: unknown = null;
  /** Which helper is current. One that has ended may still print (its own shutdown) and is not listened to. */
  private generation = 0;

  constructor(private readonly deps: TalkDeps) {}

  get active(): boolean { return this.view.state !== 'off'; }
  get threadId(): string | null { return this.view.threadId; }
  get current(): TalkView { return this.view; }

  start(): void {
    if (this.active) return;
    this.set({ state: 'starting', heard: '', level: 0, error: null, threadId: null });
    const generation = ++this.generation;
    this.helper = this.deps.spawn(
      (event) => { if (generation === this.generation) this.onHelper(event); },
      () => { if (generation === this.generation) this.onExit(); },
    );
  }

  end(): void {
    if (!this.active) return;
    const helper = this.helper;
    const { threadId } = this.view;
    this.generation++;
    this.helper = null;
    this.disarmQuiet();
    this.forgetTurn();
    this.set({ state: 'off', level: 0 });
    helper?.end();
    this.deps.closed?.(threadId);
  }

  /** Stop speaking (or stop the task thinking) and listen again. */
  interrupt(): void {
    const { state, threadId } = this.view;
    if (state !== 'speaking' && state !== 'thinking' && state !== 'waiting') return;
    this.helper?.send({ cmd: 'interrupt' });
    if (this.turnOpen && threadId) this.deps.interrupt(threadId);
    this.forgetTurn();
    this.listen();
  }

  /** A message from the talk thread's engine: every one the thread manager delivers. */
  onThreadMessage(value: object): void {
    if (!this.active || !this.helper) return;
    const msg = value as ThreadMessage;
    if (msg.t === 'request') {
      // Whatever the reply had said before it stopped to ask comes first.
      for (const said of this.reply.flush()) this.say(said);
      const question = speakable(msg.question ?? '');
      const options = msg.options ?? [];
      // Free text, or a few choices, is answered by voice. A secret is typed, and a checklist or an approval is
      // clicked: talk mode never says "allow" for anyone.
      const byVoice = !msg.masked && typeof msg.id === 'number' && (msg.kind === 'input' || (msg.isAsk === true && !msg.isMulti && options.length <= 5));
      if (byVoice) {
        this.ask = msg.id as number;
        this.say(msg.kind === 'input' || !options.length ? question : `${sentence(question)} ${spokenChoices(options)}`);
      } else {
        this.say(`${sentence(question) || 'Bimax needs your decision.'} ${msg.masked ? 'Type it on screen.' : 'Choose on screen.'}`);
      }
      this.helper.send({ cmd: 'flush' });
      return;
    }
    if (msg.t !== 'event') return;
    if (msg.name === 'stream_token') {
      this.streamed = true;
      for (const said of this.reply.push(String(msg.args?.[0] ?? ''))) this.say(said);
      return;
    }
    if (msg.name === 'message') {
      const message = msg.args?.[0] as { role?: string; level?: string; content?: unknown } | undefined;
      if (message?.role === 'assistant') {
        if (!this.streamed && typeof message.content === 'string') for (const said of this.reply.push(message.content)) this.say(said);
        for (const said of this.reply.flush()) this.say(said);
        this.streamed = false;
      } else if (message?.level === 'error' && this.turnOpen) {
        this.say('Sorry, that didn’t work. The details are on screen.');
      }
      return;
    }
    if (msg.name === 'spinner_state' && msg.args?.[0] === 'idle' && this.turnOpen) {
      for (const said of this.reply.flush()) this.say(said);
      this.turnOpen = false;
      this.streamed = false;
      this.helper.send({ cmd: 'flush' });
    }
  }

  private onHelper(event: VoiceEvent & Record<string, unknown>): void {
    switch (event.event) {
      case 'downloading':
        if (this.view.state === 'starting') this.set({ heard: 'Downloading the speech model…' });
        return;
      case 'ready': {
        const voice = event.voice ? { name: String(event.voice), quality: String(event.quality ?? 'default') } : null;
        let threadId: string;
        try { threadId = this.deps.openThread(); }
        catch (error) { this.set({ error: (error as Error).message }); this.end(); return; }
        this.set({ voice, threadId, heard: '' });
        this.listen();
        return;
      }
      case 'partial':
        if (this.view.state === 'listening') {
          const heard = String(event.text ?? '');
          this.set({ heard });
          // Someone is speaking: the quiet countdown starts again.
          if (heard.trim()) this.armQuiet();
        }
        return;
      case 'level':
        if (this.view.state === 'listening') this.set({ level: Math.max(0, Math.min(1, Number(event.value) || 0)) });
        return;
      case 'utterance': {
        const text = String(event.text ?? '').trim();
        const threadId = this.view.threadId;
        if (!text || !threadId) { this.listen(); return; }
        const ask = this.ask;
        this.disarmQuiet();
        this.forgetTurn();
        this.turnOpen = true;
        this.set({ state: 'thinking', heard: text, level: 0, error: null });
        try {
          if (ask !== null) this.deps.answer(threadId, ask, text);
          else this.deps.submit(threadId, text, `${text}\n\n${TALK_TURN_HINT}`);
        } catch (error) {
          this.turnOpen = false;
          this.set({ error: (error as Error).message });
          this.listen();
        }
        return;
      }
      case 'speaking':
        this.set({ state: 'speaking' });
        return;
      // Said everything queued so far, but the task is still working: back to thinking.
      case 'quiet':
        if (this.turnOpen && this.view.state === 'speaking') this.set({ state: 'thinking' });
        return;
      // Said everything, after a flush: the reply is over (listen), or it asked a question (listen for the answer),
      // or it is waiting on something to be clicked (wait for the click).
      case 'spoken':
        if (!this.turnOpen || this.ask !== null) this.listen();
        else this.set({ state: 'waiting' });
        return;
      case 'error':
        this.set({ error: String(event.message ?? 'Talk mode stopped.') });
        return;
      default:
    }
  }

  private onExit(): void {
    if (!this.active) return;
    this.helper = null;
    this.disarmQuiet();
    this.forgetTurn();
    this.set({ state: 'off', level: 0, error: this.view.error ?? 'Talk mode stopped unexpectedly.' });
    this.deps.closed?.(this.view.threadId);
  }

  private listen(): void {
    this.set({ state: 'listening', heard: '', level: 0 });
    this.helper?.send({ cmd: 'listen' });
    this.armQuiet();
  }

  private say(text: string): void {
    const said = text.trim();
    if (said) this.helper?.send({ cmd: 'speak', text: said });
  }

  private forgetTurn(): void {
    this.reply = new SpokenReply();
    this.streamed = false;
    this.turnOpen = false;
    this.ask = null;
  }

  private armQuiet(): void {
    this.disarmQuiet();
    const setTimer = this.deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    this.quiet = setTimer(() => {
      this.quiet = null;
      if (this.view.state !== 'listening') return;
      this.set({ error: 'Talk mode ended after two quiet minutes.' });
      this.end();
    }, QUIET_END_MS);
  }

  private disarmQuiet(): void {
    if (this.quiet === null) return;
    (this.deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)))(this.quiet);
    this.quiet = null;
  }

  private set(patch: Partial<TalkView>): void {
    this.view = { ...this.view, ...patch };
    this.deps.show(this.view);
  }
}
