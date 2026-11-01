import React, { useEffect, useRef, useState } from 'react';
import {
  Archive, Download, Folder, Link2, MessageSquare, MoreHorizontal, Pencil, Play, RotateCcw, Search, Square, Trash2,
} from 'lucide-react';
import { isQuickThread, threadActivity, type ThreadList, type ThreadSummary } from '../../../shared/threads';
import { visibleThreads } from '../threads.list.model';
import { cn } from '../lib/cn';
import { SeedMenu, SeedMenuItem, SeedMenuLabel, SeedMenuSeparator } from './ui/morph/SeedMenu';

/** What a thread action answers: a refusal says why; a cancelled confirmation says nothing. */
type ActionResult = { ok: boolean; error?: string; cancelled?: boolean };

const PRIORITIES = [
  { id: 'high', label: 'High', desc: 'Goes first when tasks wait for a free slot or folder; stopped last' },
  { id: 'normal', label: 'Normal', desc: 'The default' },
  { id: 'low', label: 'Low', desc: 'Waits for the others; stopped first to make room' },
] as const;

/**
 * The sidebar's Bimax Threads (the ⌘2 tasks).
 *
 * Fix list item 6 (owner, 2026-09-30): the list showed every thread and gave each one a wrapped line of
 * eight text buttons — Resume, Priority, Link to current, Renew, Rename, Export, Archive, Bin — so it grew
 * without bound and every row read as a toolbar. Now it shows five (`visibleThreads`; the one you are in
 * is always among them) and "Show more" for the rest; a row is its title and its state, and on hover or
 * focus it offers the three everyday actions — Resume or Stop, Rename, Bin — as icons, with everything
 * else behind "…". The way chat apps and Linear treat history rows.
 */
