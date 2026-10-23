import { stateDir } from '../utils/state.dir';
import * as fs from 'fs';
import * as path from 'path';
import { getEventLedger, EventLedger, LedgerEvent } from './event.ledger';
import { mindSingletonRoot } from './self.model';

/**
 * DailyJournal — UPGRADE PR4 (pi-mem pattern). A human-auditable, plain-markdown record of what was
 * worked on each day, PROJECTED from the event ledger so it costs nothing to maintain (no second
 * write path — it's a fold over the append-only log). Two uses:
 *
 *   1. preloadBlock() — today + yesterday as a compact system-prompt section, so a new session opens
 *      with continuity ("yesterday you were editing user.model.ts") instead of a cold start.
 *   2. writeArtifact(dateKey) — render one day to .bimax/journal/YYYY-MM-DD.md for the human to read
 *      or edit. Derived on demand; the ledger stays the source of truth.
 *
 * Static memory (CLAUDE.md, project.memory) is curated and durable; this is the running diary.
 */

export interface DayDigest {
  dateKey: string;            // local YYYY-MM-DD
  edits: number;              // successful mutating tool calls
  bash: number;               // BashTool calls
  errors: number;             // tool calls that ended in error
  subagents: number;          // sub-agent spawns
  files: string[];            // distinct files touched, most-touched first
  topTools: string[];         // most-used tools, "Name×N"
}

const MUTATING = new Set(['WriteFileTool', 'EditFileTool', 'MultiEditTool', 'SymbolEditTool', 'NotebookEditTool', 'DeleteTool']);

/** Local YYYY-MM-DD for an epoch-ms timestamp (local day, so "today"/"yesterday" match the human's). */
export function dateKeyOf(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Fold the ledger's events for ONE local date into a digest. Pure — no I/O beyond the ledger read. */
export function journalDigest(dateKey: string, ledger: EventLedger = getEventLedger()): DayDigest {
  const digest: DayDigest = { dateKey, edits: 0, bash: 0, errors: 0, subagents: 0, files: [], topTools: [] };
  const fileHits = new Map<string, number>();
  const toolHits = new Map<string, number>();

  const consider = (events: LedgerEvent[], fn: (e: LedgerEvent) => void) => {
    for (const e of events) if (dateKeyOf(e.ts) === dateKey) fn(e);
  };

  consider(ledger.byType('tool_outcome'), (e) => {
    const p = e.payload || {};
    const tool = String(p.tool || '?');
    toolHits.set(tool, (toolHits.get(tool) || 0) + 1);
    if (p.isError) digest.errors++;
    if (tool === 'BashTool') digest.bash++;
    if (MUTATING.has(tool) && !p.isError) digest.edits++;
    if (p.file && typeof p.file === 'string') fileHits.set(p.file, (fileHits.get(p.file) || 0) + 1);
  });
  consider(ledger.byType('subagent'), (e) => {
    if ((e.payload || {}).phase === 'spawned') digest.subagents++;
  });

  digest.files = [...fileHits.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
  digest.topTools = [...toolHits.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}×${n}`);
  return digest;
}

function isEmpty(d: DayDigest): boolean {
  return d.edits === 0 && d.bash === 0 && d.errors === 0 && d.subagents === 0 && d.files.length === 0;
}

/** One-line digest summary, or null when the day had no recorded activity. */
export function summarizeDay(d: DayDigest): string | null {
  if (isEmpty(d)) return null;
  const parts: string[] = [];
  if (d.files.length) {
    const shown = d.files.slice(0, 4).map(f => path.basename(f));
    parts.push(`${d.edits} edit(s) across ${d.files.length} file(s) (${shown.join(', ')}${d.files.length > 4 ? ', …' : ''})`);
  } else if (d.edits) {
    parts.push(`${d.edits} edit(s)`);
  }
  if (d.bash) parts.push(`${d.bash} bash`);
  if (d.subagents) parts.push(`${d.subagents} sub-agent(s)`);
  if (d.errors) parts.push(`${d.errors} error(s)`);
  return parts.join(' · ');
}

/** The system-prompt continuity section: today + yesterday, or '' when both are empty. */
export function journalPreloadBlock(now: number = Date.now(), ledger: EventLedger = getEventLedger()): string {
  const todayKey = dateKeyOf(now);
  const yestKey = dateKeyOf(now - 86_400_000);
  const today = summarizeDay(journalDigest(todayKey, ledger));
  const yesterday = yestKey !== todayKey ? summarizeDay(journalDigest(yestKey, ledger)) : null;
  const lines: string[] = [];
  if (today) lines.push(`- Today: ${today}`);
  if (yesterday) lines.push(`- Yesterday: ${yesterday}`);
  if (lines.length === 0) return '';
  return `### RECENT WORK (your journal — continuity across sessions)\n${lines.join('\n')}`;
}

/** Full markdown for one day's artifact (.bimax/journal/YYYY-MM-DD.md). */
export function renderDayMarkdown(d: DayDigest): string {
  const lines = [`# Journal — ${d.dateKey}`, ''];
  const summary = summarizeDay(d);
  if (!summary) { lines.push('_No recorded activity._', ''); return lines.join('\n'); }
  lines.push(`**Summary:** ${summary}`, '');
  if (d.files.length) {
    lines.push('## Files touched', ...d.files.slice(0, 40).map(f => `- \`${f}\``), '');
  }
  if (d.topTools.length) {
    lines.push('## Tools used', d.topTools.slice(0, 12).join(' · '), '');
  }
  return lines.join('\n');
}

/** Write one day's markdown artifact under .bimax/journal/. Best-effort; returns the path or ''. */
export function writeDayArtifact(dateKey: string, root: string = mindSingletonRoot()): string {
  try {
    const dir = path.join(stateDir('.bimax', root), 'journal');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${dateKey}.md`);
    fs.writeFileSync(file, renderDayMarkdown(journalDigest(dateKey)), 'utf-8');
    return file;
  } catch { return ''; }
}
