import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowUp, Square, FunctionSquare, FileText, Shield, Cpu,
  ChevronUp, Sparkles, Pencil, Search, Hammer, Flame, Plus,
} from 'lucide-react';
import { CompletionItem, ControlsMsg, UiSnapshot } from '../protocol';
import { cn } from '../lib/cn';
import { Button } from './ui/button';
import { SeedMenu, SeedMenuItem, SeedMenuLabel, SeedMenuReadout, SeedMenuSeparator } from './ui/morph/SeedMenu';
import type { SupervisorStatus } from '../global';

/**
 * Code-only composer for the agentic IDE. The strip under the input contains project autonomy,
 * model routing, attachment, and live context controls; there is no host-computer lane.
 */

/**
 * The three control levels `04_FRONTEND_PLAN.md` names, and nothing else at this level.
 *
 * "Unrestricted" is deliberately NOT one of them. It used to sit here as an ordinary fourth choice,
 * one click from the default, with the description "Continue without approval gates" — a
 * normal-looking product option that removes every approval from an agent that can edit files and
 * operate the machine. It survives only inside Custom rules, where choosing it is a deliberate act.
 */
const CONTROL_LEVELS = [
  { id: 'ask', autonomy: 'ask', short: 'Ask me first', label: 'Ask before changes', desc: 'Every edit shows you a diff first' },
  { id: 'auto', autonomy: 'auto', short: 'Approve for me', label: 'Work automatically in this project', desc: 'Apply safe edits, ask before risky actions' },
  { id: 'custom', autonomy: null, short: 'Custom rules', label: 'Custom rules…', desc: 'Choose how Bimax works and what it may do unattended' },
] as const;

/**
 * Advanced only. `04_FRONTEND_PLAN.md`: "Internal names like general/explore/sketch/code/beast,
 * rollout modes, drivers, and fallback names do not belong in the default UI." These were the
 * primary workflow control; they are now behind Custom rules, where they are described by what they
 * do rather than by the engine's persona names.
 */
const ADVANCED_MODES = [
  { id: 'general', label: 'Balanced', icon: <Sparkles size={13} />, desc: 'Understand, decide, and build' },
  { id: 'explore', label: 'Research only', icon: <Search size={13} />, desc: 'Study the project without changing it' },
  { id: 'sketch', label: 'Plan first', icon: <Pencil size={13} />, desc: 'Design the approach before editing' },
  { id: 'code', label: 'Build and verify', icon: <Hammer size={13} />, desc: 'Focus on implementation and its checks' },
  { id: 'beast', label: 'Parallel team', icon: <Flame size={13} />, desc: 'Coordinate parallel work on a larger goal' },
];

const ADVANCED_AUTONOMY = [
  { id: 'plan', label: 'Read-only', desc: 'Research and propose; never write' },
  { id: 'full', label: 'Unattended', desc: 'No approval gates. Only for work you are supervising.' },
];

const TIERS = [
  { id: 'auto', short: 'Auto', label: 'Auto tier', desc: 'Router picks lite/heavy per turn' },
  { id: 'lite', short: 'Low', label: 'Lite tier', desc: 'Fast + cheap, pinned' },
  { id: 'heavy', short: 'High', label: 'Heavy tier', desc: 'Strongest model, pinned' },
];