export function ThreadsList(): React.ReactElement {
  const [data,setData] = useState<ThreadList>({ activeId:null, threads:[], shortcutAvailable:true });
  const [error,setError] = useState('');
  const [binPending,setBinPending] = useState(false);
  const [query,setQuery] = useState('');
  const [matches,setMatches] = useState<Set<string> | null>(null);
  const [renaming,setRenaming] = useState<{ id: string; title: string } | null>(null);
  const renamingRef = useRef(renaming);
  renamingRef.current = renaming;
  const [expanded,setExpanded] = useState(false);
  const [showArchived,setShowArchived] = useState(false);
  const [archived,setArchived] = useState<ThreadSummary[]>([]);
  useEffect(() => {
    let live = true; let changed = false;
    const off = window.bimax.threads.onList(value => { changed = true; if (live) setData(value); });
    void window.bimax.threads.list().then(value => { if (live && !changed) setData(value); });
    return () => { live = false; off(); };
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
  const matching = matches ? quick.filter(t => matches.has(t.id)) : quick;
  // A search shows every match: the point of searching is to find the one past the fold.
  const { shown, hidden } = visibleThreads(matching, data.activeId, expanded || !!query.trim());
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
  async function binAction(run: () => Promise<unknown>) {
    if (binPending) return;
    setBinPending(true);
    try { await action(run); } finally { setBinPending(false); }
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
  return <div className="space-y-px pb-1">
    {(quick.length > 5 || archivedCount > 0) && <label className="mx-1 mb-1 flex items-center gap-1.5 rounded-md bg-hover px-2 py-1 text-[11px] text-dim">
      <Search size={11} className="shrink-0" aria-hidden/>
      <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search threads" aria-label="Search threads" className="min-w-0 flex-1 bg-transparent text-ink outline-none"/>
    </label>}
    {quick.length === 0 && <p className="px-2.5 py-1.5 text-[12px] text-faint">No threads yet. Press {data.shortcut ?? '⌘2'} anywhere to start one.</p>}
    {quick.length > 0 && matching.length === 0 && <p className="px-2.5 py-1.5 text-[12px] text-faint">No thread matches “{query.trim()}”.</p>}
    {!data.shortcutAvailable && <p className="px-2 text-xs text-rust">{data.shortcut ?? '⌘2'} is used by another app. Choose another shortcut from Bimax in the menu bar.</p>}
    {shown.map(thread => {
      const stopped = thread.status === 'stopped';
      const linked = !!active && active.id !== thread.id && active.peers.includes(thread.id);
      return <div key={thread.id} className="group relative">
        {renaming?.id === thread.id
          ? <div className="px-2 py-1.5">
              <input autoFocus value={renaming.title} maxLength={80} aria-label="Thread name"
                onChange={e => setRenaming({ id: thread.id, title: e.target.value })}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); finishRename(true); } else if (e.key === 'Escape') { e.preventDefault(); finishRename(false); } }}
                onBlur={() => finishRename(true)}
                className="w-full rounded bg-hover px-1.5 py-0.5 text-[12px] text-ink outline-none"/>
            </div>
          : <button
              data-active={thread.id === data.activeId || undefined}
              className="glass-row w-full cursor-pointer rounded-lg px-2.5 py-1.5 text-left focus-visible:outline-2 focus-visible:outline-ember"
              onClick={() => void action(() => window.bimax.threads.select(thread.id))}
            >
              <span className="flex gap-2 text-[12.5px] text-ink"><MessageSquare size={13} className="mt-0.5 shrink-0 text-dim"/><span className="truncate">{thread.title}</span></span>
              <span className="mt-0.5 flex items-center gap-1 pl-5 text-[10.5px] text-faint"><Folder size={10} className="shrink-0"/><span title={thread.root} className="truncate">{folderName(thread.root)}</span><span className={cn('shrink-0', thread.status === 'needs-you' ? 'text-amber' : thread.outcome === 'failed' && !thread.queued ? 'text-rust' : '')}>· {threadActivity(thread).label}</span></span>
            </button>}
        {/* The everyday actions, over the row's right edge on hover or focus — so a row never grows or
            reflows when the pointer crosses it. "…" holds the rest. Kept visible while its menu is
            open (`has-[[data-open]]`), or the menu would fold home into nothing. */}
        {renaming?.id !== thread.id && <div className="thread-row-actions absolute top-1 right-1 flex items-center gap-px rounded-md p-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 has-[[data-open]]:opacity-100">
          {stopped
            ? <RowAction label="Resume" onClick={() => void action(() => window.bimax.threads.start(thread.id))}><Play size={12}/></RowAction>
            : <RowAction label="Stop only this thread" onClick={() => void action(() => window.bimax.threads.stop(thread.id))}><Square size={11}/></RowAction>}
          <RowAction label="Rename" onClick={() => setRenaming({ id: thread.id, title: thread.title })}><Pencil size={12}/></RowAction>
          {stopped && <RowAction disabled={binPending} label="Move to the Bin" onClick={() => void binAction(() => window.bimax.threads.moveToBin(thread.id, false))}><Trash2 size={12}/></RowAction>}
          <SeedMenu
            label="More actions for this thread"
            width={248}
            motion="standard"
            triggerClassName="shrink-0 rounded-md"
            trigger={(open) => (
              <span data-open={open || undefined} title="More" className={cn('flex size-6 items-center justify-center rounded-md text-dim hover:bg-hover hover:text-ink', open && 'bg-hover text-ink')}>
                <MoreHorizontal size={13}/>
              </span>
            )}
          >
            {(close) => <>
              <SeedMenuLabel>Priority</SeedMenuLabel>
              {PRIORITIES.map(p => <SeedMenuItem key={p.id} selected={(thread.priority ?? 'normal') === p.id} label={p.label} desc={p.desc}
                onClick={() => { void action(() => window.bimax.threads.setPriority(thread.id, p.id)); close(); }}/>)}
              <SeedMenuSeparator/>
              {active && active.id !== thread.id && <SeedMenuItem icon={<Link2 size={13}/>} label={linked ? 'Unlink from the current thread' : 'Link to the current thread'}
                desc="Linked threads can send each other messages; each still changes only its own folder"
                onClick={() => { void action(() => window.bimax.threads.link(active.id, thread.id, !linked)); close(); }}/>}
              {linked && <SeedMenuItem label="Renew the link" onClick={() => { void action(() => window.bimax.threads.link(active!.id, thread.id, true)); close(); }}/>}
              <SeedMenuItem icon={<Download size={13}/>} label="Export…" desc="Markdown, PDF, or share" onClick={() => { window.bimax.threads.exportMenu(thread.id); close(); }}/>
              {thread.queued ? <SeedMenuItem label="Cancel queued messages" desc="The turn being worked on carries on"
                onClick={() => { void action(() => window.bimax.threads.cancelQueued(thread.id)); close(); }}/> : null}
              {thread.wakes?.length ? <SeedMenuItem label="Cancel wakes" desc="Stop waiting for the times, folders, CI results or answers it asked for"
                onClick={() => { void action(() => window.bimax.threads.cancelWakes(thread.id)); close(); }}/> : null}
              {stopped && <SeedMenuItem icon={<Archive size={13}/>} label="Archive" desc="Put it away; restore it from Archived"
                onClick={() => { void action(() => window.bimax.threads.archive(thread.id)); close(); }}/>}
            </>}
          </SeedMenu>
        </div>}
      </div>;
    })}
    {hidden > 0 && <button onClick={() => setExpanded(true)} className="w-full cursor-pointer rounded-lg px-2.5 py-1.5 text-left text-[11.5px] text-faint hover:bg-hover hover:text-dim focus-visible:outline-2 focus-visible:outline-ember">
      Show more ({hidden})
    </button>}
    {expanded && !query.trim() && quick.length > 5 && <button onClick={() => setExpanded(false)} className="w-full cursor-pointer rounded-lg px-2.5 py-1.5 text-left text-[11.5px] text-faint hover:bg-hover hover:text-dim focus-visible:outline-2 focus-visible:outline-ember">
      Show less
    </button>}
    {archivedCount > 0 && <button aria-expanded={showArchived} className="flex w-full cursor-pointer items-center gap-1.5 px-2.5 py-1 text-left text-[10.5px] text-dim" onClick={() => setShowArchived(v => !v)}>
      <Archive size={10}/>{showArchived ? 'Hide archived' : `Archived (${archivedCount})`}
    </button>}
    {showArchived && archivedCount > 0 && <div className="space-y-1">
      {words.length > 0 && archivedShown.length === 0 && <p className="px-2.5 py-1 text-[11px] text-faint">No archived thread matches.</p>}
      {archivedShown.map(thread => <div key={thread.id} className="group relative rounded-lg">
        <div className="px-2.5 py-1.5">
          <span className="flex gap-2 text-[12px] text-dim"><MessageSquare size={13} className="mt-0.5 shrink-0"/><span className="truncate">{thread.title}</span></span>
          <span className="mt-0.5 flex items-center gap-1 pl-5 text-[10.5px] text-faint"><Folder size={10}/><span title={thread.root} className="truncate">{folderName(thread.root)}</span></span>
        </div>
        <div className="thread-row-actions absolute top-1 right-1 flex items-center gap-px rounded-md p-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <RowAction label="Restore" onClick={() => void action(() => window.bimax.threads.unarchive(thread.id))}><RotateCcw size={12}/></RowAction>
          <RowAction disabled={binPending} label="Move to the Bin" onClick={() => void binAction(() => window.bimax.threads.moveToBin(thread.id, true))}><Trash2 size={12}/></RowAction>
        </div>
      </div>)}
    </div>}
    {binPending && <p role="status" className="px-2.5 py-1 text-[11px] text-dim">Updating conversation…</p>}
    {data.undoBin && <div role="status" className="flex items-center gap-2 px-2.5 py-1 text-[11px] text-dim">
      <span className="min-w-0 truncate" title={`Removed “${data.undoBin.title}”. Undo is available for five minutes for the five most recent removals. Project files stay as they are.`}>Removed “{data.undoBin.title}”</span>
      <button disabled={binPending} onClick={() => void binAction(() => window.bimax.threads.undoBin(data.undoBin!.id))} className="ml-auto min-h-[26px] shrink-0 cursor-pointer rounded-md px-1.5 text-ink hover:bg-hover disabled:cursor-default">Undo</button>
    </div>}
    {error && <p role="alert" className="px-2 text-xs text-rust">{error}</p>}
  </div>;
}

/** One icon action on a row. The label is its tooltip and its accessible name — an icon never stands alone. */
function RowAction({ label, onClick, children, disabled }: { label: string; onClick: () => void; children: React.ReactNode; disabled?: boolean }): React.ReactElement {
  return (
    <button type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick}
      className="flex size-6 cursor-pointer items-center justify-center rounded-md text-dim hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-ember">
      {children}
    </button>
  );
}
