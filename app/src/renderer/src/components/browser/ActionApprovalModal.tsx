import React from 'react';
import { AlertTriangle, Check, X, ShieldAlert, CreditCard, Send, Trash2 } from 'lucide-react';

export interface ActionApprovalRequest {
  id: string;
  action: string;
  targetDescription: string;
  impactType: 'payment' | 'send' | 'delete' | 'permission' | 'high_impact';
  details?: Record<string, string>;
}

export function ActionApprovalModal({
  request,
  onApprove,
  onReject,
}: {
  request: ActionApprovalRequest | null;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}): React.ReactElement | null {
  if (!request) return null;

  const getImpactIcon = () => {
    switch (request.impactType) {
      case 'payment':
        return <CreditCard size={18} className="text-rust" />;
      case 'send':
        return <Send size={18} className="text-amber" />;
      case 'delete':
        return <Trash2 size={18} className="text-rust" />;
      default:
        return <AlertTriangle size={18} className="text-amber" />;
    }
  };

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-canvas/60 backdrop-blur-xs p-4 select-none">
      <div className="w-full max-w-md rounded-lg border border-line bg-panel p-5 shadow-2xl space-y-4 animate-in fade-in zoom-in-95 duration-150">
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-amber/10 border border-amber/20">
            {getImpactIcon()}
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-[13.5px] font-semibold text-ink flex items-center gap-1.5">
              <span>Action Approval Required</span>
            </h3>
            <p className="mt-1 text-[12px] text-dim leading-relaxed">
              Bimax wants to perform a high-impact action:
            </p>
            <div className="mt-2 rounded bg-canvas border border-line/70 p-2.5 text-[11.5px] font-mono text-ink">
              <span className="text-amber font-semibold">{request.action.toUpperCase()}</span>: {request.targetDescription}
            </div>
          </div>
        </div>

        {request.details && Object.keys(request.details).length > 0 && (
          <div className="rounded border border-line/60 bg-canvas/50 p-2.5 text-[11px] space-y-1">
            {Object.entries(request.details).map(([key, val]) => (
              <div key={key} className="flex justify-between text-dim">
                <span className="font-medium text-faint">{key}:</span>
                <span className="text-ink font-mono">{val}</span>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-line/60">
          <button
            type="button"
            onClick={() => onReject(request.id)}
            className="flex items-center gap-1 rounded border border-line px-3 py-1.5 text-[12px] font-medium text-dim hover:bg-canvas hover:text-ink transition-colors"
          >
            <X size={13} />
            <span>Cancel</span>
          </button>
          <button
            type="button"
            onClick={() => onApprove(request.id)}
            className="flex items-center gap-1 rounded bg-moss px-3.5 py-1.5 text-[12px] font-medium text-canvas hover:bg-moss/90 shadow-sm transition-colors"
          >
            <Check size={13} />
            <span>Approve Action</span>
          </button>
        </div>
      </div>
    </div>
  );
}
