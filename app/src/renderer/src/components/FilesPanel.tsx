import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AtSign, ChevronDown, ChevronRight, Database, RefreshCw, Search, X } from 'lucide-react';
import { cn } from '../lib/cn';
import { DirIcon, FileIcon } from './FileIcon';

/**
 * The project explorer.
 *
 * Three things separate this from the list it replaced.
 *
 * *Directories sort above files.* The main process returns whatever readdir gives it, which
 * interleaves them; a tree where `src/` sits between two dotfiles cannot be scanned, only read.
 *
 * *Filtering searches the PROJECT, not the expanded rows.* Matching only what happens to be open
 * would answer "no results" for a file that plainly exists, which teaches the reader to distrust
 * the box. The walk is in main (`files:search`), bounded, and says when it truncated rather than
 * quietly returning a short list.
 *
 * *The open file is marked.* Without it, clicking a file changes a pane somewhere else and leaves
 * no trace of where you are.
 */

export function insertIntoComposer(text: string): void {
  window.dispatchEvent(new CustomEvent('bimax:compose-insert', { detail: text }));
}

interface DirState { entries: { name: string; dir: boolean }[]; open: boolean }
interface Hit { rel: string; name: string; dir: boolean }

/**
 * Hidden by default: every dot-directory at the project root.
 *
 * This used to be a hardcoded allowlist — `.agents`, `.bimax`, `.breakglass`, `.breakglass_graph` —
 * which meant any tool that created a new dot-directory appeared in the explorer as though it were
 * source. Observed exactly that: a `.bimax-toolcheck` directory sat between `.bimax` and
 * `.breakglass` because nobody had added it to the list. An allowlist of things to hide is the
 * wrong shape; the property is "starts with a dot", which needs no maintenance.
 *
 * Dotfiles at the root stay VISIBLE — `.gitignore`, `.env.example` and `.prettierrc` are files you
 * edit. It is the machine-owned directories that bury the project.
 */
function isHiddenRoot(name: string, dir: boolean): boolean {
  return dir && name.startsWith('.');
}

/** Directories first, then case-insensitive by name — the order the eye expects to scan. */
function ordered(entries: { name: string; dir: boolean }[]): { name: string; dir: boolean }[] {
  return [...entries].sort((a, b) =>
    Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

export function FilesPanel({
  project, onOpenFile, activeFile,
}: {
  project: string;
  onOpenFile: (rel: string) => void;
  activeFile?: string | null;
}): React.ReactElement {
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [showGenerated, setShowGenerated] = useState(false);
  const [filter, setFilter] = useState('');
  const [hits, setHits] = useState<{ list: Hit[]; truncated: boolean } | null>(null);
  const [searching, setSearching] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);

  const loadDir = useCallback((rel: string, open = true) => {
    void window.bimax.files.list(rel)
      .then((entries) => setDirs((d) => ({ ...d, [rel]: { entries, open } })))
      .catch(() => setDirs((d) => ({ ...d, [rel]: { entries: [], open } })));
  }, []);

  useEffect(() => {
    setDirs({});
    setFilter('');
    if (!project) return;
    loadDir('');
    const off = window.bimax.files.onChanged(() => {
      setDirs((d) => {
        for (const rel of Object.keys(d)) if (d[rel].open) loadDir(rel, true);
        return d;
      });
    });
    return off;
  }, [project, loadDir]);

  // Debounced: the search walks the tree, so it must not run on every keystroke.
  useEffect(() => {
    const q = filter.trim();
    if (!q) { setHits(null); setSearching(false); return; }
    setSearching(true);
    const t = setTimeout(() => {
      void window.bimax.files.search(q)
        .then((r) => setHits({ list: r.hits, truncated: r.truncated }))
        .catch(() => setHits({ list: [], truncated: false }))
        .finally(() => setSearching(false));
    }, 180);
    return () => clearTimeout(t);
  }, [filter]);

  const root = dirs[''];
  const generatedCount = root?.entries.filter((e) => isHiddenRoot(e.name, e.dir)).length ?? 0;
  const visibleDirs = useMemo(() => {
    if (!root) return dirs;
    const filtered = showGenerated ? root.entries : root.entries.filter((e) => !isHiddenRoot(e.name, e.dir));
    return { ...dirs, '': { ...root, entries: filtered } };
  }, [dirs, root, showGenerated]);

  return (
    <div className="flex h-full flex-col">
      {/* --- Filter ------------------------------------------------------------------------- */}
      <div className="mb-2 flex shrink-0 items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          <Search size={12} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-faint" />
          <input
            ref={filterRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { setFilter(''); e.currentTarget.blur(); } }}
            placeholder="Filter files…"
            aria-label="Filter files"
            spellCheck={false}
            className="w-full rounded-lg border border-line bg-raise/70 py-1 pr-6 pl-6.5 text-[11.5px] text-ink placeholder:text-faint focus:border-ember/50 focus:outline-none"
          />
          {filter && (
            <button
              onClick={() => { setFilter(''); filterRef.current?.focus(); }}
              aria-label="Clear filter"
              className="absolute top-1/2 right-1.5 -translate-y-1/2 cursor-pointer rounded p-0.5 text-faint hover:text-ink"
            >
              <X size={11} />
            </button>
          )}
        </div>
        {generatedCount > 0 && !filter && (
          <button
            onClick={() => setShowGenerated((v) => !v)}
            aria-pressed={showGenerated}
            title={showGenerated
              ? `Hide ${generatedCount} hidden folder${generatedCount === 1 ? '' : 's'}`
              : `Show ${generatedCount} hidden folder${generatedCount === 1 ? '' : 's'}`}
            className={cn(
              'flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-[10px]',
              showGenerated ? 'bg-ember/10 text-ember' : 'text-faint hover:bg-hover hover:text-ink',
            )}
          >
            <Database size={11} />{generatedCount}
          </button>
        )}
        <button
          onClick={() => loadDir('')}
          title="Refresh"
          aria-label="Refresh the file tree"
          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-dim hover:bg-hover hover:text-ink"
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {/* --- Tree, or filter results -------------------------------------------------------- */}
      <div className="quiet-scrollbar min-h-0 flex-1 overflow-y-auto">
        {filter ? (
          !hits ? (
            <div className="px-1.5 py-2 text-[11.5px] text-faint">{searching ? 'Searching…' : ''}</div>
          ) : hits.list.length === 0 ? (
            <div className="px-1.5 py-2 text-[11.5px] text-faint">No file matches “{filter}”.</div>
          ) : (
            <>
              {hits.list.map((hit) => (
                <Row
                  key={hit.rel}
                  name={hit.name}
                  sub={hit.rel.includes('/') ? hit.rel.slice(0, hit.rel.lastIndexOf('/')) : ''}
                  dir={hit.dir}
                  depth={0}
                  active={activeFile === hit.rel}
                  onClick={() => (hit.dir ? undefined : onOpenFile(hit.rel))}
                  rel={hit.rel}
                />
              ))}
              {hits.truncated && (
                <div className="px-1.5 py-1.5 text-[10px] text-faint">
                  Showing the first {hits.list.length}. Narrow the filter to see the rest.
                </div>
              )}
            </>
          )
        ) : !root ? (
          <div className="px-1.5 py-2 text-[11.5px] text-faint">Loading…</div>
        ) : root.entries.length === 0 ? (
          <div className="px-1.5 py-2 text-[11.5px] text-faint">Empty project.</div>
        ) : (
          <Tree
            rel=""
            dirs={visibleDirs}
            depth={0}
            activeFile={activeFile ?? null}
            onToggle={(r, open) => {
              if (open && !dirs[r]) loadDir(r);
              else setDirs((d) => (d[r] ? { ...d, [r]: { ...d[r], open } } : d));
            }}
            onSelect={onOpenFile}
          />
        )}
      </div>
    </div>
  );
}

