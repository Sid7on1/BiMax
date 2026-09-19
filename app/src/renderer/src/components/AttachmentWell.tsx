import React, { useEffect } from 'react';
import { X, FileText, Upload, RotateCcw } from 'lucide-react';
import { cn } from '../lib/cn';

/** Files keep the same visible read state in the attachment tray and the prompt. */
export interface Attachment {
  /** Path as the engine will resolve it: project-relative when inside the project, else absolute. */
  path: string;
  name: string;
  /** Bytes; 0 when unknown (the picker gives no size, a drop does). Cosmetic. */
  size: number;
  /**
   * Whether the engine has actually READ this file yet.
   *
   * Shown on the tile because "attached" and "read" are different claims, and only the second one
   * means the model can answer from it. A file that failed to parse must say so at attach time, not
   * silently produce an answer sourced from nothing.
   */
  state: 'reading' | 'read' | 'failed';
  /** Passages the document became, once read. */
  chunks?: number;
  /** Why it could not be read. */
  reason?: string;
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
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
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      // Tinted rather than a near-opaque slab, but still backed by a blur: this overlays the
      // composer's own textarea, and text showing through text is the one thing it must not do.
      className="absolute inset-0 z-20 flex flex-col rounded-[22px] bg-[var(--float-veil)] backdrop-blur-md"
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
        <Upload size={24} className="text-dim" />
        <span className="font-display text-[13px] text-faint transition-colors group-hover:text-ink">
          {dragging ? 'Drop files to add context' : 'Choose files or drop them here'}
        </span>
      </button>

      <div className="flex shrink-0 items-center justify-between px-4 pb-3 text-[11px] text-faint">
        <span>{attachments.length ? `${attachments.length} attached` : 'Files are checked before sending'}</span>
        <button type="button" onClick={onClose} className="rounded px-2 py-1 hover:text-ink">
          Done
        </button>
      </div>
    </div>
  );
}

/** One attached file: its real icon, its name, and a way to take it back out. */
export function FileTile({
  file, onRemove, onRetry, compact = false, locked = false,
}: { file: Attachment; onRemove: () => void; onRetry?: () => void; compact?: boolean; locked?: boolean }): React.ReactElement {
  return (
    <span
      className={cn(
        'group/tile relative inline-flex items-center gap-2 rounded-xl border border-line bg-base/60 pl-1.5 pr-2 py-1.5',
        compact ? 'max-w-[190px]' : 'max-w-[220px]',
      )}
      title={file.reason || file.name}
    >
      <FileText size={compact ? 22 : 28} aria-hidden className="shrink-0 text-dim" />
      <span className="min-w-0 leading-tight">
        <span className="block truncate text-[12px] text-ink">{file.name}</span>
        <span className={cn('block text-[10px]',
          file.state === 'failed' ? 'text-ember' : 'text-faint')}>
          {file.state === 'reading' && 'reading…'}
          {file.state === 'read' && (file.chunks ? `read · ${file.chunks} passage${file.chunks === 1 ? '' : 's'}` : 'read')}
          {file.state === 'failed' && (file.reason || 'could not be read')}
          {file.state === 'read' && !compact && !!file.size && ` · ${formatBytes(file.size)}`}
        </span>
      </span>
      {onRetry && <button type="button" disabled={locked} aria-label={`Retry ${file.name}`} onClick={onRetry} className="shrink-0 rounded-full p-1 text-dim hover:text-ink"><RotateCcw size={12} /></button>}
      <button
        type="button"
        onClick={onRemove}
        disabled={locked}
        aria-label={`Remove ${file.name}`}
        className="ml-0.5 shrink-0 rounded-full p-0.5 text-faint transition-colors hover:text-ink"
      >
        <X size={12} />
      </button>
    </span>
  );
}
