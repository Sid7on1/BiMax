/**
 * Execution-surface model for computer use.
 *
 * The core mistake in a naive computer-use system is treating "the desktop" as one thing and routing
 * every action through global mouse coordinates. In reality an agent operates on distinct SURFACES
 * with different physics: a native window on the real screen (physical pointer, must be frontmost),
 * an accessibility target (can be driven while another app is frontmost), an agent-owned browser tab
 * (driven over CDP without ever moving the physical cursor). Each has different rules for who owns
 * input, whether it is safe to capture, and whether it can run in the background.
 *
 * This module makes those surfaces first-class so the runtime can pick the RIGHT mechanism per task
 * and the UI can honestly say who currently owns the cursor and keyboard. It deliberately encodes
 * the OS truth the whole feature depends on: on macOS, a hidden background native window CANNOT
 * receive ordinary physical mouse input — so a background pointer action on such a surface is either
 * routed through accessibility or refused, never faked.
 */

export type SurfaceKind =
  | 'physical-desktop'  // the user's whole real screen; global CGEvents; user-shared, capture-unsafe
  | 'native-window'     // one app window (pid+windowId) on the physical desktop
  | 'accessibility'     // AX-tree interaction with a native app; no pointer required
  | 'pixel-only'        // screenshot pixels only, no AX tree available
  | 'browser-context'   // an agent-owned browser context (BrowserTool/Chromium)
  | 'browser-tab'       // one tab within a browser context
  | 'virtual-desktop'   // an isolated/headless display (future)
  | 'pip';              // the PiP presentation surface — a VIEW, never an input target

/** Who currently owns keyboard/mouse for a surface. 'shared' is a transient hand-off state. */
export type InputOwner = 'user' | 'agent' | 'shared' | 'none';

export interface SurfaceBounds { x: number; y: number; w: number; h: number }

