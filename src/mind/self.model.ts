import { stateDir } from '../utils/state.dir';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { betaTailProb, betaMean } from './stats';

/**
 * Root for the mind layer's SINGLETONS. Under jest, unrelated tests exercise the agent
 * loop (whose observers feed the singletons), and persisting that fake experience into
 * the repo's real .bimax/ would poison the agent's actual self-knowledge — so test runs
 * get a throwaway temp root. Explicit `new X(root)` instances (mind.test.ts) are unaffected.
 *
 * In production this MUST be stable for the whole process, anchored to the PROJECT root — not
 * raw process.cwd(). cwd() fragments the mind: launching from a subdirectory (or after a
 * ChangeDirectoryTool) opened a *different* .bimax/ledger.db, so rewards (tool_outcome),
 * episode boundaries, and policy decisions scattered across files and never assembled into a
 * scorable episode — which is exactly why /arms had no data to fold. We resolve the nearest
 * ancestor holding a .git or existing .bimax once and cache it, so every singleton shares one
 * coherent store regardless of where the binary was launched.
 */
let _cachedRoot: string | null = null;
export function mindSingletonRoot(): string {
  if (process.env.JEST_WORKER_ID) {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-mind-singleton-'));
  }
  if (_cachedRoot) return _cachedRoot;
  _cachedRoot = findProjectRoot(process.cwd());
  return _cachedRoot;
}

/**
 * Walk up from `start` to the git project root; fall back to `start` if the tree has no `.git`.
 * We anchor on `.git` (not `.bimax`) deliberately: a stray `.bimax/` left in a subdirectory by the
 * old cwd-fragmented behavior must NOT win over the real project root, or it would perpetuate the
 * very fragmentation this fix removes.
 */
function findProjectRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return start;
}

/**
 * SelfModel v2 — the agent's learned model of its OWN error surface (metacognition),
 * now statistically honest:
 *
 *   - Cells are keyed tool × domain × MODEL. Failure rates learned under one backing
 *     model never punish a different model after a swap (the v1 conflation bug).
 *   - Decisions are posterior probability statements on a Beta-Bernoulli model with
 *     partial pooling, not `n >= 6 && rate >= 0.3` magic numbers. A cell's prior is
 *     pulled from the SAME TOOL's other cells (excluding itself), falling back to a
 *     global base failure rate — so two early failures don't brand a tool "weak",
 *     while a sustained pattern does, with quantified confidence.
 *   - "Weak spot"  = P(θ_fail > 0.30) > 0.90 under the posterior.
 *   - "Escalation" = P(θ_fail > 0.45) > 0.90.
 *   - Stated confidence for the epistemic ledger = 1 − posterior mean failure rate,
 *     which is what makes the calibration curve meaningful.
 *
 * Recency: the posterior's likelihood uses the rolling window (last 40 outcomes per
 * cell); lifetime counts inform only the pooled prior. A change in behavior therefore
 * dominates within ~a window, without a hard cliff.
 */

export interface OutcomeCell {
  ok: number;
  err: number;
  /** Rolling window of the last N outcomes (1 = error) — the posterior's likelihood. */
  recent: number[];
  lastErr?: string;
  updated: string;
}

export interface WeakSpot {
  tool: string;
  domain: string;
  model: string;
  failRate: number;   // posterior mean failure rate
  pWeak: number;      // P(θ > WEAK_LEVEL) — the decision statistic
  n: number;          // window samples behind it
  advice: string;
  lastErr?: string;
}

interface SelfModelFile {
  version: 2;
  cells: Record<string, OutcomeCell>;
}

const RECENT_WINDOW = 40;
// Decision levels (what failure rate matters) and the posterior mass required to act.
const WEAK_LEVEL = 0.30;
const ESCALATE_LEVEL = 0.45;
const DECISION_MASS = 0.90;
// Pooling strength: the prior is worth κ pseudo-observations of the parent's rate.
const KAPPA = 4;
// Global base failure rate when a tool has no other history to pool from.
const PRIOR_FAIL = 0.15;

