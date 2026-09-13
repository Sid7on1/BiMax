import React from 'react';
import { Cpu, HardDrive, Thermometer, CheckCircle2, ShieldCheck, Activity, X } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import type { Phase9View } from '../usePhase9';
import type { WorkspaceToolStatus } from '../../../phase9/workspace.capabilities';

/**
 * Machine & Environment — measured, not asserted.
 *
 * Every figure in this dialog used to be a literal typed into the JSX: "CPU Load 14%", "6.4 GB of
 * 16 GB", "Thermal Nominal", "Python v3.13", "Bun v1.2", and a green banner declaring "Zero
 * toolchain conflicts detected on this Mac". App.tsx passed `trustReport={null}`, so none of it was
 * ever connected to anything — on an 8 GB machine it still reported 16 GB, and it named an Electron
 * version two majors behind the one it was running in.
 *
 * The data it needed was already arriving twice over and being discarded:
 *   hardware  → `phase9.runtime.signals`, measured in main by `currentRuntimeSignals()`
 *   toolchain → `phase9.environment.tools`, a bounded read-only probe of 13 real executables
 * Both are polled every 30 s by `usePhase9`, which App.tsx already holds.
 *
 * Two rules this file now keeps:
 *   1. Nothing is displayed that is not measured. CPU *load* is measured nowhere, so the tile shows
 *      core count instead of inventing a percentage.
 *   2. The health line reports what the probe found, including "still checking" and "some tools
 *      were not found". It never claims a clean bill of health it did not verify.
 */

function gb(mb: number): string {
  return `${(mb / 1024).toFixed(1)} GB`;
}

const PRESSURE_TONE: Record<string, string> = {
  normal: 'text-emerald-400',
  warning: 'text-amber-400',
  critical: 'text-red-400',
  unknown: 'text-zinc-400',
};

const THERMAL_LABEL: Record<string, string> = {
  nominal: 'Nominal',
  fair: 'Fair',
  serious: 'Serious',
  critical: 'Critical',
  unknown: 'Unknown',
};

const THERMAL_TONE: Record<string, string> = {
  nominal: 'text-emerald-400',
  fair: 'text-emerald-400',
  serious: 'text-amber-400',
  critical: 'text-red-400',
  unknown: 'text-zinc-400',
};

/** A dash, never a guess: the tile renders this whenever the signal has not arrived yet. */
const PENDING = '—';

function Tile({ label, value, note, tone }: {
  label: string; value: string; note: string; tone?: string;
}): React.ReactElement {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3 text-center">
      <div className="text-[10px] text-zinc-400 uppercase tracking-wide">{label}</div>
      <div className="text-[16px] font-mono font-semibold text-white mt-0.5">{value}</div>
      <div className={`text-[9.5px] mt-0.5 ${tone ?? 'text-zinc-400'}`}>{note}</div>
    </div>
  );
}

function ToolRow({ tool }: { tool: WorkspaceToolStatus }): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-3 px-3.5 py-2">
      <span className="text-zinc-300 font-mono text-[12px] truncate">{tool.label}</span>
      {tool.state === 'ready' ? (
        <span className="font-mono text-[11px] text-zinc-400 shrink-0">
          {tool.version ? `v${tool.version.replace(/^v/, '')}` : (
            <span className="text-emerald-400 flex items-center gap-1"><CheckCircle2 size={12} /> Installed</span>
          )}
        </span>
      ) : (
        <span className="font-mono text-[11px] text-zinc-500 shrink-0">
          {tool.state === 'missing' ? 'not found' : 'unverified'}
        </span>
      )}
    </div>
  );
}

