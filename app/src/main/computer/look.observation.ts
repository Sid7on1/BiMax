/**
 * What of another app's window reaches the model (record 65, stage 2).
 *
 * The driver's `tree_markdown` is the whole accessibility snapshot of the window's process, and it carries more than
 * the window: measured 2026-10-01, the menu bar came with it — the user's recent applications and their full name
 * ("Log Out <name>…"). So the menu bar is cut out whole, password fields lose their value, the driver's bookkeeping
 * (element numbers, action lists) is dropped, and the result is bounded. Pure: no driver, no Electron.
 */

export interface LookRender {
  text: string;
  lines: number;
  /** Lines left out because the window was longer than the bound. */
  omitted: number;
  menuBarRemoved: boolean;
  hiddenSecureFields: number;
}

const MAX_LINES = 400;
const MAX_LINE_CHARS = 300;

interface Line { indent: number; body: string }

function parse(markdown: string): Line[] {
  const out: Line[] = [];
  for (const raw of markdown.split('\n')) {
    const match = /^(\s*)- (.*)$/.exec(raw);
    if (!match) continue;
    out.push({ indent: match[1].length, body: match[2] });
  }
  return out;
}

/** `[12] AXButton "Save" [id=save actions=[press]]` → `AXButton "Save" (id save)`. */
function clean(body: string): string {
  let text = body.replace(/^\[\d+\]\s*/, '');
  text = text.replace(/\s?actions=\[[^\]]*\]/g, '');
  text = text.replace(/\s*\[\s*\]/g, '');
  text = text.replace(/\[id=([^\s\]]+)\s*\]/g, '(id $1)');
  text = text.replace(/\[id=([^\s\]]+)\s+([^\]]*)\]/g, '(id $1) [$2]');
  return text.trim();
}

export function renderLook(markdown: string, opts: { maxLines?: number } = {}): LookRender {
  const maxLines = opts.maxLines ?? MAX_LINES;
  const kept: string[] = [];
  let menuBarRemoved = false;
  let hiddenSecureFields = 0;
  let skipBelow: number | null = null;
  let omitted = 0;

  for (const line of parse(markdown)) {
    if (skipBelow !== null) {
      if (line.indent > skipBelow) continue;
      skipBelow = null;
    }
    // The menu bar and everything under it: recent apps, recent documents, the account name.
    if (/^(\[\d+\]\s*)?AXMenuBar\b/.test(line.body)) {
      menuBarRemoved = true;
      skipBelow = line.indent;
      continue;
    }
    let body = clean(line.body);
    if (/^AXSecureTextField\b/.test(body)) {
      if (/=\s*"/.test(body)) hiddenSecureFields += 1;
      body = body.replace(/=\s*"(?:[^"\\]|\\.)*"/, '= (hidden)');
    }
    if (!body) continue;
    if (kept.length >= maxLines) { omitted += 1; continue; }
    const indent = '  '.repeat(Math.min(12, Math.floor(line.indent / 2)));
    kept.push((indent + body).slice(0, MAX_LINE_CHARS));
  }

  const tail = omitted ? [`… ${omitted} more line${omitted === 1 ? '' : 's'} not shown`] : [];
  return {
    text: [...kept, ...tail].join('\n'),
    lines: kept.length,
    omitted,
    menuBarRemoved,
    hiddenSecureFields,
  };
}
