import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { isTurnScopedCapability, type CapabilityNotice } from '../engine.state';

/** How long a per-call failure stays on screen. Its tool card in the transcript keeps the detail. */
const TURN_NOTICE_MS = 9000;

/**
 * Capability problems, compact and quiet.
 *
 * Two kinds of notice arrive here and they are not treated alike. A subsystem outage — memory recall,
 * embeddings, an MCP server — is a standing condition and stays until the engine reports that
 * capability ready again. A per-call failure describes a single turn (see `isTurnScopedCapability`):
 * it fades after a few seconds and clears when the next turn starts.
 *
 * Every notice can be dismissed. A dismissal is keyed to the notice's `observedAt`, so the same
 * capability failing again later is shown again rather than silently swallowed.
 */
export function CapabilityBanner({ notices }: { notices: CapabilityNotice[] }): React.ReactElement | null {
  const [dismissed, setDismissed] = useState<Record<string, string>>({});
  const [now, setNow] = useState(() => Date.now());
  const expiring = notices.some((notice) => isTurnScopedCapability(notice.id));

  useEffect(() => {
    if (!expiring) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [expiring]);

  const visible = notices.filter((notice) => {
    if (dismissed[notice.id] === notice.observedAt) return false;
    if (!isTurnScopedCapability(notice.id)) return true;
    const observed = Date.parse(notice.observedAt);
    return Number.isNaN(observed) || now - observed < TURN_NOTICE_MS;
  });
  if (!visible.length) return null;

  return (
    <section role="status" aria-live="polite" aria-label="Capability problems" className="capability-banner">
      {visible.map((notice) => (
        <div key={notice.id} className="capability-notice" data-capability-id={notice.id}>
          <span className="capability-dot" aria-hidden />
          <details className="min-w-0 flex-1">
            <summary>
              <strong>{notice.label}</strong>
              <span className="capability-impact" title={notice.impact}>
                {notice.state}{notice.impact ? ` — ${notice.impact}` : ''}
              </span>
            </summary>
            <p>{notice.reason} {notice.action}</p>
          </details>
          <button
            type="button"
            aria-label={`Dismiss ${notice.label} notice`}
            className="capability-dismiss"
            onClick={() => setDismissed((current) => ({ ...current, [notice.id]: notice.observedAt }))}
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </section>
  );
}
