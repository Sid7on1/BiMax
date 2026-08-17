import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check, Accessibility, MonitorPlay, HardDrive, Mic, ArrowUp, RefreshCw,
  MousePointer2,
} from 'lucide-react';
import { cn } from '../lib/cn';

/**
 * The permissions setup.
 *
 * macOS TCC grants cannot be given by an app — only by the user, in System Settings, for a
 * responsible process the system chooses. Every honest permission UI is therefore a *guide*, and
 * the two ways to get it wrong are equally bad: pretending to grant (a switch that appears to do
 * something and cannot), or dumping the user into System Settings with no idea what to touch.
 *
 * So this pane does three things and nothing else:
 *
 *   1. Reports the true state, read non-prompting (`isTrustedAccessibilityClient(false)`,
 *      `getMediaAccessStatus`). A row never says "Enabled" on our say-so.
 *   2. Opens the EXACT pane for the permission being granted, from a fixed map in the main process
 *      — never a renderer-supplied URL.
 *   3. Shows a drag coach while that pane is open, because the Accessibility list is add-by-drag
 *      and a first-time user has no way to guess that.
 *
 * The state is polled while the coach is up, so the row flips to Enabled the moment the grant
 * lands — the user should not have to come back and press refresh to find out whether it worked.
 */

export type Disposition = 'granted' | 'denied' | 'not-determined' | 'unavailable';

/** A permission we can deep-link to. `pane` matches the fixed map in main/index.ts. */
interface PermissionSpec {
  id: string;
  label: string;
  desc: string;
  icon: React.ComponentType<{ size?: number | string; className?: string }>;
  /** Deep-linkable panes only; others are informational until a pane map entry exists. */
  pane?: 'accessibility' | 'screenRecording' | 'fullDisk' | 'microphone';
  /** True when the list is add-by-drag, so the coach shows the drag affordance. */
  dragToAdd?: boolean;
  /** Why Bimax needs it — shown when the row is not yet granted. */
  why: string;
  /** Only these permissions gate Control Mac. Optional permissions never lower the readiness score. */
  required: boolean;
}

const PERMISSIONS: PermissionSpec[] = [
  {
    id: 'accessibility',
    label: 'Accessibility',
    desc: 'Identify windows and apps you’re working with',
    icon: Accessibility,
    pane: 'accessibility',
    dragToAdd: true,
    required: true,
    why: 'Without it Bimax can read no window contents, so computer use cannot target anything.',
  },
  {
    id: 'screenRecording',
    label: 'Screen Recording',
    desc: 'Capture app previews for visual context',
    icon: MonitorPlay,
    pane: 'screenRecording',
    dragToAdd: true,
    required: true,
    why: 'Without it screenshots come back empty and the vision model has nothing to ground on.',
  },
  {
    id: 'fullDisk',
    label: 'Full Disk Access',
    desc: 'Search and access files across your Mac',
    icon: HardDrive,
    pane: 'fullDisk',
    dragToAdd: true,
    required: false,
    why: 'Optional. Only needed to read files outside the folders you have opened.',
  },
  {
    id: 'microphone',
    label: 'Microphone',
    desc: 'Enable voice input and audio features',
    icon: Mic,
    pane: 'microphone',
    required: false,
    why: 'Optional. Only needed for voice input.',
  },
];

