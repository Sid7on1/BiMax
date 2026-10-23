import { stateDir } from '../utils/state.dir';
import * as fs from 'fs';
import * as path from 'path';
import { getEventLedger } from './event.ledger';
import { mindSingletonRoot } from './self.model';
import { Logger } from '../utils/logger';
import { HarnessLabStore, candidateFrom, labEnabled, labEvent, renderHarnessBlock } from './harness.lab';
import { evaluateExperiment, selectCohort } from './harness.lab.eval';

/**
 * Harness self-tuner (the Self-Harness pattern, June 2026: agents that mine their own failure
 * patterns into harness patches lifted Terminal-Bench pass rates by 15–21 points).
 *
 * The tuner reads the event ledger's typed tool outcomes — the ground truth the agent already
 * records about itself — and turns RECURRING failure signatures (tool × error class) into
 * concrete steering patches injected into the system prompt. Each patch carries its own
 * effectiveness accounting: the failure rate that justified it (baseline) and the failure rate
 * observed since it went live. A patch that measurably doesn't help is auto-retired, so the
 * prompt only ever carries steering that earns its tokens.
 *
 * Counterfactual gate (INFRA P4 #10): a freshly mined patch no longer goes straight to the live
 * prompt. It is STAGED, and labPass() evaluates it offline against recorded episodes
 * (harness.lab.eval.ts) — only a passing verdict (or a manual /harness approve) activates it;
 * a vetoed candidate is retired with the verdict as its reason. BIMAX_HARNESS_LAB=0 restores
 * the legacy immediate-activation path.
 *
 * Everything is best-effort and file-backed (.bimax/harness-patches.json): a broken tuner can
 * never break the agent, and patches survive across sessions like the rest of the mind layer.
 */

export interface HarnessPatch {
  id: string;
  tool: string;
  errorClass: string;
  rule: string;
  createdAt: number;
  /** Failures in the mining window that justified the patch. */
  evidenceCount: number;
  /** Failure rate for this tool at creation time (the bar the patch must beat). */
  baselineRate: number;
  /** Outcome accounting since the patch went live. */
  samplesSince: number;
  failuresSince: number;
  /** 'staged' = mined but awaiting the counterfactual lab's verdict — not in the prompt. */
  status: 'staged' | 'active' | 'retired';
  retiredReason?: string;
  /** Counterfactual experiment this patch is/was gated by (audit link). */
  labExperimentId?: string;
  stagedAt?: number;
  /** When the patch went live — live effectiveness accounting starts HERE, not at mining. */
  activatedAt?: number;
  activatedBy?: 'lab' | 'user' | 'legacy';
}

// A failure signature must recur this often in the mining window before it earns a patch.
const MIN_EVIDENCE = 4;
// Effectiveness verdict needs this many post-patch samples of the tool before judging.
const MIN_SAMPLES_TO_JUDGE = 10;
// How much of the recent ledger the miner looks at.
const WINDOW = 500;
const MAX_ACTIVE_PATCHES = 6; // prompt budget — only the strongest patterns get steering

/** Steering text per error-class family. Grounded, imperative, and tool-specific. */
function ruleFor(tool: string, errorClass: string, count: number): string {
  const ec = errorClass.toLowerCase();
  if (/syntax|parse/.test(ec)) {
    return `${tool} has produced ${count} syntax-broken results recently. Before writing, re-read the exact lines you are changing; after writing, immediately run the project's typecheck/build on that file. For symbol-level changes prefer SymbolEditTool (AST-addressed) over raw text edits.`;
  }
  if (/not_?found|enoent|no such file|missing/.test(ec)) {
    return `${tool} keeps failing on paths that don't exist (${count}× recently). Verify the path first — GlobTool or a quick ls — instead of assuming it; never construct paths from memory.`;
  }
  if (/timeout|timed?_?out/.test(ec)) {
    return `${tool} keeps timing out (${count}× recently). Split the work into smaller invocations, add explicit timeouts, and background anything long-running instead of waiting inline.`;
  }
  if (/permission|denied|eacces/.test(ec)) {
    return `${tool} keeps hitting permission errors (${count}× recently). Check ownership/mode before the call and stay inside the workspace root; do not retry the identical call.`;
  }
  if (/conflict|match|old_string|no match/.test(ec)) {
    return `${tool} keeps failing to match its target (${count}× recently). Re-read the file immediately before editing so the anchor text is byte-exact — whitespace included — and keep anchors short but unique.`;
  }
  return `${tool} has failed with '${errorClass}' ${count}× recently. Before the next call, state what will be different from the failed attempts; if it fails twice the same way, switch tools or approach instead of retrying.`;
}