function Row({
  name, sub, dir, depth, active, open, onClick, rel,
}: {
  name: string;
  sub?: string;
  dir: boolean;
  depth: number;
  active: boolean;
  open?: boolean;
  onClick: () => void;
  rel: string;
}): React.ReactElement {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter') onClick(); }}
      data-active={active || undefined}
      title={dir ? rel : `${rel} — open in editor`}
      style={{ paddingLeft: `${6 + depth * 13}px` }}
      className={cn(
        'group flex w-full cursor-pointer items-center gap-1.5 rounded-md py-[3px] pr-1.5 text-left text-[11.5px] text-dim',
        'hover:bg-hover hover:text-ink data-[active]:bg-selected data-[active]:text-ink',
      )}
    >
      {dir ? (
        <>
          {open ? <ChevronDown size={11} className="shrink-0 text-faint" /> : <ChevronRight size={11} className="shrink-0 text-faint" />}
          <DirIcon open={!!open} name={name} />
        </>
      ) : (
        <>
          <span className="w-[11px] shrink-0" />
          <FileIcon name={name} />
        </>
      )}
      <span className="min-w-0 truncate">{name}</span>
      {sub ? <span className="ml-1 min-w-0 shrink truncate text-[10px] text-faint">{sub}</span> : null}
      {!dir && (
        <button
          onClick={(e) => { e.stopPropagation(); insertIntoComposer(`@${rel} `); }}
          title="Insert @path into the composer"
          aria-label={`Insert @${rel} into the composer`}
          className="ml-auto hidden size-5 shrink-0 cursor-pointer items-center justify-center rounded text-faint group-hover:flex hover:bg-line hover:text-ink"
        >
          <AtSign size={11} />
        </button>
      )}
    </div>
  );
}

function Tree({
  rel, dirs, depth, onToggle, onSelect, activeFile,
}: {
  rel: string;
  dirs: Record<string, DirState>;
  depth: number;
  onToggle: (rel: string, open: boolean) => void;
  onSelect: (rel: string) => void;
  activeFile: string | null;
}): React.ReactElement | null {
  const state = dirs[rel];
  if (!state) return null;
  return (
    <>
      {ordered(state.entries).map((e) => {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        const open = dirs[childRel]?.open ?? false;
        return (
          <React.Fragment key={childRel}>
            <Row
              name={e.name}
              dir={e.dir}
              depth={depth}
              open={open}
              active={!e.dir && activeFile === childRel}
              rel={childRel}
              onClick={() => (e.dir ? onToggle(childRel, !open) : onSelect(childRel))}
            />
            {e.dir && open && (
              <Tree rel={childRel} dirs={dirs} depth={depth + 1} onToggle={onToggle} onSelect={onSelect} activeFile={activeFile} />
            )}
          </React.Fragment>
        );
      })}
    </>
  );
}