export function PermissionsPane({
  readings, probeState, readingSource, onOpenPane, onRefresh, host, checkedAt,
  computerUseReady, computerUseDetail, serviceCard,
}: {
  readings: Record<string, Disposition>;
  probeState: 'checking' | 'ready' | 'unavailable';
  readingSource?: 'helper' | 'in-process';
  onOpenPane: (pane: 'accessibility' | 'screenRecording' | 'fullDisk' | 'microphone') => Promise<boolean>;
  /** The bundle macOS attributes these grants to, and whether it is a dev host rather than Bimax. */
  host?: { name: string; bundle: string; isDevHost: boolean } | null;
  onRefresh: () => Promise<void>;
  checkedAt?: number;
  /** Overall readiness includes the separately signed native service, not only this host process. */
  computerUseReady?: boolean;
  computerUseDetail?: string;
  /** Desktop-owned identity/TCC card placed beside the required host grants, before optional access. */
  serviceCard?: React.ReactNode;
}): React.ReactElement {
  const [coach, setCoach] = useState<PermissionSpec | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const coachWasActiveRef = useRef(false);

  const required = useMemo(() => PERMISSIONS.filter((p) => p.required), []);
  const requiredGranted = useMemo(
    () => required.filter((p) => readings[p.id] === 'granted').length,
    [readings, required],
  );
  const optionalGranted = useMemo(
    () => PERMISSIONS.filter((p) => !p.required && readings[p.id] === 'granted').length,
    [readings],
  );

  // While the coach is up the user is in System Settings, not here. Poll so the row flips the
  // moment the grant lands: a UI that needs a manual refresh to notice cannot tell "you have not
  // done it yet" apart from "you did it and we did not look".
  useEffect(() => {
    if (!coach) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    pollRef.current = setInterval(() => { void onRefresh(); }, 1200);
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [coach, onRefresh]);

  // Dismiss the coach as soon as the permission it is coaching becomes granted.
  useEffect(() => {
    if (coach && readings[coach.id] === 'granted') setCoach(null);
  }, [coach, readings]);

  const start = useCallback(async (spec: PermissionSpec) => {
    if (!spec.pane) return;
    const opened = await onOpenPane(spec.pane);
    if (opened) setCoach(spec);
  }, [onOpenPane]);

  // The floating drag source lives in its own window and must not outlive an ACTIVE coach state.
  // Do not return stop() from this transition effect: when start() resolves, React cleans up the
  // previous `coach === null` render before committing the active one. That cleanup used to destroy
  // the BrowserWindow that main had just created, leaving System Settings open with no drag tile.
  useEffect(() => {
    if (!coach && coachWasActiveRef.current) {
      void window.bimax?.permissionCoach?.stop?.();
    }
    coachWasActiveRef.current = coach !== null;
  }, [coach]);

  // Component unmount is the other legitimate owner-lifecycle boundary. The ref avoids a spurious
  // stop during React StrictMode's initial effect probe, before any coach has existed.
  useEffect(() => () => {
    if (coachWasActiveRef.current) void window.bimax?.permissionCoach?.stop?.();
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <ProgressCard
        granted={requiredGranted}
        total={required.length}
        checkedAt={checkedAt}
        onRefresh={onRefresh}
        computerUseReady={computerUseReady === true}
        detail={computerUseDetail}
        checking={probeState === 'checking'}
      />
      {host?.isDevHost && <DevHostNotice host={host} />}

      <section>
        <div className="mb-2 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-[10px] font-semibold tracking-[0.1em] text-faint uppercase">Required for Control Mac</h3>
            <p className="mt-0.5 text-[11px] text-faint">Code work stays available without either permission.</p>
          </div>
          <span className={cn(
            'rounded-full px-2 py-1 text-[10.5px] font-medium',
            probeState === 'ready' && requiredGranted === required.length
              ? 'bg-moss/10 text-moss'
              : 'bg-amber/10 text-amber',
          )}>
            {probeState === 'checking'
              ? 'Checking…'
              : probeState === 'unavailable'
                ? 'Can’t read'
                : requiredGranted === required.length
                  ? 'Host ready'
                  : `${required.length - requiredGranted} needed`}
          </span>
        </div>
        <div className="overflow-hidden rounded-[14px] border border-line bg-well/25">
          {required.map((spec, index) => (
            <PermissionRow
              key={spec.id}
              spec={spec}
              disposition={readings[spec.id] ?? 'not-determined'}
              probeState={probeState}
              first={index === 0}
              onEnable={() => void start(spec)}
            />
          ))}
        </div>
      </section>

      {serviceCard}

      <section>
        <div className="mb-2 flex items-center justify-between">
          <div>
            <h3 className="text-[10px] font-semibold tracking-[0.1em] text-faint uppercase">Optional</h3>
            <p className="mt-0.5 text-[11px] text-faint">Ask only when you use a feature that needs it.</p>
          </div>
          <span className="text-[10.5px] text-faint">
            {probeState === 'checking'
              ? 'Checking…'
              : probeState === 'unavailable'
                ? 'Can’t read'
                : `${optionalGranted}/2 allowed`}
          </span>
        </div>
        <div className="overflow-hidden rounded-[14px] border border-line bg-well/25">
          {PERMISSIONS.filter((spec) => !spec.required).map((spec, index) => (
            <PermissionRow
              key={spec.id}
              spec={spec}
              disposition={readings[spec.id] ?? 'not-determined'}
              probeState={probeState}
              first={index === 0}
              onEnable={() => void start(spec)}
            />
          ))}
        </div>
      </section>

      {coach && <DragCoach spec={coach} onDone={() => setCoach(null)} />}

      {/* The bundled helper bypasses the main process's launch-time TCC cache. Relaunch is only an
          honest recommendation when that helper was unavailable and main had to use its fallback. */}
      {readingSource === 'in-process' && <StaleReadingNotice />}
    </div>
  );
}

/**
 * The honest explanation for "I changed it in System Settings and Bimax still shows the old value".
 *
 * This is a degraded fallback only. Normal packaged builds use `bimax-desktop-helper`, whose fresh
 * process bypasses the main process's launch-time TCC cache and therefore never show this notice.
 */
function StaleReadingNotice(): React.ReactElement {
  const [restarting, setRestarting] = useState(false);
  return (
    <section className="flex items-start justify-between gap-3 rounded-xl border border-line px-4 py-3">
      <p className="min-w-0 text-[11px] leading-relaxed text-faint">
        The live permission helper is unavailable, so this reading came from Bimax’s launch-time
        cache and may be stale. Restart Bimax to force a new macOS reading.
      </p>
      <button
        disabled={restarting}
        onClick={() => { setRestarting(true); void window.bimax.permissionCoach.relaunch(); }}
        className="shrink-0 cursor-pointer rounded-lg border border-line px-3 py-1.5 text-[11.5px] text-dim transition-all duration-150 hover:border-ember/50 hover:text-ink active:scale-[0.97] disabled:opacity-50"
      >
        {restarting ? 'Restarting…' : 'Restart & re-check'}
      </button>
    </section>
  );
}

/* ----------------------------------------------------------------------- dev host ------------- */

/**
 * The single most confusing thing about macOS permissions, made explicit.
 *
 * TCC grants belong to the *running executable*. A dev run is Electron.app, so the row the user
 * toggles in System Settings — the one labelled "Bimax" — governs a bundle that is not this
 * process. Turning it off changes nothing here, and the pane keeps reporting Enabled, which reads
 * exactly like a lie.
 *
 * It is not a stale cache and there is nothing to fix in code: the reading is correct, the question
 * was ambiguous. So name the bundle. A user who knows they are looking at Electron's grant can act
 * on it; one staring at an unexplained green tick cannot.
 */
function DevHostNotice({ host }: { host: { name: string; bundle: string } }): React.ReactElement {
  return (
    <section className="rounded-xl border border-amber/40 bg-amber/[0.06] px-4 py-3">
      <h4 className="flex items-center gap-1.5 text-[12px] font-semibold text-ink">
        These are <b className="text-amber">{host.name}</b>’s permissions, not Bimax’s
      </h4>
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-dim">
        You’re running a development build, so macOS grants permissions to <b>{host.name}.app</b> —
        the binary that is actually running. Toggling the <b>Bimax</b> row in System Settings has no
        effect on this process, which is why a row here can stay <b>Enabled</b> after you switch
        Bimax off.
      </p>
      <p className="mt-1.5 text-[11px] text-faint">
        Enable <b>{host.name}</b> in the list instead — the drag coach already drags the right
        bundle. A packaged Bimax.app gets its own grants.
      </p>
      <p className="mt-1.5 truncate font-mono text-[10px] text-faint" title={host.bundle}>{host.bundle}</p>
    </section>
  );
}

/* ------------------------------------------------------------------------ progress ------------ */

function ProgressCard({
  granted, total, checkedAt, onRefresh, computerUseReady, detail, checking,
}: {
  granted: number;
  total: number;
  checkedAt?: number;
  onRefresh: () => Promise<void>;
  computerUseReady: boolean;
  detail?: string;
  checking: boolean;
}): React.ReactElement {
  const fraction = total === 0 ? 0 : granted / total;
  const radius = 26;
  const circumference = 2 * Math.PI * radius;
  return (
    <section className="relative overflow-hidden rounded-[16px] border border-line bg-well/55 px-5 py-4">
      <div
        className="absolute inset-y-0 left-0 bg-ember/[0.045] transition-[width] duration-500 ease-out"
        style={{ width: `${Math.round(fraction * 100)}%` }}
      />
      <div className="relative flex items-center justify-between gap-5">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className={cn('size-2 rounded-full', computerUseReady ? 'bg-moss' : 'bg-amber')} />
          <h2 className="text-[15px] font-semibold text-ink">
            {checking ? 'Checking Computer Use setup' : computerUseReady ? 'Control Mac is ready' : 'Finish Computer Use setup'}
          </h2>
        </div>
        <p className="mt-1 text-[12px] leading-relaxed text-dim">
          {detail || 'Checking the host and native Computer Use service…'}
        </p>
        <button
          onClick={() => void onRefresh()}
          className="mt-2 inline-flex cursor-pointer items-center gap-1.5 text-[10.5px] text-faint transition-colors hover:text-ink"
        >
          <RefreshCw size={10} />
          Checked {checkedAt ? new Date(checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'just now'}
        </button>
      </div>
      <div className="relative shrink-0" style={{ width: 64, height: 64 }}>
        <svg width="64" height="64" viewBox="0 0 64 64" className="-rotate-90">
          <circle cx="32" cy="32" r={radius} fill="none" strokeWidth="4" className="stroke-line" />
          <circle
            cx="32" cy="32" r={radius} fill="none" strokeWidth="4" strokeLinecap="round"
            className="stroke-ember transition-[stroke-dashoffset] duration-700 ease-out"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - fraction)}
          />
        </svg>
        <span className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[14px] font-semibold text-ink">{checking ? '–' : granted}/{total}</span>
          <span className="text-[8.5px] tracking-wide text-faint uppercase">Host</span>
        </span>
      </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------------------- row ------------- */

function PermissionRow({
  spec, disposition, probeState, first, onEnable,
}: {
  spec: PermissionSpec;
  disposition: Disposition;
  probeState: 'checking' | 'ready' | 'unavailable';
  first: boolean;
  onEnable: () => void;
}): React.ReactElement {
  const Icon = spec.icon;
  const isGranted = disposition === 'granted';
  const statusLabel = probeState === 'checking'
    ? 'Checking…'
    : probeState === 'unavailable'
      ? 'Can’t read'
      : disposition === 'denied'
    ? 'Off'
    : disposition === 'not-determined'
      ? 'Not added'
      : disposition === 'unavailable'
        ? 'Can’t read'
        : 'Allowed';
  return (
    <div className={cn('group flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-raise/60', !first && 'border-t border-line')}>
      <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-[10px] border border-line bg-raise', isGranted ? 'text-moss' : 'text-faint')}>
        <Icon size={17} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[12.5px] font-medium text-ink">{spec.label}</span>
        <span className="truncate text-[11px] text-faint">{spec.desc}</span>
        {!isGranted && <span className="mt-0.5 text-[10.5px] leading-snug text-dim">{spec.why}</span>}
      </span>
      {isGranted ? (
        <span className="flex shrink-0 items-center gap-1.5 text-[11.5px] font-medium text-moss">
          <Check size={13} /> {statusLabel}
        </span>
      ) : spec.pane && probeState === 'ready' ? (
        <span className="flex shrink-0 flex-col items-end gap-1.5">
          <span className={cn(
            'rounded-full px-2 py-0.5 text-[9.5px] font-medium',
            disposition === 'denied' ? 'bg-rust/10 text-rust' : 'bg-amber/10 text-amber',
          )}>
            {statusLabel}
          </span>
          <button
            onClick={onEnable}
            className="pressable cursor-pointer rounded-lg border border-line bg-raise px-3 py-1.5 text-[11.5px] font-medium text-dim transition-all duration-150 hover:border-ember/50 hover:text-ink"
          >
            <span className="flex items-center gap-1.5">
              {spec.dragToAdd ? <MousePointer2 size={11} /> : <Mic size={11} />}
              {spec.dragToAdd ? 'Open & drag…' : 'Request access…'}
            </span>
          </button>
        </span>
      ) : (
        // No pane map entry means we cannot deep-link it. Saying "Enable" on a button that opens
        // nothing is worse than naming the one place it can be done.
        <span className="shrink-0 text-[10.5px] text-faint">System Settings</span>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- coach ------------- */

/**
 * The step-by-step overlay shown while System Settings is open.
 *
 * It stays inside the Bimax window rather than floating over System Settings: an always-on-top
 * panel hovering over another app's window is exactly the shape of the click-occlusion bug we
 * already fixed once — it steals the clicks it is pointing at.
 */
function DragCoach({ spec, onDone }: { spec: PermissionSpec; onDone: () => void }): React.ReactElement {
  return (
    <section className="rounded-xl border border-ember/40 bg-ember/[0.06] px-5 py-4">
      <div className="flex items-start gap-3">
        <span className="relative mt-0.5 flex shrink-0 items-center justify-center">
          <span className="absolute inline-flex h-9 w-9 animate-ping rounded-full bg-ember/25" />
          <span className="relative flex h-9 w-9 items-center justify-center rounded-lg bg-ember/15 text-ember">
            <ArrowUp size={16} />
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <h4 className="text-[12.5px] font-semibold text-ink">
            {spec.dragToAdd ? 'Grab the floating BiMAX tile' : 'System Settings is open'}
          </h4>
          <ol className="mt-2 flex flex-col gap-1.5 text-[11.5px] leading-relaxed text-dim">
            {spec.dragToAdd ? (
              <>
                <li><b className="text-ink">1.</b> Click the padlock and authenticate if asked.</li>
                <li>
                  <b className="text-ink">2.</b> If <b className="text-ink">Bimax</b> is already listed
                  as On but this window still says Off, switch it Off then On once. Local builds get
                  a new macOS identity when Bimax is rebuilt.
                </li>
                <li>
                  <b className="text-ink">3.</b> Otherwise drag the floating <b className="text-ink">BiMAX</b> tile
                  into the list, then make sure its switch is On.
                </li>
                <li>
                  <b className="text-ink">4.</b> macOS asks for your password <i>after</i> the drop.
                  Take your time — Bimax stays out of the way until you’re done, and comes back on
                  its own once the grant lands.
                </li>
              </>
            ) : (
              <>
                <li><b className="text-ink">1.</b> Find <b className="text-ink">Bimax</b> in the list.</li>
                <li><b className="text-ink">2.</b> Turn its switch on.</li>
              </>
            )}
          </ol>
          <p className="mt-2 text-[11px] text-faint">
            This updates by itself the moment macOS records the grant — you don’t need to come back
            and refresh. Turning Accessibility off may still require a Bimax restart to confirm.
          </p>
        </div>
        <button
          onClick={onDone}
          className="shrink-0 cursor-pointer rounded-lg border border-line px-2.5 py-1.5 text-[11px] text-dim transition-colors hover:border-ember/50 hover:text-ink"
        >
          Dismiss
        </button>
      </div>
    </section>
  );
}
