import { spokenSummary } from './push.talk';

/**
 * Spoken updates (backlog N9): when a task finishes while you are not looking at it, Bimax can say so out loud —
 * "Tidy Downloads is done. Moved 30 files and freed 6 GB." Off by default; the menu bar and Settings → Voice turn it
 * on. It speaks with the voice chosen in Settings → Voice, and never over talk mode or while it is listening.
 */

export interface FinishedTask {
  title: string;
  outcome?: string;
  check?: string;
}

/** The line said for a finished task: its name, how it ended, and the first sentence of its answer. */
export function spokenUpdate(task: FinishedTask, answer: string): string {
  const name = task.title.trim() || 'A task';
  const verdict = task.outcome === 'time-limit' ? 'stopped at its time limit'
    : task.outcome === 'failed' ? 'failed'
      : task.outcome === 'interrupted' ? 'was interrupted'
        : task.check === 'failed' ? 'finished, but its check failed'
          : 'is done';
  const said = spokenSummary(answer.trim().split(/\n\s*\n/)[0] ?? '', 160); // the first paragraph: the result, not the details
  return `${name} ${verdict}.${said ? ` ${said}` : ''}`;
}

/** Whether to speak now: the person asked for it, is not looking at the task, and Bimax is not already talking. */
export function shouldSpeakUpdate(input: { enabled: boolean; onScreen: boolean; talking: boolean; listening: boolean }): boolean {
  return input.enabled && !input.onScreen && !input.talking && !input.listening;
}
