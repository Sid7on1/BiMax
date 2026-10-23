import { CapabilityDecision, CapabilityPlan, MemoryInfo, ProfileId } from './types';

/**
 * Resource-aware capability selection. Decides, per launch, which optional engine subsystems run —
 * so an 8 GB machine gets a usable engine instead of a SIGKILLed one. Pure: memory and env come in
 * as arguments; the output is a typed plan plus the env vars that implement it (the engine reads
 * BIMAX_DISABLE_HEADROOM / both code-memory gate spellings / BIMAX_AUTO_INDEX /
 * BIMAX_DRIVES_BOOT).
 *
 * The decision is adaptive, not hardcoded: a healthy machine runs `full`; headroom pressure steps
 * down to `conservative`, real scarcity (or repeated resource crashes, via the restart policy) to
 * `minimal`. Explicit user env always wins and is reported as such — a capability the user forced
 * on is never silently shed, one the user disabled is never silently re-enabled.
 */

// Below ~1.5 GB free, background indexers + the codebase-memory engine are what tip macOS into
// killing the child; below ~700 MB even background indexing is a gamble.
const CONSERVATIVE_FREE_BYTES = 1.5 * 1024 * 1024 * 1024;
const MINIMAL_FREE_BYTES = 700 * 1024 * 1024;

/** What Electron's `process.getSystemMemoryInfo()` returns. All figures are KILOBYTES. */
export interface SystemMemorySample {
  total: number;
  free: number;
  /** Page cache. macOS hands this back on demand, so it is available, not used. */
  fileBacked?: number;
  purgeable?: number;
}

/**
 * How much memory is actually AVAILABLE, rather than how much is untouched.
 *
 * `os.freemem()` counts only wholly free pages, and macOS deliberately keeps almost none: it fills
 * spare RAM with file cache and evicts on demand. Measured on this 8 GB machine, both at once:
 *
 *     os.freemem()                     0.07 GB
 *     free + fileBacked + purgeable    1.97 GB
 *
 * The thresholds above are 1.5 GB and 700 MB, so feeding them os.freemem() pinned `profileForMemory`
 * to `minimal` permanently — codebaseMemory, autoIndex and drivesBoot all deferred, on a machine
 * with nearly 2 GB free. Worse, it was silent by design: EngineStatusBanner suppresses `degraded`
 * because it was believed to be the adaptive path working as intended on a small Mac. It was not
 * adapting. It was reading the wrong number, by a factor of 26.
 *
 * This is the same failure as measuring our own bookkeeping field and shipping backwards advice:
 * a policy is only as good as the sensor under it, and this one has to be checked against what the
 * operating system actually thinks is available.
 */
export function availableBytes(sample: SystemMemorySample): number {
  const kilobytes = sample.free + (sample.fileBacked ?? 0) + (sample.purgeable ?? 0);
  return Math.max(0, kilobytes) * 1024;
}

export function profileForMemory(mem: MemoryInfo): ProfileId {
  if (mem.freeBytes < MINIMAL_FREE_BYTES) return 'minimal';
  if (mem.freeBytes < CONSERVATIVE_FREE_BYTES) return 'conservative';
  return 'full';
}

const PROFILE_ORDER: Record<ProfileId, number> = { full: 0, conservative: 1, minimal: 2 };

/** The more constrained of two profiles (policy shedding vs live memory reading). */
export function minProfile(a: ProfileId, b: ProfileId): ProfileId {
  return PROFILE_ORDER[a] >= PROFILE_ORDER[b] ? a : b;
}