export function MachineHealthDialog({
  open,
  onOpenChange,
  phase9,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  phase9: Phase9View;
}): React.ReactElement {
  const signals = phase9.runtime?.signals ?? null;
  const environment = phase9.environment;

  const arch = signals
    ? (signals.architecture === 'arm64' ? 'Apple silicon · arm64'
      : signals.architecture === 'x64' ? 'Intel · x86_64' : 'Unknown architecture')
    : 'Reading this machine…';

  // Only tools the probe actually resolved or actively failed to find. `unverified` entries are
  // shown too — an unverified tool is information, and hiding it would be the same silent
  // optimism this dialog is being repaired for.
  const tools = environment?.tools ?? [];
  const ready = tools.filter((tool) => tool.state === 'ready').length;
  const missing = tools.filter((tool) => tool.state === 'missing').length;

  const health = (() => {
    if (!environment) {
      return { tone: 'zinc', title: 'Checking this machine', detail: 'Probing runtimes, package managers and local services. Nothing is being installed or modified.' };
    }
    if (missing === 0) {
      return { tone: 'emerald', title: `${ready} developer tools resolved`, detail: `Every tool this probe looks for was found. Read from ${environment.projectName || 'this project'} without sourcing shell profiles or running project scripts.` };
    }
    return {
      tone: 'amber',
      title: `${ready} of ${tools.length} developer tools resolved`,
      detail: `${missing} ${missing === 1 ? 'tool was' : 'tools were'} not found on PATH. That is only a problem if you need ${missing === 1 ? 'it' : 'them'} — the probe does not install anything.`,
    };
  })();

  const healthClasses = health.tone === 'emerald'
    ? { box: 'border-emerald-500/20 bg-emerald-500/10', icon: 'text-emerald-400', title: 'text-emerald-200', detail: 'text-emerald-300/80' }
    : health.tone === 'amber'
      ? { box: 'border-amber-500/20 bg-amber-500/10', icon: 'text-amber-400', title: 'text-amber-200', detail: 'text-amber-300/80' }
      : { box: 'border-white/10 bg-white/[0.03]', icon: 'text-zinc-400', title: 'text-zinc-200', detail: 'text-zinc-400' };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* No border/background/blur of its own: the shell is the app's glass now, and a second
          material here drew a box inside a box. Only the width and the light-on-dark ink are local. */}
      <DialogContent className="w-[min(28rem,calc(100vw-min(64px,40vw)))] overflow-hidden p-0 text-zinc-100">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4 bg-white/[0.02]">
          <div className="flex items-center gap-2.5">
            <div className="size-8 rounded-xl bg-white/10 border border-white/15 flex items-center justify-center text-white">
              <Cpu size={18} />
            </div>
            <div>
              <DialogTitle className="text-[15px] font-semibold text-white">
                Machine &amp; Environment
              </DialogTitle>
              <div className="text-[11px] text-zinc-400 font-mono">
                {arch}{signals ? ` · ${signals.cpuCount} cores` : ''}
              </div>
            </div>
          </div>
          <button
            onClick={() => onOpenChange(false)}
            aria-label="Close"
            className="flex size-7 items-center justify-center rounded-lg text-zinc-400 hover:bg-white/10 hover:text-white transition-colors cursor-pointer"
          >
            <X size={15} />
          </button>
        </div>

        <div className="p-5 space-y-4 text-[13px]">
          {/* Measured hardware */}
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-2">
              Hardware Resources
            </div>
            <div className="grid grid-cols-3 gap-2">
              {/* Cores, not load. Nothing on this machine measures CPU load, and a number nobody
                  computes is exactly what this dialog was rebuilt to remove. */}
              <Tile
                label="CPU"
                value={signals ? String(signals.cpuCount) : PENDING}
                note={signals ? 'cores' : 'reading…'}
              />
              <Tile
                label="Memory free"
                value={signals ? gb(signals.availableMemoryMb) : PENDING}
                note={signals ? `of ${gb(signals.totalMemoryMb)} · ${signals.memoryPressure}` : 'reading…'}
                tone={signals ? PRESSURE_TONE[signals.memoryPressure] : undefined}
              />
              <Tile
                label="Thermal"
                value={signals ? THERMAL_LABEL[signals.thermal] : PENDING}
                note={signals ? (signals.powerSource === 'battery' ? 'on battery' : signals.powerSource === 'ac' ? 'on power' : 'power unknown') : 'reading…'}
                tone={signals ? THERMAL_TONE[signals.thermal] : undefined}
              />
            </div>
          </div>

          {/* Probed toolchains */}
          <div>
            <div className="flex items-baseline justify-between gap-3 mb-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                Runtime &amp; Toolchains
              </div>
              {phase9.refreshing ? (
                <span className="text-[10px] text-zinc-500 flex items-center gap-1"><Activity size={10} /> refreshing</span>
              ) : null}
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[0.03] divide-y divide-white/5 max-h-56 overflow-y-auto">
              {tools.length === 0 ? (
                <div className="px-3.5 py-3 text-[11.5px] text-zinc-500">
                  {environment ? 'The probe returned no tools.' : 'Probing this machine…'}
                </div>
              ) : (
                tools.map((tool) => <ToolRow key={tool.id} tool={tool} />)
              )}
            </div>
            {environment?.declarations.length ? (
              <div className="mt-2 flex items-center gap-1.5 text-[10.5px] text-zinc-500">
                <HardDrive size={11} className="shrink-0" />
                <span className="truncate">
                  Declared by this project: {environment.declarations.map((d) => d.ecosystem).join(', ')}
                </span>
              </div>
            ) : null}
          </div>

          {/* Derived health — never a blanket assertion */}
          <div className={`rounded-xl border p-3 flex items-center gap-3 ${healthClasses.box}`}>
            <ShieldCheck size={18} className={`shrink-0 ${healthClasses.icon}`} />
            <div className="min-w-0">
              <div className={`text-[12.5px] font-semibold ${healthClasses.title}`}>
                {health.title}
              </div>
              <div className={`text-[11px] ${healthClasses.detail}`}>
                {health.detail}
              </div>
            </div>
          </div>

          {environment ? (
            <div className="flex items-center gap-1.5 text-[10px] text-zinc-500">
              <Thermometer size={10} className="shrink-0" />
              <span>Read at {new Date(environment.generatedAt).toLocaleTimeString()} · nothing was installed, no shell profile was sourced, no project script was run.</span>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
