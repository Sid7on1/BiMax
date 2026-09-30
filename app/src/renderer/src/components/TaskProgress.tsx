import React from 'react';
import type { TaskProgressView } from '../task.progress.model';

/** Persistent task context outside scrollback: proximity, four chunks, no nested glass or cards. */
export function TaskProgress({ value, onReview, wide = false }: {
  value: TaskProgressView; onReview: () => void; wide?: boolean;
}): React.ReactElement {
  const files = value.files.length === 0 ? 'No changes' : value.files.length === 1 ? value.files[0] : `${value.files.length} changed files`;
  return (
    <section aria-label="Current task" data-task-progress data-task-state={value.state}
      className="shrink-0 border-b border-line px-4 py-2">
      <dl className={`grid ${wide ? 'grid-cols-4' : 'grid-cols-2'} gap-x-4 gap-y-1 text-[11px]`}>
        <div className="min-w-0"><dt className="text-faint">Goal</dt><dd className="h-6 truncate leading-6 text-ink" title={value.goal}>{value.goal}</dd></div>
        <div className="min-w-0"><dt className="text-faint">Step</dt><dd key={value.state} className="anim-fade-in h-6 truncate leading-6 text-dim" title={value.step} aria-live="polite" aria-atomic="true">{value.step}</dd></div>
        <div className="min-w-0"><dt className="text-faint">Files</dt><dd className="h-6 truncate leading-6 text-dim" title={value.files.join('\n') || files}>
          {value.files.length ? <button onClick={onReview} className="h-6 max-w-full cursor-pointer truncate text-left align-bottom hover:text-ink">{files}</button> : files}
        </dd></div>
        <div className="min-w-0"><dt className="text-faint">Next</dt><dd className="h-6 truncate leading-6 text-dim" title={value.next}>{value.next}</dd></div>
      </dl>
    </section>
  );
}
