/**
 * Voice settings (backlog N7): which voice talk mode speaks with, and how fast. The on-device helper lists the
 * installed voices (`bimax-voice --voices`) and speaks with `--voice <id> --rate <x>`; these helpers decide what the
 * picker shows and what reaches the helper's command line, so they are tested without the helper.
 */

export type VoiceQuality = 'default' | 'enhanced' | 'premium';
export interface VoiceOption { id: string; name: string; language: string; quality: VoiceQuality }
export interface VoiceList { voices: VoiceOption[]; automatic: string }

/** The speeds offered, as multiples of the Mac's normal speaking rate. */
export const SPEECH_RATES = [0.8, 0.9, 1, 1.1, 1.25, 1.5] as const;
export const DEFAULT_RATE = 1;

const VOICE_ID = /^[A-Za-z0-9._-]{1,200}$/;
const QUALITY_RANK: Record<VoiceQuality, number> = { premium: 3, enhanced: 2, default: 1 };

/** The helper's `voices` line, with anything malformed left out. */
export function parseVoiceList(stdout: string): VoiceList {
  for (const line of stdout.split('\n')) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    const event = value as { event?: unknown; voices?: unknown; automatic?: unknown };
    if (event?.event !== 'voices' || !Array.isArray(event.voices)) continue;
    const voices: VoiceOption[] = [];
    for (const raw of event.voices as Array<Record<string, unknown>>) {
      const { id, name, language, quality } = raw ?? {};
      if (typeof id !== 'string' || !VOICE_ID.test(id) || typeof name !== 'string' || typeof language !== 'string') continue;
      voices.push({ id, name, language, quality: quality === 'premium' || quality === 'enhanced' ? quality : 'default' });
    }
    return { voices, automatic: typeof event.automatic === 'string' && VOICE_ID.test(event.automatic) ? event.automatic : '' };
  }
  return { voices: [], automatic: '' };
}

/**
 * What the picker offers: best quality first, then by name. The Mac's old novelty and robot voices
 * (`com.apple.speech.synthesis.voice.*` — Bad News, Bubbles, Zarvox…) are left out, unless one is the current choice.
 */
export function pickerVoices(voices: readonly VoiceOption[], chosen: string | undefined): VoiceOption[] {
  return voices
    .filter((voice) => !voice.id.startsWith('com.apple.speech.synthesis.voice.') || voice.id === chosen)
    .sort((a, b) => QUALITY_RANK[b.quality] - QUALITY_RANK[a.quality] || a.name.localeCompare(b.name) || a.language.localeCompare(b.language));
}

/** True when only the basic voices are installed, so Settings can say where to get a natural one. */
export function onlyBasicVoices(voices: readonly VoiceOption[]): boolean {
  return !voices.some((voice) => voice.quality !== 'default');
}

export function qualityLabel(quality: VoiceQuality): string {
  return quality === 'premium' ? 'Premium' : quality === 'enhanced' ? 'Enhanced' : 'Basic';
}

/** A saved voice id, or undefined for "choose the best one" (a malformed id is treated the same). */
export function validVoice(value: unknown): string | undefined {
  return typeof value === 'string' && VOICE_ID.test(value) ? value : undefined;
}

/** A saved speed, snapped to one of SPEECH_RATES; anything else means the normal speed. */
export function validRate(value: unknown): number {
  return typeof value === 'number' && (SPEECH_RATES as readonly number[]).includes(value) ? value : DEFAULT_RATE;
}

/** The helper arguments that make talk mode (and a preview) speak with the chosen voice and speed. */
export function speakingArguments(settings: { talkVoice?: unknown; talkRate?: unknown }): string[] {
  const voice = validVoice(settings.talkVoice);
  const rate = validRate(settings.talkRate);
  return [...(voice ? ['--voice', voice] : []), ...(rate !== DEFAULT_RATE ? ['--rate', String(rate)] : [])];
}
