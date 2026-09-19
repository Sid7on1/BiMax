import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, Bot, BrainCircuit, ChevronDown, Cpu, ExternalLink, FlaskConical, Globe2,
  KeyRound, Search, Settings2, Shield, TerminalSquare, X,
} from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { cn } from '../lib/cn';
import type { EngineConfig } from '../protocol';
import type { InspectorTabId } from '../inspector.model';
import type { Phase9View } from '../usePhase9';

type Control =
  | { kind: 'toggle' }
  | { kind: 'select'; options: { value: string; label: string }[] }
  | { kind: 'number'; min?: number; max?: number; step?: number; placeholder?: string }
  | { kind: 'text'; placeholder?: string };

interface Item { key: keyof EngineConfig; label: string; desc: string; control: Control }
type PageId = 'general' | 'providers' | 'environment' | 'alchemist' | 'autonomy' | 'safety';
interface Page { id: PageId; label: string; icon: React.ReactNode; subtitle: string; items: Item[] }

const PAGES: Page[] = [
  {
    id: 'general', label: 'General', icon: <Settings2 size={15} />, subtitle: 'Interface, notifications and project behavior',
    items: [
      { key: 'notificationBell', label: 'Notification bell', desc: 'Play a sound when a turn finishes while Bimax is in the background.', control: { kind: 'toggle' } },
      { key: 'autoIndex', label: 'Build code maps automatically', desc: 'Prepare the visual code map when a project opens.', control: { kind: 'toggle' } },
      { key: 'verbose', label: 'Diagnostic detail', desc: 'Include additional local troubleshooting detail in engine logs.', control: { kind: 'toggle' } },
      { key: 'reducedMotion', label: 'Reduce motion', desc: 'Prefer quiet fades and short state transitions throughout Bimax.', control: { kind: 'toggle' } },
    ],
  },
  {
    id: 'providers', label: 'Providers & models', icon: <Cpu size={15} />, subtitle: 'Credentials, routing and model roles',
    items: [
      { key: 'model', label: 'Main model', desc: 'The model Bimax uses for building and reasoning.', control: { kind: 'text', placeholder: 'provider/model-id' } },
      { key: 'liteModel', label: 'Fast model', desc: 'A quicker model for summaries and small supporting tasks.', control: { kind: 'text', placeholder: 'provider/model-id' } },
      { key: 'subagentModel', label: 'Specialist model', desc: 'Used by agent-team specialists. Empty inherits the main model.', control: { kind: 'text', placeholder: 'use main model' } },
      { key: 'fallbackModel', label: 'Backup model', desc: 'Used only when the main model is temporarily unavailable.', control: { kind: 'text', placeholder: 'off' } },
      { key: 'reasoningEffort', label: 'Reasoning effort', desc: 'Thinking budget for compatible models.', control: { kind: 'select', options: [{ value: '', label: 'Off' }, { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }] } },
      { key: 'contextMode', label: 'Tool context', desc: 'Smart loads tools on demand; Full sends the complete tool set.', control: { kind: 'select', options: [{ value: 'smart', label: 'Smart · deferred' }, { value: 'full', label: 'Full · all tools' }] } },
      { key: 'contextWindowTokens', label: 'Context window', desc: 'Actual model context in tokens. Zero uses the conservative default.', control: { kind: 'number', min: 0, step: 1000, placeholder: '0 · auto' } },
      { key: 'temperature', label: 'Temperature', desc: 'Sampling temperature for the main loop.', control: { kind: 'number', min: 0, max: 2, step: 0.1 } },
      { key: 'topP', label: 'Top-p', desc: 'Nucleus sampling cap.', control: { kind: 'number', min: 0, max: 1, step: 0.05 } },
      { key: 'maxTokens', label: 'Max output tokens', desc: 'Per-response output budget.', control: { kind: 'number', min: 256, step: 256 } },
      { key: 'parallelToolCalls', label: 'Parallel tool calls', desc: 'Allow compatible models to batch independent tool calls.', control: { kind: 'toggle' } },
    ],
  },
  { id: 'environment', label: 'Environment', icon: <TerminalSquare size={15} />, subtitle: 'Runtimes, SDKs and local developer services', items: [] },
  { id: 'alchemist', label: 'ML Alchemist', icon: <FlaskConical size={15} />, subtitle: 'Measured local-model experiments and compression', items: [] },
  {
    id: 'autonomy', label: 'Agent behavior', icon: <Bot size={15} />, subtitle: 'Depth, parallel work and verification',
    items: [
      { key: 'maxToolIterations', label: 'Max tool iterations', desc: 'Per-turn budget for autonomous tool loops.', control: { kind: 'number', min: 1, max: 500, step: 5 } },
      { key: 'maxSubAgents', label: 'Parallel specialists', desc: 'Maximum number of specialists Bimax may coordinate at once.', control: { kind: 'number', min: 1, max: 20, step: 1 } },
      { key: 'selfCritic', label: 'Self-critic pass', desc: 'Review each result before it reaches you.', control: { kind: 'toggle' } },
      { key: 'adversarialVerify', label: 'Adversarial verify', desc: 'Run an additional full-model challenge pass.', control: { kind: 'toggle' } },
      { key: 'autoVerify', label: 'Auto-verify edits', desc: 'Feed typecheck failures back into the active loop.', control: { kind: 'toggle' } },
      { key: 'gitAutoCommit', label: 'Git auto-commit', desc: 'Commit after successful agent edits and record the result.', control: { kind: 'toggle' } },
    ],
  },
  {
    id: 'safety', label: 'Agent safety', icon: <Shield size={15} />, subtitle: 'Project-scoped approval and mutation gates',
    items: [
      { key: 'diffApproval', label: 'Diff approval', desc: 'Surface every mutating edit and wait for approval.', control: { kind: 'toggle' } },
      { key: 'blastGate', label: 'Blast-radius gate', desc: 'Confirm edits touching high-impact code symbols.', control: { kind: 'toggle' } },
      { key: 'sandboxBash', label: 'Sandboxed shell', desc: 'Run compatible shell commands through the macOS sandbox.', control: { kind: 'toggle' } },
    ],
  },
];

