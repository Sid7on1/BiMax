import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { cn } from '../lib/cn';

/**
 * The attachment well — the Composer's "drop anything" surface.
 *
 * Opened by the `+` button, it covers the composer entirely: a black hole at the centre that opens
 * the file picker wherever you click, "Click or Drop" beneath it, and the files you have added
 * sitting along the top. Enter closes it and the attachments move above the prompt.
 *
 * ## Why real Finder icons and not filenames
 *
 * An attachment should look like the document the person recognises. `app.getFileIcon` returns the
 * exact icon Finder draws — the red Acrobat sheet, the green spreadsheet grid — so a tray of four
 * files is scannable at a glance. The previous behaviour pasted `/Users/<name>/Desktop/<file>.pdf`
 * into the textarea as raw characters: it took the full width, buried the prompt the user was
 * writing, and could only be removed with backspace.
 *
 * The absolute path is never shown. It is an implementation detail of how the engine resolves the
 * file, not something a person should have to read.
 */

export interface Attachment {
  /** Path as the engine will resolve it: project-relative when inside the project, else absolute. */
  path: string;
  name: string;
  /** Data URL of the real Finder icon; empty until resolved, or if the lookup failed. */
  icon: string;
  /** Bytes, 0 when unknown. Cosmetic. */
  size: number;
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * The black hole.
 *
 * Three layers, all CSS so there is no asset to load and nothing to fetch: a slowly rotating
 * accretion ring (conic gradient), a soft glow that breathes, and the event horizon itself — a
 * radial gradient that is genuinely black in the middle. `prefers-reduced-motion` stops the
 * rotation and the breathing; the shape stays, because the shape is the affordance.
 */
function BlackHole({ pulling }: { pulling: boolean }): React.ReactElement {
  return (
    <div className={cn('relative grid place-items-center transition-transform duration-300',
      pulling ? 'scale-110' : 'scale-100')}>
      <style>{`
        @keyframes bimax-accretion { to { transform: rotate(360deg); } }
        @keyframes bimax-breathe {
          0%, 100% { opacity: .55; transform: scale(1); }
          50%      { opacity: .9;  transform: scale(1.06); }
        }
        @media (prefers-reduced-motion: reduce) {
          .bimax-accretion, .bimax-glow { animation: none !important; }
        }
      `}</style>

      {/* Outer glow — the light bending around it. */}
      <div
        aria-hidden
        className="bimax-glow absolute h-[150px] w-[150px] rounded-full blur-2xl"
        style={{
          background: 'radial-gradient(circle, rgba(255,138,76,.45) 0%, rgba(255,138,76,.10) 55%, transparent 70%)',
          animation: 'bimax-breathe 3.6s ease-in-out infinite',
        }}
      />

      {/* Accretion disc — a conic gradient rotating behind the horizon. */}
      <div
        aria-hidden
        className="bimax-accretion absolute h-[104px] w-[104px] rounded-full"
        style={{
          background: 'conic-gradient(from 0deg, transparent 0deg, rgba(255,168,92,.95) 45deg, rgba(255,214,170,1) 90deg, rgba(255,138,76,.7) 150deg, transparent 240deg, transparent 360deg)',
          animation: `bimax-accretion ${pulling ? '2.2s' : '7s'} linear infinite`,
          maskImage: 'radial-gradient(circle, transparent 56%, #000 60%)',
          WebkitMaskImage: 'radial-gradient(circle, transparent 56%, #000 60%)',
        }}
      />

      {/* Event horizon. Actually black, with a rim of lensed light. */}
      <div
        aria-hidden
        className="relative h-[92px] w-[92px] rounded-full"
        style={{
          background: 'radial-gradient(circle at 50% 50%, #000 0%, #000 62%, rgba(20,14,10,.96) 78%, rgba(0,0,0,0) 100%)',
          boxShadow: 'inset 0 0 22px 6px rgba(0,0,0,1), 0 0 26px 2px rgba(255,138,76,.28)',
        }}
      />
    </div>
  );
}

export function AttachmentWell({
  attachments, dragging, onPick, onRemove, onClose,
}: {
  attachments: Attachment[];
  /** True while files are being dragged over the composer — the hole reacts. */
  dragging: boolean;
  onPick: () => void;
  onRemove: (path: string) => void;
  onClose: () => void;
}): React.ReactElement {
  // Enter closes the well and returns focus to the prompt. Escape does the same — a surface that
  // covers the composer must always be dismissible by the key people reach for first.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="absolute inset-0 z-20 flex flex-col rounded-[22px] bg-raise/95 backdrop-blur-sm"
      role="dialog"
      aria-label="Attach files"
    >
      {/* Added files live along the TOP, so the hole below stays clickable as the tray fills. */}
      <div className="min-h-0 shrink-0 px-4 pt-3">
        {attachments.length > 0 && (
          <div className="flex max-h-[104px] flex-wrap gap-2 overflow-y-auto">
            {attachments.map((file) => (
              <FileTile key={file.path} file={file} onRemove={() => onRemove(file.path)} />
            ))}
          </div>
        )}
      </div>

      {/* The whole middle is the target: "wherever I click on that it should open a file". */}
      <button
        type="button"
        onClick={onPick}
        aria-label="Choose files to attach"
        className="group flex min-h-0 flex-1 cursor-pointer flex-col items-center justify-center gap-4 rounded-[18px] outline-none"
      >
        <BlackHole pulling={dragging} />
        <span className="font-display text-[13px] text-faint transition-colors group-hover:text-ink">
          {dragging ? 'Let go — it reads anything' : 'Click or Drop'}
        </span>
      </button>

      <div className="flex shrink-0 items-center justify-between px-4 pb-3 text-[11px] text-faint">
        <span>{attachments.length ? `${attachments.length} attached` : 'PDFs, scans, spreadsheets, notes — anything with text'}</span>
        <button type="button" onClick={onClose} className="rounded px-2 py-1 hover:text-ink">
          Done <span className="opacity-60">↵</span>
        </button>
      </div>
    </div>
  );
}

