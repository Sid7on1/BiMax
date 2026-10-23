import React from 'react';
import { AlertTriangle, ArrowRight, RefreshCcw, RotateCcw, ShieldCheck } from 'lucide-react';
import type { RecoveryActionName, SupervisorStatus } from '../global';

/**
 * Human-facing recovery notice. Startup is intentionally silent: opening a project should feel
 * like opening a workspace, not watching infrastructure boot. Technical detail lives in Settings.
 *
 * This renders for a CRASH only. `degraded` is deliberately silent: it means the supervisor shed
 * an optional capability (codebase memory, drives boot) because the machine is low on free memory
 * — the documented adaptive path, not a fault. On an 8GB Mac that state is effectively permanent,
 * so surfacing it put a warning banner above every session for a system that was working exactly
 * as designed. Nothing is broken and there is no action to take, so there is nothing to say.
 *
 * This component was written during Phase 2 but never rendered by anything — a crashed engine
 * simply produced a task surface that had stopped responding, with no statement and no way back.
 * Phase 5 wires it into the task column, which is the only place a crash is actually in the way.
 */
export function EngineStatusBanner({
  status, onAction, onOpenSupport,
}: {
  status: SupervisorStatus;
  onAction: (action: RecoveryActionName, sessionId?: string) => void;
  onOpenSupport: () => void;
}): React.ReactElement | null {
  const failed = status.phase === 'exited' || status.phase === 'failed';

  if (!failed) return null;

  return (
    <section
      aria-label="Bimax status"
      aria-live="polite"
      className="shrink-0 border-b border-rust/25 bg-rust/8 px-4 py-2.5"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-rust/12 text-rust">
          <AlertTriangle size={14} />
        </span>
        <div className="min-w-[220px] flex-1">
          <div className="text-[12.5px] font-medium text-rust">Bimax hit a problem</div>
          <div className="mt-0.5 text-[11px] text-dim">Your work is safe. Try again to continue.</div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <NoticeButton icon={<RefreshCcw size={12} />} label="Try again" primary onClick={() => onAction('retry')} />
          <NoticeButton icon={<ShieldCheck size={12} />} label="Start safely" onClick={() => onAction('restartSafe')} />
          {status.interruptedSessionId && (
            <NoticeButton icon={<RotateCcw size={12} />} label="Restore last task" onClick={() => onAction('restartSafe', status.interruptedSessionId)} />
          )}
          <button onClick={onOpenSupport} className="flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] text-dim hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-ember">
            Open settings <ArrowRight size={11} />
          </button>
        </div>
      </div>
    </section>
  );
}

function NoticeButton({ icon, label, primary = false, onClick }: {
  icon: React.ReactNode;
  label: string;
  primary?: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      onClick={onClick}
      className={`flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium ${primary ? 'bg-ink text-bg hover:bg-white' : 'border border-line bg-raise text-dim hover:bg-hover hover:text-ink'}`}
    >
      {icon}{label}
    </button>
  );
}