export function SettingsDialog({
  open, onClose, onOpenHealth, onOpenModels, onOpenInspector, phase9, configGet, configSet,
}: {
  open: boolean;
  onClose: () => void;
  onOpenHealth: () => void;
  onOpenModels: () => void;
  onOpenInspector: (tab: InspectorTabId) => void;
  phase9: Phase9View;
  configGet: () => Promise<EngineConfig>;
  configSet: (patch: EngineConfig) => Promise<EngineConfig>;
}): React.ReactElement {
  const [page, setPage] = useState<PageId>('general');
  const [search, setSearch] = useState('');
  const [cfg, setCfg] = useState<EngineConfig | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const debounceRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    if (!open) return;
    setCfg(null); setUnsupported(false);
    void configGet().then((value) => { setUnsupported(Object.keys(value).length === 0); setCfg(value); });
  }, [open, configGet]);

  useEffect(() => () => {
    debounceRef.current.forEach((timer) => clearTimeout(timer));
    debounceRef.current.clear();
  }, []);

  const apply = (key: keyof EngineConfig, value: unknown, debounceMs = 0): void => {
    setCfg((current) => ({ ...(current ?? {}), [key]: value }) as EngineConfig);
    const timers = debounceRef.current;
    const previous = timers.get(key as string);
    if (previous) clearTimeout(previous);
    const save = (): void => {
      timers.delete(key as string);
      void configSet({ [key]: value } as EngineConfig).then((canonical) => {
        if (timers.size === 0 && Object.keys(canonical).length > 0) setCfg(canonical);
      });
    };
    if (debounceMs > 0) timers.set(key as string, setTimeout(save, debounceMs)); else save();
  };

  const q = search.trim().toLowerCase();
  const currentPage = PAGES.find((entry) => entry.id === page) ?? PAGES[0];
  const visible = useMemo(() => {
    if (!q) return currentPage.items;
    return PAGES.flatMap((entry) => entry.items).filter((item) => `${item.label} ${item.desc}`.toLowerCase().includes(q));
  }, [currentPage.items, q]);
  const customPage = !q && currentPage.items.length === 0;

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
      <DialogContent className="settings-shell flex h-[min(720px,88vh)] w-[min(1020px,calc(100vw-min(48px,40vw)))] max-w-none flex-row gap-0 overflow-hidden p-0">
        <nav className="settings-nav" aria-label="Settings sections">
          <div className="settings-search">
            <Search size={13} />
            <input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search settings" aria-label="Search settings" />
            {search ? <button onClick={() => setSearch('')} aria-label="Clear search"><X size={12} /></button> : null}
          </div>
          <div className="settings-nav-label">Bimax</div>
          {PAGES.map((entry) => (
            <button key={entry.id} onClick={() => { setPage(entry.id); setSearch(''); }} className={cn('settings-nav-item pressable', !q && page === entry.id && 'settings-nav-item--active')}>
              <span>{entry.icon}</span><span className="min-w-0 flex-1 truncate">{entry.label}</span>
              {(entry.id === 'environment' || entry.id === 'alchemist') ? <span className="size-1.5 rounded-full bg-moss" /> : null}
            </button>
          ))}
          <div className="mt-auto pt-4">
            <button onClick={() => { onClose(); onOpenHealth(); }} className="settings-support pressable">
              <Activity size={14} /><span><strong>Support</strong><small>App health and diagnostics</small></span>
            </button>
          </div>
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="settings-heading">
            <div className="min-w-0">
              <DialogTitle className="text-[16px] font-semibold text-ink">{q ? `Search · ${visible.length}` : currentPage.label}</DialogTitle>
              <p className="mt-0.5 text-[11px] text-faint">{q ? 'Matching controls across Bimax' : currentPage.subtitle}</p>
            </div>
            <button onClick={onClose} title="Close" aria-label="Close settings" className="evidence-close pressable"><X size={15} /></button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-7 pb-7">
            {unsupported ? <div className="mt-3 rounded-xl border border-amber/30 bg-amber/8 px-3 py-2 text-xs text-amber">Engine controls are unavailable in this build. Capability pages remain read-only.</div> : null}
            {customPage ? (
              <CapabilitySettings page={page} phase9={phase9} onOpenModels={onOpenModels} onOpenInspector={onOpenInspector} onOpenHealth={onOpenHealth} onClose={onClose} />
            ) : !cfg && !unsupported ? (
              <div className="mt-6 space-y-3">{[0, 1, 2, 3].map((index) => <div key={index} className="h-16 animate-pulse rounded-xl bg-raise" />)}</div>
            ) : (
              <div className="mt-2">
                {page === 'providers' && !q ? (
                  <ActionCard icon={<KeyRound size={16} />} title="Provider catalogue & credentials" description="Connect API providers, store keys in the macOS Keychain and choose a compatible model for each role." action="Manage providers" onClick={onOpenModels} />
                ) : null}
                {visible.map((item, index) => <SettingRow key={item.key} item={item} cfg={cfg ?? {}} onApply={apply} index={index} disabled={unsupported} />)}
                {q && visible.length === 0 ? <div className="mt-10 text-center text-xs text-faint">No settings match “{search}”.</div> : null}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CapabilitySettings({ page, phase9, onOpenModels, onOpenInspector, onOpenHealth, onClose }: {
  page: PageId; phase9: Phase9View; onOpenModels: () => void; onOpenInspector: (tab: InspectorTabId) => void; onOpenHealth: () => void; onClose: () => void;
}): React.ReactElement {
  /*
   * This page used to describe BrowserTool — "stable indexed targets, screenshots, downloads,
   * assertions and page-health evidence" — and a "managed Puppeteer browser". Neither exists:
   * src/browser/ was deleted in the 2026-09-02 code-only reset and no browser tool is registered.
   * What DOES exist is the embedded research browser you drive yourself, which lives entirely in
   * the app's main process (embedded.browser.manager.ts) and never involved the engine at all.
   * Every claim below is checked against that implementation.
   */
  if (page === 'environment') {
    const ready = phase9.environment?.tools.filter((tool) => tool.state === 'ready').length ?? 0;
    return <div className="settings-capability-grid"><CapabilityHero icon={<TerminalSquare size={18} />} title={`${ready} developer tools resolved`} description="A bounded, read-only inventory of runtimes, package managers, SDKs and local services. No profile sourcing or project scripts." status={phase9.environment ? 'Live' : 'Loading'} /><ActionCard icon={<ExternalLink size={15} />} title="Environment map" description="Inspect exact tool paths, versions and project declarations in Evidence Studio." action="Open Environment" /></div>;
  }
  const ready = phase9.alchemist?.backends.filter((backend) => backend.state === 'ready').length ?? 0;
  return <div className="settings-capability-grid"><CapabilityHero icon={<FlaskConical size={18} />} title={`${ready} local model backends ready`} description="MLX, Core ML Tools, llama.cpp and Ollama are detected without installing or running a model." status={phase9.alchemist?.state ?? 'Loading'} /><ActionCard icon={<BrainCircuit size={15} />} title="Measured experiment pipeline" description="Inspect → quantize or fine-tune → compare quality, memory and latency → verify → export. Unavailable steps remain disabled." action="Open Alchemist" /><ActionCard icon={<Cpu size={15} />} title="Model roles" description="Select provider models for coding, quick replies, and specialist agents." action="Manage models" onClick={onOpenModels} /><ActionCard icon={<Shield size={15} />} title="Isolation boundary" description="Model transforms require isolated workers and immutable artifact handles; unsafe pickle input is refused." action="Open support" onClick={() => { onClose(); onOpenHealth(); }} /></div>;
}

function CapabilityHero({ icon, title, description, status }: { icon: React.ReactNode; title: string; description: string; status: string }): React.ReactElement {
  return <section className="settings-capability-hero"><span className="settings-capability-icon">{icon}</span><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h3>{title}</h3><span className="status-chip status-chip--ok">{status}</span></div><p>{description}</p></div></section>;
}

function CapabilityNote({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }): React.ReactElement {
  return <section className="settings-note"><span>{icon}</span><div><h3>{title}</h3><p>{description}</p></div></section>;
}

/**
 * A capability card. `onClick` is optional: some capabilities are described here but have no lane
 * to open any more, and a button that navigates nowhere is worse than a plain statement — so
 * without a handler the card renders as static prose and drops its action affordance entirely.
 */
function ActionCard({ icon, title, description, action, onClick }: { icon: React.ReactNode; title: string; description: string; action: string; onClick?: () => void }): React.ReactElement {
  const body = (
    <>
      <span className="settings-capability-icon">{icon}</span>
      <span className="min-w-0 flex-1 text-left"><strong>{title}</strong><small>{description}</small></span>
      {onClick ? <span className="settings-action-label">{action}<ExternalLink size={11} /></span> : null}
    </>
  );
  if (!onClick) return <div className="settings-action-card">{body}</div>;
  return <button onClick={onClick} className="settings-action-card pressable">{body}</button>;
}

function SettingRow({ item, cfg, onApply, index, disabled }: { item: Item; cfg: EngineConfig; onApply: (key: keyof EngineConfig, value: unknown, debounceMs?: number) => void; index: number; disabled: boolean }): React.ReactElement {
  const value = cfg[item.key];
  return <div className="anim-fade-up flex items-start justify-between gap-6 border-b border-line/60 py-4 last:border-b-0" style={{ animationDelay: `${Math.min(index, 10) * 24}ms` }}><div className="min-w-0"><div className="text-[13px] text-ink">{item.label}</div><div className="mt-0.5 text-[11.5px] leading-relaxed text-dim">{item.desc}</div></div><div className={cn('shrink-0 pt-0.5', disabled && 'pointer-events-none opacity-40')}>
    {item.control.kind === 'toggle' ? <Toggle checked={Boolean(value)} onChange={(next) => onApply(item.key, next)} label={item.label} /> : null}
    {item.control.kind === 'select' ? <div className="relative"><select value={String(value ?? item.control.options[0].value)} onChange={(event) => onApply(item.key, event.target.value)} aria-label={item.label} className="settings-select">{item.control.options.map((option) => <option key={option.value} value={option.value} className="bg-raise">{option.label}</option>)}</select><ChevronDown size={12} className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-faint" /></div> : null}
    {item.control.kind === 'number' ? <input type="number" value={value === undefined ? '' : Number(value)} min={item.control.min} max={item.control.max} step={item.control.step} placeholder={item.control.placeholder} aria-label={item.label} onChange={(event) => onApply(item.key, event.target.value === '' ? 0 : Number(event.target.value), 600)} className="settings-input w-32 text-right" /> : null}
    {item.control.kind === 'text' ? <input type="text" value={String(value ?? '')} placeholder={item.control.placeholder} aria-label={item.label} onChange={(event) => onApply(item.key, event.target.value, 700)} className="settings-input w-64" /> : null}
  </div></div>;
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }): React.ReactElement {
  return <button role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} className={cn('relative h-6 w-10.5 cursor-pointer rounded-full transition-colors duration-200', checked ? 'bg-ember' : 'bg-line hover:bg-hover')}><span className={cn('absolute top-0.5 left-0.5 size-5 rounded-full bg-ink shadow-[0_1px_3px_rgba(0,0,0,0.35)] transition-transform duration-200 ease-out', checked && 'translate-x-[18px]')} /></button>;
}