export function planCapabilities(
  mem: MemoryInfo,
  env: Record<string, string | undefined>,
  floor: ProfileId = 'full',
): CapabilityPlan {
  // BIMAX_FORCE_PROFILE pins the whole ladder for advanced users; otherwise combine the live
  // memory reading with the floor the restart policy demands (shedding after resource crashes).
  const forced = env.BIMAX_FORCE_PROFILE as ProfileId | undefined;
  const profile: ProfileId = forced && forced in PROFILE_ORDER
    ? forced
    : minProfile(profileForMemory(mem), floor);

  const caps: CapabilityDecision[] = [];
  const spawnEnv: Record<string, string> = {};
  // The persistent graph remains enabled, but its disk hydration is not on the Desktop's
  // interactive-startup critical path. Graph-backed tools promote themselves when it arrives.
  spawnEnv.BIMAX_DEFER_GRAPH_LOAD = '1';

  // Native context compression is in-process and cheap — always on, and expressly NOT dependent
  // on the Headroom sidecar (it's the fallback that keeps compression working without it).
  caps.push({ id: 'nativeCompression', enabled: true, reason: 'built-in (works without the Headroom sidecar)' });

  // Persistent graph store (SQLite) is core functionality, not an optional heavy service.
  caps.push({ id: 'persistentGraph', enabled: true, reason: 'core storage' });

  // Headroom Python/ONNX sidecar: too expensive to provision implicitly in a desktop process —
  // OFF unless the user explicitly set BIMAX_DISABLE_HEADROOM=0 AND the profile allows it.
  const headroomUserOn = env.BIMAX_DISABLE_HEADROOM === '0';
  if (headroomUserOn && profile === 'full') {
    spawnEnv.BIMAX_DISABLE_HEADROOM = '0';
    caps.push({ id: 'headroomProxy', enabled: true, reason: 'env override (BIMAX_DISABLE_HEADROOM=0)' });
  } else {
    spawnEnv.BIMAX_DISABLE_HEADROOM = '1';
    caps.push({
      id: 'headroomProxy', enabled: false,
      reason: headroomUserOn ? `low memory (profile ${profile})` : 'off by default on desktop (set BIMAX_DISABLE_HEADROOM=0 to enable)',
    });
  }

  // Codebase-memory engine (C binary + its own index): shed below `full` unless the user pinned it.
  // Two engine entry points historically used different names: the container gate reads the
  // short CODEMEM spelling while the standalone backend/MCP integration reads CODEBASE_MEMORY.
  // Treat either explicit setting as authoritative and always emit BOTH so a constrained launch
  // cannot accidentally start the second copy of the semantic engine through another path.
  const codememRaw = env.BIMAX_DISABLE_CODEMEM ?? env.BIMAX_DISABLE_CODEBASE_MEMORY;
  const codememUserOff = codememRaw === '1';
  const codememUserOn = codememRaw === '0';
  const codememOn = codememUserOn || (!codememUserOff && profile === 'full');
  spawnEnv.BIMAX_DISABLE_CODEMEM = codememOn ? '0' : '1';
  spawnEnv.BIMAX_DISABLE_CODEBASE_MEMORY = codememOn ? '0' : '1';
  caps.push({
    id: 'codebaseMemory', enabled: codememOn,
    reason: codememUserOn ? 'env override' : codememUserOff ? 'env override' : codememOn ? 'default' : `deferred (profile ${profile})`,
  });

  // Background auto-indexing survives `conservative`, sheds only in `minimal`.
  const autoIndexUserOff = env.BIMAX_AUTO_INDEX === '0';
  const autoIndexOn = !autoIndexUserOff && profile !== 'minimal';
  spawnEnv.BIMAX_AUTO_INDEX = autoIndexOn ? '1' : '0';
  caps.push({
    id: 'autoIndex', enabled: autoIndexOn,
    reason: autoIndexUserOff ? 'env override' : autoIndexOn ? 'default' : `deferred (profile ${profile})`,
  });

  // Mind-layer boot measurement: cheap, but it's still spawned work — full profile only.
  const drivesUserOff = env.BIMAX_DRIVES_BOOT === '0';
  const drivesOn = !drivesUserOff && profile === 'full';
  spawnEnv.BIMAX_DRIVES_BOOT = drivesOn ? '1' : '0';
  caps.push({
    id: 'drivesBoot', enabled: drivesOn,
    reason: drivesUserOff ? 'env override' : drivesOn ? 'default' : `deferred (profile ${profile})`,
  });

  return { profile, capabilities: caps, env: spawnEnv };
}

/** Capabilities the plan turned off — the `degraded` report the UI shows. */
export function degradedCapabilities(plan: CapabilityPlan): CapabilityPlan['capabilities'][number]['id'][] {
  return plan.capabilities.filter((c) => !c.enabled && c.id !== 'headroomProxy').map((c) => c.id);
}
