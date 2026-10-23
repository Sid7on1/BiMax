import React from 'react';
import { Mic } from 'lucide-react';
import type { Dictation } from '../useDictation';

/**
 * The dictation button. Absent where dictation can't run (before macOS 26, or without the helper); while listening,
 * a ring follows the voice (--mic-level). Mouse-down keeps focus in the field so the words land at its cursor.
 */
export function MicButton({ dictation, className, size = 16, disabled }: {
  dictation: Dictation;
  className?: string;
  size?: number;
  disabled?: boolean;
}): React.ReactElement | null {
  if (!dictation.available) return null;
  const live = dictation.state !== 'idle';
  return (
    <button
      type="button"
      className={`mic-button ${className ?? ''}`}
      data-listening={live ? dictation.state : undefined}
      aria-pressed={live}
      aria-label={live ? 'Stop dictation' : 'Dictate'}
      title={live ? 'Stop dictation · Esc discards' : 'Dictate — click, or hold right ⌥'}
      disabled={disabled}
      style={{ '--mic-level': dictation.level.toFixed(2) } as React.CSSProperties}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => dictation.toggle()}
    >
      <Mic size={size} aria-hidden />
    </button>
  );
}