export interface ExecutionSurface {
  id: string;
  kind: SurfaceKind;
  app?: string;
  pid?: number;
  windowId?: number;
  browserContextId?: string;
  browserTabId?: string;
  /** Global screen points for native surfaces; viewport for browser surfaces. */
  bounds?: SurfaceBounds;
  display?: number;
  /** Backing scale factor (Retina = 2). */
  scale?: number;
  /** Who owns input right now. */
  focusOwner: InputOwner;
  /** Safe to screenshot/record WITHOUT exposing unrelated windows (window/tab-scoped capture). */
  captureSafe: boolean;
  /** Can receive input without being frontmost (browser/AX yes; physical native window no). */
  backgroundCapable: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * The automation mechanism that should deliver an acting verb to a surface. These map to the
 * runtime's REAL delivery paths, so the choice is honest rather than aspirational:
 *  - physical-foreground: the Swift helper posts a real global CGEvent — moves the one macOS cursor
 *    and requires the target window to be frontmost first (visible mode).
 *  - sidecar-background:  the native sidecar PID-posts a synthetic event to a specific window — does
 *    NOT move the physical cursor and does NOT need foreground, but some accessibility frameworks
 *    can ignore synthetic events (which is exactly why visible/foreground is the default).
 *  - accessibility:       an AX action (set_value / press on an element handle) — no cursor, no
 *    foreground, and reliable for controls the accessibility tree exposes.
 *  - browser-automation:  driven over the browser protocol; the physical cursor is never touched.
 *  - unsupported:         no safe mechanism exists for this combination — reported, never faked.
 */
export type AutomationMechanism =
  | 'physical-foreground'
  | 'sidecar-background'
  | 'accessibility'
  | 'browser-automation'
  | 'unsupported';

export interface MechanismChoice {
  mechanism: AutomationMechanism;
  /** True when the surface must be the frontmost app for this delivery to land. */
  requiresForeground: boolean;
  reason: string;
}

/** Acting verbs that move a pointer or send keystrokes (vs. observation/discovery verbs). */
const POINTER_VERBS = new Set(['click', 'drag', 'scroll', 'move', 'hover', 'hold', 'mouse_down', 'mouse_up']);
const KEYBOARD_VERBS = new Set(['type', 'key', 'copy', 'paste']);

/** Per-kind defaults for the capture/background/owner physics. */
export function defaultSurfaceTraits(kind: SurfaceKind): Pick<ExecutionSurface, 'focusOwner' | 'captureSafe' | 'backgroundCapable'> {
  switch (kind) {
    case 'physical-desktop': return { focusOwner: 'user', captureSafe: false, backgroundCapable: false };
    case 'native-window':    return { focusOwner: 'none', captureSafe: true,  backgroundCapable: true  };
    case 'accessibility':    return { focusOwner: 'none', captureSafe: true,  backgroundCapable: true  };
    case 'pixel-only':       return { focusOwner: 'none', captureSafe: true,  backgroundCapable: false };
    case 'browser-context':  return { focusOwner: 'agent', captureSafe: true, backgroundCapable: true  };
    case 'browser-tab':      return { focusOwner: 'agent', captureSafe: true, backgroundCapable: true  };
    case 'virtual-desktop':  return { focusOwner: 'agent', captureSafe: true, backgroundCapable: true  };
    case 'pip':              return { focusOwner: 'none', captureSafe: true,  backgroundCapable: true  };
  }
  // Exhaustive above; this guards against a future SurfaceKind added without a case.
  throw new Error(`unhandled surface kind: ${kind as string}`);
}

/**
 * Choose the correct automation mechanism for an acting verb on a surface. This is the routing brain
 * the whole architecture hinges on: it refuses to pretend a physical pointer can reach a hidden
 * window, and it keeps browser/AX work OFF the physical cursor entirely.
 */
export function chooseMechanism(
  surface: Pick<ExecutionSurface, 'kind' | 'backgroundCapable'>,
  action: string,
  opts: { delivery: 'foreground' | 'background'; hasAxHandle?: boolean } = { delivery: 'foreground' },
): MechanismChoice {
  const isPointer = POINTER_VERBS.has(action);
  const isKeyboard = KEYBOARD_VERBS.has(action);
  const isAxSet = action === 'set_value' || action === 'menu_activate' || action === 'menu_search';

  // Browser surfaces never touch the physical cursor — drive them over the automation protocol.
  if (surface.kind === 'browser-tab' || surface.kind === 'browser-context') {
    return { mechanism: 'browser-automation', requiresForeground: false, reason: 'agent-owned browser surface — driven over the browser automation protocol, physical cursor untouched' };
  }

  // A pure AX value set can always go through accessibility without foregrounding.
  if (isAxSet) {
    return { mechanism: 'accessibility', requiresForeground: false, reason: 'accessibility value set — delivered without moving the physical cursor or stealing focus' };
  }

  // Window placement is delivered through Accessibility, but the runtime deliberately fronts the
  // target first (fullscreen changes are otherwise silently refused by macOS). Reflect that real
  // focus ownership instead of labelling the action as observation-only.
  if (action === 'arrange') {
    return { mechanism: 'accessibility', requiresForeground: true, reason: 'window management through accessibility — target is brought frontmost before placement' };
  }

  if (isPointer || isKeyboard) {
    if (opts.delivery === 'foreground') {
      return { mechanism: 'physical-foreground', requiresForeground: true, reason: 'visible mode — one real macOS cursor delivers the action; the target window is brought frontmost first' };
    }
    // Background delivery. Prefer accessibility when we hold a real element handle (most reliable,
    // no cursor). Otherwise a native window can still be driven by the sidecar's synthetic PID-post
    // — but ONLY a window with a pid. A whole-desktop surface has nothing to target in the background.
    if (opts.hasAxHandle || surface.kind === 'accessibility') {
      return { mechanism: 'accessibility', requiresForeground: false, reason: 'background delivery routed through accessibility — no cursor moves, no foreground needed' };
    }
    if (surface.kind === 'physical-desktop') {
      return { mechanism: 'unsupported', requiresForeground: true, reason: 'background input has no specific window to target on the bare desktop; open/select a window first, or use visible mode' };
    }
    if (surface.backgroundCapable) {
      return { mechanism: 'sidecar-background', requiresForeground: false, reason: 'background delivery via the sidecar synthetic event (cursor untouched) — some accessibility frameworks can ignore synthetic events; visible mode is more reliable for those surfaces' };
    }
    return { mechanism: 'unsupported', requiresForeground: true, reason: 'no background mechanism for this surface; use visible mode or target a named accessibility element' };
  }

  // Non-acting verb (observe/screenshot/status/…): no input mechanism is needed.
  return { mechanism: 'accessibility', requiresForeground: false, reason: 'observation verb — no input delivery' };
}

/**
 * SurfaceRegistry — the single source of truth for which surfaces exist this session, which one is
 * active, and who owns input on each. Enforces the "never both the user and the agent driving the
 * same surface at once" rule so a foreground takeover can't quietly fight the human.
 */
export class SurfaceRegistry {
  private surfaces = new Map<string, ExecutionSurface>();
  private activeId: string | null = null;
  private seq = 0;

