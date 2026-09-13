import React, { useEffect, useState } from 'react';
import { Link2, Square, Folder, MessageSquare } from 'lucide-react';
import { isQuickThread, type ThreadList } from '../../../shared/threads';

export function ThreadsList(): React.ReactElement {
  const [data,setData] = useState<ThreadList>({ activeId:null, threads:[], shortcutAvailable:true });
  const [error,setError] = useState('');
  useEffect(() => {
    const off = window.bimax.threads.onList(setData);
    void window.bimax.threads.list().then(setData);
    return off;
  },[]);
  const active = data.threads.find(t => t.id === data.activeId);
  // Projects opened from Recents run as threads too, but they are listed in Recents, not here.
  const shown = data.threads.filter(isQuickThread);
  async function action(run: () => Promise<unknown>) {
    try { setError(''); await run(); } catch(e) { setError(String((e as Error).message)); }
  }
  return <div className="space-y-1 pb-1">
    {shown.length === 0 && <p className="px-2.5 py-1.5 text-[12px] text-faint">No threads yet. Press ⌘2 anywhere to start one.</p>}
    {!data.shortcutAvailable && <p className="px-2 text-xs text-rust">⌘2 is in use by another app.</p>}
    {shown.map(thread => <div key={thread.id} className={`group rounded-lg ${thread.id === data.activeId ? 'bg-hover' : ''}`}>
      <button className="w-full cursor-pointer px-2 py-2 text-left" onClick={() => void action(() => window.bimax.threads.select(thread.id))}>
        <span className="flex gap-2 text-[12px] text-ink"><MessageSquare size={13} className="mt-0.5 shrink-0"/><span className="truncate">{thread.title}</span></span>
        <span className="mt-1 flex items-center gap-1 pl-5 text-[10px] text-faint"><Folder size={10}/><span title={thread.root} className="truncate">{thread.root.split('/').filter(Boolean).pop()}</span><span className={thread.status === 'needs-you' ? 'text-amber' : ''}>· {thread.status === 'needs-you' ? 'Needs you' : thread.status}</span></span>
      </button>
      <div className="flex gap-3 px-3 pb-1.5 text-[10px] text-dim">
        {thread.status === 'stopped' && <button className="cursor-pointer" onClick={() => void action(() => window.bimax.threads.start(thread.id))}>Resume</button>}
        {thread.status !== 'stopped' && <button title="Stop only this thread" className="flex cursor-pointer gap-1" onClick={() => void action(() => window.bimax.threads.stop(thread.id))}><Square size={10}/>Stop</button>}
        {active && active.id !== thread.id && <button className="flex cursor-pointer gap-1" onClick={() => void action(() => window.bimax.threads.link(active.id,thread.id,!active.peers.includes(thread.id)))}><Link2 size={11}/>{active.peers.includes(thread.id) ? 'Unlink' : 'Link to current'}</button>}
        {active?.peers.includes(thread.id) && <button className="cursor-pointer" onClick={() => void action(() => window.bimax.threads.link(active.id,thread.id,true))}>Renew</button>}
      </div>
    </div>)}
    {shown.length > 1 && <p className="px-2 py-1 text-[10px] text-faint">Link threads to let them exchange messages. Each keeps its own folder and permissions.</p>}
    {error && <p role="alert" className="px-2 text-xs text-rust">{error}</p>}
  </div>;
}
