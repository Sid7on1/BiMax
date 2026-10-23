/**
 * A streamed reply, made speakable for talk mode: complete sentences as soon as they arrive, so speech starts while
 * the model is still writing, with markdown, links and code kept off the air. A code block becomes one short line.
 */
const FENCE = '```';
const CODE_LINE = 'I’ve put the code on screen.';
/** A sentence this long with no end in sight is split at a comma (or a space) so speech doesn't stall on it. */
const LONG = 240;

export function speakable(text: string): string {
  const s = text
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<?https?:\/\/[^\s>)]+>?/g, 'a link')
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*(?:[-*+•]|\d{1,3}[.)])[ \t]+/gm, '')
    .replace(/^[ \t]*\|.*\|[ \t]*$/gm, ' ')
    .replace(/(\*\*|__|~~)(\S(?:.*?\S)?)\1/g, '$2')
    .replace(/(^|\s)\*(\S(?:.*?\S)?)\*(?=\s|[.,!?]|$)/g, '$1$2')
    .replace(/[*`#|~]+/g, ' ')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return /[\p{L}\p{N}]/u.test(s) ? s : '';
}

export class SpokenReply {
  private buffer = '';
  private inCode = false;
  private saidCode = false;

  push(chunk: string): string[] {
    this.buffer += chunk;
    return this.take(false);
  }

  /** Whatever is left, once the message has ended. */
  flush(): string[] {
    const out = this.take(true);
    this.buffer = '';
    this.inCode = false;
    return out;
  }

  private take(final: boolean): string[] {
    const out: string[] = [];
    const say = (text: string): void => { const s = speakable(text); if (s) out.push(s); };
    for (;;) {
      if (this.inCode) {
        const close = this.buffer.indexOf(FENCE);
        // Keep two characters: the closing fence may be arriving in pieces.
        if (close < 0) { this.buffer = final ? '' : this.buffer.slice(-2); return out; }
        this.buffer = this.buffer.slice(close + FENCE.length);
        this.inCode = false;
        continue;
      }
      const open = this.buffer.indexOf(FENCE);
      const prose = open < 0 ? this.buffer : this.buffer.slice(0, open);
      // A sentence ends at . ! ? followed by space (so "6.2 GB" is not an end), or at a line break.
      const boundary = /[.!?]+["'’”)\]]*\s+|\n+/g;
      let last = 0;
      for (let m = boundary.exec(prose); m; m = boundary.exec(prose)) {
        say(prose.slice(last, m.index + m[0].length));
        last = m.index + m[0].length;
      }
      let rest = prose.slice(last);
      if (open >= 0) {
        say(rest);
        if (!this.saidCode) { out.push(CODE_LINE); this.saidCode = true; }
        this.buffer = this.buffer.slice(open + FENCE.length);
        this.inCode = true;
        continue;
      }
      if (!final && rest.length > LONG) {
        const comma = rest.lastIndexOf(', ', LONG);
        const cut = comma > 80 ? comma + 1 : rest.lastIndexOf(' ', LONG);
        if (cut > 40) { say(rest.slice(0, cut)); rest = rest.slice(cut); }
      }
      if (final) { say(rest); rest = ''; }
      this.buffer = rest;
      return out;
    }
  }
}
