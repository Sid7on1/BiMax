import React, { useEffect, useState } from 'react';
import { Play } from 'lucide-react';
import type { VoiceSettingsView } from '../../../preload/index';

/**
 * Settings → Voice (backlog N7): the voice talk mode speaks with, and how fast. "Automatic" is the best voice
 * installed for the Mac's language. Only Premium and Enhanced voices sound natural; when none is installed, the
 * page says where to download one.
 */
const QUALITY = { premium: 'Premium', enhanced: 'Enhanced', default: 'Basic' } as const;
const speed = (rate: number): string => (rate === 1 ? 'Normal' : `${rate}×`);

export function VoiceSettings(): React.ReactElement {
  const [view, setView] = useState<VoiceSettingsView | null | undefined>(undefined);
  const [voice, setVoice] = useState('');
  const [rate, setRate] = useState(1);
  const [updates, setUpdates] = useState(false);

  useEffect(() => {
    void window.bimax.voice.voices().then((value) => {
      setView(value);
      if (value) { setVoice(value.chosen); setRate(value.rate); setUpdates(value.speakUpdates); }
    }).catch(() => setView(null));
  }, []);

  const choose = (nextVoice: string, nextRate: number): void => {
    setVoice(nextVoice); setRate(nextRate);
    void window.bimax.voice.choose(nextVoice, nextRate);
  };

  if (view === undefined) return <div className="mt-6 h-16 animate-pulse rounded-xl bg-raise" />;
  if (!view || !view.voices.length) {
    return <p className="mt-6 text-xs text-faint">Bimax could not list this Mac’s voices. Talk mode uses the Mac’s own voice.</p>;
  }
  const automatic = view.voices.find((v) => v.id === view.automatic);
  return (
    <div className="mt-2 space-y-5">
      <label className="block">
        <span className="text-[13px] font-medium text-ink">Voice</span>
        <span className="mt-0.5 block text-[11.5px] text-dim">The voice Bimax speaks with in talk mode.</span>
        <select value={voice} onChange={(e) => choose(e.target.value, rate)} className="mt-2 w-full max-w-[420px] rounded-lg border border-line bg-raise px-2.5 py-1.5 text-[13px] text-ink">
          <option value="">Automatic{automatic ? ` · ${automatic.name} (${QUALITY[automatic.quality]})` : ''}</option>
          {view.voices.map((v) => <option key={v.id} value={v.id}>{v.name} · {v.language} · {QUALITY[v.quality]}</option>)}
        </select>
      </label>
      <div>
        <span className="text-[13px] font-medium text-ink">Speaking speed</span>
        <div className="mt-2 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Speaking speed">
          {view.rates.map((r) => (
            <button key={r} role="radio" aria-checked={rate === r} onClick={() => choose(voice, r)}
              className={`rounded-lg border px-2.5 py-1 text-[12px] ${rate === r ? 'border-ember/60 bg-ember/10 text-ink' : 'border-line text-dim hover:text-ink'}`}>
              {speed(r)}
            </button>
          ))}
        </div>
      </div>
      <label className="flex max-w-[520px] items-start gap-2.5">
        <input type="checkbox" className="mt-0.5" checked={updates} onChange={(e) => { setUpdates(e.target.checked); void window.bimax.voice.speakUpdates(e.target.checked); }} />
        <span>
          <span className="block text-[13px] font-medium text-ink">Speak when a task finishes</span>
          <span className="mt-0.5 block text-[11.5px] text-dim">When a task you are not looking at finishes, Bimax says so out loud — its name, how it ended, and the first sentence of its answer.</span>
        </span>
      </label>
      <button onClick={() => void window.bimax.voice.preview(voice, rate)} className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12.5px] text-ink hover:bg-hover">
        <Play size={12} aria-hidden /> Preview
      </button>
      {view.onlyBasic ? (
        <p className="max-w-[520px] rounded-xl border border-amber/30 bg-amber/8 px-3 py-2 text-[12px] text-amber">
          Only basic voices are installed. For a natural voice, download a Premium or Enhanced one in System Settings → Accessibility → Spoken Content → System voice → Manage Voices, then choose it here.
        </p>
      ) : (
        <p className="text-[11.5px] text-dim">Premium and Enhanced voices sound the most natural.</p>
      )}
    </div>
  );
}
