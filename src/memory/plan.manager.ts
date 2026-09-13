import { stateDir } from '../utils/state.dir';
import * as fs from 'fs/promises';
import * as path from 'path';
import { EventEmitter } from 'events';
import * as yaml from 'js-yaml';

export const planEvents = new EventEmitter();

export interface PlanStep {
  index: number;        // 1-based
  text: string;
  done: boolean;
}

export interface Plan {
  slug: string;         // filename without extension, used as ID
  title: string;
  goal: string;
  steps: PlanStep[];
  risks: string[];
  filesToTouch: string[];
  goalId?: string;      // linked GoalManager id
  createdAt: string;
  updatedAt: string;
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'plan';
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Serialize a Plan to the on-disk markdown format. */
function serialize(plan: Plan): string {
  const fmFields: Record<string, string> = {
    title: plan.title,
    slug: plan.slug,
    created: plan.createdAt,
    updated: plan.updatedAt,
  };
  if (plan.goalId) fmFields.goal_id = plan.goalId;
  const frontmatter = yaml.dump(fmFields, { lineWidth: -1 }).trimEnd();

  const checkboxes = plan.steps.map(s => `- [${s.done ? 'x' : ' '}] ${s.text}`).join('\n');
  const risks = plan.risks.length ? `\n## Risks\n${plan.risks.map(r => `- ${r}`).join('\n')}` : '';
  const files = plan.filesToTouch.length ? `\n## Files\n${plan.filesToTouch.map(f => `- \`${f}\``).join('\n')}` : '';

  return `---\n${frontmatter}\n---\n\n## Goal\n${plan.goal}\n\n## Steps\n${checkboxes}${risks}${files}`;
}

/** Parse a persisted plan markdown file back into a Plan object. */
function deserialize(slug: string, raw: string): Plan {
  // Locate the two --- delimiters robustly (tolerates trailing spaces and CRLF)
  const open = raw.match(/^---[ \t]*\r?\n/);
  if (!open) throw new Error('Invalid plan format: missing opening ---');
  const fmStart = open[0].length;
  const closeRe = /\r?\n---[ \t]*(\r?\n|$)/g;
  closeRe.lastIndex = fmStart;
  const close = closeRe.exec(raw);
  if (!close) throw new Error('Invalid plan format: missing closing ---');

  const fmText = raw.slice(fmStart, close.index);
  const body = raw.slice(close.index + close[0].length);

  const meta = (yaml.load(fmText) || {}) as Record<string, string>;
  const title = meta.title || '';
  const createdAt = meta.created || '';
  const updatedAt = meta.updated || '';
  const goalId = meta.goal_id || undefined;

  const section = (name: string) => {
    const m = body.match(new RegExp(`(?:^|\n)## ${name}\n([\\s\\S]*?)(?=\n## |$)`));
    return m ? m[1].trim() : '';
  };

  const goal = section('Goal');

  const stepsBlock = section('Steps');
  const steps: PlanStep[] = [];
  let idx = 1;
  for (const line of stepsBlock.split('\n')) {
    const m = line.match(/^-\s+\[([xX ])\]\s+(.+)$/);
    if (m) steps.push({ index: idx++, done: m[1].toLowerCase() === 'x', text: m[2].trim() });
  }

  const risksBlock = section('Risks');
  const risks = risksBlock
    ? risksBlock.split('\n').map(l => l.replace(/^-\s+/, '').trim()).filter(Boolean)
    : [];

  const filesBlock = section('Files');
  const filesToTouch = filesBlock
    ? filesBlock.split('\n').map(l => l.replace(/^-\s+`?|`?$/g, '').trim()).filter(Boolean)
    : [];

  return { slug, title, goal, steps, risks, filesToTouch, goalId, createdAt, updatedAt };
}

export class PlanManager {
  private dir: string;

  constructor(projectRoot: string) {
    this.dir = path.join(stateDir('.bimax', projectRoot), 'plans');
  }

  async save(plan: Plan): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    plan.updatedAt = nowIso();
    await fs.writeFile(path.join(this.dir, `${plan.slug}.md`), serialize(plan), 'utf-8');
    planEvents.emit('plans_changed');
  }

  async load(slug: string): Promise<Plan | null> {
    try {
      const raw = await fs.readFile(path.join(this.dir, `${slug}.md`), 'utf-8');
      return deserialize(slug, raw);
    } catch { return null; }
  }

  async list(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.dir);
      return files.filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)).sort();
    } catch { return []; }
  }

  /** The slug of the most-recently-modified plan, or null if none. Used by `/plan show` (no slug). */
  async newestSlug(): Promise<string | null> {
    try {
      const files = (await fs.readdir(this.dir)).filter(f => f.endsWith('.md'));
      if (files.length === 0) return null;
      const stamped = await Promise.all(
        files.map(async f => ({ slug: f.slice(0, -3), mtime: (await fs.stat(path.join(this.dir, f))).mtimeMs }))
      );
      stamped.sort((a, b) => b.mtime - a.mtime);
      return stamped[0].slug;
    } catch { return null; }
  }

  /** Find a slug not already taken on disk: "foo", then "foo-2", "foo-3", … (avoids silent overwrite). */
  private async uniqueSlug(base: string): Promise<string> {
    const existing = new Set(await this.list());
    if (!existing.has(base)) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base}-${n}`;
      if (!existing.has(candidate)) return candidate;
    }
  }

  async create(opts: {
    title: string;
    goal: string;
    steps: string[];
    risks?: string[];
    filesToTouch?: string[];
    goalId?: string;
  }): Promise<Plan> {
    const slug = await this.uniqueSlug(slugify(opts.title));
    const plan: Plan = {
      slug,
      title: opts.title,
      goal: opts.goal,
      steps: opts.steps.map((text, i) => ({ index: i + 1, text, done: false })),
      risks: opts.risks || [],
      filesToTouch: opts.filesToTouch || [],
      goalId: opts.goalId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await this.save(plan);
    return plan;
  }

  async setStepDone(slug: string, stepIndex: number, done: boolean): Promise<Plan | null> {
    const plan = await this.load(slug);
    if (!plan) return null;
    const step = plan.steps.find(s => s.index === stepIndex);
    if (!step) return null;
    step.done = done;
    await this.save(plan);
    return plan;
  }

  async delete(slug: string): Promise<boolean> {
    try { await fs.rm(path.join(this.dir, `${slug}.md`)); return true; } catch { return false; }
  }

  /** Human-readable summary for system prompt / TUI display. */
  formatPlan(plan: Plan): string {
    const done = plan.steps.filter(s => s.done).length;
    const total = plan.steps.length;
    const steps = plan.steps.map(s => `  ${s.done ? '[x]' : '[ ]'} ${s.index}. ${s.text}`).join('\n');
    const risks = plan.risks.length ? `\nRisks:\n${plan.risks.map(r => `  - ${r}`).join('\n')}` : '';
    return `Plan: ${plan.title} (${done}/${total} steps done)\nGoal: ${plan.goal}\n${steps}${risks}`;
  }
}

let _globalPlanManager: PlanManager | null = null;

export function initPlanManager(projectRoot: string): PlanManager {
  _globalPlanManager = new PlanManager(projectRoot);
  return _globalPlanManager;
}

export function getPlanManager(): PlanManager {
  if (!_globalPlanManager) throw new Error('[PlanManager] not initialized — call initPlanManager(projectRoot) first');
  return _globalPlanManager;
}
