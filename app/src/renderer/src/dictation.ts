/**
 * Dictation text and the hold-to-talk key, kept pure so they can be tested without a microphone.
 *
 * What the helper hears lands at the cursor: the words before it stay, the words after it stay, and a space is added
 * only where two words would otherwise touch.
 */
export const HOLD_TO_TALK_MS = 250;

export function composeDictation(before: string, spoken: string, after: string): { text: string; caret: number } {
  const words = spoken.replace(/\s+/g, ' ').trim();
  if (!words) return { text: before + after, caret: before.length };
  const lead = before && !/[\s([]$/.test(before) ? ' ' : '';
  const trail = after && !/^[\s.,!?;:)\]]/.test(after) ? ' ' : '';
  const head = before + lead + words;
  return { text: head + trail + after, caret: head.length };
}

/** Right ⌥ on its own is the talk key; with ⌘, ⌃ or ⇧ held it is left to whatever shortcut that is. */
export function isTalkKey(e: { code: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): boolean {
  return e.code === 'AltRight' && !e.metaKey && !e.ctrlKey && !e.shiftKey;
}

/**
 * Hold right ⌥ to talk. A quick tap does nothing, and pressing another key before the hold registers means ⌥ was
 * being used to type a character (⌥E, ⌥8…), so dictation never starts under someone's typing.
 */
export class HoldToTalk {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active = false;

  constructor(private readonly begin: () => void, private readonly end: () => void, private readonly delay = HOLD_TO_TALK_MS) {}

  down(): void {
    if (this.timer || this.active) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.active = true;
      this.begin();
    }, this.delay);
  }

  /** Another key arrived while ⌥ was still only pending. */
  interrupt(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  up(): void {
    if (this.timer) {
      this.interrupt();
      return;
    }
    if (!this.active) return;
    this.active = false;
    this.end();
  }
}