export class HarnessTuner {
  private patches: HarnessPatch[] = [];
  private loaded = false;
  private file: string;
  private rootDir: string;
  private lab: HarnessLabStore | null = null;
  private labBusy = false;

  constructor(root: string) {
    this.rootDir = root;
    this.file = path.join(stateDir('.bimax', root), 'harness-patches.json');
  }

  /** The counterfactual experiment store this tuner's patches are gated by. */
  labStore(): HarnessLabStore {
    if (!this.lab) this.lab = new HarnessLabStore(this.rootDir);
    return this.lab;
  }

  root(): string { return this.rootDir; }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      if (Array.isArray(raw?.patches)) this.patches = raw.patches;
    } catch { /* first run */ }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ patches: this.patches }, null, 2), 'utf-8');
    } catch { /* best-effort */ }
  }

  /**
   * One mining pass over the recent ledger: create patches for recurring failure signatures,
   * update effectiveness accounting on live ones, retire the ones that don't help.
   * Cheap (tail read + one pass) — safe to call at every episode boundary.
   */
  mine(): { created: number; retired: number } {
    this.load();
    let created = 0, retired = 0;
    try {
      // Escape hatch (BIMAX_HARNESS_LAB=0): legacy immediate activation — any patch a prior
      // lab-enabled session left staged goes live now, exactly as pre-lab mining would have.
      if (!labEnabled()) {
        let promoted = false;
        for (const p of this.patches) {
          if (p.status !== 'staged') continue;
          p.status = 'active';
          p.activatedAt = Date.now();
          p.activatedBy = 'legacy';
          promoted = true;
        }
        if (promoted) this.save();
      }

      const events = getEventLedger().tail(WINDOW).filter(e => e.type === 'tool_outcome');
      if (events.length === 0) return { created, retired };

      // Per-tool totals and per-signature failures, with timestamps for since-patch accounting.
      const toolTotals = new Map<string, { total: number; failures: number }>();
      const sigFailures = new Map<string, { count: number; tool: string; errorClass: string }>();
      for (const e of events) {
        const p = e.payload || {};
        const tool = String(p.tool || '');
        if (!tool) continue;
        const t = toolTotals.get(tool) || { total: 0, failures: 0 };
        t.total++;
        const failed = p.status === 'error' || p.isError === true;
        if (failed) {
          t.failures++;
          const ec = String(p.errorClass || 'unknown');
          const key = `${tool}|${ec}`;
          const s = sigFailures.get(key) || { count: 0, tool, errorClass: ec };
          s.count++;
          sigFailures.set(key, s);
        }
        toolTotals.set(tool, t);
      }

      // Effectiveness accounting: outcomes AFTER the patch went LIVE (activation, not
      // mining — a lab-gated patch steers nothing while staged, so earlier failures are
      // not evidence against it).
      for (const patch of this.patches) {
        if (patch.status !== 'active') continue;
        const liveSince = patch.activatedAt ?? patch.createdAt;
        let samples = 0, failures = 0;
        for (const e of events) {
          if (e.ts <= liveSince) continue;
          const p = e.payload || {};
          if (String(p.tool || '') !== patch.tool) continue;
          samples++;
          if (p.status === 'error' || p.isError === true) failures++;
        }
        patch.samplesSince = samples;
        patch.failuresSince = failures;
        if (samples >= MIN_SAMPLES_TO_JUDGE) {
          const rate = failures / samples;
          if (rate >= patch.baselineRate) {
            patch.status = 'retired';
            patch.retiredReason = `no improvement (${(rate * 100).toFixed(0)}% failures since vs ${(patch.baselineRate * 100).toFixed(0)}% baseline)`;
            retired++;
            Logger.info(`[HarnessTuner] Retired patch ${patch.id} — ${patch.retiredReason}`);
          }
        }
      }

      // New patches for signatures with enough evidence and no live patch yet. Staged and
      // active patches both occupy budget slots — staging six candidates that could all
      // activate must not overshoot the prompt budget.
      const occupiedCount = () => this.patches.filter(p => p.status === 'active' || p.status === 'staged').length;
      const stageNew = labEnabled();
      const ranked = [...sigFailures.values()].sort((a, b) => b.count - a.count);
      for (const sig of ranked) {
        if (sig.count < MIN_EVIDENCE) break; // ranked — everything after is below threshold
        if (occupiedCount() >= MAX_ACTIVE_PATCHES) break;
        // Any prior patch for this signature blocks a new one — an ACTIVE patch already covers
        // it, and a RETIRED one is evidence steering didn't help here (re-creating it would
        // ping-pong retire→create forever on a signature steering can't fix).
        const exists = this.patches.some(p => p.tool === sig.tool && p.errorClass === sig.errorClass);
        if (exists) continue;
        const totals = toolTotals.get(sig.tool) || { total: sig.count, failures: sig.count };
        const patch: HarnessPatch = {
          id: `hp-${Date.now().toString(36)}-${this.patches.length}`,
          tool: sig.tool,
          errorClass: sig.errorClass,
          rule: ruleFor(sig.tool, sig.errorClass, sig.count),
          createdAt: Date.now(),
          evidenceCount: sig.count,
          baselineRate: totals.total > 0 ? totals.failures / totals.total : 1,
          samplesSince: 0,
          failuresSince: 0,
          status: stageNew ? 'staged' : 'active',
        };
        if (stageNew) patch.stagedAt = Date.now();
        else { patch.activatedAt = Date.now(); patch.activatedBy = 'legacy'; }
        this.patches.push(patch);
        created++;
        Logger.info(`[HarnessTuner] New ${stageNew ? 'STAGED' : 'active'} patch: ${sig.tool} × ${sig.errorClass} (${sig.count} failures in window)${stageNew ? ' — awaiting counterfactual lab verdict' : ''}.`);
      }

      if (created || retired) this.save();
      else if (this.patches.some(p => p.status === 'active')) this.save(); // persist accounting updates
    } catch { /* mining must never break the agent */ }
    return { created, retired };
  }

  /**
   * The system-prompt block carrying every ACTIVE patch ('' when there are none). Staged
   * patches never appear here — that is the whole point of the counterfactual gate. The
   * render is shared byte-for-byte with the lab's candidate arm (renderHarnessBlock), so
   * what the lab evaluated is exactly what activation injects.
   */
  getPromptBlock(): string {
    this.load();
    const active = this.patches.filter(p => p.status === 'active');
    return renderHarnessBlock(active.map(p => p.rule));
  }

  all(): HarnessPatch[] {
    this.load();
    return [...this.patches];
  }

  /** Manually retire a patch (the /harness command). */
  retire(id: string): boolean {
    this.load();
    const p = this.patches.find(x => x.id === id && x.status === 'active');
    if (!p) return false;
    p.status = 'retired';
    p.retiredReason = 'manually retired';
    this.save();
    return true;
  }

  // -------------------------------------------------------------------------
  // Counterfactual lab lifecycle (INFRA P4 #10)
  // -------------------------------------------------------------------------

  /**
   * One offline validation pass over staged patches: ensure each has its experiment,
   * evaluate against the current recorded-episode cohort, and apply the verdict —
   * pass ⇒ activate, veto ⇒ retire, insufficient evidence ⇒ stay staged until the
   * cohort changes (new episodes are the re-evaluation trigger, so identical passes
   * are idempotent). Cross-process double work is skipped via the advisory eval lock;
   * correctness never depends on it because evaluations are deterministic and keyed
   * by candidate × cohort. Never throws.
   */
  async labPass(opts: { force?: boolean; only?: string } = {}): Promise<{ evaluated: number; activated: number; rejected: number; skipped: number }> {
    const out = { evaluated: 0, activated: 0, rejected: 0, skipped: 0 };
    if (!labEnabled()) return out;
    this.load();
    const staged = this.patches.filter(p => p.status === 'staged'
      && (!opts.only || p.id === opts.only || p.labExperimentId === opts.only));
    if (staged.length === 0) return out;
    if (this.labBusy) { out.skipped = staged.length; return out; }
    this.labBusy = true;
    const release = this.labStore().acquireEvalLock();
    if (!release) { this.labBusy = false; out.skipped = staged.length; return out; }
    try {
      for (const p of staged) {
        try {
          const cand = candidateFrom(p);
          const { exp } = this.labStore().getOrCreate(cand);
          if (p.labExperimentId !== exp.id) { p.labExperimentId = exp.id; this.save(); }
          // A terminal experiment for this exact candidate means the verdict already
          // exists — converge the patch instead of re-litigating.
          if (exp.status === 'rejected' || exp.status === 'rolled_back') {
            p.status = 'retired';
            p.retiredReason = `lab: experiment ${exp.id} is ${exp.status}`;
            this.save();
            out.rejected++;
            continue;
          }
          const cohort = selectCohort(this.rootDir, cand);
          const last = exp.evaluations[exp.evaluations.length - 1];
          if (!opts.force && last && last.cohort.cohortHash === cohort.cohortHash) {
            out.skipped++; // same evidence ⇒ same verdict — nothing new to learn
            continue;
          }
          const activeRules = this.patches.filter(x => x.status === 'active').map(x => x.rule);
          const ev = await evaluateExperiment(exp, this.rootDir, { cohort, activeRules });
          this.labStore().appendEvaluation(exp.id, ev);
          out.evaluated++;
          if (ev.verdict === 'pass') {
            this.labStore().transition(exp.id, 'activated',
              `lab pass (${ev.confidence} confidence, cohort ${ev.cohort.cohortHash.slice(0, 12)})`, 'auto');
            p.status = 'active';
            p.activatedAt = Date.now();
            p.activatedBy = 'lab';
            this.save();
            out.activated++;
            Logger.info(`[HarnessLab] Patch ${p.id} (${p.tool} × ${p.errorClass}) activated — experiment ${exp.id} passed.`);
          } else if (ev.verdict === 'veto') {
            const why = ev.vetoReasons.join('; ').slice(0, 300);
            this.labStore().transition(exp.id, 'rejected', why, 'auto');
            p.status = 'retired';
            p.retiredReason = `lab veto: ${why}`;
            this.save();
            out.rejected++;
            Logger.info(`[HarnessLab] Patch ${p.id} vetoed — ${why}`);
          }
          // 'insufficient_evidence': patch stays staged; the next cohort change re-evaluates.
        } catch { /* one broken candidate must not block the rest */ }
      }
    } finally {
      this.labBusy = false;
      release();
    }
    return out;
  }

  /** Manual escape hatch: activate a staged patch without (or despite) a lab verdict. */
  approve(id: string): boolean {
    this.load();
    const p = this.patches.find(x => x.id === id && x.status === 'staged');
    if (!p) return false;
    p.status = 'active';
    p.activatedAt = Date.now();
    p.activatedBy = 'user';
    this.save();
    if (p.labExperimentId) {
      this.labStore().transition(p.labExperimentId, 'activated', 'manually approved (escape hatch)', 'user');
    } else {
      labEvent('activated', { patchId: id, by: 'user', reason: 'manual approval before any experiment existed' });
    }
    return true;
  }

  /** Manually reject a staged patch — it retires and its experiment closes as rejected. */
  rejectStaged(id: string): boolean {
    this.load();
    const p = this.patches.find(x => x.id === id && x.status === 'staged');
    if (!p) return false;
    p.status = 'retired';
    p.retiredReason = 'manually rejected (lab)';
    this.save();
    if (p.labExperimentId) this.labStore().transition(p.labExperimentId, 'rejected', 'manually rejected', 'user');
    else labEvent('rejected', { patchId: id, by: 'user' });
    return true;
  }

  /** Roll back an ACTIVE patch: it leaves the prompt and its experiment records the reversal. */
  rollback(id: string): boolean {
    this.load();
    const p = this.patches.find(x => x.id === id && x.status === 'active');
    if (!p) return false;
    p.status = 'retired';
    p.retiredReason = 'rolled back by user';
    this.save();
    if (p.labExperimentId) this.labStore().transition(p.labExperimentId, 'rolled_back', 'rolled back by user', 'user');
    else labEvent('rolled_back', { patchId: id, by: 'user' });
    return true;
  }
}

let _global: HarnessTuner | null = null;
export function getHarnessTuner(): HarnessTuner {
  if (!_global) _global = new HarnessTuner(mindSingletonRoot());
  return _global;
}
/** Test hook — swap the singleton for per-test isolation. */
export function __setHarnessTuner(t: HarnessTuner | null): void {
  _global = t;
}