export function Composer({
  busy, mode, tier, snapshot, streamedChars, completions, project, branch,
  onSubmit, onInterrupt, onControls, onCommand, onQuery, onClearCompletions, onOpenModels, runtime,
}: {
  busy: boolean;
  mode: string;
  tier: string;
  /** Absolute path of the open project — only its last segment is shown. */
  project: string;
  branch: string | null;
  snapshot: UiSnapshot | null;
  streamedChars: number;
  completions: CompletionItem[];
  onSubmit: (text: string) => void;
  onInterrupt: () => void;
  onControls: (controls: Omit<ControlsMsg, 't'>) => void;
  onCommand: (cmd: string) => void;
  onQuery: (text: string) => void;
  onClearCompletions: () => void;
  /** Opens the model window. Configuration never goes through the transcript. */
  onOpenModels: () => void;
  runtime: SupervisorStatus | null;
}): React.ReactElement {
  const [text, setText] = useState('');
  const [queued, setQueued] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const [permission, setPermission] = useState('auto');
  const taRef = useRef<HTMLTextAreaElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const historyRef = useRef<string[]>([]);
  const histIdxRef = useRef(-1);

  const visibleCompletions = completions.filter((item) => item.kind !== 'command');
  const showDropdown = visibleCompletions.length > 0 && text.trim().length > 0;
  const modeId = (mode || '').toLowerCase() === 'plan' ? 'general' : (mode || '').toLowerCase() || 'general';
  const activeMode = ADVANCED_MODES.find((m) => m.id === modeId) ?? ADVANCED_MODES[0];
  const readOnlyMode = ['PLAN', 'EXPLORE', 'SKETCH'].includes((mode || '').toUpperCase());
  const activeLevel = CONTROL_LEVELS.find((level) => level.id === permission) ?? CONTROL_LEVELS[1];
  const activeTier = TIERS.find((t) => t.id === (tier || 'auto')) ?? TIERS[0];

  const ctxPct = snapshot && snapshot.contextWindow > 0
    ? Math.min(100, Math.round(((snapshot.tokensBaseline + streamedChars / 4) / snapshot.contextWindow) * 100))
    : null;
  const available = runtime?.phase === 'ready' || runtime?.phase === 'degraded';

  // Let the first instruction feel instant even while a newly opened project finishes loading.
  // The user never has to wait for or understand the background runtime lifecycle.
  useEffect(() => {
    if (!available || !queued) return;
    onSubmit(queued);
    setQueued(null);
  }, [available, queued, onSubmit]);

  useEffect(() => { setSel(0); }, [completions]);

  // Files panel "@" button (and anything else in the shell) can inject text into the composer.
  useEffect(() => {
    const h = (e: Event): void => {
      const detail = String((e as CustomEvent).detail ?? '');
      if (!detail) return;
      setText((t) => (t ? `${t.replace(/\s+$/, '')} ${detail}` : detail));
      taRef.current?.focus();
    };
    window.addEventListener('bimax:compose-insert', h);
    return () => window.removeEventListener('bimax:compose-insert', h);
  }, []);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  }, [text]);

  const change = (v: string): void => {
    setText(v);
    histIdxRef.current = -1;
    clearTimeout(debounceRef.current);
    if (v.includes('@')) {
      debounceRef.current = setTimeout(() => onQuery(v), 120);
    } else if (completions.length) {
      onClearCompletions();
    }
  };

  const submit = (): void => {
    if (!text.trim() || busy || queued) return;
    historyRef.current.push(text);
    histIdxRef.current = -1;
    if (!available) {
      setQueued(text);
      setText('');
      return;
    }
    onSubmit(text);
    setText('');
  };

  const accept = (item: CompletionItem): void => {
    if (item.disabled) return;
    const at = text.lastIndexOf('@');
    setText(at === -1 ? item.value : text.slice(0, at) + item.value);
    onClearCompletions();
    taRef.current?.focus();
  };

  /**
   * Add file paths to the prompt as `@` references.
   *
   * `@path` is the Composer's front door: the engine expands it, and a document format or an
   * oversized file is ingested into the searchable corpus instead of being pasted into the prompt.
   * So attaching and dropping are the same gesture, and neither needs to know about RAG.
   */
  const addPaths = (paths: string[]): void => {
    const usable = paths.filter(Boolean);
    if (!usable.length) return;
    const refs = usable.map((p) => `@${p}`).join(' ');
    setText((t) => (t ? `${t.replace(/\s+$/, '')} ${refs} ` : `${refs} `));
    taRef.current?.focus();
  };

  const attach = (): void => {
    void window.bimax.pickFiles().then(addPaths);
  };

  /**
   * Drag-and-drop.
   *
   * `depth` rather than a boolean: dragenter/dragleave fire for every child element the pointer
   * crosses, so a boolean flickers the highlight off as soon as the cursor moves over the textarea
   * inside the drop zone. Counting enter/leave pairs is what makes the affordance stable.
   */
  const [dropDepth, setDropDepth] = useState(0);

  const onDragOver = (e: React.DragEvent): void => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onDragEnter = (e: React.DragEvent): void => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    setDropDepth((d) => d + 1);
  };
  const onDragLeave = (): void => setDropDepth((d) => Math.max(0, d - 1));
  const onDrop = (e: React.DragEvent): void => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    setDropDepth(0);
    // Electron 32 removed `File.path`; `webUtils.getPathForFile` in the preload is the replacement.
    // Files with no resolvable path (a drag from a browser, say) are dropped rather than passed on
    // as empty strings, which would become a meaningless `@` reference.
    addPaths(Array.from(e.dataTransfer.files).map((file) => window.bimax.pathForFile(file)));
  };

  const keyDown = (e: React.KeyboardEvent): void => {
    if (showDropdown) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, visibleCompletions.length - 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.metaKey)) {
        e.preventDefault();
        accept(visibleCompletions[sel]);
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); onClearCompletions(); return; }
    }
    // ↑/↓ recall past prompts when the input is empty or already navigating history.
    const hist = historyRef.current;
    if (e.key === 'ArrowUp' && hist.length && (text === '' || histIdxRef.current !== -1)) {
      e.preventDefault();
      histIdxRef.current = histIdxRef.current === -1 ? hist.length - 1 : Math.max(0, histIdxRef.current - 1);
      setText(hist[histIdxRef.current]);
      return;
    }
    if (e.key === 'ArrowDown' && histIdxRef.current !== -1) {
      e.preventDefault();
      histIdxRef.current = histIdxRef.current >= hist.length - 1 ? -1 : histIdxRef.current + 1;
      setText(histIdxRef.current === -1 ? '' : hist[histIdxRef.current]);
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || (!e.shiftKey && !showDropdown))) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === 'Escape' && busy) {
      e.preventDefault();
      onInterrupt();
    }
  };

  return (
    <div className="relative shrink-0 px-4 pt-1 pb-4">
      {showDropdown && (
        <div className="absolute bottom-full left-1/2 z-20 mb-1 w-[min(860px,calc(100%-48px))] -translate-x-1/2 overflow-hidden rounded-[10px] border border-line bg-raise shadow-[0_12px_32px_rgba(0,0,0,0.45)]">
          {visibleCompletions.slice(0, 8).map((c, i) => (
            <button
              key={c.value + i}
              onMouseEnter={() => setSel(i)}
              onClick={() => accept(c)}
              className={cn(
                'flex w-full cursor-pointer items-baseline gap-2.5 px-3 py-[7px] text-left text-[12.5px]',
                i === sel && 'bg-ember/15',
                c.disabled && 'opacity-40',
              )}
            >
              <span className="w-4 shrink-0 text-ember">
                {c.kind === 'symbol' ? <FunctionSquare size={13} /> : <FileText size={13} />}
              </span>
              <span className="font-mono">{c.label}</span>
              <span className="truncate text-faint">{c.disabled ? c.disabledReason || c.desc : c.desc}</span>
            </button>
          ))}
        </div>
      )}

      <div className="composer-column mx-auto">
      <div
        onDragOver={onDragOver}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cn(
          'launch-console relative rounded-[22px] border bg-raise shadow-[0_18px_50px_rgba(0,0,0,0.12)] transition-[border-color,box-shadow] focus-within:border-ember/45 focus-within:shadow-[0_20px_56px_rgba(0,0,0,0.16)]',
          dropDepth > 0 ? 'border-ember/70 shadow-[0_20px_56px_rgba(0,0,0,0.16)]' : 'border-line',
        )}
      >
        {/*
          * The corpus readout. Two jobs: tell the user what the agent is actually working from, and
          * — the important one — surface what could NOT be read. Silence about a failed attachment
          * is the worst outcome available: the user believes the file was read and acts on an answer
          * that never saw it.
          */}
        {snapshot?.composer && (snapshot.composer.session + snapshot.composer.library) > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 pt-2 text-[11px] text-faint">
            <span className="inline-flex items-center gap-1.5">
              <FileText size={11} />
              {snapshot.composer.session + snapshot.composer.library} document
              {snapshot.composer.session + snapshot.composer.library === 1 ? '' : 's'}
              {' · '}
              {snapshot.composer.passages} passage{snapshot.composer.passages === 1 ? '' : 's'}
              {snapshot.composer.facts > 0 && ` · ${snapshot.composer.facts} measurement${snapshot.composer.facts === 1 ? '' : 's'}`}
            </span>
            {snapshot.composer.library > 0 && (
              <span className="text-faint/80">{snapshot.composer.library} in library</span>
            )}
            {!!snapshot.composer.lastIngest?.skipped.length && (
              <span
                className="text-ember"
                title={snapshot.composer.lastIngest.skipped
                  .map((skip) => `${skip.name} — ${skip.reason}`)
                  .join('\n')}
              >
                {snapshot.composer.lastIngest.skipped.length} could not be read
              </span>
            )}
          </div>
        )}

        {dropDepth > 0 && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[22px] bg-raise/85 backdrop-blur-[1px]"
          >
            <span className="flex items-center gap-2 font-display text-[13px] text-ember">
              <FileText size={14} />
              Drop to read — PDFs, scans, Office files, anything text
            </span>
          </div>
        )}
        <div className="flex items-end gap-3 px-5 pt-4 pb-3">
          <textarea
            ref={taRef}
            rows={1}
            value={text}
            aria-label="Describe what you want Bimax to do"
            data-bimax-composer=""
            placeholder={busy ? 'Add direction while Bimax works…' : queued ? 'Your task will start in a moment…' : 'Do anything'}
            onChange={(e) => change(e.target.value)}
            onKeyDown={keyDown}
            className="max-h-[220px] min-h-12 flex-1 resize-none border-none bg-transparent font-display text-[15px] leading-relaxed outline-none placeholder:text-faint"
          />
        </div>

        <div className="flex min-w-0 items-center gap-1.5 px-3 pb-3">
          <button
            type="button"
            title="Attach files as @references"
            onClick={attach}
            className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full border border-line text-dim transition-colors hover:border-ember/50 hover:bg-hover hover:text-ink"
          >
            <Plus size={16} />
          </button>

          {/* Widest of the strip's menus: in `custom` it grows three sections deep, and `fitHeight`
              means the surface is exactly as tall as whichever shape it is in rather than sized for
              its largest one. */}
          <SeedMenu
            label="Permission level"
            width={300}
            trigger={(open) => <ComposerPill open={open} icon={<Shield size={13} />} label={activeLevel.short} title={activeLevel.label} />}
          >
            {(close) => (
              <>
                {CONTROL_LEVELS.map((level) => (
                  <SeedMenuItem
                    key={level.id}
                    selected={level.id === activeLevel.id}
                    label={level.label}
                    desc={level.desc}
                    onClick={() => {
                      if (level.autonomy) onControls({ autonomy: level.autonomy as ControlsMsg['autonomy'] });
                      setPermission(level.id);
                      close();
                    }}
                  />
                ))}
                {permission === 'custom' && (
                  <>
                    <SeedMenuSeparator />
                    <SeedMenuLabel>How Bimax works</SeedMenuLabel>
                    {ADVANCED_MODES.map((m) => (
                      <SeedMenuItem
                        key={m.id}
                        icon={m.icon}
                        selected={m.id === activeMode.id}
                        label={m.label}
                        desc={m.desc}
                        onClick={() => { onControls({ mode: m.id as ControlsMsg['mode'] }); close(); }}
                      />
                    ))}
                    <SeedMenuSeparator />
                    <SeedMenuLabel>Approvals</SeedMenuLabel>
                    {ADVANCED_AUTONOMY.map((option) => (
                      <SeedMenuItem
                        key={option.id}
                        selected={readOnlyMode && option.id === 'plan'}
                        label={option.label}
                        desc={option.desc}
                        onClick={() => { onControls({ autonomy: option.id as ControlsMsg['autonomy'] }); close(); }}
                      />
                    ))}
                  </>
                )}
              </>
            )}
          </SeedMenu>

          <span className="flex-1" />

          {/* Context only speaks up once it is worth knowing. A meter pinned at 8% all day is
              furniture; one that appears at 60% is a warning. */}
          {ctxPct !== null && ctxPct >= 60 && (
            <span
              className={cn('shrink-0 font-mono text-[10px] tabular-nums', ctxPct >= 85 ? 'text-rust' : 'text-amber')}
              title={`Context ~${ctxPct}% of ${snapshot!.contextWindow.toLocaleString()} tokens`}
            >
              {ctxPct}% context
            </span>
          )}

          {/*
            The first surface on Seed Morph v2 (docs/motion/SEED_MORPH_BRIEF.md, Prompt 2 §72): the
            pill physically becomes the menu and folds back into it.

            It also stopped being a one-item menu. "Change model…" alone made the pill a button
            wearing a chevron: the label already showed the work model, so the only thing the menu
            could tell you was that a window existed. Naming both loaded slots means the common
            question — *what is actually running right now?* — is answered by the control that
            claims to show it, and the window is one row further on for the case that needs it.
          */}
          <SeedMenu
            label="Model"
            width={280}
            trigger={(open) => <ComposerPill open={open} icon={<Cpu size={13} />} label={shortModel(snapshot?.models.coding)} mono />}
          >
            {(close) => (
              <>
                <SeedMenuLabel>Loaded</SeedMenuLabel>
                {/* Readouts, not disabled controls: the engine picks between these per turn, so
                    there is nothing to choose — but "which model is actually loaded" is the whole
                    reason to open this menu, and a disabled style would draw the answer faintest. */}
                <SeedMenuReadout label="Work" value={snapshot?.models.coding ?? 'not reported'} />
                <SeedMenuReadout label="Quick" value={snapshot?.models.lite ?? 'not reported'} />
                <SeedMenuSeparator />
                <SeedMenuItem
                  label="Change model…"
                  desc="Slots, reasoning effort and what the engine actually kept"
                  onClick={() => { onOpenModels(); close(); }}
                />
              </>
            )}
          </SeedMenu>

          <SeedMenu
            label="Model quality"
            trigger={(open) => <ComposerPill open={open} label={activeTier.short} title={activeTier.desc} />}
          >
            {(close) => (
              <>
                <SeedMenuLabel>Model quality</SeedMenuLabel>
                {TIERS.map((t) => (
                  <SeedMenuItem key={t.id} selected={(tier || 'auto') === t.id} label={t.label} desc={t.desc} onClick={() => { onControls({ tier: t.id as ControlsMsg['tier'] }); close(); }} />
                ))}
              </>
            )}
          </SeedMenu>
          {queued && (
            <span className="hidden items-center gap-1.5 text-[10px] text-dim sm:flex">
              <span className="signal-beacon size-1.5 rounded-full bg-amber" /> Starting your task…
            </span>
          )}

          {busy ? (
            <Button variant="accent" size="icon" className="ml-1 size-9 rounded-full" title="Stop" onClick={onInterrupt}>
              <Square size={11} fill="currentColor" className="rounded-[2px]" />
            </Button>
          ) : (
            <Button variant="accent" size="icon" className="ml-1 size-9 rounded-full shadow-[0_6px_16px_rgba(0,0,0,0.18)]" title="Send (Enter)" disabled={!text.trim() || !!queued} onClick={submit}>
              <ArrowUp size={16} />
            </Button>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}

/**
 * The composer strip's control shape — and, since the model menu became a Seed Morph, the shape a
 * surface has to grow out of.
 *
 * Exported so the Motion Lab can seed a real morph from the real control rather than from a copy of
 * its classes: the seed's corner radius and box are measured off this element, so a harness that
 * reproduced the markup would be verifying its own reproduction.
 */
export function ComposerPill({
  open, icon, label, mono = false, tone = 'default', title, testId,
}: {
  open: boolean;
  icon?: React.ReactNode;
  label: string;
  mono?: boolean;
  tone?: 'default' | 'mac';
  title?: string;
  testId?: string;
}): React.ReactElement {
  return (
    <span
      title={title}
      data-bimax-pill={testId}
      className={cn(
        'flex max-w-[190px] items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-[10.5px] transition-colors',
        open ? 'bg-ember/12 text-ember'
          : tone === 'mac' ? 'bg-amber/10 text-amber' : 'text-dim hover:bg-hover hover:text-ink',
      )}
    >
      {icon ? <span className={open ? 'text-ember' : 'text-faint'}>{icon}</span> : null}
      <span className={cn('truncate', mono && 'font-mono text-[9.5px]')}>{label}</span>
      <ChevronUp size={9} className={cn('shrink-0 text-faint transition-transform', open && 'rotate-180')} />
    </span>
  );
}

function shortModel(id?: string): string {
  if (!id) return 'model';
  const tail = id.split('/').pop() || id;
  return tail.length > 22 ? tail.slice(0, 21) + '…' : tail;
}
