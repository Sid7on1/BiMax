import path from 'node:path';

/**
 * Dictation in the main process. Each dictation is one run of the on-device helper (native/voice/main.swift):
 * started when the user presses the mic or holds right ⌥, told "stop" or "cancel" over stdin, and gone when it
 * exits. One microphone session runs at a time — starting another cancels the first — and events go only to the
 * window that started it. Every session ends with exactly one "stopped", even when the helper crashes.
 */
export interface VoiceEvent { event: string; text?: string; value?: number; code?: string; message?: string; cancelled?: boolean }

export interface VoiceChild {
  stdin: { write(text: string): unknown } | null;
  stdout: { on(event: 'data', listener: (chunk: string | Buffer) => void): unknown } | null;
  on(event: string, listener: (...args: any[]) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export function splitVoiceLines(buffer: string): { events: VoiceEvent[]; rest: string } {
  const lines = buffer.split('\n');
  const rest = lines.pop() ?? '';
  const events: VoiceEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && typeof value.event === 'string') events.push(value as VoiceEvent);
    } catch { /* not a protocol line */ }
  }
  return { events, rest: rest.length > 64_000 ? '' : rest };
}

export function voiceHelperPath(input: { packaged: boolean; resourcesPath: string; appPath: string }): string {
  return input.packaged ? path.join(input.resourcesPath, 'voice', 'bimax-voice') : path.join(input.appPath, 'voice', 'bimax-voice');
}

/** SpeechAnalyzer's dictation model needs macOS 26, which is Darwin 25. */
export function voiceSupported(platform: string, release: string, helperExists: boolean): boolean {
  return platform === 'darwin' && Number.parseInt(release, 10) >= 25 && helperExists;
}

interface Session { owner: number; child: VoiceChild; ended: boolean; errored: boolean }

export class VoiceSessions {
  private current: Session | null = null;

  constructor(private readonly deps: {
    spawn: (args: string[]) => VoiceChild;
    send: (owner: number, event: VoiceEvent) => void;
    setTimeout?: (fn: () => void, ms: number) => unknown;
  }) {}

  get activeOwner(): number | null { return this.current?.owner ?? null; }

  start(owner: number, options: { locales: readonly string[]; context: readonly string[] }): void {
    this.cancelCurrent();
    const args = ['--listen'];
    const locales = options.locales.filter((l) => /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/.test(l));
    if (locales.length) args.push('--locale', locales.join(','));
    const words = [...new Set(options.context.map((w) => w.replace(/[,\n]/g, ' ').trim()).filter(Boolean))];
    if (words.length) args.push('--context', words.join(','));
    let child: VoiceChild;
    try {
      child = this.deps.spawn(args);
    } catch (error) {
      this.deps.send(owner, { event: 'stopped', code: 'helper', message: `Dictation couldn’t start: ${(error as Error).message}` });
      return;
    }
    const session: Session = { owner, child, ended: false, errored: false };
    this.current = session;
    let rest = '';
    child.stdout?.on('data', (chunk) => {
      const parsed = splitVoiceLines(rest + String(chunk));
      rest = parsed.rest;
      for (const event of parsed.events) {
        if (event.event === 'stopped') session.ended = true;
        if (event.event === 'error') session.errored = true;
        this.deps.send(owner, event);
      }
    });
    const finish = (message?: string): void => {
      if (this.current === session) this.current = null;
      if (session.ended) return;
      session.ended = true;
      // A helper that already explained its failure (microphone off, language unsupported) keeps that message.
      this.deps.send(owner, { event: 'stopped', ...(message && !session.errored ? { code: 'helper', message } : {}) });
    };
    child.on('exit', (code: number | null) => finish(code ? 'Dictation stopped unexpectedly.' : undefined));
    child.on('error', (error: Error) => finish(`Dictation couldn’t start: ${error.message}`));
  }

  /** Keep what was heard: the helper settles its last words, then exits. */
  stop(owner: number): void {
    const s = this.current;
    if (!s || s.owner !== owner) return;
    this.write(s, 'stop');
    this.later(() => { if (!s.ended) s.child.kill(); }, 8000);
  }

  /** Drop what was heard. */
  cancel(owner: number): void {
    if (this.current?.owner === owner) this.cancelCurrent();
  }

  dispose(): void { this.cancelCurrent(); }

  private cancelCurrent(): void {
    const s = this.current;
    if (!s) return;
    this.current = null;
    this.write(s, 'cancel');
    this.later(() => { if (!s.ended) s.child.kill(); }, 1500);
  }

  private write(s: Session, text: string): void {
    try { s.child.stdin?.write(`${text}\n`); } catch { s.child.kill(); }
  }

  private later(fn: () => void, ms: number): void {
    (this.deps.setTimeout ?? ((f: () => void, t: number) => setTimeout(f, t)))(fn, ms);
  }
}
