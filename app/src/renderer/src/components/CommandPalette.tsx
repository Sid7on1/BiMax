import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, FolderOpen, GitCompareArrows, SquareTerminal, Settings, SquarePen, PanelsTopLeft, Sun, Files } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { paletteEntries, movePaletteSelection, firstPaletteSelection, type PaletteCommand, type PaletteEntry, type PaletteAvailability } from '../palette.model';
import { cn } from '../lib/cn';

const GROUP_ICONS = { Task: SquarePen, Project: FolderOpen, Evidence: GitCompareArrows, Workspace: SquareTerminal,
  App: Settings, Layout: PanelsTopLeft, Appearance: Sun, Editor: Files };

export function CommandPalette({ open, onClose, onCommand, available }: {
  open: boolean;
  onClose: () => void;
  onCommand: (command: PaletteCommand) => void;
  available: PaletteAvailability;
}): React.ReactElement {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const executing = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const filtered = useMemo(() => paletteEntries(query, available), [query, available.busy, available.editor, available.files]);

  useEffect(() => { setSelected(firstPaletteSelection(filtered)); }, [filtered]);
  useEffect(() => {
    if (!open) return;
    executing.current = false;
    setQuery('');
  }, [open]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected, filtered, open]);

  const execute = (action: PaletteEntry | undefined): void => {
    if (!action || action.disabled) return;
    executing.current = true;
    onClose();
    onCommand(action.id);
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
        onOpenAutoFocus={(event) => { event.preventDefault(); inputRef.current?.focus(); }}
        onCloseAutoFocus={(event) => { if (executing.current) event.preventDefault(); }}
        motion="materialize"
        kind="palette"
        className="max-h-[64vh] w-[min(560px,calc(100vw-min(64px,40vw)))] p-0"
      >
        <DialogTitle className="sr-only">Search and open</DialogTitle>
        <div className="flex items-center gap-2 border-b border-line px-4 py-3.5">
          <Search size={16} className="shrink-0 text-faint" />
          <input
            ref={inputRef}
            role="combobox"
            aria-label="Search commands"
            aria-controls="bimax-command-results"
            aria-expanded={open}
            aria-autocomplete="list"
            aria-activedescendant={filtered[selected] && !filtered[selected].disabled ? `command-${filtered[selected].id}` : undefined}
            value={query}
            placeholder="Search BiMAX…"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') { event.preventDefault(); setSelected((value) => movePaletteSelection(filtered, value, 1)); }
              if (event.key === 'ArrowUp') { event.preventDefault(); setSelected((value) => movePaletteSelection(filtered, value, -1)); }
              if (event.key === 'Enter') { event.preventDefault(); execute(filtered[selected]); }
            }}
            className="flex-1 border-none bg-transparent text-[14px] outline-none placeholder:text-faint"
          />
          <kbd className="rounded-md border border-line bg-well px-1.5 py-0.5 text-[9px] text-faint">esc</kbd>
        </div>
        <div ref={listRef} id="bimax-command-results" role="listbox" aria-label="Commands" className="max-h-[48vh] overflow-y-auto p-2">
          {filtered.map((action, index) => (
            <button
              key={action.id}
              id={`command-${action.id}`}
              role="option"
              aria-selected={selected === index && !action.disabled}
              disabled={action.disabled}
              tabIndex={-1}
              onMouseEnter={() => { if (!action.disabled) setSelected(index); }}
              onClick={() => execute(action)}
              className={cn('flex w-full cursor-pointer disabled:cursor-default disabled:opacity-45 items-center gap-3 rounded-[9px] px-3 py-2.5 text-left text-[12.5px]', selected === index ? 'bg-selected text-ink' : 'text-dim')}
            >
              <span className={cn('text-faint', selected === index && 'text-ember')}>{React.createElement(GROUP_ICONS[action.group as keyof typeof GROUP_ICONS], { size: 14 })}</span>
              <span className="flex-1">{action.label}</span>
              <span className="text-[10px] text-faint">{action.shortcut ?? (action.disabled ? 'Unavailable now' : action.group)}</span>
            </button>
          ))}
          {filtered.length === 0 && <div className="px-3 py-8 text-center text-xs text-faint">No matching actions.</div>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
