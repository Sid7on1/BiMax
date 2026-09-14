import React, { useEffect, useRef, useState } from 'react';
import { Archive, Folder, Link2, MessageSquare, Pencil, RotateCcw, Search, Square, Trash2 } from 'lucide-react';
import { isQuickThread, threadActivity, type ThreadList, type ThreadSummary } from '../../../shared/threads';

/** What a thread action answers: a refusal says why; a cancelled confirmation says nothing. */
type ActionResult = { ok: boolean; error?: string; cancelled?: boolean };

export function ThreadsList(): React.ReactElement {
  const [data,setData] = useState<ThreadList>({ activeId:null, threads:[], shortcutAvailable:true });
  const [error,setError] = useState('');
  const [query,setQuery] = useState('');
  const [matches,setMatches] = useState<Set<string> | null>(null);
  const [renaming,setRenaming] = useState<{ id: string; title: string } | null>(null);
  const renamingRef = useRef(renaming);
  renamingRef.current = renaming;
  const [showArchived,setShowArchived] = useState(false);
  const [archived,setArchived] = useState<ThreadSummary[]>([]);
  useEffect(() => {
    const off = window.bimax.threads.onList(setData);
    void window.bimax.threads.list().then(setData);
    return off;
  },[]);
  // Projects opened from Recents run as threads too, but they are listed in Recents, not here.
  const quick = data.threads.filter(isQuickThread);
  // Search runs in the main process, over each thread's name, folder and conversation (backlog N11).
  useEffect(() => {
    if (!query.trim()) { setMatches(null); return; }
    let live = true;
    const timer = setTimeout(() => {
      void window.bimax.threads.search(query).then((ids: string[]) => { if (live) setMatches(new Set(ids)); });
    }, 150);
    return () => { live = false; clearTimeout(timer); };
  },[query, quick.length]);
  const archivedCount = data.archivedCount ?? 0;
  useEffect(() => {
    if (!showArchived) return;
    let live = true;
    void window.bimax.threads.archived().then((list: ThreadSummary[]) => { if (live) setArchived(list); });
    return () => { live = false; };
  },[showArchived, archivedCount]);
  const active = data.threads.find(t => t.id === data.activeId);
  const shown = matches ? quick.filter(t => matches.has(t.id)) : quick;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const archivedShown = archived.filter(t => words.every(w => `${t.title}\n${t.root}`.toLowerCase().includes(w)));
  const folderName = (root: string) => root.split('/').filter(Boolean).pop();
  async function action(run: () => Promise<unknown>) {
    try {
      setError('');
      const result = await run() as ActionResult | boolean | null | undefined;
      if (result && typeof result === 'object' && !result.ok && !result.cancelled) setError(result.error ?? 'That did not work.');
    } catch(e) { setError(String((e as Error).message)); }
  }
  // Enter or leaving the field saves; Escape cancels. The ref makes a blur after Enter or Escape a no-op.
  function finishRename(save: boolean) {
    const current = renamingRef.current;
    renamingRef.current = null;
    setRenaming(null);
    if (!save || !current) return;
    const title = current.title.trim();
    if (title && title !== data.threads.find(t => t.id === current.id)?.title) void action(() => window.bimax.threads.rename(current.id, title));
  }
  return <div className="space-y-1 pb-1">
    {(quick.length > 3 || archivedCount > 0) && <label className="mx-1 flex items-center gap-1.5 rounded-md bg-hover px-2 py-1 text-[11px] text-dim">
      <Search size={11} className="shrink-0" aria-hidden/>
      <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search threads" aria-label="Search threads" className="min-w-0 flex-1 bg-transparent text-ink outline-none"/>
    </label>}
    {quick.length === 0 && <p className="px-2.5 py-1.5 text-[12px] text-faint">No threads yet. Press {data.shortcut ?? '⌘2'} anywhere to start one.</p>}
    {quick.length > 0 && shown.length === 0 && <p className="px-2.5 py-1.5 text-[12px] text-faint">No thread matches “{query.trim()}”.</p>}
    {!data.shortcutAvailable && <p className="px-2 text-xs text-rust">{data.shortcut ?? '⌘2'} is used by another app. Choose another shortcut from Bimax in the menu bar.</p>}
    {shown.map(thread => <div key={thread.id} className={`group rounded-lg ${thread.id === data.activeId ? 'bg-hover' : ''}`}>
      {renaming?.id === thread.id
        ? <div className="px-2 py-2">
            <input autoFocus value={renaming.title} maxLength={80} aria-label="Thread name"
              onChange={e => setRenaming({ id: thread.id, title: e.target.value })}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); finishRename(true); } else if (e.key === 'Escape') { e.preventDefault(); finishRename(false); } }}
              onBlur={() => finishRename(true)}
              className="w-full rounded bg-hover px-1.5 py-0.5 text-[12px] text-ink outline-none"/>
          </div>
        : <button className="w-full cursor-pointer px-2 py-2 text-left" onClick={() => void action(() => window.bimax.threads.select(thread.id))}>
            <span className="flex gap-2 text-[12px] text-ink"><MessageSquare size={13} className="mt-0.5 shrink-0"/><span className="truncate">{thread.title}</span></span>
            <span className="mt-1 flex items-center gap-1 pl-5 text-[10px] text-faint"><Folder size={10}/><span title={thread.root} className="truncate">{folderName(thread.root)}</span><span className={thread.status === 'needs-you' ? 'text-amber' : thread.outcome === 'failed' && !thread.queued ? 'text-rust' : ''}>· {threadActivity(thread).label}</span></span>
          </button>}
      <div className="flex flex-wrap gap-x-3 gap-y-1 px-3 pb-1.5 text-[10px] text-dim">
        {thread.status === 'stopped' && <button className="cursor-pointer" onClick={() => void action(() => window.bimax.threads.start(thread.id))}>Resume</button>}
        {thread.status !== 'stopped' && <button title="Stop only this thread" className="flex cursor-pointer gap-1" onClick={() => void action(() => window.bimax.threads.stop(thread.id))}><Square size={10}/>Stop</button>}
        {thread.queued ? <button title="Drop the messages waiting to be sent. The turn being worked on carries on." className="cursor-pointer" onClick={() => void action(() => window.bimax.threads.cancelQueued(thread.id))}>Cancel queued</button> : null}
        {active && active.id !== thread.id && <button className="flex cursor-pointer gap-1" onClick={() => void action(() => window.bimax.threads.link(active.id,thread.id,!active.peers.includes(thread.id)))}><Link2 size={11}/>{active.peers.includes(thread.id) ? 'Unlink' : 'Link to current'}</button>}
        {active?.peers.includes(thread.id) && <button className="cursor-pointer" onClick={() => void action(() => window.bimax.threads.link(active.id,thread.id,true))}>Renew</button>}
        <button className="flex cursor-pointer gap-1" onClick={() => setRenaming({ id: thread.id, title: thread.title })}><Pencil size={10}/>Rename</button>
        {thread.status === 'stopped' && <>
          <button title="Put this thread away. Restore it from Archived." className="flex cursor-pointer gap-1" onClick={() => void action(() => window.bimax.threads.archive(thread.id))}><Archive size={10}/>Archive</button>
          <button title="Move this conversation to the Bin" className="flex cursor-pointer gap-1" onClick={() => void action(() => window.bimax.threads.moveToBin(thread.id, false))}><Trash2 size={10}/>Bin</button>
        </>}
      </div>
    </div>)}
    {shown.length > 1 && !query.trim() && <p className="px-2 py-1 text-[10px] text-faint">Link threads to let them exchange messages. Each changes files only in its own folder and asks for its own permissions.</p>}
    {archivedCount > 0 && <button aria-expanded={showArchived} className="flex w-full cursor-pointer items-center gap-1.5 px-2.5 py-1 text-left text-[10px] text-dim" onClick={() => setShowArchived(v => !v)}>
      <Archive size={10}/>{showArchived ? 'Hide archived' : `Archived (${archivedCount})`}
    </button>}
    {showArchived && archivedCount > 0 && <div className="space-y-1">
      {words.length > 0 && archivedShown.length === 0 && <p className="px-2.5 py-1 text-[11px] text-faint">No archived thread matches.</p>}
      {archivedShown.map(thread => <div key={thread.id} className="rounded-lg">
        <div className="px-2 py-1.5">
          <span className="flex gap-2 text-[12px] text-dim"><MessageSquare size={13} className="mt-0.5 shrink-0"/><span className="truncate">{thread.title}</span></span>
          <span className="mt-1 flex items-center gap-1 pl-5 text-[10px] text-faint"><Folder size={10}/><span title={thread.root} className="truncate">{folderName(thread.root)}</span></span>
        </div>
        <div className="flex gap-3 px-3 pb-1.5 text-[10px] text-dim">
          <button className="flex cursor-pointer gap-1" onClick={() => void action(() => window.bimax.threads.unarchive(thread.id))}><RotateCcw size={10}/>Restore</button>
          <button title="Move this conversation to the Bin" className="flex cursor-pointer gap-1" onClick={() => void action(() => window.bimax.threads.moveToBin(thread.id, true))}><Trash2 size={10}/>Bin</button>
        </div>
      </div>)}
    </div>}
    {error && <p role="alert" className="px-2 text-xs text-rust">{error}</p>}
  </div>;
}
