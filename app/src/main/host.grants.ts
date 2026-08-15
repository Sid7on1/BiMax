/**
 * Host TCC grants, read from a process young enough to see them.
 *
 * ## The defect this exists to fix
 *
 * `systemPreferences.isTrustedAccessibilityClient(false)` answers for *this* process, and macOS
 * decides a process's Accessibility trust once. A main process that started before the user granted
 * the permission keeps returning `false` for its entire life — there is no notification, no
 * invalidation, and no API to ask again. Screen Recording behaves the same way.
 *
 * Measured on this machine (macOS 26.5.2), with the grant already recorded by the system:
 *
 *   $ /Applications/Bimax.app/Contents/MacOS/bimax-desktop-helper status
 *   {"ok":true,"accessibility":true,"screenRecording":true,...}
 *
 * …while the running main process reported neither as granted. The grant was never missing; the
 * question was being asked by the one process that could not see the answer.
 *
 * That single stale read produced every symptom of the "permissions are broken" report: the grant
 * watch polled a value that could never flip, so it sat out its full five-minute timeout instead of
 * bringing the window back; the Trust Center rendered the same stale value and showed Off forever;
 * and relaunching from the Dock did not help, because a second launch only activates the existing
 * process (`index.ts` — it must never create another permission owner) rather than starting one
 * that would evaluate trust afresh.
 *
 * ## Why a child process is the fix and not a workaround
 *
 * TCC attributes a child to its responsible bundle, so `bimax-desktop-helper` — which ships inside
 * `Bimax.app` and is launched by it — is evaluated as Bimax. It gets a *new* trust evaluation
 * because it is a new process. Spawning one is the only way this process can ask the question again
 * without restarting itself, which is the alternative the journey is specifically designed to avoid
 * (see `permission.coach.ts`: relaunching on a timer was the original bug).
 *
 * ## Why the helper is authoritative only for the positive
 *
 * `AXIsProcessTrusted()` and `CGPreflightScreenCaptureAccess()` return booleans, so the helper can
 * prove *granted* but cannot distinguish "denied" from "never asked". The in-process API can, and
 * being stale does not stop it classifying a negative. So the fresh child decides granted vs not,
 * and the in-process reading only refines a negative into `denied` / `not-determined`. A stale
 * in-process *positive* never overrides a fresh negative — a revoked grant has to be observable too.
 *
 * Full Disk Access is deliberately not here: `probeFullDisk()` tests it by attempting a read, and
 * the kernel re-evaluates that on every call, so it was never stale. Microphone is not here either
 * — it is prompt-driven, and the prompt's own callback updates the running process.
 */
import { execFileSync } from 'node:child_process';
import { systemPreferences } from 'electron';
import { bimaxDesktopHelperBinary } from './engine';

export type Disposition = 'granted' | 'denied' | 'not-determined' | 'unavailable';

export interface HostGrants {
  accessibility: Disposition;
  screenRecording: Disposition;
  /**
   * How the reading was obtained. `in-process` means the helper was unavailable and the values may
   * be stale — surfaced rather than hidden, because "we could not ask freshly" is a different
   * statement from "the permission is off", and the UI is entitled to say so.
   */
  source: 'helper' | 'in-process';
  readAt: number;
}

/**
 * How long a reading is reused.
 *
 * The helper costs 50–120ms measured, which is too much to pay on every snapshot push but nothing
 * against the 1s poll of an active grant watch. 750ms keeps the watch effectively live (it never
 * reuses a reading across two of its own ticks) while collapsing the bursts of reads that happen
 * when the Trust Center renders.
 */
const FRESH_MS = 750;

/** A hung helper must not hang the main process. Generous next to a measured 120ms. */
const HELPER_TIMEOUT_MS = 2_000;

let cached: HostGrants | null = null;

/**
 * The fresh reading, as an injectable seam.
 *
 * Returns null when there is nothing that can answer freshly. Injected rather than imported so this
 * policy stays testable without a bundle on disk — `runtime.paths.ts` makes the same choice for the
 * same reason. Without the seam a unit test silently measures whatever the *real* installed helper
 * says about the *developer's* machine, which is how the first version of this module made two
 * existing coach tests pass or fail depending on the tester's own permissions.
 */
export type FreshGrantProbe = () => { accessibility: boolean; screenRecording: boolean } | null;

let probe: FreshGrantProbe = () => helperGrants();

/** Replace the fresh probe. Pass null to restore the bundled helper. Tests only. */
export function setFreshGrantProbe(next: FreshGrantProbe | null): void {
  probe = next ?? (() => helperGrants());
  cached = null;
}

function toDisposition(value: unknown): Disposition {
  if (value === true || value === 'granted') return 'granted';
  if (value === false) return 'denied';
  if (value === 'denied' || value === 'restricted') return 'denied';
  if (value === 'not-determined' || value === 'unknown') return 'not-determined';
  return 'unavailable';
}

/** This process's own answer. Correct for negatives, potentially stale for positives. */
function inProcessGrants(): { accessibility: Disposition; screenRecording: Disposition } {
  if (process.platform !== 'darwin') {
    return { accessibility: 'unavailable', screenRecording: 'unavailable' };
  }
  return {
    accessibility: toDisposition(systemPreferences.isTrustedAccessibilityClient(false)),
    screenRecording: toDisposition(systemPreferences.getMediaAccessStatus('screen')),
  };
}

/**
 * Ask a fresh child. Returns null when there is no helper to ask — a development run without the
 * native components staged, which must degrade to the old behaviour rather than report everything
 * as denied.
 */
function helperGrants(): { accessibility: boolean; screenRecording: boolean } | null {
  if (process.platform !== 'darwin') return null;
  const helper = bimaxDesktopHelperBinary();
  if (!helper) return null;
  try {
    const stdout = execFileSync(helper, ['status'], {
      encoding: 'utf8',
      timeout: HELPER_TIMEOUT_MS,
      // The helper writes one JSON line. Nothing here should reach a terminal.
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = JSON.parse(stdout.trim().split('\n').pop() || '{}');
    if (parsed?.ok !== true) return null;
    return {
      accessibility: parsed.accessibility === true,
      screenRecording: parsed.screenRecording === true,
    };
  } catch {
    // A missing, unsigned, killed or malformed helper is not evidence about the permission.
    return null;
  }
}

/**
 * The current host grants, cached for {@link FRESH_MS}.
 *
 * Synchronous because every caller is: the grant watch's interval, the permission probe, and the
 * snapshot the renderer reads. Pass `force` to bypass the cache at a moment the answer is expected
 * to have just changed.
 */
export function hostGrants(force = false): HostGrants {
  const now = Date.now();
  if (!force && cached && now - cached.readAt < FRESH_MS) return cached;

  const inProcess = inProcessGrants();
  const fresh = probe();

  const resolve = (live: boolean | undefined, fallback: Disposition): Disposition => {
    if (live === undefined) return fallback;
    if (live) return 'granted';
    // A fresh negative stands. The stale reading only says which kind of negative it is.
    return fallback === 'granted' ? 'denied' : fallback;
  };

  cached = {
    accessibility: resolve(fresh?.accessibility, inProcess.accessibility),
    screenRecording: resolve(fresh?.screenRecording, inProcess.screenRecording),
    source: fresh ? 'helper' : 'in-process',
    readAt: now,
  };
  return cached;
}

/** Drop the cache. Called when something has just happened that could change a grant. */
export function invalidateHostGrants(): void {
  cached = null;
}
