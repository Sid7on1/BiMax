import { engineReducer, initialEngineState, EngineUiState } from './engine.state';

/** Immutable reducer projections. All snapshots publish before any subscriber is notified. */
export class EngineDomain<T extends object> {
  private value: T;
  private listeners = new Set<() => void>();

  constructor(private select: (state: EngineUiState) => T, state: EngineUiState) {
    this.value = Object.freeze(select(state));
  }

  getSnapshot = (): T => this.value;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  update(state: EngineUiState): boolean {
    const next = this.select(state);
    if ((Object.keys(next) as (keyof T)[]).every((key) => Object.is(next[key], this.value[key]))) return false;
    this.value = Object.freeze(next);
    return true;
  }

  notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/** One store per mounted engine owner, never a process-global singleton. */
export class EngineStore {
  private state: EngineUiState;
  readonly domains;

  constructor(state: EngineUiState = initialEngineState) {
    this.state = state;
    this.domains = {
      transcript: new EngineDomain((s) => ({ items: s.items }), state),
      stream: new EngineDomain((s) => ({
        streaming: s.streaming, thinking: s.thinking,
        busy: s.spinner.state !== 'idle' && s.spinner.state !== '',
      }), state),
      task: new EngineDomain((s) => ({
        spinner: s.spinner, status: s.status, todos: s.todos, subagents: s.subagents,
        request: s.request, awaitingNewTurn: s.awaitingNewTurn,
      }), state),
      review: new EngineDomain((s) => ({ review: s.review }), state),
      settings: new EngineDomain((s) => ({ snapshot: s.snapshot, mode: s.mode, tier: s.tier }), state),
      // Migration facade for the workspace shell. Text never crosses this subscription; the
      // boolean only changes when the live tail appears/disappears (home-view visibility).
      workspace: new EngineDomain((s) => {
        const { streaming, thinking, ...rest } = s;
        return { ...rest, hasActiveStream: Boolean(streaming || thinking) };
      }, state),
    };
  }

  getState = (): EngineUiState => this.state;

  dispatch = (action: Parameters<typeof engineReducer>[1]): void => {
    const next = engineReducer(this.state, action);
    if (next === this.state) return;
    this.state = next;
    const changed = Object.values(this.domains).filter((domain) => domain.update(next));
    for (const domain of changed) domain.notify();
  };
}
