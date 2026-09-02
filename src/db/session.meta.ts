import * as fs from 'fs';
import * as path from 'path';

export interface SessionMeta {
  id: string;           // same as the JSONL filename stem
  title: string;        // first user message, truncated
  cwd: string;          // working directory when session started
  startedAt: string;    // ISO
  endedAt?: string;     // ISO — set on shutdown
  messageCount: number;
  tokenEstimate: number;
  goalId?: string;      // active GoalManager goal at session start
  goalTitle?: string;
}

const META_FILE = '.breakglass/sessions/sessions-meta.jsonl';

// Resolved lazily: the engine chdir()s to BIMAX_CWD during boot (after some modules load) and
// tests chdir to tmpdirs — a captured-at-import path would write meta into the wrong project.
function metaPath(): string {
  return path.join(process.cwd(), META_FILE);
}

function readAllMeta(): SessionMeta[] {
  let raw: string;
  try {
    raw = fs.readFileSync(metaPath(), 'utf8');
  } catch {
    return [];   // no file yet — a genuinely empty history
  }
  // Parse per line. A torn or truncated line is the ONLY thing that should be lost: parsing the
  // whole file under one try/catch meant a single bad byte returned [], which silently erased the
  // entire session list (Recents rendered "Nothing yet") AND made updateMeta's findIndex miss every
  // id, so titles and message counts stopped being written and every later session stayed
  // "(no messages yet)" forever. Append-only logs must degrade line by line.
  const out: SessionMeta[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as SessionMeta);
    } catch { /* skip the damaged line, keep the history */ }
  }
  return out;
}

function appendMeta(meta: SessionMeta): void {
  try {
    const p = metaPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(meta) + '\n', 'utf8');
  } catch { /* best-effort */ }
}

function updateMeta(id: string, updates: Partial<SessionMeta>): void {
  try {
    const all = readAllMeta();
    const idx = all.findIndex(m => m.id === id);
    if (idx === -1) return;
    all[idx] = { ...all[idx], ...updates };
    // Write through a temp file and rename. A full-file writeFileSync here races appendMeta (and a
    // second engine process), and an interrupted one leaves a half-written line that used to poison
    // every later read. rename(2) is atomic on the same filesystem, so a reader sees either the old
    // file or the new one — never a torn one.
    const p = metaPath();
    const tmp = `${p}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(tmp, all.map(m => JSON.stringify(m)).join('\n') + '\n', 'utf8');
    fs.renameSync(tmp, p);
  } catch { /* best-effort */ }
}

// --- Module-level session tracker ---

let _current: SessionMeta | null = null;

// Progress writes are debounced so a long session doesn't trigger O(n) JSONL rewrites on
// every assistant message. The timer fires 10s after the last update; endSessionMeta() always
// flushes immediately regardless.
let _progressTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleProgressFlush(): void {
  if (_progressTimer) return;
  _progressTimer = setTimeout(() => {
    _progressTimer = null;
    if (_current) updateMeta(_current.id, { messageCount: _current.messageCount, tokenEstimate: _current.tokenEstimate });
  }, 10_000);
  // A pending flush must never hold the engine process open after stdin closes.
  (_progressTimer as any).unref?.();
}

/** Flush the debounced progress write immediately (shutdown paths and tests). */
export function flushSessionMeta(): void {
  if (!_current) return;
  if (_progressTimer) { clearTimeout(_progressTimer); _progressTimer = null; }
  updateMeta(_current.id, { messageCount: _current.messageCount, tokenEstimate: _current.tokenEstimate });
}

/** Called at session start (in FullScreen after sessionRef.init()). */
export function startSessionMeta(sessionId: string, cwd: string, goalId?: string, goalTitle?: string): void {
  _current = {
    id: sessionId,
    title: '(no messages yet)',
    cwd,
    startedAt: new Date().toISOString(),
    messageCount: 0,
    tokenEstimate: 0,
    goalId,
    goalTitle,
  };
  appendMeta(_current);
}

/** Called when the first user message arrives — sets the session title. Returns true if it did. */
export function recordFirstUserMessage(text: string): boolean {
  if (!_current || _current.title !== '(no messages yet)') return false;
  _current.title = text.replace(/\s+/g, ' ').trim().slice(0, 80);
  updateMeta(_current.id, { title: _current.title });
  return true;
}

/**
 * Point the tracker at an EXISTING session (true resume: the thread continues in its own record).
 * Reuses the on-disk record when present; a session that predates meta tracking gets a new record
 * so it appears in lists from now on. Clears endedAt — the thread is live again.
 */
export function resumeSessionMeta(id: string, fallbackTitle?: string): void {
  const existing = readAllMeta().find(m => m.id === id);
  if (existing) {
    _current = { ...existing, endedAt: undefined };
    updateMeta(id, { endedAt: undefined });
  } else {
    _current = {
      id,
      title: (fallbackTitle || '').replace(/\s+/g, ' ').trim().slice(0, 80) || '(no messages yet)',
      cwd: process.cwd(),
      startedAt: new Date().toISOString(),
      messageCount: 0,
      tokenEstimate: 0,
    };
    appendMeta(_current);
  }
}

/** Called on each assistant message — keeps message count and token estimate current. */
export function recordSessionProgress(messageCount: number, tokenEstimate: number): void {
  if (!_current) return;
  _current.messageCount = messageCount;
  _current.tokenEstimate = tokenEstimate;
  scheduleProgressFlush();
}

/** Called on shutdown — flushes any pending progress and marks the session as ended. */
export function endSessionMeta(): void {
  if (!_current) return;
  if (_progressTimer) { clearTimeout(_progressTimer); _progressTimer = null; }
  updateMeta(_current.id, {
    messageCount: _current.messageCount,
    tokenEstimate: _current.tokenEstimate,
    endedAt: new Date().toISOString(),
  });
  _current = null;
}

export function getCurrentSessionId(): string | null {
  return _current?.id ?? null;
}

/** Returns the most recent N session metadata records, newest first. */
export function listSessionMeta(n = 40): SessionMeta[] {
  return readAllMeta().reverse().slice(0, n);
}
