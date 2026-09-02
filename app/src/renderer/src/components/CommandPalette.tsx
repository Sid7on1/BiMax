import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search, FolderOpen, GitCompareArrows, Files, SquareTerminal, Users, Map,
  BrainCircuit, Settings, SquarePen, Receipt, Globe, Activity, FlaskConical, HardDrive,
} from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import type { InspectorTabId } from '../inspector.model';
import type { WorkspaceSheetTab } from './WorkspaceSheet';
import { cn } from '../lib/cn';

interface PaletteAction {
  id: string;
  label: string;
  group: string;
  icon: React.ReactNode;
  run: () => void;
}

export function CommandPalette({
  open, onClose, onOpenInspector, onOpenTerminal, onOpenWorkspace, onOpenSettings, onNewTask, onOpenGallery,
}: {
  open: boolean;
  onClose: () => void;
  onOpenInspector: (tab: InspectorTabId) => void;
  onOpenTerminal: () => void;
  onOpenWorkspace: (tab: WorkspaceSheetTab) => void;
  onOpenSettings: () => void;
  onNewTask: () => void;
  onOpenGallery: () => void;
}): React.ReactElement {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // The palette is now the home for everything that stopped being permanent chrome. Each entry
  // names an outcome rather than a subsystem — no mode, driver or protocol vocabulary.
  const actions = useMemo<PaletteAction[]>(() => [
    { id: 'new', label: 'Start a new task', group: 'Task', icon: <SquarePen size={14} />, run: onNewTask },
    { id: 'project', label: 'Open another project', group: 'Project', icon: <FolderOpen size={14} />, run: () => { void window.bimax.pickFolder(); } },
    { id: 'review', label: 'Review changes', group: 'Evidence', icon: <GitCompareArrows size={14} />, run: () => onOpenInspector('review') },
    { id: 'github', label: 'GitHub — fetch, pull, push', group: 'Evidence', icon: <GitCompareArrows size={14} />, run: () => onOpenInspector('github') },
    { id: 'files', label: 'Browse files', group: 'Workspace', icon: <Files size={14} />, run: () => onOpenInspector('files') },
    { id: 'terminal', label: 'Open terminal', group: 'Workspace', icon: <SquareTerminal size={14} />, run: onOpenTerminal },
    { id: 'map', label: 'Explore code map', group: 'Workspace', icon: <Map size={14} />, run: () => onOpenWorkspace('map') },
    { id: 'memory', label: 'Open memory', group: 'Workspace', icon: <BrainCircuit size={14} />, run: () => onOpenWorkspace('memory') },
    { id: 'chats', label: 'Browse all chats', group: 'Task', icon: <Files size={14} />, run: onOpenGallery },
    { id: 'settings', label: 'Open settings', group: 'App', icon: <Settings size={14} />, run: onOpenSettings },
  ], [onNewTask, onOpenGallery, onOpenInspector, onOpenSettings, onOpenTerminal, onOpenWorkspace]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? actions.filter((action) => `${action.label} ${action.group}`.toLowerCase().includes(needle)) : actions;
  }, [actions, query]);

  useEffect(() => { setSelected(0); }, [query]);
  useEffect(() => {
    if (!open) return;
    setQuery('');
    const id = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(id);
  }, [open]);

  const execute = (action: PaletteAction | undefined): void => {
    if (!action) return;
    action.run();
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
      {/*
        `palette`, not a Tailwind offset. Prompt 2 §43/§45: a command palette is its own destination
        semantics — it sits high the way Spotlight does, and when it is opened from ⌘K there is no
        spatial seed to grow from and none may be invented. Naming the kind gets both; the previous
        `top-[18%]` positioned the box while the flight knew nothing about it.

        `materialize` rather than `seeded`, and that is the part §45 is actually about. The palette
        can also be opened by clicking a control, and the intent tracker would happily hand it that
        control as an origin — so the same surface would fly from the toolbar or appear in place
        depending on how it was summoned, which is a motion that reports the input device. It is
        kept on the driver (rather than made `standard`) for the two things only the driver gives
        it: `destinationFor`'s placement, and a live height target, so the sheet shrinks as the
        query filters the list instead of leaving a growing block of empty glass under the results.
      */}
      <DialogContent
        aria-describedby={undefined}
        motion="materialize"
        kind="palette"
        className="max-h-[64vh] w-[min(560px,calc(100vw-min(64px,40vw)))] p-0"
      >
        <DialogTitle className="sr-only">Search and open</DialogTitle>
        <div className="flex items-center gap-2 border-b border-line px-4 py-3.5">
          <Search size={16} className="shrink-0 text-faint" />
          <input
            ref={inputRef}
            value={query}
            placeholder="Search BiMAX…"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') { event.preventDefault(); setSelected((value) => Math.min(value + 1, filtered.length - 1)); }
              if (event.key === 'ArrowUp') { event.preventDefault(); setSelected((value) => Math.max(value - 1, 0)); }
              if (event.key === 'Enter') { event.preventDefault(); execute(filtered[selected]); }
            }}
            className="flex-1 border-none bg-transparent text-[14px] outline-none placeholder:text-faint"
          />
          <kbd className="rounded-md border border-line bg-well px-1.5 py-0.5 text-[9px] text-faint">esc</kbd>
        </div>
        <div className="max-h-[48vh] overflow-y-auto p-2">
          {filtered.map((action, index) => (
            <button
              key={action.id}
              onMouseEnter={() => setSelected(index)}
              onClick={() => execute(action)}
              className={cn('flex w-full cursor-pointer items-center gap-3 rounded-[9px] px-3 py-2.5 text-left text-[12.5px]', selected === index ? 'bg-selected text-ink' : 'text-dim')}
            >
              <span className={cn('text-faint', selected === index && 'text-ember')}>{action.icon}</span>
              <span className="flex-1">{action.label}</span>
              <span className="text-[10px] text-faint">{action.group}</span>
            </button>
          ))}
          {filtered.length === 0 && <div className="px-3 py-8 text-center text-xs text-faint">No matching actions.</div>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
