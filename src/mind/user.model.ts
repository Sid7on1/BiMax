import { stateDir } from '../utils/state.dir';
import * as fs from 'fs';
import * as path from 'path';
import { mindSingletonRoot } from './self.model';
import { embed, packEmbedding, nearest, cosine, embedderInfo } from './embedder';

/**
 * UserModel — theory of mind. A persistent, *learned* model of this user built from
 * two labeled signals nobody else uses:
 *
 *   1. Diff decisions — every accepted/rejected inline diff (the diffApproval flow)
 *      is a labeled example. With ≥20 decisions, k-NN over embedded past diffs; below
 *      that, coarse features (file type, diff size, change kind, comment density).
 *   2. Preference assertions (v2 §3.5.2) — corrections become ASSERTIONS with a Beta
 *      posterior each, polarity, and a lifecycle (candidate → confirmed → contradicted
 *      → retired). They are confirmed by CONSEQUENCE, not capture: every turn where an
 *      assertion was active in the prompt and the user did NOT correct that behavior
 *      is weak positive evidence; a contradicting correction is strong negative
 *      evidence. Opposite-polarity assertions that embed near each other are flagged
 *      as a contradiction and surfaced for the user to resolve. Assertions decay
 *      toward the prior unless re-evidenced — drift handling for free.
 *
 * Static convention files (CLAUDE.md/AGENTS.md) describe the repo; this learns the human.
 */

interface FeatureStat { accept: number; reject: number }

export interface Assertion {
  text: string;                // the preference, near-verbatim (trimmed first line)
  polarity: 'do' | 'dont';
  alpha: number;               // Beta posterior: positive evidence (statements + quiet consequence)
  beta: number;                // negative evidence (contradicting corrections)
  count: number;               // explicit statements (repeats of the same preference)
  lastSeen: string;            // last evidence of ANY kind (statement or consequence)
  embedding: number[];
  embedderV?: number;          // vector-space version; text is stored, so a swap re-embeds
  status: 'candidate' | 'confirmed' | 'contradicted' | 'retired';
  source: 'regex' | 'critic';
  contradicts?: string;        // text of the opposing assertion, when status === 'contradicted'
}

interface DiffDecision {
  embedding: number[];   // hashed local embedding of summary+diff (see mind/embedder)
  embedderV?: number;    // vector-space version; a backend swap must not mix spaces
  approved: boolean;
  summary: string;       // shown as evidence when a neighbor drives a warning
  at: string;
}

interface UserModelFile {
  version: 3;
  features: Record<string, FeatureStat>;
  assertions: Assertion[];
  decisions: { accepts: number; rejects: number };
  history: DiffDecision[];
}

const MAX_ASSERTIONS = 40;
const MAX_HISTORY = 200;
const PREDICT_MIN_SAMPLES = 4;
const PREDICT_WARN_BELOW = 0.4;
// The plan's own cold-start rule (§3.5): k-NN over past decisions only once the corpus
// is ≥ 20; below that, the coarse 4-feature model — labeled low-confidence.
const KNN_MIN_CORPUS = 20;
const KNN_K = 8;

// Assertion lifecycle numbers — evidence rules, not vibes:
const SIM_SAME = 0.8;        // same-polarity similarity that counts as a RESTATEMENT
const SIM_OPPOSITE = 0.55;   // opposite-polarity similarity that counts as a CONTRADICTION
const WEAK_POSITIVE = 0.1;   // per active-and-uncorrected turn (confirmed by consequence)
const ALPHA_CAP = 30;        // quiet consequence saturates; it never outvotes a correction forever
const CONFIRM_MEAN = 0.6;    // posterior mean where a candidate earns 'confirmed'
const RETIRE_MEAN = 0.35;    // posterior mean where an assertion stops steering anything
const DECAY_HALFLIFE_DAYS = 120; // un-evidenced assertions drift toward the 0.5 prior
// FSRS-lite (UPGRADE PR4, vestige pattern): each explicit restatement is a "review" that grows the
// assertion's STABILITY, so a repeatedly-stated preference decays slower. count=1 keeps the base
// half-life; count=2 → base×growth; count≥3 stays durable (the human restated it three times — it
// has earned permanence). Consequence-only evidence (quiet alpha) never confers durability.
const STABILITY_GROWTH = 2.5;