/** One attached file: its real icon, its name, and a way to take it back out. */
export function FileTile({
  file, onRemove, compact = false,
}: { file: Attachment; onRemove: () => void; compact?: boolean }): React.ReactElement {
  const [broken, setBroken] = useState(false);
  return (
    <span
      className={cn(
        'group/tile relative inline-flex items-center gap-2 rounded-xl border border-line bg-base/60 pl-1.5 pr-2 py-1.5',
        compact ? 'max-w-[190px]' : 'max-w-[220px]',
      )}
      title={file.name}
    >
      {file.icon && !broken ? (
        // The real Finder icon. Decorative: the filename beside it carries the meaning.
        <img
          src={file.icon}
          alt=""
          aria-hidden
          onError={() => setBroken(true)}
          className={compact ? 'h-6 w-6 shrink-0' : 'h-8 w-8 shrink-0'}
        />
      ) : (
        // Only reached when Launch Services has no icon for the type — a neutral placeholder, never
        // a guessed glyph that would claim the wrong file type.
        <span className={cn('shrink-0 rounded bg-line/60', compact ? 'h-6 w-6' : 'h-8 w-8')} />
      )}
      <span className="min-w-0 leading-tight">
        <span className="block truncate text-[12px] text-ink">{file.name}</span>
        {!compact && !!file.size && (
          <span className="block text-[10px] text-faint">{formatBytes(file.size)}</span>
        )}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${file.name}`}
        className="ml-0.5 shrink-0 rounded-full p-0.5 text-faint opacity-0 transition-opacity hover:text-ink focus:opacity-100 group-hover/tile:opacity-100"
      >
        <X size={12} />
      </button>
    </span>
  );
}
