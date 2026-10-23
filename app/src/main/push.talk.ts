import type { VoiceEvent } from './voice';

/**
 * Talk anywhere (backlog N8): hold a shortcut in any app, say what you want, let go. The words become a ⌘2 task in
 * the folder Finder shows (the same context ⌘2 reads), and the answer comes back out loud or as a notification.
 *
 * Electron's global shortcuts report the press, never the release, so the voice helper watches the key itself
 * (`--listen --hold <key code>`). When macOS does not report the key as held — a quick tap, or a Mac that refuses —
 * the shortcut toggles instead: press to start, press again to send. Nothing is sent when nothing was heard.
 */

export interface PushTalkChoice { accelerator: string; label: string; keyCode: number }

/** Off by default: a global shortcut takes the key from every app, so the person chooses one. */
export const PUSH_TALK_CHOICES: readonly PushTalkChoice[] = [
  { accelerator: 'Control+Alt+T', label: '⌃⌥T', keyCode: 17 },
  { accelerator: 'Control+Alt+Command+Space', label: '⌃⌥⌘Space', keyCode: 49 },
  { accelerator: 'Control+Alt+Space', label: '⌃⌥Space', keyCode: 49 },
];

export function pushTalkChoice(saved: unknown): PushTalkChoice | null {
  return PUSH_TALK_CHOICES.find((choice) => choice.accelerator === saved) ?? null;
}

export type PushTalkAnswer = 'voice' | 'notification';
export function pushTalkAnswer(saved: unknown): PushTalkAnswer {
  return saved === 'notification' ? 'notification' : 'voice';
}

/** What is said out loud for an answer: its first sentences, at most about 300 characters. */
export function spokenSummary(answer: string, limit = 300): string {
  const flat = answer.replace(/```[\s\S]*?```/g, ' ').replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, '').replace(/[*_`#>|]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  const sentences = flat.match(/[^.!?…]+[.!?…]+/g) ?? [];
  let out = '';
  for (const sentence of sentences) {
    if ((out + sentence).length > limit) break;
    out += sentence;
  }
  return (out || `${flat.slice(0, limit - 1)}…`).trim();
}

export interface PushTalkDeps {
  /** Start listening; `holdKey` asks the helper to stop by itself when that key is released. */
  listen(holdKey: number): void;
  stop(): void;
  /** The folder the task works in, read at the press (before anything takes focus); null when there is none. */
  folder(): Promise<string | null>;
  /** Start the task with the words heard. */
  submit(root: string, words: string): void;
  /** No usable folder: open the ⌘2 bar with the words in it, so the person picks one. */
  openBar(words: string): void;
  /** The menu bar shows that Bimax is listening. */
  indicate(listening: boolean): void;
  /** Tell the person something went wrong, or that nothing was heard. */
  tell(message: string): void;
}

export class PushToTalk {
  private state: 'idle' | 'starting' | 'listening' | 'settling' = 'idle';
  private heard: string[] = [];
  private root: string | null = null;
  /** An error was already told for this session, so "didn't hear anything" would only repeat it. */
  private failed = false;

  constructor(private readonly deps: PushTalkDeps) {}

  get listening(): boolean { return this.state !== 'idle'; }

  /** The shortcut was pressed: start listening, or — while listening — send what was said. */
  async press(choice: PushTalkChoice): Promise<void> {
    if (this.state === 'listening') { this.state = 'settling'; this.deps.stop(); return; }
    if (this.state !== 'idle') return;
    this.state = 'starting';
    this.heard = [];
    this.failed = false;
    this.root = await this.deps.folder().catch(() => null);
    if (this.state !== 'starting') return;
    this.state = 'listening';
    this.deps.indicate(true);
    this.deps.listen(choice.keyCode);
  }

  /** An event from the helper for this session. */
  onEvent(event: VoiceEvent): void {
    if (this.state === 'idle') return;
    if (event.event === 'final' && typeof event.text === 'string' && event.text.trim()) this.heard.push(event.text.trim());
    else if (event.event === 'error' && event.message) { this.failed = true; this.deps.tell(event.message); }
    else if (event.event === 'stopped') this.finish(event);
  }

  private finish(event: VoiceEvent): void {
    this.state = 'idle';
    this.deps.indicate(false);
    const words = this.heard.join(' ').replace(/\s+/g, ' ').trim();
    this.heard = [];
    if (event.cancelled) return;
    if (!words) { if (!this.failed) this.deps.tell(event.message || 'Bimax didn’t hear anything.'); return; }
    if (this.root) this.deps.submit(this.root, words);
    else this.deps.openBar(words);
  }
}
