import React, { useCallback, useEffect, useState } from 'react';
import { Check, CircleAlert, Copy, ShieldCheck, ShieldOff } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { PermissionsPane, type Disposition } from './PermissionsPane';
import type { ManualAlphaServiceStatus } from '../global';
import { cn } from '../lib/cn';

/**
 * The permissions window — what replaced the Trust Center.
 *
 * The Trust Center reported on build identity, executable digests and signature state: true things
 * nobody acted on. The only question a user ever brought to it was "why can't Bimax see my screen",
 * and the answer to that is a permission switch. So this window answers exactly that and drops the
 * rest.
 *
 * Readings come from the main process's non-prompting probes, never from anything the renderer
 * infers — a permission UI that guesses is worse than none, because it teaches the user to distrust
 * a green tick.
 */
export function PermissionsDialog({
  open, onClose,
}: {
  open: boolean;
  onClose: () => void;
}): React.ReactElement {
  const [readings, setReadings] = useState<Record<string, Disposition>>({});
  const [probeState, setProbeState] = useState<'checking' | 'ready' | 'unavailable'>('checking');
  const [readingSource, setReadingSource] = useState<'helper' | 'in-process'>();
  const [host, setHost] = useState<{ name: string; bundle: string; isDevHost: boolean } | null>(null);
  const [checkedAt, setCheckedAt] = useState<number>();
  const [manualAlpha, setManualAlpha] = useState<ManualAlphaServiceStatus | null>(null);
  const [serviceCoach, setServiceCoach] = useState<'accessibility' | 'screenRecording' | null>(null);

  /**
   * Read all four live from the main process, along with WHICH bundle they belong to.
   *
   * This deliberately does not go through the trust report: that only covered two permissions and
   * said nothing about the responsible executable, which is the fact that makes the other readings
   * interpretable at all.
   */
  const refreshPermissions = useCallback(async () => {
    try {
      const probe = await window.bimax.permissionCoach.probe();
      if (!probe) {
        setReadings({});
        setReadingSource(undefined);
        setProbeState('unavailable');
        return;
      }
      setReadings(probe.readings as Record<string, Disposition>);
      setReadingSource(probe.readingSource);
      setHost({ name: probe.responsibleName, bundle: probe.responsibleBundle, isDevHost: probe.isDevHost });
      setCheckedAt(Date.now());
      setProbeState('ready');
    } catch {
      setReadings({});
      setReadingSource(undefined);
      setProbeState('unavailable');
    }
  }, []);

  const refreshService = useCallback(async () => {
    setManualAlpha(await window.bimax.manualAlpha.status().catch(() => null));
  }, []);

  const refresh = useCallback(async () => {
    await Promise.all([refreshPermissions(), refreshService()]);
  }, [refreshPermissions, refreshService]);

  const hostReady = readings.accessibility === 'granted' && readings.screenRecording === 'granted';
  const servicePermissionsReady = !!manualAlpha?.permissions
    && manualAlpha.permissions.accessibility === 'granted'
    && manualAlpha.permissions.screenRecording === 'granted';
  const computerUseReady = hostReady && manualAlpha?.ready === true && servicePermissionsReady;
  const computerUseDetail = probeState === 'checking'
    ? 'Checking Bimax’s current macOS grants…'
    : probeState === 'unavailable'
      ? 'Bimax could not read the current macOS grants. Refresh or restart the app.'
      : !hostReady
        ? 'macOS keeps the host controls. Bimax can only guide you to the right switch.'
        : !manualAlpha
          ? 'Checking the native Computer Use service…'
          : !manualAlpha.ready
            ? manualAlpha.detail
            : !servicePermissionsReady
              ? 'The host is ready, but the native Computer Use service still needs its own macOS grants.'
              : 'Bimax can observe and operate the Mac when a task asks for it.';

  useEffect(() => {
    if (!open) return;
    setProbeState('checking');
    void refresh();
  }, [open, refresh]);

  // Permissions change outside this window, so re-read whenever the user comes back to it. Without
  // this, revoking a grant in System Settings leaves a stale green tick until the app restarts.
  useEffect(() => {
    if (!open) return;
    const onFocus = (): void => { void refresh(); };
    window.addEventListener('focus', onFocus);
    // Permission reads are cheap and non-prompting. The manual-alpha service probe launches a
    // native handshake, so do not put it on this timer; refresh it on open/focus and after actions.
    const timer = setInterval(() => { void refreshPermissions(); }, 1500);
    return () => { window.removeEventListener('focus', onFocus); clearInterval(timer); };
  }, [open, refresh, refreshPermissions]);

  // The native service is a separate TCC identity. While its drag tile is active, poll that
  // service's live handshake and close the coach the moment the dropped grant is visible. Closing
  // the coach restores and focuses Bimax automatically; Cancel is no longer the return path.
  useEffect(() => {
    if (!open || !serviceCoach) return;
    const timer = setInterval(() => { void refreshService(); }, 1200);
    return () => clearInterval(timer);
  }, [open, refreshService, serviceCoach]);

  useEffect(() => {
    if (!serviceCoach || manualAlpha?.permissions?.[serviceCoach] !== 'granted') return;
    setServiceCoach(null);
    void window.bimax.permissionCoach.stop();
  }, [manualAlpha, serviceCoach]);

  const openPane = useCallback(async (pane: 'accessibility' | 'screenRecording' | 'fullDisk' | 'microphone') => {
    if (pane === 'microphone') {
      const requested = await window.bimax.permissionCoach.requestMicrophone().catch(() => false);
      if (requested) await refreshPermissions();
      return requested;
    }
    // Prefer the drag coach: the Accessibility list is add-by-drag and the plain deep link leaves
    // the user staring at a list with no way in. Fall back to the deep link if the coach cannot
    // start (non-macOS, or no app bundle to drag).
    const coached = await window.bimax.permissionCoach.start(pane).catch(() => false);
    if (coached) return true;
    // The legacy deep link only knows two panes; anything else has no fallback to offer.
    if (pane === 'accessibility' || pane === 'screenRecording') {
      return window.bimax.openPermissionSettings(pane);
    }
    return false;
  }, [refreshPermissions]);

  const openServicePane = useCallback(async (which: 'accessibility' | 'screenRecording') => {
    const opened = await window.bimax.permissionCoach.startService(which).catch(() => false);
    if (opened) setServiceCoach(which);
    return opened;
  }, []);

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
      <DialogContent
        className="flex h-[min(780px,calc(100vh-40px))] w-[min(760px,calc(100vw-min(40px,40vw)))] flex-col p-0"
        style={{ maxHeight: 'calc(100vh - 40px)', overflow: 'hidden' }}
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <div>
            <DialogTitle className="text-[14px] font-semibold">Trust Center</DialogTitle>
            <p className="mt-0.5 text-[10.5px] text-faint">Live permissions and the exact code allowed to control your Mac</p>
          </div>
          <span className="rounded-full border border-line bg-well px-2.5 py-1 font-mono text-[9.5px] text-faint">
            {host?.isDevHost ? `${host.name} host` : 'BiMAX host'}
          </span>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <PermissionsPane
            readings={readings}
            probeState={probeState}
            readingSource={readingSource}
            onOpenPane={openPane}
            onRefresh={refresh}
            host={host}
            checkedAt={checkedAt}
            computerUseReady={computerUseReady}
            computerUseDetail={computerUseDetail}
            serviceCard={manualAlpha ? (
              <ManualAlphaCard
                status={manualAlpha}
                onServicePermission={openServicePane}
                onApprove={async (hash) => {
                  // `null` is what main returns when it REFUSED the call — an untrusted sender or a
                  // payload that failed validation. Silently ignoring it (the old `if (next)`) is
                  // what made a refused approval look like a dead button, so say so instead.
                  const next = await window.bimax.manualAlpha.approve(hash).catch(() => null);
                  if (next) { setManualAlpha(next); return; }
                  throw new Error('Bimax refused the approval before it reached the trust store. Press Refresh and review the hash again.');
                }}
                onRevoke={async () => {
                  const next = await window.bimax.manualAlpha.revoke().catch(() => null);
                  if (next) { setManualAlpha(next); return; }
                  throw new Error('Bimax refused the revocation. Press Refresh and try again.');
                }}
              />
            ) : undefined}
          />
        </div>
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-line px-5 py-3">
          <p className="text-[11px] text-faint">BiMAX can open the right pane; only you and macOS can grant access.</p>
          <button
            onClick={onClose}
            className="pressable cursor-pointer rounded-lg bg-ember px-3.5 py-1.5 text-[12.5px] font-semibold text-bg transition-colors hover:bg-ember-bright"
          >
            Done
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ManualAlphaCard({
  status, onApprove, onRevoke, onServicePermission,
}: {
  status: ManualAlphaServiceStatus;
  onApprove: (hash: string) => Promise<void>;
  onRevoke: () => Promise<void>;
  onServicePermission: (which: 'accessibility' | 'screenRecording') => Promise<boolean>;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  /** Why the last approve/revoke did not take effect. Shown so a refusal is never a dead button. */
  const [actionError, setActionError] = useState<string | null>(null);
  const approved = status.state === 'approved-ad-hoc';
  const production = status.state === 'developer-id';
  const warning = status.state === 'approval-required';
  const Icon = production || approved ? ShieldCheck : warning ? CircleAlert : ShieldOff;

  const copyHash = (): void => {
    if (!status.codeDirectoryHash) return;
    void navigator.clipboard.writeText(status.codeDirectoryHash).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <section className={cn(
      'overflow-hidden rounded-[14px] border',
      production || approved ? 'border-moss/25 bg-moss/[0.035]' : warning ? 'border-amber/35 bg-amber/[0.04]' : 'border-rust/25 bg-rust/[0.035]',
    )}>
      <div className="flex items-start gap-3 px-4 py-3.5">
        <span className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-[10px] border bg-raise',
          production || approved ? 'border-moss/20 text-moss' : warning ? 'border-amber/25 text-amber' : 'border-rust/20 text-rust',
        )}>
          <Icon size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[12.5px] font-semibold text-ink">Computer Use service</h3>
            <span className={cn(
              'rounded-full px-2 py-0.5 text-[9.5px] font-medium',
              production || approved ? 'bg-moss/10 text-moss' : warning ? 'bg-amber/10 text-amber' : 'bg-rust/10 text-rust',
            )}>
              {production ? 'Developer ID' : approved ? 'Local build approved' : warning ? 'Approval needed' : 'Unavailable'}
            </span>
          </div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-dim">{status.detail}</p>
          {!production && (
            <p className="mt-1 text-[10.5px] leading-relaxed text-faint">
              Exact-hash approval confirms that this sealed local binary has not changed. It does not establish who built it and never bypasses macOS permissions.
            </p>
          )}
        </div>
      </div>

      {status.codeDirectoryHash && !production && (
        <div className="border-t border-line/80 px-4 py-3">
          <div className="mb-1 flex items-center justify-between gap-3">
            <span className="text-[9.5px] font-semibold tracking-[0.09em] text-faint uppercase">Code Directory hash</span>
            <button onClick={copyHash} className="inline-flex cursor-pointer items-center gap-1 text-[10px] text-faint hover:text-ink">
              {copied ? <Check size={10} /> : <Copy size={10} />} {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <code className="block break-all rounded-lg border border-line bg-well px-3 py-2 font-mono text-[10.5px] leading-relaxed text-dim">
            {status.codeDirectoryHash}
          </code>
        </div>
      )}

      {status.permissions && (
        <div className="border-t border-line/80 px-4 py-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div>
              <p className="text-[10.5px] font-semibold text-ink">Native service permissions</p>
              <p className="text-[9.5px] text-faint">The CU service is a separate process in local builds, so its grants are checked separately.</p>
            </div>
          </div>
          {(['accessibility', 'screenRecording'] as const).map((which) => {
            const granted = status.permissions?.[which] === 'granted';
            return (
              <div key={which} className="flex items-center justify-between gap-3 border-t border-line/60 py-2 first:border-t-0">
                <span className="text-[11px] text-dim">{which === 'accessibility' ? 'Accessibility' : 'Screen Recording'}</span>
                {granted ? (
                  <span className="inline-flex items-center gap-1 text-[10.5px] text-moss"><Check size={10} /> Allowed</span>
                ) : (
                  <button
                    onClick={() => void onServicePermission(which)}
                    className="pressable cursor-pointer rounded-lg border border-line px-2.5 py-1 text-[10.5px] text-ink hover:border-ember/50 hover:bg-well"
                  >
                    Open & drag service…
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {(status.canApprove || approved) && (
        <div className="flex items-center justify-between gap-3 border-t border-line/80 px-4 py-3">
          <p className="min-w-0 text-[10.5px] text-faint">
            {approved
              ? `Approved ${status.approvedAt ? new Date(status.approvedAt).toLocaleString() : 'for this exact build'}`
              : 'Use only for a local build you produced or independently verified.'}
          </p>
          <button
            disabled={busy}
            onClick={() => {
              setActionError(null);
              // Never send a placeholder hash: main validates the payload and refuses an empty
              // string, which used to surface as a button that did nothing at all.
              if (!approved && !status.codeDirectoryHash) {
                setActionError('This build reports no code directory hash, so there is nothing to approve. Press Refresh — if it stays empty the service seal could not be read.');
                return;
              }
              setBusy(true);
              const action = approved ? onRevoke() : onApprove(status.codeDirectoryHash as string);
              void action
                .catch((error: unknown) => setActionError(error instanceof Error ? error.message : String(error)))
                .finally(() => setBusy(false));
            }}
            className={cn(
              'pressable shrink-0 cursor-pointer rounded-lg border px-3 py-1.5 text-[11.5px] font-medium disabled:cursor-default disabled:opacity-50',
              approved ? 'border-line text-dim hover:border-rust/40 hover:text-rust' : 'border-amber/40 bg-amber/10 text-ink hover:border-amber',
            )}
          >
            {busy ? 'Checking…' : approved ? 'Revoke approval' : 'Approve this exact build'}
          </button>
        </div>
      )}

      {actionError && (
        <p className="border-t border-rust/25 bg-rust/[0.06] px-4 py-2.5 text-[10.5px] text-rust">
          {actionError}
        </p>
      )}
    </section>
  );
}
