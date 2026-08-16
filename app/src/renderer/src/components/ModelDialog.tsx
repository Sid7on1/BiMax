import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check, TriangleAlert, Loader, Search, RefreshCw, KeyRound, Plus, Eye, Wrench,
  Brain, Gauge, X, ChevronRight,
} from 'lucide-react';
import { cn } from '../lib/cn';
import type { EngineConfig, EngineCatalog, CatalogModelEntry, ProviderEntry } from '../protocol';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { computerUseModelReadiness } from '../computer.use.model';

/**
 * The model window.
 *
 * Four things here are deliberate, and each one exists because its absence caused a real, reported
 * failure.
 *
 * *It is a window, not a transcript message.* Choosing a model used to run `/model`, which printed
 * the engine's picker into the conversation and echoed the choice back as a user turn — putting a
 * configuration change into immutable scrollback, and leaving "which model is actually loaded?"
 * somewhere in the history instead of in front of you.
 *
 * *You pick from a list, you do not type an id.* The old dialog was four text inputs. A typo, a
 * renamed id, or a model the provider dropped all produced the same silent outcome: requests failing
 * later, far from the screen where the mistake was made.
 *
 * *Every write is confirmed by a read of the LOADED state.* `configSet` answers with what the engine
 * will actually use — `llmAdapter.readEffective()`, not the config file — so a slot that did not
 * take says so. Echoing back the file the dialog just wrote is precisely how "I changed the model
 * and it never changed" stayed invisible for so long.
 *
 * *Models the provider does not serve are shown, not hidden.* A stale pin has to remain visible to
 * be diagnosable; silently dropping it from the list turns "my model vanished" into a mystery.
 */

interface Slot {
  key: 'model' | 'liteModel' | 'visionModel' | 'subagentModel' | 'fallbackModel';
  label: string;
  desc: string;
  /** Catalogue tier whose models are offered first for this slot. */
  tier?: CatalogModelEntry['tier'];
  optional?: boolean;
}

const SLOTS: Slot[] = [
  { key: 'model', label: 'Work', desc: 'Builds, reasons, and runs the task', tier: 'coding' },
  { key: 'liteModel', label: 'Quick', desc: 'Short replies and small supporting steps', tier: 'lite' },
  { key: 'visionModel', label: 'Vision', desc: 'Reads screenshots and grounds clicks', tier: 'vision' },
  { key: 'subagentModel', label: 'Team', desc: 'Parallel sub-agents — empty means Work', optional: true },
  { key: 'fallbackModel', label: 'Backup', desc: 'Takes over when Work is unavailable', optional: true },
];

const EFFORTS = [
  { id: '', label: 'Off', desc: 'Send no effort hint' },
  { id: 'low', label: 'Low', desc: 'Answer fast' },
  { id: 'medium', label: 'Medium', desc: 'Balanced' },
  { id: 'high', label: 'High', desc: 'Think longer before answering' },
];

type Outcome = { state: 'saving' } | { state: 'applied' } | { state: 'rejected'; actual: string };
type Pane = { view: 'slots' } | { view: 'pick'; slot: Slot } | { view: 'providers' };

