import React, { useCallback, useEffect, useState } from 'react';
import { CircleCheck, HardDrive, RefreshCw } from 'lucide-react';
import { cn } from '../lib/cn';
import type { LocalModelReport, LocalRuntimeEntry } from '../global';

/**
 * What this machine can run without the network.
 *
 * The one thing this panel must not do is flatten "downloaded" into "usable". A Hugging Face cache
 * directory is weights on disk; a running Ollama is an endpoint. Presenting both as pickable
 * models sends the user to an entry where every request fails, so the servable ones are the only
 * ones that get a button, and everything else states what it is and what would change that.
 */
export function LocalModels({ onUse }: {
  onUse: (input: { baseURL: string; model: string }) => Promise<void>;
}): React.ReactElement {
  const [report, setReport] = useState<LocalModelReport | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState('');

  const scan = useCallback(async () => {
    setScanning(true);
    try { setReport(await window.bimax.providers.localModels()); }
    catch { setReport(null); }
    finally { setScanning(false); }
  }, []);

  useEffect(() => { void scan(); }, [scan]);

  const use = useCallback(async (runtime: LocalRuntimeEntry, model: string) => {
    if (!runtime.baseURL) return;
    setBusy(model);
    try { await onUse({ baseURL: runtime.baseURL, model }); }
    finally { setBusy(''); }
  }, [onUse]);

  const servable = report?.servable.length ?? 0;

  return (
    <section className="rounded-xl border border-line bg-raise/50 p-3">
      <div className="flex items-center gap-2">
        <HardDrive size={14} className="shrink-0 text-dim" />
        <span className="text-[12.5px] font-semibold text-ink">On this machine</span>
        <span className="text-[10.5px] text-faint">
          {report ? (servable > 0 ? `${servable} ready to use` : 'nothing ready to use yet') : 'scanning…'}
        </span>
        <button
          onClick={() => void scan()}
          aria-label="Rescan local model runtimes"
          className="ml-auto shrink-0 cursor-pointer rounded-md p-1 text-faint hover:bg-hover hover:text-ink"
        >
          <RefreshCw size={12} className={cn(scanning && 'animate-spin')} />
        </button>
      </div>

      <div className="mt-2.5 space-y-2">
        {(report?.runtimes ?? []).map((runtime) => (
          <div key={runtime.id} className="rounded-lg border border-line/70 px-2.5 py-2">
            <div className="flex items-center gap-2">
              <span className={cn(
                'size-1.5 shrink-0 rounded-full',
                runtime.running ? 'bg-moss' : runtime.installed ? 'bg-amber' : 'bg-line',
              )} />
              <span className="text-[11.5px] font-medium text-ink">{runtime.label}</span>
              <span className="text-[10px] text-faint">
                {runtime.running ? 'running' : runtime.installed ? 'installed' : 'not installed'}
              </span>
            </div>

            {runtime.hint && <p className="mt-1 text-[10.5px] leading-relaxed text-dim">{runtime.hint}</p>}

            {runtime.models.length > 0 && (
              <ul className="mt-1.5 space-y-1">
                {runtime.models.slice(0, 8).map((model) => (
                  <li key={model.id} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-dim" title={model.detail}>
                      {model.label}
                      {model.sizeBytes ? ` · ${(model.sizeBytes / 1e9).toFixed(1)} GB` : ''}
                    </span>
                    {model.servable ? (
                      <button
                        onClick={() => void use(runtime, model.id)}
                        disabled={!!busy}
                        className="shrink-0 cursor-pointer rounded-md border border-line bg-raise px-1.5 py-0.5 text-[10px] text-dim hover:bg-hover hover:text-ink disabled:opacity-40"
                      >
                        {busy === model.id ? 'Setting…' : 'Use'}
                      </button>
                    ) : (
                      <span className="shrink-0 text-[9.5px] text-faint">not served</span>
                    )}
                  </li>
                ))}
                {runtime.models.length > 8 && (
                  <li className="text-[10px] text-faint">+{runtime.models.length - 8} more</li>
                )}
              </ul>
            )}
          </div>
        ))}
      </div>

      {servable > 0 && (
        <p className="mt-2 flex items-start gap-1.5 text-[10px] text-faint">
          <CircleCheck size={11} className="mt-px shrink-0 text-moss" />
          Choosing one points Bimax at that local server. Nothing leaves this machine.
        </p>
      )}
    </section>
  );
}
