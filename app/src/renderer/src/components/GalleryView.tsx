import React, { useEffect, useMemo, useState } from 'react';
import { Search, MessageSquare, ArrowLeft, FolderGit2 } from 'lucide-react';
import { cn } from '../lib/cn';
import type { SessionMetaRecord } from '../global';

/**
 * Sessions gallery — the Artifacts-style grid: every past session as a card with a searchable
 * header. Clicking a card resumes it (/resume <id>) and returns to the chat view. Data comes
 * from the engine's sessions-meta.jsonl, read natively by the main process. Right-clicking a card exports or shares
 * that session (backlog N4).
 */

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 30 * 86400) return `${Math.round(s / 86400)}d ago`;
  return `${Math.round(s / (30 * 86400))}mo ago`;
}

export function GalleryView({
  project, onResume, onBack,
}: {
  project: string;
  onResume: (id: string) => void;
  onBack: () => void;
}): React.ReactElement {
  const [meta, setMeta] = useState<SessionMetaRecord[]>([]);
  const [search, setSearch] = useState('');

  useEffect(() => {
    void window.bimax.sessionsMeta().then(setMeta).catch(() => setMeta([]));
  }, [project]);

  const q = search.trim().toLowerCase();
  const visible = useMemo(
    () => meta.filter((m) => !q || m.title.toLowerCase().includes(q) || m.id.includes(q)),
    [meta, q],
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[980px] px-6 pt-8 pb-10">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            title="Back to chat"
            className="flex size-8 cursor-pointer items-center justify-center rounded-lg border border-line text-dim transition-colors hover:bg-hover hover:text-ink"
          >
            <ArrowLeft size={15} />
          </button>
          <h1 className="text-[24px] font-semibold tracking-tight text-ink">Sessions</h1>
          <span className="mt-1 text-xs text-faint tabular-nums">{meta.length}</span>
        </div>

        <div className="mt-5 flex items-center gap-2.5 rounded-xl border border-line bg-raise px-3.5 py-2.5 transition-colors focus-within:border-ember/55">
          <Search size={15} className="shrink-0 text-faint" />
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search sessions…"
            className="min-w-0 flex-1 bg-transparent text-[13.5px] text-ink outline-none placeholder:text-faint"
          />
        </div>

        {visible.length === 0 ? (
          <div className="mt-16 flex flex-col items-center gap-2 text-center">
            <MessageSquare size={22} className="text-faint" />
            <div className="text-sm text-dim">{q ? `Nothing matches “${search}”.` : 'No sessions yet — they accrue as you work.'}</div>
          </div>
        ) : (
          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((m) => (
              <button
                key={m.id}
                onClick={() => onResume(m.id)}
                onContextMenu={(e) => { e.preventDefault(); window.bimax.sessionExportMenu(m.id); }}
                title={`Resume — injects this session's messages into the current context. Right-click to export or share it.`}
                className={cn(
                  'group flex cursor-pointer flex-col rounded-xl border border-line bg-raise/70 p-4 text-left',
                  'transition-colors duration-120 hover:bg-hover hover:border-ember/40',
                )}
              >
                <span className="line-clamp-2 min-h-[2.6em] text-[14px] leading-snug font-medium text-ink group-hover:text-ember-bright">
                  {m.title && m.title !== '(no messages yet)' ? m.title : 'Untitled session'}
                </span>
                <span className="mt-2 text-[10.5px] text-faint tabular-nums">{relTime(m.startedAt)}</span>
                <span className="mt-3 flex items-center gap-1.5 text-[10.5px] text-faint">
                  <FolderGit2 size={11} />
                  <span className="truncate">{m.cwd.split('/').slice(-2).join('/')}</span>
                  <span className="ml-auto shrink-0 tabular-nums">{m.messageCount} msgs</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
