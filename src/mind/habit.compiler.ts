import { stateDir } from '../utils/state.dir';
import * as fs from 'fs';
import * as path from 'path';
import { mindSingletonRoot } from './self.model';

/**
 * HabitCompiler — procedural memory. Watches the stream of tool calls, mines
 * recurring multi-step sequences (n-grams over tool×domain tokens), and "compiles"
 * the ones that keep recurring into deterministic macros: a named recipe persisted
 * to .bimax/habits/<slug>.md plus a prompt hint telling the model to run the whole
 * sequence as one batch instead of re-deriving it step by step every time.
 *
 * This is habit formation: deliberate reasoning (slow, token-hungry) becomes a
 * reflex (fast, deterministic). Mining is pure counting — no LLM in the loop.
 */

export interface Habit {
  /** Stable key: the step tokens joined by '→'. */
  key: string;
  steps: string[];   // e.g. ["EditFileTool:ts", "BashTool:npm", "BashTool:go"]
  count: number;     // times the full sequence was observed (successful runs only)
  lastSeen: string;  // ISO
  compiled: boolean; // recipe written to .bimax/habits/
  slug?: string;
  /**
   * Set when every step is a BashTool call whose concrete command was STABLE across
   * the supporting occurrences — the habit is then a deterministic, executable macro
   * (`/habits run <slug>`), not just a prompt hint. Commands replay through the
   * governed BashTool, so every safety gate still applies.
   */
  commands?: string[];
}

interface SeqEntry { t: string; ok: boolean; cmd?: string }

interface HabitsFile {
  version: 1;
  seq: SeqEntry[];
  habits: Record<string, Habit>;
}

const SEQ_CAP = 2000;         // rolling window of observed calls persisted across sessions
const MINE_EVERY = 25;        // observe() calls between mining passes
const MIN_OCCURRENCES = 4;    // a sequence seen this often is a habit
const NGRAM_MIN = 2;
const NGRAM_MAX = 5;

/** Read-only tools: sequences made ONLY of these are exploration, not a procedure worth compiling. */
const READ_ONLY = new Set(['ReadFileTool', 'GrepTool', 'GlobTool', 'GraphQueryTool', 'GraphContextTool', 'MemoryQueryTool', 'LspQueryTool']);

/**
 * Episode boundary sentinel. Mining never crosses one — an n-gram spanning two
 * unrelated user tasks is coincidence, not procedure. Pushed at each new user turn.
 */
const BOUNDARY = '⊥';

function slugify(steps: string[]): string {
  return steps.map(s => s.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()).join('--').slice(0, 80);
}

