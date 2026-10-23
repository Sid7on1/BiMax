import { stateDir } from '../utils/state.dir';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';

// Lightweight event bus for goals — avoids importing the full engineEvents (which imports React)
// in a module that is also imported by the container (Node-only context). Consumers bridge
// these to engineEvents.on('goals_changed') in the UI layer.
export const goalEvents = new EventEmitter();

export type GoalStatus = 'active' | 'completed' | 'abandoned';

export interface Goal {
  id: string;
  title: string;
  description: string;
  status: GoalStatus;
  created: string;  // ISO timestamp
  updated: string;
  sessions: string[]; // session IDs this goal was touched in
  notes?: string;
}

function goalId(): string {
  return crypto.randomBytes(4).toString('hex');
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * GoalManager — cross-session persistent goals (Bimax-unique).
 *
 * Unlike the per-session TodoTool, goals survive across sessions and are injected
 * into the system prompt at startup so the model always knows the overarching
 * objectives without being re-briefed. Model writes via GoalsTool; user writes via /goals.
 *
 * Storage: .bimax/goals.json (JSON array of Goal objects).
 * The in-memory cache is loaded once at init() and written on every mutation.
 */
export class GoalManager {
  private goals: Goal[] = [];
  private loaded = false;
  private goalsPath: string;

  constructor(projectRoot: string) {
    this.goalsPath = path.join(stateDir('.bimax', projectRoot), 'goals.json');
  }

  async init(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(this.goalsPath, 'utf-8');
      const parsed = JSON.parse(raw);
      // Guard against a corrupt/hand-edited file: a non-array (e.g. {}, "x", null) would parse fine
      // but then throw on every .filter()/.find() — crashing /goals, GoalsTool, and prompt injection.
      this.goals = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.goals = [];
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.goalsPath), { recursive: true });
    await fs.writeFile(this.goalsPath, JSON.stringify(this.goals, null, 2), 'utf-8');
    goalEvents.emit('goals_changed', this.getActiveGoals());
  }

  getActiveGoals(): Goal[] {
    return this.goals.filter(g => g.status === 'active');
  }

  getAllGoals(): Goal[] {
    return [...this.goals];
  }

  getGoal(id: string): Goal | undefined {
    return this.goals.find(g => g.id === id);
  }

  async addGoal(title: string, description: string, sessionId?: string): Promise<Goal> {
    const goal: Goal = {
      id: goalId(),
      title,
      description,
      status: 'active',
      created: nowIso(),
      updated: nowIso(),
      sessions: sessionId ? [sessionId] : [],
    };
    this.goals.push(goal);
    await this.save();
    return goal;
  }

  async updateGoal(id: string, changes: Partial<Pick<Goal, 'title' | 'description' | 'notes'>>, sessionId?: string): Promise<Goal | null> {
    const goal = this.goals.find(g => g.id === id);
    if (!goal) return null;
    if (changes.title !== undefined) goal.title = changes.title;
    if (changes.description !== undefined) goal.description = changes.description;
    if (changes.notes !== undefined) goal.notes = changes.notes;
    goal.updated = nowIso();
    if (sessionId && !goal.sessions.includes(sessionId)) goal.sessions.push(sessionId);
    await this.save();
    return goal;
  }

  async setStatus(id: string, status: GoalStatus, sessionId?: string): Promise<Goal | null> {
    const goal = this.goals.find(g => g.id === id);
    if (!goal) return null;
    goal.status = status;
    goal.updated = nowIso();
    if (sessionId && !goal.sessions.includes(sessionId)) goal.sessions.push(sessionId);
    await this.save();
    return goal;
  }

  async touchSession(id: string, sessionId: string): Promise<void> {
    const goal = this.goals.find(g => g.id === id);
    if (!goal || goal.sessions.includes(sessionId)) return;
    goal.sessions.push(sessionId);
    goal.updated = nowIso();
    await this.save();
  }

  /** For system prompt injection: a compact block summarizing active goals. */
  getSystemPromptBlock(): string {
    const active = this.getActiveGoals();
    if (active.length === 0) return '';
    const lines = active.map((g, i) =>
      `  ${i + 1}. [${g.id}] ${g.title}${g.description ? ` — ${g.description}` : ''}`
    );
    return `### PERSISTENT GOALS (cross-session)\nThe user has set these goals that persist across sessions. Keep them in mind when planning and executing tasks. Call GoalsTool to mark one complete when it is achieved.\n${lines.join('\n')}`;
  }
}

// Initialized lazily at startup with the project root.
let _globalGoalManager: GoalManager | null = null;

export function initGoalManager(projectRoot: string): GoalManager {
  _globalGoalManager = new GoalManager(projectRoot);
  return _globalGoalManager;
}

export function getGoalManager(): GoalManager {
  if (!_globalGoalManager) throw new Error('[GoalManager] not initialized — call initGoalManager(projectRoot) first');
  return _globalGoalManager;
}
