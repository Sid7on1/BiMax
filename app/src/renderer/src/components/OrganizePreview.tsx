import React, { useEffect, useState } from 'react';
import { Folder, FolderPlus, X } from 'lucide-react';
import type { OrganizeView } from '../../../preload/index';
import { useSurface } from './ThreadSurfaces';

/**
 * The Organize preview (backlog FL2): the folder tree a task proposes, before anything moves. Drag a file onto another
 * folder, or onto "New folder", to put it there; when other files share its group, Bimax offers to put them all there
 * too. "Leave it" keeps a file where it is. Apply makes every move in one step that ↶ Undo reverses as a whole.
 */
export function OrganizePreview(): React.ReactElement {
  const glass = useSurface('organize');
  const [view, setView] = useState<OrganizeView | null>(null);
  const [offer, setOffer] = useState<{ group: string; count: number; folder: string } | null>(null);
  const [newFolder, setNewFolder] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.bimax.organize.current().then(setView);
    return window.bimax.organize.onPlan((value) => { setView(value); setOffer(null); setError(''); });
  }, []);

  const drop = async (from: string, folder: string): Promise<void> => {
    const result = await window.bimax.organize.move(from, folder);
    if (!result) { setError('That folder name cannot be used.'); return; }
    setView(result.view);
    setOffer(result.offer);
    setError('');
  };
  const dragProps = (folder: string) => ({
    onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes('application/x-bimax-file')) e.preventDefault(); },
    onDrop: (e: React.DragEvent) => { e.preventDefault(); const from = e.dataTransfer.getData('application/x-bimax-file'); if (from) void drop(from, folder); },
  });

  if (!view) return <div className="aux-panel" data-glass={glass}><div className="aux-panel-body"><p className="aux-panel-note">No plan is waiting.</p></div></div>;
  return (
    <div className="aux-panel" data-glass={glass}>
      <header className="aux-panel-header quick-drag">
        <span>{view.title} · {view.total} file{view.total === 1 ? '' : 's'}{view.byYou ? ` · ${view.byYou} placed by you` : ''}</span>
        <button type="button" aria-label="Dismiss the plan" title="Dismiss — nothing moves" className="quick-circle" onClick={() => void window.bimax.organize.cancel()}><X size={14} /></button>
      </header>
      <div className="aux-panel-body" style={{ overflowY: 'auto' }}>
        <p className="aux-panel-note">Nothing has moved. Drag a file onto another folder to change where it goes; Apply makes every move at once, and ↶ Undo reverses them together.</p>
        {view.conflicts.length ? <p role="alert" className="quick-error">{view.conflicts.slice(0, 3).join(' · ')}</p> : null}
        {offer ? (
          <div className="quick-request" role="status">
            <p className="quick-request-question">Put all {offer.count} other {offer.group} in {offer.folder || 'the top folder'} too?</p>
            <div className="quick-request-options">
              <button type="button" className="quick-choice quick-choice-primary" onClick={() => { void window.bimax.organize.moveGroup(offer.group, offer.folder).then((v) => { if (v) setView(v); setOffer(null); }); }}>Put them all there</button>
              <button type="button" className="quick-choice" onClick={() => setOffer(null)}>Just this one</button>
            </div>
          </div>
        ) : null}
        {view.tree.map((entry) => (
          <section key={entry.folder} className="quick-request" {...dragProps(entry.folder)} aria-label={`Folder ${entry.folder || 'top'}`}>
            <p className="quick-request-question"><Folder size={12} aria-hidden /> {entry.folder || `${view.root.split('/').pop()} (top)`} <span className="aux-panel-note">· {entry.files.length}</span></p>
            <ul>
              {entry.files.map((file) => (
                <li key={file.from} draggable onDragStart={(e) => { e.dataTransfer.setData('application/x-bimax-file', file.from); e.dataTransfer.effectAllowed = 'move'; }}
                  className="flex cursor-grab items-center gap-2 text-[12px]" title={`From ${file.from}`}>
                  <span className="min-w-0 flex-1 truncate">{file.name}</span>
                  <span className="aux-panel-note">{file.group}{file.byYou ? ' · you' : ''}</span>
                  <button type="button" className="quick-link" title="Leave this file where it is" onClick={() => { void window.bimax.organize.keep(file.from).then(setView); }}>Leave it</button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {view.kept.length ? (
          <section className="quick-request" aria-label="Kept where you put them">
            <p className="quick-request-question">Kept where you put them · {view.kept.length}</p>
            <p className="aux-panel-note">You moved these yourself after the last plan, so this revision leaves them alone.</p>
            <ul>
              {view.kept.map((file) => (
                <li key={file.from} className="flex items-center gap-2 text-[12px]">
                  <span className="min-w-0 flex-1 truncate" title={`The task would move it to ${file.to}`}>{file.from}</span>
                  <button type="button" className="quick-link" onClick={() => { void window.bimax.organize.include(file.from).then((v) => { if (v) setView(v); }); }}>Include anyway</button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <section className="quick-request" {...{
          onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes('application/x-bimax-file')) e.preventDefault(); },
          onDrop: (e: React.DragEvent) => {
            e.preventDefault();
            const from = e.dataTransfer.getData('application/x-bimax-file');
            if (!newFolder.trim()) { setError('Type the new folder’s name first, then drop a file on it.'); return; }
            if (from) void drop(from, newFolder.trim());
          },
        }}>
          <p className="quick-request-question"><FolderPlus size={12} aria-hidden /> New folder</p>
          <input value={newFolder} onChange={(e) => setNewFolder(e.target.value)} placeholder="e.g. Invoices/2026 — then drop a file here" className="quick-rules-text" aria-label="New folder name" />
        </section>
        {error ? <p role="alert" className="quick-error">{error}</p> : null}
        <div className="quick-request-options">
          <button type="button" className="quick-choice quick-choice-primary" disabled={busy || view.conflicts.length > 0}
            onClick={() => { setBusy(true); void window.bimax.organize.apply().then((r) => { setBusy(false); if (!r.ok) setError(r.error || 'Could not apply the plan.'); }); }}>
            Apply {view.total} move{view.total === 1 ? '' : 's'}
          </button>
          <button type="button" className="quick-choice" onClick={() => void window.bimax.organize.cancel()}>Dismiss</button>
        </div>
      </div>
    </div>
  );
}