export class HabitMiner {
  private data: HabitsFile = { version: 1, seq: [], habits: {} };
  private loaded = false;
  private dirty = false;
  private sinceMine = 0;
  private filePath: string;
  private habitsDir: string;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(projectRoot: string = process.cwd()) {
    this.filePath = path.join(stateDir('.bimax', projectRoot), 'habits.json');
    this.habitsDir = path.join(stateDir('.bimax', projectRoot), 'habits');
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      if (parsed && Array.isArray(parsed.seq) && parsed.habits && typeof parsed.habits === 'object') {
        this.data = { version: 1, seq: parsed.seq, habits: parsed.habits };
      }
    } catch { /* first run */ }
  }

  private scheduleSave(): void {
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

  /** Mark an episode boundary (new user task) — mined patterns never cross it. */
  markBoundary(): void {
    this.load();
    const last = this.data.seq[this.data.seq.length - 1];
    if (!last || last.t === BOUNDARY) return; // no leading/duplicate boundaries
    this.data.seq.push({ t: BOUNDARY, ok: true });
    if (this.data.seq.length > SEQ_CAP) this.data.seq.splice(0, this.data.seq.length - SEQ_CAP);
    this.dirty = true;
    this.scheduleSave();
  }

  /**
   * Feed one tool call outcome into the stream. `cmd` (BashTool only) is kept so habits
   * whose commands prove stable can be compiled into executable macros. Mining runs
   * periodically, inline (it's cheap counting).
   */
  observe(tool: string, domain: string, ok: boolean, cmd?: string): void {
    this.load();
    const token = `${tool}:${domain}`;
    // Collapse immediate repeats (Read × 6 → Read): repeats are exploration noise, not procedure.
    const last = this.data.seq[this.data.seq.length - 1];
    if (last && last.t === token) { last.ok = last.ok && ok; this.dirty = true; this.scheduleSave(); return; }
    this.data.seq.push({ t: token, ok, ...(cmd ? { cmd: cmd.trim().slice(0, 300) } : {}) });
    if (this.data.seq.length > SEQ_CAP) this.data.seq.splice(0, this.data.seq.length - SEQ_CAP);
    this.dirty = true;
    if (++this.sinceMine >= MINE_EVERY) { this.sinceMine = 0; this.mine(); }
    this.scheduleSave();
  }

  /**
   * N-gram mining pass over the successful-call stream. Counts every 2..5-gram,
   * records those seen >= MIN_OCCURRENCES times that contain at least one
   * non-read tool, and prunes sub-habits fully contained in a longer habit with
   * (near-)equal support, so "build+test" doesn't shadow "edit+build+test".
   */
  mine(): Habit[] {
    this.load();
    // Keep boundaries in the stream so windows can refuse to cross them.
    const tokens = this.data.seq.filter(e => e.ok || e.t === BOUNDARY).map(e => e.t);
    const counts = new Map<string, { steps: string[]; count: number }>();
    for (let n = NGRAM_MIN; n <= NGRAM_MAX; n++) {
      for (let i = 0; i + n <= tokens.length; i++) {
        const steps = tokens.slice(i, i + n);
        if (steps.includes(BOUNDARY)) continue;                      // never span two tasks
        if (new Set(steps).size < 2) continue;                       // all-same token = noise
        if (steps.every(s => READ_ONLY.has(s.split(':')[0]))) continue; // pure exploration
        const key = steps.join('→');
        const c = counts.get(key);
        if (c) c.count++; else counts.set(key, { steps, count: 1 });
      }
    }
    const found = Array.from(counts.values()).filter(c => c.count >= MIN_OCCURRENCES);
    // Prefer longer habits: drop an n-gram if a longer one containing it has >= 80% of its support.
    const keep = found.filter(a => !found.some(b =>
      b.steps.length > a.steps.length &&
      b.steps.join('→').includes(a.steps.join('→')) &&
      b.count >= a.count * 0.8
    ));
    const now = new Date().toISOString();
    for (const k of keep) {
      const key = k.steps.join('→');
      const existing = this.data.habits[key];
      if (existing) { existing.count = k.count; existing.lastSeen = now; }
      else this.data.habits[key] = { key, steps: k.steps, count: k.count, lastSeen: now, compiled: false };
    }
    this.dirty = true;
    this.scheduleSave();
    return Object.values(this.data.habits).sort((a, b) => b.count - a.count);
  }

  /**
   * For an all-BashTool habit, find the concrete command tuple behind its occurrences.
   * Returns the commands only when they were STABLE: the dominant tuple must back ≥60%
   * of occurrences and appear ≥3 times — otherwise the "habit" varies too much to replay.
   */
  private stableCommands(steps: string[]): string[] | null {
    if (!steps.every(s => s.startsWith('BashTool:'))) return null;
    const stream = this.data.seq.filter(e => e.ok || e.t === BOUNDARY);
    const tuples = new Map<string, { cmds: string[]; count: number }>();
    for (let i = 0; i + steps.length <= stream.length; i++) {
      const win = stream.slice(i, i + steps.length);
      if (win.some(e => e.t === BOUNDARY)) continue;
      if (!win.every((e, j) => e.t === steps[j])) continue;
      if (!win.every(e => e.cmd)) continue; // recorded before command capture existed
      const cmds = win.map(e => e.cmd!);
      const key = cmds.join(' ');
      const t = tuples.get(key);
      if (t) t.count++; else tuples.set(key, { cmds, count: 1 });
    }
    let total = 0, best: { cmds: string[]; count: number } | null = null;
    for (const t of tuples.values()) {
      total += t.count;
      if (!best || t.count > best.count) best = t;
    }
    if (!best || best.count < 3 || best.count / total < 0.6) return null;
    return best.cmds;
  }

  /** Compile every uncompiled habit into a deterministic recipe file. Returns the newly compiled. */
  compileAll(): Habit[] {
    this.load();
    const compiled: Habit[] = [];
    for (const h of Object.values(this.data.habits)) {
      // Re-derive executability even for already-compiled habits — commands can
      // stabilize (or drift apart) as more occurrences accumulate.
      try { h.commands = this.stableCommands(h.steps) ?? undefined; } catch { /* best-effort */ }
      if (h.compiled) continue;
      try {
        fs.mkdirSync(this.habitsDir, { recursive: true });
        const slug = slugify(h.steps);
        const lines = [
          `# Habit: ${h.steps.map(s => s.split(':')[0]).join(' → ')}`,
          '',
          `Mined from ${h.count} recurring occurrences in this repo's tool history.`,
          'When the first step happens, the rest almost always follow — run them together as one batch.',
          '',
          ...h.steps.map((s, i) => {
            const [tool, domain] = s.split(':');
            return `${i + 1}. ${tool}${domain && domain !== '-' ? ` (on ${domain})` : ''}`;
          }),
          ...(h.commands ? ['', 'Executable macro (stable commands):', ...h.commands.map(c => `    ${c}`), '', `Run with: /habits run ${slugify(h.steps)}`] : []),
          '',
        ];
        fs.writeFileSync(path.join(this.habitsDir, `${slug}.md`), lines.join('\n'), 'utf-8');
        h.compiled = true;
        h.slug = slug;
        compiled.push(h);
      } catch { /* skip this habit */ }
    }
    this.dirty = true;
    this.saveNow();
    return compiled;
  }

  habits(): Habit[] {
    this.load();
    return Object.values(this.data.habits).sort((a, b) => b.count - a.count);
  }

  /**
   * Prompt hint for compiled habits: tell the model its own recurring procedures so it
   * batches them in one turn instead of re-deriving them. Empty when nothing is compiled.
   */
  getPromptBlock(): string {
    const compiled = this.habits().filter(h => h.compiled).slice(0, 4);
    if (compiled.length === 0) return '';
    const lines = compiled.map(h => {
      if (h.commands) {
        // Executable macro: give the model the EXACT stable command chain — no guessing.
        return `- Your stable verified sequence (seen ${h.count}×): run \`${h.commands.join(' && ')}\` as ONE BashTool call when this situation recurs.`;
      }
      const pretty = h.steps.map(s => {
        const [tool, domain] = s.split(':');
        return domain && domain !== '-' ? `${tool}(${domain})` : tool;
      }).join(' → ');
      return `- ${pretty} (seen ${h.count}×): when you start this sequence, run ALL its steps together this turn.`;
    });
    return `### COMPILED HABITS (your own recurring procedures — batch them)\n${lines.join('\n')}`;
  }

  /** Executable macros only — the /habits run surface. */
  executable(): Habit[] {
    return this.habits().filter(h => h.compiled && h.commands && h.slug);
  }

  report(): string[] {
    this.load();
    const hs = this.habits();
    if (hs.length === 0) return ['- No habits mined yet — they form as recurring tool sequences repeat (≥4×).'];
    return hs.slice(0, 8).map(h => {
      const pretty = h.steps.map(s => s.split(':').filter(x => x && x !== '-').join(' ')).join(' → ');
      const marker = h.commands ? '⚡' : h.compiled ? '⚙' : '·';
      const note = h.commands
        ? `(executable — /habits run ${h.slug})`
        : h.compiled ? `(compiled → .bimax/habits/${h.slug}.md)` : '(not compiled yet)';
      return `- ${marker} ${pretty} — ${h.count}× ${note}`;
    });
  }
}

let _global: HabitMiner | null = null;
export function getHabitMiner(): HabitMiner {
  if (!_global) {
    _global = new HabitMiner(mindSingletonRoot());
    process.once('exit', () => { try { _global?.saveNow(); } catch { /* exiting */ } });
  }
  return _global;
}
export function __setHabitMiner(m: HabitMiner | null): void { _global = m; }