/** Correction/preference openers — messages that are instructions about HOW to work. */
const CORRECTION_RE = /^\s*(no[,.!\s]|don'?t\b|do not\b|never\b|always\b|stop\b|not like|that'?s wrong|wrong[,.!\s]|instead\b|make sure (you|to)\b|remember (to|that)\b|from now on\b|please stop\b)/i;
/** Negative-polarity openers (a subset of the above): "stop doing X" vs "always do X". */
const DONT_RE = /^\s*(no[,.!\s]|don'?t\b|do not\b|never\b|stop\b|please stop\b|not like|that'?s wrong|wrong[,.!\s])/i;

export function extractDiffFeatures(summary: string, diff: string): string[] {
  const feats: string[] = [];
  const extMatch = summary.match(/\.([a-zA-Z0-9]{1,8})(\b|$)/);
  if (extMatch) feats.push(`ext:${extMatch[1].toLowerCase()}`);
  const kind = (summary.trim().split(/[\s:]/)[0] || 'Edit').replace(/[^A-Za-z]/g, '');
  if (kind) feats.push(`kind:${kind}`);
  const lines = diff.split('\n');
  const changed = lines.filter(l => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
  const size = changed.length < 30 ? 'small' : changed.length < 150 ? 'medium' : 'large';
  feats.push(`size:${size}`);
  const addedComments = lines.filter(l => /^\+\s*(\/\/|#|\/\*|\*)/.test(l)).length;
  if (addedComments > 3) feats.push('comments:heavy');
  return feats;
}

function normText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

export class UserModel {
  private data: UserModelFile = { version: 3, features: {}, assertions: [], decisions: { accepts: 0, rejects: 0 }, history: [] };
  private loaded = false;
  private dirty = false;
  private filePath: string;
  private saveTimer: NodeJS.Timeout | null = null;
  /** Assertions injected into the LAST built prompt — the "active" set consequence evidence applies to. */
  private activeLastTurn: string[] = [];

  constructor(projectRoot: string = process.cwd()) {
    this.filePath = path.join(stateDir('.bimax', projectRoot), 'user-model.json');
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      if (parsed && parsed.features && parsed.decisions) {
        this.data = {
          version: 3,
          features: parsed.features,
          decisions: parsed.decisions,
          history: Array.isArray(parsed.history) ? parsed.history : [],
          assertions: Array.isArray(parsed.assertions) ? parsed.assertions : [],
        };
        // v2 migration (the plan's rule): standing prefs import as CANDIDATES at 0.5,
        // repeats counting as the positive evidence they were.
        if (this.data.assertions.length === 0 && Array.isArray(parsed.prefs)) {
          for (const p of parsed.prefs) {
            if (!p?.text) continue;
            this.data.assertions.push({
              text: p.text, polarity: DONT_RE.test(p.text) ? 'dont' : 'do',
              alpha: 1 + Math.max(0, (p.count || 1) - 1), beta: 1,
              count: p.count || 1, lastSeen: p.lastSeen || new Date().toISOString(),
              embedding: packEmbedding(embed(p.text)),
              embedderV: embedderInfo().version,
              status: 'candidate', source: 'regex',
            });
          }
          this.dirty = true;
        }
      }
    } catch { /* first run */ }
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.saveNow(); }, 1500);
    this.saveTimer.unref?.();
  }

  saveNow(): void {
    if (!this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
      this.dirty = false;
    } catch { /* best-effort */ }
  }

  /** Record one real diff decision (only called for genuine user choices, never auto-approvals). */
  recordDiffDecision(approved: boolean, summary: string, diff: string): void {
    this.load();
    if (approved) this.data.decisions.accepts++; else this.data.decisions.rejects++;
    for (const f of extractDiffFeatures(summary, diff)) {
      const s = this.data.features[f] || (this.data.features[f] = { accept: 0, reject: 0 });
      if (approved) s.accept++; else s.reject++;
    }
    // Embedded history — the k-NN taste corpus (§3.5). Diff text dominates the vector;
    // the summary is kept as the human-readable evidence line shown with warnings.
    this.data.history.push({
      embedding: packEmbedding(embed(`${summary}\n${diff.slice(0, 8000)}`)),
      embedderV: embedderInfo().version,
      approved,
      summary: summary.slice(0, 140),
      at: new Date().toISOString(),
    });
    if (this.data.history.length > MAX_HISTORY) this.data.history.splice(0, this.data.history.length - MAX_HISTORY);
    this.scheduleSave();
  }

  /**
   * "Would the user approve this diff?" — with a corpus of ≥ 20 decisions, similarity-
   * weighted vote among the k nearest PAST DECISIONS (retrieved neighbors are returned
   * as evidence: "similar to the X diff you rejected"). Below that, the coarse
   * per-feature accept-rate fallback. Returns null until there's signal worth saying.
   */
  predictApproval(summary: string, diff: string): { p: number; riskyFeatures: string[]; method: 'knn' | 'features' } | null {
    this.load();
    const total = this.data.decisions.accepts + this.data.decisions.rejects;
    if (total < PREDICT_MIN_SAMPLES) return null;

    // Only vectors from the ACTIVE embedder count — after a backend swap the old diff
    // vectors are unrecoverable (the diff text isn't stored), so the taste model
    // honestly cold-starts on the new space instead of comparing apples to hashes.
    const currentV = embedderInfo().version;
    const comparable = this.data.history.filter(h => (h.embedderV ?? 1) === currentV);
    if (comparable.length >= KNN_MIN_CORPUS) {
      const q = embed(`${summary}\n${diff.slice(0, 8000)}`);
      const nbrs = nearest(q, comparable, KNN_K);
      if (nbrs.length >= 3) {
        let wAccept = 0;
        let wTotal = 0;
        for (const { item, sim } of nbrs) {
          wTotal += sim;
          if (item.approved) wAccept += sim;
        }
        const p = wTotal > 0 ? wAccept / wTotal : 0.5;
        // Evidence, not vibes: name the similar rejected diffs driving a low score.
        const risky = nbrs
          .filter(n => !n.item.approved && n.sim > 0.3)
          .slice(0, 3)
          .map(n => `similar to "${n.item.summary}" (rejected, ${Math.round(n.sim * 100)}% match)`);
        return { p, riskyFeatures: risky, method: 'knn' };
      }
    }

    const feats = extractDiffFeatures(summary, diff);
    const rates: number[] = [];
    const risky: string[] = [];
    for (const f of feats) {
      const s = this.data.features[f];
      if (!s || s.accept + s.reject < 2) continue;
      const rate = (s.accept + 1) / (s.accept + s.reject + 2);
      rates.push(rate);
      if (rate < PREDICT_WARN_BELOW) risky.push(`${f} (${s.reject}/${s.accept + s.reject} rejected)`);
    }
    if (rates.length === 0) return null;
    return { p: rates.reduce((a, b) => a + b, 0) / rates.length, riskyFeatures: risky, method: 'features' };
  }

  /**
   * Watch a user message. A correction becomes/updates an assertion; anything else is
   * quiet CONSEQUENCE — weak positive evidence for every assertion that was active in
   * the prompt the user just read and chose not to correct.
   */
  observeUserMessage(message: string): void {
    const first = (message || '').trim().split('\n')[0].slice(0, 160);
    const isCorrection = !!first && first.length >= 8 && CORRECTION_RE.test(first)
      // Courtesy phrases start like corrections but aren't instructions — don't learn them.
      && !/^\s*no (problem|worries|thanks|thank you|rush|need|idea)\b/i.test(first);

    if (!isCorrection) {
      if (!first || this.activeLastTurn.length === 0) return;
      this.load();
      const now = new Date().toISOString();
      for (const key of this.activeLastTurn) {
        const a = this.data.assertions.find(x => normText(x.text) === key);
        if (!a || a.status === 'retired') continue;
        a.alpha = Math.min(ALPHA_CAP, a.alpha + WEAK_POSITIVE);
        a.lastSeen = now;
        if (a.status === 'candidate' && a.alpha >= 2 && this.mean(a) >= CONFIRM_MEAN) a.status = 'confirmed';
      }
      this.scheduleSave();
      return;
    }

    this.learnAssertion(first, DONT_RE.test(first) ? 'dont' : 'do', 'regex');
  }

  /**
   * Integrate one stated preference (from the correction regex or the lite-model
   * critic pass). Restatements strengthen; opposite-polarity lookalikes contradict.
   */
  learnAssertion(text: string, polarity: 'do' | 'dont', source: 'regex' | 'critic'): void {
    const clean = (text || '').trim().slice(0, 160);
    if (clean.length < 8) return;
    this.load();
    // Assertions store their full text, so a backend swap re-embeds them in place —
    // similarity matching below never compares across vector spaces.
    const v = embedderInfo().version;
    for (const a of this.data.assertions) {
      if ((a.embedderV ?? 1) !== v) {
        a.embedding = packEmbedding(embed(a.text));
        a.embedderV = v;
        this.dirty = true;
      }
    }
    const now = new Date().toISOString();
    const q = embed(clean);
    const norm = normText(clean);

    // Restatement of an existing assertion (same polarity): strong positive evidence.
    let bestSame: Assertion | null = null;
    let bestSameSim = 0;
    let bestOpp: Assertion | null = null;
    let bestOppSim = 0;
    for (const a of this.data.assertions) {
      if (a.status === 'retired') continue;
      const sim = normText(a.text) === norm ? 1 : cosine(q, a.embedding);
      if (a.polarity === polarity && sim > bestSameSim) { bestSame = a; bestSameSim = sim; }
      if (a.polarity !== polarity && sim > bestOppSim) { bestOpp = a; bestOppSim = sim; }
    }

    if (bestSame && bestSameSim >= SIM_SAME) {
      bestSame.alpha += 1;
      bestSame.count += 1;
      bestSame.lastSeen = now;
      if (bestSame.status === 'contradicted' || (bestSame.status === 'candidate' && this.mean(bestSame) >= CONFIRM_MEAN)) {
        bestSame.status = 'confirmed';
        delete bestSame.contradicts;
      }
      // Restating one side RESOLVES a standing contradiction: the opposing twin loses.
      if (bestOpp && bestOppSim >= SIM_OPPOSITE) {
        bestOpp.beta += 1;
        if (this.mean(bestOpp) < RETIRE_MEAN || bestOpp.status === 'contradicted') bestOpp.status = 'retired';
      }
      this.scheduleSave();
      return;
    }

    const fresh: Assertion = {
      text: clean, polarity, alpha: 1, beta: 1, count: 1, lastSeen: now,
      embedding: packEmbedding(q), embedderV: v, status: 'candidate', source,
    };

    // Contradiction (§3.5): "always add tests" meets "stop adding tests" — strong
    // negative evidence against the OLD one, and the pair is surfaced to resolve.
    if (bestOpp && bestOppSim >= SIM_OPPOSITE) {
      bestOpp.beta += 1;
      if (this.mean(bestOpp) < RETIRE_MEAN) {
        bestOpp.status = 'retired';
      } else {
        bestOpp.status = 'contradicted';
        bestOpp.contradicts = clean;
        fresh.contradicts = bestOpp.text;
      }
    }

    this.data.assertions.push(fresh);
    if (this.data.assertions.length > MAX_ASSERTIONS) {
      // Evict the weakest signal: retired first, then lowest confidence, then oldest.
      this.data.assertions.sort((a, b) =>
        (a.status === 'retired' ? -1 : 1) - (b.status === 'retired' ? -1 : 1) ||
        this.confidence(a) - this.confidence(b) || a.lastSeen.localeCompare(b.lastSeen)
      );
      this.data.assertions.splice(0, this.data.assertions.length - MAX_ASSERTIONS);
    }
    this.scheduleSave();
  }

  private mean(a: Assertion): number { return a.alpha / (a.alpha + a.beta); }

  /** Posterior mean decayed toward the 0.5 prior with time since last evidence (drift). */
  confidence(a: Assertion): number {
    const ageDays = Math.max(0, (Date.now() - new Date(a.lastSeen).getTime()) / 86_400_000);
    // FSRS-lite: stability (effective half-life) grows with each restatement; ≥3× is durable.
    // count=1 → base 120d (v1 behavior); count=2 → 300d; count≥3 → permanent (decay 1).
    const stabilityDays = DECAY_HALFLIFE_DAYS * Math.pow(STABILITY_GROWTH, Math.max(0, a.count - 1));
    const decay = a.count >= 3 ? 1 : Math.exp(-(Math.LN2 * ageDays) / stabilityDays);
    return 0.5 + (this.mean(a) - 0.5) * decay;
  }

  /** All assertions with their computed confidence (for /self and tests). */
  assertions(): (Assertion & { confidence: number })[] {
    this.load();
    return this.data.assertions.map(a => ({ ...a, confidence: this.confidence(a) }));
  }

  /** The USER MODEL prompt section: living assertions + learned diff taste. */
  getPromptBlock(): string {
    this.load();
    const lines: string[] = [];

    // Candidates MUST stay active to gather consequence evidence — only assertions the
    // evidence has turned against (mean < retire floor), retired, or contradicted ones
    // stop steering. Contradicted pairs get ONE resolution line instead.
    const active = this.data.assertions
      .filter(a => (a.status === 'candidate' || a.status === 'confirmed') && this.mean(a) >= RETIRE_MEAN)
      .sort((x, y) => this.confidence(y) - this.confidence(x))
      .slice(0, 6);
    for (const a of active) {
      lines.push(`- ${a.count > 1 ? `(said ${a.count}×) ` : ''}"${a.text}"${a.status === 'confirmed' ? ` — confirmed (${Math.round(this.confidence(a) * 100)}%)` : ''}`);
    }
    this.activeLastTurn = active.map(a => normText(a.text));

    const conflict = this.data.assertions.find(a => a.status === 'contradicted' && a.contradicts);
    if (conflict) {
      lines.push(`- ⚠ Conflicting guidance on record: "${conflict.text}" vs "${conflict.contradicts}". The newer one is being followed — when natural, ask the user which stands (it may be repo-scoped).`);
    }

    const total = this.data.decisions.accepts + this.data.decisions.rejects;
    if (total >= PREDICT_MIN_SAMPLES) {
      const rejectFeats = Object.entries(this.data.features)
        .filter(([, s]) => s.accept + s.reject >= 3 && s.reject / (s.accept + s.reject) >= 0.5)
        .map(([f, s]) => `${f} (${s.reject}/${s.accept + s.reject} rejected)`);
      if (rejectFeats.length > 0) {
        lines.push(`- Diff taste: this user rejects changes matching ${rejectFeats.slice(0, 3).join(', ')} — keep such changes minimal or ask first.`);
      }
    }
    if (lines.length === 0) return '';
    return `### USER MODEL (learned from this user's past corrections and diff decisions)\nHonor these standing instructions without being re-told:\n${lines.join('\n')}`;
  }

  report(): string[] {
    this.load();
    const t = this.data.decisions;
    const total = t.accepts + t.rejects;
    const lines: string[] = [];
    lines.push(total > 0
      ? `- Diff decisions learned: ${total} (${t.accepts} accepted / ${t.rejects} rejected — ${Math.round((t.accepts / total) * 100)}% approval)`
      : '- No diff decisions observed yet (turn on /diffapproval to teach diff taste).');
    const live = this.data.assertions.filter(a => a.status !== 'retired');
    if (live.length > 0) {
      lines.push(`- Preference assertions: ${live.length} (${live.filter(a => a.status === 'confirmed').length} confirmed by consequence)`);
      for (const a of [...live].sort((x, y) => this.confidence(y) - this.confidence(x)).slice(0, 5)) {
        lines.push(`  · [${a.status} ${Math.round(this.confidence(a) * 100)}%] "${a.text}"${a.count > 1 ? ` (${a.count}×)` : ''}${a.status === 'contradicted' ? ` — conflicts with "${a.contradicts}"` : ''}`);
      }
    } else {
      lines.push('- No preference assertions yet — they accumulate from messages like "don\'t …", "always …", and are confirmed by the turns you DON\'T correct.');
    }
    return lines;
  }
}

let _global: UserModel | null = null;
export function getUserModel(): UserModel {
  if (!_global) {
    _global = new UserModel(mindSingletonRoot());
    process.once('exit', () => { try { _global?.saveNow(); } catch { /* exiting */ } });
  }
  return _global;
}
export function __setUserModel(m: UserModel | null): void { _global = m; }