export function ModelDialog({
  open, onClose, purpose = 'general', onComputerUseReady, configGet, configSet, catalogGet,
}: {
  open: boolean;
  onClose: () => void;
  purpose?: 'general' | 'computer-use';
  onComputerUseReady?: () => void;
  configGet: () => Promise<EngineConfig>;
  configSet: (patch: EngineConfig) => Promise<EngineConfig>;
  catalogGet: (refresh?: boolean) => Promise<EngineCatalog>;
}): React.ReactElement {
  const [config, setConfig] = useState<EngineConfig | null>(null);
  const [catalog, setCatalog] = useState<EngineCatalog | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [pane, setPane] = useState<Pane>({ view: 'slots' });
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!open) return;
    setOutcomes({});
    setPane({ view: 'slots' });
    void configGet().then(setConfig);
    void catalogGet(false).then(setCatalog);
  }, [open, configGet, catalogGet]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    // Re-read both: a provider switch changes the served list AND the slots the engine reports.
    const [next, cfg] = await Promise.all([catalogGet(true), configGet()]);
    setCatalog(next);
    setConfig(cfg);
    setRefreshing(false);
  }, [catalogGet, configGet]);

  const apply = useCallback(async (key: string, value: string) => {
    setOutcomes((current) => ({ ...current, [key]: { state: 'saving' } }));
    const canonical = await configSet({ [key]: value } as EngineConfig);
    // Treat bridge values as snapshots. Some engines/mocks reuse the same object identity; cloning
    // keeps readiness and the disabled Continue button live after a slot changes.
    setConfig({ ...canonical });
    const actual = String((canonical as Record<string, unknown>)[key] ?? '');
    setOutcomes((current) => ({
      ...current,
      [key]: actual.trim() === value.trim() ? { state: 'applied' } : { state: 'rejected', actual },
    }));
  }, [configSet]);

  const activeProvider = catalog?.providers.find((p) => p.active);
  const cuReadiness = useMemo(() => computerUseModelReadiness(config, catalog), [config, catalog]);

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
      {/* The one dialog that morphs. Prompt 2 §42 names `model button→picker` as the case the
          signature exists for: the model control and the picker are the same subject at two sizes,
          and the surface is always opened from a visible control that states the current model. */}
      <DialogContent
        motion="seeded"
        className="flex h-[min(720px,calc(100vh-40px))] w-[min(760px,calc(100vw-min(40px,40vw)))] flex-col p-0"
        style={{ maxHeight: 'calc(100vh - 40px)', overflow: 'hidden' }}
      >
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-2.5">
            {pane.view !== 'slots' && (
              <button
                onClick={() => setPane({ view: 'slots' })}
                aria-label="Back to slots"
                className="-ml-1 cursor-pointer rounded-md p-1 text-dim transition-colors hover:bg-well hover:text-ink"
              >
                <ChevronRight size={15} className="rotate-180" />
              </button>
            )}
            <DialogTitle className="truncate text-[14px] font-semibold">
              {pane.view === 'slots' ? (purpose === 'computer-use' ? 'Models for Control Mac' : 'Model catalogue')
                : pane.view === 'providers' ? 'Providers'
                : `Choose a model for ${pane.slot.label}`}
            </DialogTitle>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {pane.view === 'slots' && (
              <button
                onClick={() => setPane({ view: 'providers' })}
                className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[11.5px] text-dim transition-colors hover:border-ember/50 hover:text-ink"
              >
                <KeyRound size={12} />
                {activeProvider?.label ?? 'Provider'}
              </button>
            )}
            <button
              onClick={() => void refresh()}
              aria-label="Refresh the model list"
              className="cursor-pointer rounded-lg border border-line p-1.5 text-dim transition-colors hover:border-ember/50 hover:text-ink"
            >
              <RefreshCw size={12} className={cn('transition-transform', refreshing && 'animate-spin')} />
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {config === null ? (
            <p className="py-16 text-center text-[12.5px] text-faint">Reading the engine’s configuration…</p>
          ) : pane.view === 'providers' ? (
            <ProviderPane
              catalog={catalog}
              onApply={async (input) => {
                const result = await window.bimax.providers.configure(input);
                if (!result.ok) {
                  setCatalog((current) => ({
                    providers: current?.providers ?? [],
                    models: current?.models ?? [],
                    error: result.error || 'The provider could not be configured.',
                  }));
                  return;
                }
                // Provider secrets are injected only when the engine starts. Wait for that new
                // generation before asking for its catalogue; otherwise catalogGet is deliberately
                // rejected by the supervisor while the child is booting.
                const deadline = Date.now() + 45_000;
                while (Date.now() < deadline) {
                  const status = await window.bimax.supervisor.getStatus().catch(() => null) as { phase?: string } | null;
                  if (status?.phase === 'ready' || status?.phase === 'degraded') break;
                  await new Promise((resolve) => setTimeout(resolve, 250));
                }
                const [next, cfg] = await Promise.all([catalogGet(true), configGet()]);
                setCatalog(next);
                setConfig(cfg);
              }}
            />
          ) : pane.view === 'pick' ? (
            <PickPane
              slot={pane.slot}
              catalog={catalog}
              current={String((config as Record<string, unknown>)[pane.slot.key] ?? '')}
              onPick={async (id) => { await apply(pane.slot.key, id); setPane({ view: 'slots' }); }}
            />
          ) : (
            <>
              {purpose === 'computer-use' && (
                <div className={cn(
                  'mx-5 mt-4 rounded-xl border px-3.5 py-3 text-[11.5px] leading-relaxed',
                  cuReadiness.ready ? 'border-moss/25 bg-moss/5 text-dim' : 'border-amber/30 bg-amber/5 text-dim',
                )}>
                  <div className="mb-1 flex items-center gap-2 font-semibold text-ink">
                    {cuReadiness.ready ? <Check size={13} className="text-moss" /> : <TriangleAlert size={13} className="text-amber" />}
                    {cuReadiness.ready ? 'Control Mac model route is ready' : 'Pick a compatible route before Bimax can control the Mac'}
                  </div>
                  {cuReadiness.ready
                    ? `${cuReadiness.work?.label} will run tools; ${cuReadiness.vision?.label} will ground screenshots.`
                    : cuReadiness.reasons.join(' ')}
                </div>
              )}
              <SlotsPane
                config={config}
                catalog={catalog}
                outcomes={outcomes}
                onOpenPicker={(slot) => setPane({ view: 'pick', slot })}
                onApply={apply}
              />
            </>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-line px-5 py-3">
          <p className="min-w-0 truncate text-[11px] text-faint">
            {catalog?.error
              ? catalog.error
              : activeProvider
                ? `${activeProvider.label} · ${catalog?.models.filter((m) => m.served).length ?? 0} models served`
                : 'Changes apply to the next turn.'}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            {purpose === 'computer-use' && (
              <button onClick={onClose} className="cursor-pointer rounded-lg px-2.5 py-1.5 text-[11.5px] text-dim hover:bg-well hover:text-ink">
                Not now
              </button>
            )}
            <button
              onClick={purpose === 'computer-use' ? onComputerUseReady : onClose}
              disabled={purpose === 'computer-use' && !cuReadiness.ready}
              className="pressable shrink-0 cursor-pointer rounded-lg bg-ember px-3.5 py-1.5 text-[12.5px] font-semibold text-bg transition-colors hover:bg-ember-bright focus-visible:outline-2 focus-visible:outline-ember disabled:cursor-default disabled:opacity-35"
            >
              {purpose === 'computer-use' ? 'Continue to permissions' : 'Done'}
            </button>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- slots ------------ */

function SlotsPane({
  config, catalog, outcomes, onOpenPicker, onApply,
}: {
  config: EngineConfig;
  catalog: EngineCatalog | null;
  outcomes: Record<string, Outcome>;
  onOpenPicker: (slot: Slot) => void;
  onApply: (key: string, value: string) => Promise<void>;
}): React.ReactElement {
  const effort = String(config.reasoningEffort ?? '');
  const thinking = Number((config as Record<string, unknown>).maxThinkingTokens ?? 0);
  const byId = useMemo(
    () => new Map((catalog?.models ?? []).map((m) => [m.id, m])),
    [catalog],
  );
  const workModel = byId.get(String(config.model ?? ''));

  return (
    <div className="px-5 py-4">
      <Section label="Slots">
        {SLOTS.map((slot) => (
          <SlotRow
            key={slot.key}
            slot={slot}
            value={String((config as Record<string, unknown>)[slot.key] ?? '')}
            entry={byId.get(String((config as Record<string, unknown>)[slot.key] ?? ''))}
            outcome={outcomes[slot.key]}
            knownCatalog={!!catalog && catalog.models.length > 0}
            onOpen={() => onOpenPicker(slot)}
            onClear={slot.optional ? () => void onApply(slot.key, '') : undefined}
          />
        ))}
      </Section>

      <Section label="Reasoning effort">
        <div className="flex gap-1.5">
          {EFFORTS.map((option) => (
            <button
              key={option.id || 'off'}
              title={option.desc}
              onClick={() => void onApply('reasoningEffort', option.id)}
              className={cn(
                'flex-1 cursor-pointer rounded-lg border px-3 py-2 text-[12.5px] transition-all duration-150 active:scale-[0.97]',
                effort === option.id
                  ? 'border-ember bg-ember/12 text-ink'
                  : 'border-line text-dim hover:border-ember/50 hover:text-ink',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
        {/*
          The knob is only meaningful on models that advertise it. Sending it to one that does not
          makes the provider reject the whole request, so say the model ignores it rather than
          letting a dead control look live.
        */}
        {workModel?.capabilities && !workModel.capabilities.reasoningEffortKnob && effort !== '' && (
          <Note tone="amber">
            {workModel.label} does not take an effort hint — the engine will not send one.
          </Note>
        )}
        {outcomes.reasoningEffort?.state === 'rejected' && (
          <Note tone="amber">The engine kept “{outcomes.reasoningEffort.actual || 'off'}”.</Note>
        )}
      </Section>

      <Section label="Thinking budget">
        <ThinkingTokens
          value={thinking}
          supported={workModel?.capabilities?.thinking !== false}
          modelLabel={workModel?.label}
          outcome={outcomes.maxThinkingTokens}
          onApply={(next) => void onApply('maxThinkingTokens', String(next))}
        />
      </Section>
    </div>
  );
}

function SlotRow({
  slot, value, entry, outcome, knownCatalog, onOpen, onClear,
}: {
  slot: Slot;
  value: string;
  entry?: CatalogModelEntry;
  outcome?: Outcome;
  knownCatalog: boolean;
  onOpen: () => void;
  onClear?: () => void;
}): React.ReactElement {
  // "Not served" is only assertable when we actually have a list to have been absent from. With no
  // catalogue (offline, no key) every model would look broken, which is worse than saying nothing.
  const missing = knownCatalog && !!value && (!entry || !entry.served);

  return (
    <div className="mb-2 last:mb-0">
      <div className="flex items-center gap-2">
        <button
          onClick={onOpen}
          // The visible text is three separate spans, which screen readers announce as a run-on
          // string ("Work Builds, reasons… nvidia/nemotron…"). Name the control by what it DOES.
          aria-label={`${slot.label} model: ${value || 'not set'}. Choose a different model.`}
          className={cn(
            'group flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left transition-all duration-150',
            'border-line hover:border-ember/50 hover:bg-well/60 active:scale-[0.995]',
          )}
        >
          <span className="flex min-w-0 flex-col">
            <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink">
              {slot.label}
              {missing && <TriangleAlert size={11} className="text-amber" />}
            </span>
            <span className="truncate text-[11px] text-faint">{slot.desc}</span>
          </span>
          <span className="flex min-w-0 items-center gap-2">
            <span className="flex min-w-0 flex-col items-end">
              <span className={cn('max-w-[260px] truncate text-[11.5px] font-medium', value ? 'text-ink' : 'text-faint')}>
                {entry?.label || (value ? value.split('/').pop() : slot.optional ? 'Off' : 'Not set')}
              </span>
              {entry && <span className="max-w-[260px] truncate font-mono text-[9.5px] text-faint">{entry.id}</span>}
            </span>
            <ChevronRight size={13} className="shrink-0 text-faint transition-transform group-hover:translate-x-0.5" />
          </span>
        </button>
        {onClear && !!value && (
          <button
            onClick={onClear}
            aria-label={`Clear ${slot.label}`}
            className="shrink-0 cursor-pointer rounded-lg border border-line p-2 text-faint transition-colors hover:border-ember/50 hover:text-ink"
          >
            <X size={12} />
          </button>
        )}
      </div>
      {missing && (
        <Note tone="amber">
          {entry ? 'This provider is not serving that model right now.' : 'Not in this provider’s list — it may have been renamed or dropped.'}
        </Note>
      )}
      {outcome?.state === 'saving' && <Note tone="faint"><Loader size={11} className="animate-spin" /> Applying…</Note>}
      {outcome?.state === 'applied' && <Note tone="moss"><Check size={11} /> The engine is using this.</Note>}
      {outcome?.state === 'rejected' && (
        <Note tone="amber">Not applied — the engine kept “{outcome.actual || 'empty'}”.</Note>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------- picker ------------- */

const TIER_LABEL: Record<CatalogModelEntry['tier'], string> = {
  coding: 'Work', lite: 'Quick', vision: 'Vision', other: 'Other',
};

function PickPane({
  slot, catalog, current, onPick,
}: {
  slot: Slot;
  catalog: EngineCatalog | null;
  current: string;
  onPick: (id: string) => void;
}): React.ReactElement {
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { searchRef.current?.focus(); }, []);

  const groups = useMemo(() => {
    const all = catalog?.models ?? [];
    const needle = query.trim().toLowerCase();
    const matches = needle
      ? all.filter((m) => m.id.toLowerCase().includes(needle) || m.label.toLowerCase().includes(needle))
      : all;
    // Searching means the user is looking for something specific — never hide a match behind
    // "browse all", or the search box appears broken for models outside the slot's tier.
    const scoped = (needle || showAll || !slot.tier) ? matches : matches.filter((m) => m.tier === slot.tier);
    const recommended = scoped.filter((m) => m.curated && m.served);
    const unverified = scoped.filter((m) => m.curated && !m.served);
    const extra = scoped.filter((m) => !m.curated);
    return { recommended, unverified, extra, total: all.length };
  }, [catalog, query, showAll, slot.tier]);

  if (!catalog) {
    return <p className="py-16 text-center text-[12.5px] text-faint">Reading the provider’s model list…</p>;
  }

  return (
    <div>
      <div className="sticky top-0 z-10 border-b border-line bg-raise/95 px-5 py-3 backdrop-blur-xl">
        <div className="flex items-center gap-2 rounded-lg border border-line bg-well px-2.5 py-1.5 focus-within:border-ember/60">
          <Search size={13} className="shrink-0 text-faint" />
          <input
            ref={searchRef}
            value={query}
            spellCheck={false}
            placeholder={`Search ${groups.total} models…`}
            onChange={(event) => setQuery(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-faint"
          />
          {!!query && (
            <button onClick={() => setQuery('')} aria-label="Clear search" className="cursor-pointer text-faint hover:text-ink">
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      <div className="px-5 py-3">
        {catalog.error && <Note tone="amber">{catalog.error}</Note>}

        <ModelGroup label="Recommended" models={groups.recommended} current={current} onPick={onPick} />
        <ModelGroup
          label="Not served right now"
          hint="In our catalogue, but this provider is not listing them."
          models={groups.unverified}
          current={current}
          onPick={onPick}
        />
        <ModelGroup
          label="Everything else this provider serves"
          hint="Real ids we have not measured."
          models={groups.extra}
          current={current}
          onPick={onPick}
        />

        {groups.recommended.length + groups.unverified.length + groups.extra.length === 0 && (
          <p className="py-10 text-center text-[12.5px] text-faint">
            {query ? `Nothing matches “${query}”.` : 'No models to show.'}
          </p>
        )}

        {!query && slot.tier && !showAll && (
          <button
            onClick={() => setShowAll(true)}
            className="mt-2 w-full cursor-pointer rounded-lg border border-dashed border-line px-3 py-2 text-[11.5px] text-dim transition-colors hover:border-ember/50 hover:text-ink"
          >
            Browse all {groups.total} models
          </button>
        )}
      </div>
    </div>
  );
}

function ModelGroup({
  label, hint, models, current, onPick,
}: {
  label: string;
  hint?: string;
  models: CatalogModelEntry[];
  current: string;
  onPick: (id: string) => void;
}): React.ReactElement | null {
  if (models.length === 0) return null;
  return (
    <section className="mb-4 last:mb-0">
      <h3 className="mb-1.5 text-[9.5px] font-semibold tracking-[0.1em] text-faint uppercase">{label}</h3>
      {hint && <p className="mb-1.5 text-[11px] text-faint">{hint}</p>}
      <div className="flex flex-col gap-1">
        {models.map((model) => (
          <ModelRow key={model.id} model={model} selected={model.id === current} onPick={() => onPick(model.id)} />
        ))}
      </div>
    </section>
  );
}

function ModelRow({
  model, selected, onPick,
}: {
  model: CatalogModelEntry;
  selected: boolean;
  onPick: () => void;
}): React.ReactElement {
  const caps = model.capabilities;
  return (
    <button
      onClick={onPick}
      aria-pressed={selected}
      // Lead with the caution: a screen-reader user should hear WHY a model is flagged before they
      // commit to it, not after, and the visual pills convey that ordering sighted.
      aria-label={[
        model.label,
        model.avoidAutoSelect ? 'not auto-picked' : '',
        model.served ? '' : 'not served right now',
        model.id,
      ].filter(Boolean).join(', ')}
      className={cn(
        'group flex w-full cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-all duration-150 active:scale-[0.995]',
        selected ? 'border-ember bg-ember/10' : 'border-transparent hover:border-line hover:bg-well/60',
      )}
    >
      <span className={cn('mt-0.5 shrink-0', selected ? 'text-ember' : 'text-transparent')}>
        <Check size={13} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-[12.5px] font-medium text-ink">{model.label}</span>
          <Pill>{TIER_LABEL[model.tier]}</Pill>
          {/*
            avoidAutoSelect is a bar on the MACHINE choosing this model, never on the person. The
            reason lives in `desc` — usually a measured timeout or missing tool-calling — so it is
            surfaced as a caution the user can overrule, not a disabled row.
          */}
          {model.avoidAutoSelect && (
            <Pill tone="amber"><TriangleAlert size={9} /> not auto-picked</Pill>
          )}
          {!model.served && <Pill tone="amber">unverified</Pill>}
        </span>
        <span className="truncate font-mono text-[10.5px] text-faint">{model.id}</span>
        <span className="text-[11px] leading-snug text-dim">{model.desc}</span>
        {caps && (
          <span className="mt-0.5 flex flex-wrap items-center gap-2 text-[10.5px] text-faint">
            {caps.visionInput && <span className="flex items-center gap-1"><Eye size={10} /> vision</span>}
            {caps.thinking && <span className="flex items-center gap-1"><Brain size={10} /> thinks</span>}
            {caps.parallelToolCalls && <span className="flex items-center gap-1"><Wrench size={10} /> parallel tools</span>}
            {caps.contextWindow > 0 && (
              <span className="flex items-center gap-1">
                <Gauge size={10} /> {Math.round(caps.contextWindow / 1000)}k context
              </span>
            )}
          </span>
        )}
      </span>
    </button>
  );
}

/* ----------------------------------------------------------------------- providers ------------ */

function ProviderPane({
  catalog, onApply,
}: {
  catalog: EngineCatalog | null;
  onApply: (input: { name: string; baseURL?: string; apiKey?: string }) => Promise<void>;
}): React.ReactElement {
  const [busy, setBusy] = useState<string | null>(null);
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const [keyValue, setKeyValue] = useState('');
  const [baseURL, setBaseURL] = useState('');
  const [credentialStatus, setCredentialStatus] = useState<Awaited<ReturnType<typeof window.bimax.providers.credentialStatus>>>([]);

  useEffect(() => {
    void window.bimax.providers.credentialStatus().then(setCredentialStatus).catch(() => setCredentialStatus([]));
  }, [catalog]);

  const run = useCallback(async (input: { name: string; baseURL?: string; apiKey?: string }) => {
    setBusy(input.name);
    try {
      await onApply(input);
      setCredentialStatus(await window.bimax.providers.credentialStatus().catch(() => []));
      setKeyFor(null);
      setKeyValue('');
      setBaseURL('');
    } finally {
      setBusy(null);
    }
  }, [onApply]);

  const fallback: ProviderEntry[] = [
    ['nvidia', 'NVIDIA NIM', 'NVIDIA_API_KEY'],
    ['openai', 'OpenAI', 'OPENAI_API_KEY'],
    ['anthropic', 'Anthropic', 'ANTHROPIC_API_KEY'],
    ['openrouter', 'OpenRouter', 'OPENROUTER_API_KEY'],
    ['deepseek', 'DeepSeek', 'DEEPSEEK_API_KEY'],
    ['google', 'Google AI', 'GOOGLE_API_KEY'],
  ].map(([name, label, apiKeyEnv]) => ({
    name, label, apiKeyEnv, baseURL: '', active: false, hasKey: false, keyCount: 0,
  }));
  const rows = (catalog?.providers.length ? catalog.providers : fallback).map((provider) => {
    const secure = credentialStatus.find((item) => item.name === provider.name);
    return secure?.hasKey
      ? { ...provider, hasKey: true, keyCount: 1, keyHint: secure.keyHint, active: secure.active || provider.active }
      : { ...provider, active: secure?.active || provider.active };
  });

  return (
    <div className="px-5 py-4">
      <p className="mb-3 text-[11.5px] leading-relaxed text-dim">
        Choose who serves the models Bimax uses. Keys you save here are protected by macOS Keychain
        and injected only into the engine process — never written to a project or sent through chat.
      </p>

      <div className="flex flex-col gap-1.5">
        {rows.map((provider) => (
          <ProviderRow
            key={provider.name}
            provider={provider}
            busy={busy === provider.name}
            expanded={keyFor === provider.name}
            keyValue={keyValue}
            baseURL={baseURL}
            onKeyValue={setKeyValue}
            onBaseURL={setBaseURL}
            onExpand={() => {
              setKeyFor(keyFor === provider.name ? null : provider.name);
              setKeyValue('');
              setBaseURL(provider.baseURL || '');
            }}
            onUse={() => void run({ name: provider.name, ...(baseURL ? { baseURL } : {}) })}
            onSaveKey={() => void run({ name: provider.name, apiKey: keyValue, ...(baseURL ? { baseURL } : {}) })}
          />
        ))}
      </div>

      {catalog?.error && <Note tone="amber">{catalog.error}</Note>}
    </div>
  );
}

function ProviderRow({
  provider, busy, expanded, keyValue, baseURL, onKeyValue, onBaseURL, onExpand, onUse, onSaveKey,
}: {
  provider: ProviderEntry;
  busy: boolean;
  expanded: boolean;
  keyValue: string;
  baseURL: string;
  onKeyValue: (value: string) => void;
  onBaseURL: (value: string) => void;
  onExpand: () => void;
  onUse: () => void;
  onSaveKey: () => void;
}): React.ReactElement {
  return (
    <div className={cn('rounded-lg border transition-colors', provider.active ? 'border-ember/60 bg-ember/[0.06]' : 'border-line')}>
      <div className="flex items-center gap-3 px-3 py-2.5">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink">
            {provider.label}
            {provider.active && <Pill tone="ember">active</Pill>}
          </span>
          <span className="truncate text-[10.5px] text-faint">
            {provider.hasKey
              ? `${provider.keyCount} key${provider.keyCount === 1 ? '' : 's'}${provider.keyHint ? ` · ${provider.keyHint}` : ''}`
              : `no key · set ${provider.apiKeyEnv}`}
          </span>
        </span>
        <button
          onClick={onExpand}
          className="shrink-0 cursor-pointer rounded-lg border border-line px-2 py-1.5 text-[11px] text-dim transition-colors hover:border-ember/50 hover:text-ink"
        >
          {provider.hasKey ? <KeyRound size={11} /> : <Plus size={11} />}
        </button>
        {!provider.active && (
          <button
            onClick={onUse}
            disabled={busy}
            className="shrink-0 cursor-pointer rounded-lg border border-line px-2.5 py-1.5 text-[11.5px] text-dim transition-colors hover:border-ember/50 hover:text-ink disabled:opacity-50"
          >
            {busy ? <Loader size={11} className="animate-spin" /> : 'Use'}
          </button>
        )}
      </div>

      {expanded && (
        <div className="border-t border-line px-3 py-2.5">
          <label className="mb-1 block text-[10.5px] text-faint">
            Paste a key for {provider.label}. Bimax protects it with macOS Keychain.
          </label>
          <div className="flex items-center gap-1.5">
            <input
              type="password"
              value={keyValue}
              spellCheck={false}
              autoComplete="off"
              placeholder={provider.apiKeyEnv}
              onChange={(event) => onKeyValue(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && keyValue) onSaveKey(); }}
              className="min-w-0 flex-1 rounded-lg border border-line bg-well px-2.5 py-1.5 font-mono text-[11.5px] text-ink outline-none placeholder:text-faint focus:border-ember/60"
            />
            <button
              onClick={onSaveKey}
              disabled={!keyValue || busy}
              className="shrink-0 cursor-pointer rounded-lg bg-ember px-2.5 py-1.5 text-[11.5px] font-semibold text-bg transition-colors hover:bg-ember-bright disabled:opacity-40"
            >
              {busy ? <Loader size={11} className="animate-spin" /> : 'Save & use'}
            </button>
          </div>
          <label className="mt-2 mb-1 block text-[10.5px] text-faint">Custom HTTPS endpoint <span className="opacity-70">(optional)</span></label>
          <input
            type="url"
            value={baseURL}
            spellCheck={false}
            placeholder={provider.baseURL || 'https://api.example.com/v1'}
            onChange={(event) => onBaseURL(event.target.value)}
            className="w-full rounded-lg border border-line bg-well px-2.5 py-1.5 font-mono text-[11.5px] text-ink outline-none placeholder:text-faint focus:border-ember/60"
          />
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------- thinking tokens --------- */

const THINKING_PRESETS = [0, 1024, 4096, 16384];

function ThinkingTokens({
  value, supported, modelLabel, outcome, onApply,
}: {
  value: number;
  supported: boolean;
  modelLabel?: string;
  outcome?: Outcome;
  onApply: (value: number) => void;
}): React.ReactElement {
  return (
    <>
      <div className="flex gap-1.5">
        {THINKING_PRESETS.map((preset) => (
          <button
            key={preset}
            onClick={() => onApply(preset)}
            className={cn(
              'flex-1 cursor-pointer rounded-lg border px-3 py-2 text-[12.5px] transition-all duration-150 active:scale-[0.97]',
              value === preset
                ? 'border-ember bg-ember/12 text-ink'
                : 'border-line text-dim hover:border-ember/50 hover:text-ink',
            )}
          >
            {preset === 0 ? 'Default' : `${preset / 1024}k`}
          </button>
        ))}
      </div>
      <p className="mt-1.5 text-[11px] text-faint">
        How many tokens the model may spend reasoning before it must answer. Default leaves it to the
        provider.
      </p>
      {!supported && modelLabel && <Note tone="amber">{modelLabel} does not expose a thinking budget.</Note>}
      {outcome?.state === 'rejected' && <Note tone="amber">The engine kept “{outcome.actual || '0'}”.</Note>}
    </>
  );
}

/* --------------------------------------------------------------------------- bits ------------- */

function Section({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <section className="mb-5 last:mb-0">
      <h3 className="mb-2 text-[9.5px] font-semibold tracking-[0.1em] text-faint uppercase">{label}</h3>
      {children}
    </section>
  );
}

function Pill({ children, tone = 'line' }: { children: React.ReactNode; tone?: 'line' | 'amber' | 'ember' }): React.ReactElement {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[9.5px] font-medium',
        tone === 'amber' ? 'bg-amber/15 text-amber'
          : tone === 'ember' ? 'bg-ember/20 text-ember'
            : 'bg-well text-faint',
      )}
    >
      {children}
    </span>
  );
}

function Note({ children, tone }: { children: React.ReactNode; tone: 'amber' | 'moss' | 'faint' }): React.ReactElement {
  return (
    <p
      className={cn(
        'mt-1 flex items-center gap-1.5 text-[11px]',
        tone === 'amber' ? 'text-amber' : tone === 'moss' ? 'text-moss' : 'text-faint',
      )}
    >
      {tone === 'amber' && <TriangleAlert size={11} className="shrink-0" />}
      {children}
    </p>
  );
}