/** Routing alternatives keyed by tool — what to reach for instead when a cell is weak. */
const ALTERNATIVES: Record<string, string> = {
  EditFileTool: 'prefer SymbolEditTool (AST-addressed, whole-symbol replace) or MultiEditTool, and re-read the file immediately before editing',
  MultiEditTool: 'fall back to single EditFileTool calls with a fresh ReadFileTool before each',
  SymbolEditTool: 'fall back to EditFileTool with an exact unique old_string taken from a fresh read',
  WriteFileTool: 'read the target first and prefer surgical edits over whole-file rewrites',
  BashTool: 'double-check flags against --help before running, and prefer dedicated tools (GrepTool/GlobTool/ReadFileTool) over shell equivalents',
  GrepTool: 'try GraphQueryTool SEARCH_NODES / SEMANTIC when the repo is indexed — it resolves symbols greps miss',
  WebFetchTool: 'try WebSearchTool first to find a working URL',
};

/** Short, stable key for the active backing model ('-' when unknown). */
export function currentModelKey(): string {
  try {
    // Lazy require avoids a config→mind→config cycle and tolerates config not loaded yet.
    const { getConfig } = require('../engine/config');
    const id = String(getConfig().model || '');
    if (!id) return '-';
    return id.split('/').pop()!.slice(0, 40);
  } catch { return '-'; }
}

function cellKey(tool: string, domain: string, model: string): string {
  return `${tool}|${domain}|${model}`;
}

/** Parse a v1 or v2 cell key. v1 keys (`tool|domain`) are treated as model '-'. */
function parseKey(key: string): { tool: string; domain: string; model: string } {
  const parts = key.split('|');
  return { tool: parts[0], domain: parts[1] ?? '-', model: parts[2] ?? '-' };
}

/**
 * Classify a tool result into ok | err | rejected. Necessary because most tools report
 * failure by RETURNING an error string (the loop's isError flag only covers throws), so
 * outcome telemetry keyed on isError alone would count almost every real failure as a
 * success. 'rejected' (user said no to a diff) is neither — it's preference data, not
 * agent incompetence, and must not poison the failure rates.
 */
export function classifyOutcome(result: string, isError: boolean): 'ok' | 'err' | 'rejected' {
  const head = (result || '').slice(0, 300);
  if (/rejected by user/i.test(head)) return 'rejected';
  if (isError) return 'err';
  if (/^\s*(Error|Tool Error|Failed|❌|✗)/i.test(head)) return 'err';
  if (/\b(syntax check failed|no match found|not found in file|blocked by governor|governor blocked|edit shield|command failed|ENOENT|EACCES)\b/i.test(head)) return 'err';
  return 'ok';
}

/**
 * Derive the outcome domain from a tool call's raw JSON args: file extension for
 * path-taking tools, the shell program for BashTool, '-' otherwise.
 */
export function domainOf(toolName: string, rawArgs: string): string {
  let args: any;
  try { args = JSON.parse(rawArgs || '{}'); } catch { return '-'; }
  if (toolName === 'BashTool') {
    const cmd = String(args.command || '').trim();
    const first = cmd.split(/\s+/)[0] || '-';
    // strip paths: /usr/bin/git → git
    return first.split('/').pop() || '-';
  }
  const p = args.path || args.file_path || args.filePath || args.file || args.target || '';
  if (typeof p === 'string' && p) {
    const ext = path.extname(p).replace(/^\./, '');
    return ext || path.basename(p);
  }
  return '-';
}

/** The file path a tool call touches, if any — used by the epistemic ledger to scope claims. */
export function pathOf(rawArgs: string): string | undefined {
  try {
    const args = JSON.parse(rawArgs || '{}');
    const p = args.path || args.file_path || args.filePath || args.file || args.target;
    return typeof p === 'string' && p ? p : undefined;
  } catch { return undefined; }
}

export class SelfModel {
  private cells: Record<string, OutcomeCell> = {};
  private loaded = false;
  private dirty = false;
  private filePath: string;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(projectRoot: string = process.cwd()) {
    this.filePath = path.join(stateDir('.bimax', projectRoot), 'self-model.json');
  }