  /**
   * Register (or replace) a surface and make it active. Returns the stored record.
   *
   * Registration implies activation because the runtime registers the surface it just targeted.
   * Activating only when nothing was active yet meant that opening a second app registered it but
   * left `active()` pinned to the FIRST one — so PiP capture and the persisted session state both
   * kept naming an app the agent had moved on from. Pass `activate: false` to register a surface
   * the session merely knows about without redirecting the active pointer at it.
   */
  register(input: Partial<ExecutionSurface> & { kind: SurfaceKind; activate?: boolean }): ExecutionSurface {
    const now = Date.now();
    const { activate = true, ...spec } = input;
    const id = spec.id || `${spec.kind}-${++this.seq}`;
    const traits = defaultSurfaceTraits(spec.kind);
    const existing = this.surfaces.get(id);
    const surface: ExecutionSurface = {
      ...traits,
      ...existing,
      ...spec,
      id,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      // Explicit trait overrides win over both defaults and the prior record.
      focusOwner: spec.focusOwner ?? existing?.focusOwner ?? traits.focusOwner,
      captureSafe: spec.captureSafe ?? existing?.captureSafe ?? traits.captureSafe,
      backgroundCapable: spec.backgroundCapable ?? existing?.backgroundCapable ?? traits.backgroundCapable,
    };
    this.surfaces.set(id, surface);
    if (activate || !this.activeId) this.activeId = id;
    return surface;
  }

  update(id: string, patch: Partial<ExecutionSurface>): ExecutionSurface | null {
    const existing = this.surfaces.get(id);
    if (!existing) return null;
    const surface = { ...existing, ...patch, id, updatedAt: Date.now() };
    this.surfaces.set(id, surface);
    return surface;
  }

  get(id: string): ExecutionSurface | null { return this.surfaces.get(id) || null; }
  all(): ExecutionSurface[] { return Array.from(this.surfaces.values()); }
  remove(id: string): void { this.surfaces.delete(id); if (this.activeId === id) this.activeId = null; }
  clear(): void { this.surfaces.clear(); this.activeId = null; }

  setActive(id: string): boolean { if (!this.surfaces.has(id)) return false; this.activeId = id; return true; }
  active(): ExecutionSurface | null { return this.activeId ? this.surfaces.get(this.activeId) || null : null; }

  /**
   * Claim input ownership for a surface. Refuses to hand the agent a surface the USER currently owns
   * unless forced (an explicit, user-approved takeover), so the agent never silently fights the human
   * for the cursor mid-task.
   */
  claimInput(id: string, owner: Exclude<InputOwner, 'none'>, opts: { force?: boolean } = {}): { ok: boolean; conflict?: string } {
    const surface = this.surfaces.get(id);
    if (!surface) return { ok: false, conflict: `no surface ${id}` };
    if (owner === 'agent' && surface.focusOwner === 'user' && !opts.force) {
      return { ok: false, conflict: 'the user currently owns input on this surface — takeover must be explicit' };
    }
    this.update(id, { focusOwner: owner });
    return { ok: true };
  }

  /** Release agent ownership, returning the surface to its natural owner (user for physical). */
  releaseInput(id: string): void {
    const surface = this.surfaces.get(id);
    if (!surface) return;
    const natural = surface.kind === 'physical-desktop' || surface.kind === 'native-window' ? 'user' : 'none';
    this.update(id, { focusOwner: natural });
  }
}
