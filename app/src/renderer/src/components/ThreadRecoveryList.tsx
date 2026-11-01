import React, { useState } from 'react';
import type { ThreadRecoveryEntry } from '../../../shared/threads';
import { THREADS_PAGE } from '../threads.list.model';

export function ThreadRecoveryList({ entries, exportCopy }: {
  entries: ThreadRecoveryEntry[];
  exportCopy: (id: string, archived: boolean, backup?: boolean) => Promise<{ ok: boolean; error?: string; cancelled?: boolean }>;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [pages, setPages] = useState(1);
  if (!entries.length) return null;
  return <section aria-label="Conversation recovery" className="space-y-2 px-2.5 py-2 text-[12px]">
    <p className="font-medium text-ink">Conversations needing recovery</p>
    <p className="text-dim">The original saved copies are retained. Export a recovery copy before starting a new conversation.</p>
    {entries.slice(0, pages * THREADS_PAGE).map(entry => {
      const key = `${entry.backup ? 'bin' : entry.archived ? 'archive' : 'saved'}:${entry.id}`;
      return <div key={key} className="rounded-lg border border-line p-2">
        <p className="truncate text-ink" title={entry.id}>{entry.backup ? 'Conversation recovery backup' : entry.archived ? 'Archived conversation' : 'Saved conversation'} · {entry.id}</p>
        <p className="text-dim">{entry.reason === 'oversized' ? 'Too large to open safely' : entry.reason === 'capacity' ? 'History list is full' : 'Saved history could not be read'}</p>
        <button type="button" disabled={pending !== null} className="mt-1 rounded px-2 py-1 text-ink focus-visible:outline-2 focus-visible:outline-ember"
          onClick={async () => {
            if (pending !== null) return;
            setPending(key); setStatus('');
            try {
              const result = await exportCopy(entry.id, entry.archived, entry.backup ?? false);
              if (result.ok) setStatus('Recovery copy exported. The original is unchanged.');
              else if (!result.cancelled) setStatus(result.error || 'Could not export the recovery copy. Try again.');
            } catch { setStatus('Could not export the recovery copy. Try again.'); }
            finally { setPending(null); }
          }}>{pending === key ? 'Exporting…' : 'Export recovery copy…'}</button>
      </div>;
    })}
    {entries.length > pages * THREADS_PAGE && <button type="button" className="rounded px-2 py-1 text-ink" onClick={() => setPages(n => n + 1)}>Show more recovery copies</button>}
    {status && <p role="status" className="text-dim">{status}</p>}
  </section>;
}