  /** Synchronous lazy load — prompt building is sync, so the model must be too. */
  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed: SelfModelFile = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      if (parsed && typeof parsed.cells === 'object' && parsed.cells !== null && !Array.isArray(parsed.cells)) {
        this.cells = parsed.cells; // v1 two-part keys parse as model '-' via parseKey
      }
    } catch { /* first run / corrupt file — start empty */ }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 1500);
    // Never keep the process alive just to flush telemetry.
    this.saveTimer.unref?.();
  }

  /** Drop in-memory state and re-read the file on next use — after a view rebuild swapped it. */
  reload(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.loaded = false;
    this.dirty = false;
    this.cells = {};
  }

  /** Cell totals keyed by tool|domain|model — the comparable essence of the learned state. */
  cellTotals(): Record<string, { ok: number; err: number }> {
    this.load();
    const out: Record<string, { ok: number; err: number }> = {};
    for (const [k, c] of Object.entries(this.cells)) out[k] = { ok: c.ok, err: c.err };
    return out;
  }

  /** Flush to disk immediately (also used on shutdown). Best-effort, no-op when clean. */
  saveNow(): void {
    if (!this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const data: SelfModelFile = { version: 2, cells: this.cells };
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
      this.dirty = false;
    } catch { /* telemetry must never break the loop */ }
  }

  record(tool: string, domain: string, ok: boolean, errSample?: string, modelKey?: string): void {
    this.load();
    this.dirty = true;
    // modelKey override exists for ledger replays (rebuilds must attribute each event to
    // the model that produced it, not whichever model is active at rebuild time).
    const key = cellKey(tool, domain, modelKey ?? currentModelKey());
    let c = this.cells[key];
    if (!c) {
      c = { ok: 0, err: 0, recent: [], updated: '' };
      this.cells[key] = c;
    }
    if (ok) c.ok++; else c.err++;
    c.recent.push(ok ? 0 : 1);
    if (c.recent.length > RECENT_WINDOW) c.recent.splice(0, c.recent.length - RECENT_WINDOW);
    if (!ok && errSample) c.lastErr = errSample.slice(0, 200);
    c.updated = new Date().toISOString();
    this.scheduleSave();
  }

  /**
   * Pooled prior mean for a cell: the same tool's OTHER cells' lifetime failure rate
   * (Jeffreys-smoothed), falling back to the global base rate. Excluding the cell
   * itself is what stops a lone cell from being its own prior (which would defeat
   * shrinkage entirely and let two early failures condemn a tool).
   */
  private priorMean(key: string): number {
    const { tool } = parseKey(key);
    let okSum = 0, errSum = 0;
    for (const [k, c] of Object.entries(this.cells)) {
      if (k === key) continue;
      if (parseKey(k).tool !== tool) continue;
      okSum += c.ok;
      errSum += c.err;
    }
    const n = okSum + errSum;
    if (n === 0) return PRIOR_FAIL;
    return (errSum + 0.5) / (n + 1); // Jeffreys smoothing
  }

  /** Posterior Beta(α, β) over the cell's FAILURE rate: pooled prior + recent-window likelihood. */
  private posterior(key: string, c: OutcomeCell): { alpha: number; beta: number; n: number } {
    const mu = this.priorMean(key);
    const f = c.recent.reduce((a: number, b: number) => a + b, 0);
    const s = c.recent.length - f;
    return { alpha: KAPPA * mu + f, beta: KAPPA * (1 - mu) + s, n: c.recent.length };
  }

  /** Cells relevant to the ACTIVE model (its own cells plus legacy model-agnostic ones). */
  private activeCells(): Array<{ key: string; tool: string; domain: string; model: string; cell: OutcomeCell }> {
    this.load();
    const active = currentModelKey();
    const out: Array<{ key: string; tool: string; domain: string; model: string; cell: OutcomeCell }> = [];
    for (const [key, cell] of Object.entries(this.cells)) {
      const p = parseKey(key);
      if (p.model === active || p.model === '-') out.push({ key, ...p, cell });
    }
    return out;
  }

  weakSpots(): WeakSpot[] {
    const out: WeakSpot[] = [];
    for (const { key, tool, domain, model, cell } of this.activeCells()) {
      const { alpha, beta, n } = this.posterior(key, cell);
      const pWeak = betaTailProb(WEAK_LEVEL, alpha, beta);
      if (pWeak < DECISION_MASS) continue;
      const advice = ALTERNATIVES[tool] || 'slow down here: verify arguments before the call and read the result back after';
      out.push({ tool, domain, model, failRate: betaMean(alpha, beta), pWeak, n, advice, lastErr: cell.lastErr });
    }
    return out.sort((a, b) => b.failRate - a.failRate);
  }

  /**
   * Stated confidence for a claim made after using this tool on this domain under the
   * active model: 1 − posterior mean failure rate. With no history the pooled prior
   * yields ≈ 1 − PRIOR_FAIL, so cold cells state ~0.85 — grounded, not hardcoded.
   */
  confidenceFor(tool: string, domain: string): number {
    this.load();
    const key = cellKey(tool, domain, currentModelKey());
    const c = this.cells[key] ?? this.cells[cellKey(tool, domain, '-')];
    if (!c) {
      const mu = this.priorMean(key);
      return Math.min(0.99, Math.max(0.05, 1 - mu));
    }
    const { alpha, beta } = this.posterior(key, c);
    return Math.min(0.99, Math.max(0.05, 1 - betaMean(alpha, beta)));
  }

  /** Domains where the agent is unreliable enough that claims need hard evidence. */
  escalationDomains(): string[] {
    const out: string[] = [];
    for (const { key, tool, domain, cell } of this.activeCells()) {
      const { alpha, beta } = this.posterior(key, cell);
      if (betaTailProb(ESCALATE_LEVEL, alpha, beta) >= DECISION_MASS) out.push(`${tool} on ${domain}`);
    }
    return out;
  }

  /** Total recorded outcomes — used by /self to show how much experience the model rests on. */
  totals(): { calls: number; errors: number; cells: number } {
    this.load();
    let calls = 0, errors = 0;
    for (const c of Object.values(this.cells)) { calls += c.ok + c.err; errors += c.err; }
    return { calls, errors, cells: Object.keys(this.cells).length };
  }

  /**
   * The SELF-KNOWLEDGE prompt section: top weak spots as routing rules. Empty string
   * when there's nothing actionable (never pad the prompt with noise).
   */
  getPromptBlock(): string {
    const weak = this.weakSpots().slice(0, 5);
    if (weak.length === 0) return '';
    const lines = weak.map(w =>
      `- ${w.tool} on \`${w.domain}\` fails ~${Math.round(w.failRate * 100)}% of the time here (P>${Math.round(w.pWeak * 100)}% certain, n=${w.n}) — ${w.advice}.`
    );
    return `### SELF-KNOWLEDGE (learned from your own telemetry — route around your weaknesses)\nThese are YOUR measured failure rates in this repo under the current model. Adjust your tool choices accordingly; after acting in a weak area, verify the result (read the file back / run the check) before claiming success.\n${lines.join('\n')}`;
  }

  /** Human-readable report for /self and /diagnostics. */
  report(): string[] {
    this.load();
    const t = this.totals();
    if (t.calls === 0) return ['- No outcomes recorded yet — the self-model builds as tools run.'];
    const lines = [`- Experience: ${t.calls} tool outcomes across ${t.cells} tool×domain×model cells (${t.errors} failures).`];
    const weak = this.weakSpots().slice(0, 6);
    if (weak.length === 0) {
      lines.push('- No weak spots above the posterior decision threshold — all routes healthy.');
    } else {
      for (const w of weak) {
        lines.push(`- ⚠ ${w.tool} × ${w.domain}${w.model !== '-' ? ` × ${w.model}` : ''}: ~${Math.round(w.failRate * 100)}% fail (P(θ>${WEAK_LEVEL})=${w.pWeak.toFixed(2)}, n=${w.n}) → ${w.advice}`);
      }
    }
    const esc = this.escalationDomains();
    if (esc.length > 0) lines.push(`- Verification escalated for: ${esc.join(', ')}`);
    return lines;
  }
}

let _global: SelfModel | null = null;
export function getSelfModel(): SelfModel {
  if (!_global) {
    _global = new SelfModel(mindSingletonRoot());
    // The debounced save can be lost on a fast exit; flush whatever is pending.
    process.once('exit', () => { try { _global?.saveNow(); } catch { /* exiting */ } });
  }
  return _global;
}
/** Test hook: replace the singleton (e.g. with one rooted in a temp dir). */
export function __setSelfModel(m: SelfModel | null): void { _global = m; }
