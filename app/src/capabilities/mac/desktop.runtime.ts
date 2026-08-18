import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile, spawn } from 'child_process';
import { phaseTrace } from './phase.trace';
import { allowsEvidenceFocus } from './delivery.policy';
import { capabilityEvents as cliEvents } from './events';
import { loadMacCapabilityConfig as loadConfig } from './config';
import { normalizedToPixel, screenshotToGlobal, elementCenterToScreenshot, globalFrameToScreenshot, frameCenter, pixelInImage, Frame } from './coordinates';
import { SurfaceRegistry, ExecutionSurface, InputOwner, chooseMechanism, AutomationMechanism } from './surface';
import { ExecutorLevel, classifyExecutorLevel, describeLevel } from './executor.ladder';
import { DragMachine } from './drag';
import { pointInFrame } from './coordinates';
import { classifyVerification, VerificationResult, evaluateExpectation } from './verification';
import { RecoveryController, RecoveryDecision } from './recovery';
import { ActionHistory, ActionHistorySummary, ComputerSessionState, writeSessionState, readSessionState } from './durability';
import { RecordingController } from './recording';
import { toActionResult, ActionResult } from './verification';
import { SidecarTransport, SidecarTransportPort, bimaxBrand } from './transport';
import { TargetOwnership, ComputerTarget } from './target';
import { LivePipPort, LivePipStatus, NativeLivePip } from './pip';
import { FrameRegistry, FrameMetadata } from './frame';
import { TargetSwitch, SwitchLatencyLog } from './switch';
import { InputExecutor, heldButtonFor } from './input.executor';
import { waitUntil, waitFor } from './settle';
import { rankSemanticTargets } from './semantic.targeting';
import { foldTreeTextIntoElements } from './tree.text';
import {
  VisualFingerprint, VisualDelta, NativeVisualSignature, parseVisualFingerprint,
  diffVisualFingerprints, visualElementIdentities, compactVisualEvidence,
} from './visual.fingerprint';
import {
  NativeElementReceipt, ElementMatchReceipt, KeyboardReceipt,
  matchHitElement, sameNativeElement, compareKeyboardFocus,
} from './action.receipt';

/**
 * Offline/development fallback for Bimax Computer Use.
 *
 * On macOS this is a small in-repo Swift helper (helper.source.ts), compiled and signed at build
 * time. End-user machines never need Xcode Command Line Tools. Degradation ladder when the helper is
 * absent: cliclick → AppleScript System Events. On Linux the fallback is xdotool. Shipped builds
 * normally use BimaxComputerRuntime below, backed by the pinned native sidecar.
 *
 * Coordinate contract: everything is GLOBAL SCREEN POINTS. Retina screenshots are downscaled to
 * point resolution before the model sees them, so "click where the pixel is" is always correct.
 * click/move/drag/scroll also accept the 0–1000 normalized space VLMs emit (Gemini convention),
 * scaled against the main display.
 */

/** One source of truth for every model-facing ComputerTool action. The schema imports this value,
 * so adding a runtime action without exposing it (or exposing a verb the runtime cannot route) is
 * no longer possible through two independently maintained lists. */
export const PUBLIC_DESKTOP_ACTIONS = [
  'status', 'request_access', 'apps', 'windows', 'open', 'focus', 'observe', 'screenshot',
  'click', 'type', 'key', 'set_value', 'drag', 'scroll', 'hover', 'hold', 'mouse_down',
  'mouse_up', 'cursor', 'frontmost', 'move', 'copy', 'paste', 'clipboard', 'arrange',
  'desktop', 'close', 'quit_app', 'wait', 'record_start', 'record_status', 'record_stop',
] as const;

export type PublicDesktopAction = typeof PUBLIC_DESKTOP_ACTIONS[number];

export type DesktopAction = PublicDesktopAction
  // Internal plumbing verbs: the pasteboard and window-geometry primitives the model-facing verbs
  // are built from. Deliberately absent from the tool schema — the model never calls these directly.
  | 'clipboard_read' | 'clipboard_write' | 'clipboard_write_files'
  | 'reopen_background'
  | 'screens' | 'window_frame' | 'window_set_frame' | 'window_fullscreen' | 'modal_frame' | 'ax_enable'
  | 'window_at' | 'window_raise'
  | 'bundle_id' | 'app_running' | 'desktop_icons' | 'visual_signatures' | 'visual_analysis' | 'focused_element';

export interface DesktopCommand {
  action: DesktopAction;
  x?: number; y?: number;
  toX?: number; toY?: number;
  dx?: number; dy?: number;
  button?: 'left' | 'right' | 'middle';
  modifier?: Array<'cmd' | 'shift' | 'alt' | 'ctrl' | 'fn'>;
  count?: number;
  text?: string;
  /** type: select the target editable field's existing contents before entering text. */
  replaceExisting?: boolean;
  combo?: string;
  app?: string;
  bundleId?: string;
  pid?: number;
  windowId?: number;
  elementIndex?: number;
  elementToken?: string;
  query?: string;
  /** Optional semantic postcondition checked in the automatic post-action observation. This is
   * deliberately separate from query, which names the element to act on. */
  expect?: string;
  expectMode?: 'present' | 'absent';
  /** drag: destination element handle from the newest observation (mirrors query/elementToken/elementIndex for the source). */
  toQuery?: string;
  toElementToken?: string;
  toElementIndex?: number;
  maxElements?: number;
  includeScreenshot?: boolean;
  /** INTERNAL, never part of the public tool surface. Set on observations the runtime makes on
   * behalf of an action (post-action evidence, semantic re-grounding): those cannot use a menu-only
   * background frame for anything, so they may focus the target app once and re-walk it. A caller's
   * own observe must never steal the user's focus, so it leaves this unset. */
  focusIfBackground?: boolean;
  value?: string;
  /** clipboard: absolute file paths to place on the pasteboard, so an app can receive them by paste. */
  paths?: string[];
  /** drag: destination APPLICATION for a cross-app drop. Must already be open in this session
   *  (open/focus); toX/toY are then read in THAT window's screenshot space, not the source's. */
  toApp?: string;
  /** arrange: where to put the window — a named region of the screen, or explicit bounds. */
  layout?: WindowLayout;
  /** arrange / window_set_frame: explicit target rectangle in global screen points. */
  bounds?: { x: number; y: number; w: number; h: number };
  deliveryMode?: 'background' | 'foreground';
  session?: string;
  newInstance?: boolean;
  display?: number;
  ms?: number;
  /** Interpret coordinates in the 0–1000 normalized space and scale to the main display. */
  normalized?: boolean;
  /** The frame these coordinates were planned from, as returned by the observation that produced
   * them. Optional — omitting it keeps the pre-existing behaviour — but supplying it is what lets
   * the runtime detect a stale frame of the SAME window and refuse rather than mis-click. */
  frameId?: string;
  /** Internal/manual smoke aid: ask the native driver to save a click crosshair image. */
  debugImageOut?: string;
  /** Backward-compatible no-op: screenshot pixels are first-class in the native runtime. */
  pixelFallback?: boolean;
  /** record_start: include a native ScreenCaptureKit/ffmpeg MP4 in addition to turn artifacts. */
  recordVideo?: boolean;
  /** record_start: capture only the owned window (default), or the whole human-visible display.
   * Whole-display video remains guarded by a governor-minted single-use approval token. */
  captureScope?: 'window' | 'display';
  /** record_start: optional output directory; defaults under .bimax/computer/recordings. */
  outputDir?: string;
  /** record_start: single-use approval token for WHOLE-DISPLAY video capture, minted ONLY by the
   * runtime's authorizeFullDisplayRecording() after a governor-approved prompt. This field is
   * STRIPPED from model-supplied arguments by the tool layer — a model cannot forge it, and no
   * boolean can authorize whole-display capture. */
  fullDisplayToken?: string;
  /** Internal visual sampler input. Rectangles are screenshot pixels, never global screen points. */
  imagePath?: string;
  regions?: Array<{ id: string; x: number; y: number; w: number; h: number }>;
}

export interface AccessibilityEvent {
  pid: number;
  notification: string;
  timestampMs: number;
  element?: AXElementIdentity;
}

export interface NativeVisualText {
  text: string;
  confidence: number;
  frame: ScreenRect;
}

export interface NativeVisualShape {
  id: string;
  contourCount: number;
  topLevelCount: number;
  rectangleCount: number;
  occupiedFrame?: ScreenRect;
  kind: 'roundish' | 'square' | 'horizontal' | 'vertical' | 'complex' | 'empty';
}

export interface DesktopDisplay { index: number; width: number; height: number; scale: number; main: boolean }

/** A rectangle in global screen points (top-left origin), the space every helper command speaks. */
export interface ScreenRect { x: number; y: number; w: number; h: number }

/** A screen, with the area a window may actually occupy (menu bar and Dock excluded). */
export interface ScreenInfo { index: number; main: boolean; scale: number; frame: ScreenRect; visible: ScreenRect }

/** Native Accessibility identity used by the preflight/receipt layer. Values are deliberately
 * metadata-only: text contents are represented by length/caret, never copied into diagnostics. */
export interface AXElementIdentity {
  pid: number;
  role?: string;
  subrole?: string;
  title?: string;
  description?: string;
  identifier?: string;
  frame?: ScreenRect;
  enabled?: boolean;
  focused?: boolean;
  editable?: boolean;
  valueLength?: number;
  selectedRange?: { location: number; length: number };
  actions?: string[];
}

/**
 * Named window placements. These cover what "put them side by side" and "make it fullscreen"
 * actually mean, computed against the screen's VISIBLE area so a tiled window never hides under the
 * menu bar or Dock. `fullscreen`/`unfullscreen` are the native macOS Space toggle, which is a
 * different thing from `maximize` (a window filling the visible area, still on the current Space).
 */
export type WindowLayout =
  | 'left' | 'right' | 'top' | 'bottom'
  | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  // Thirds — what a three-app workflow actually needs. Halves cannot express "reference on the
  // left, editor in the middle, terminal on the right" without overlapping windows.
  | 'left-third' | 'center-third' | 'right-third'
  | 'left-two-thirds' | 'right-two-thirds'
  // Put the window back where it was before the last arrange — the undo a multi-app layout needs
  // so a workflow can borrow the screen and hand it back.
  | 'restore'
  | 'maximize' | 'center' | 'fullscreen' | 'unfullscreen';

export interface DesktopResult {
  ok: boolean;
  action: DesktopAction;
  driver: string;
  error?: string;
  screenshot?: string;
  width?: number; height?: number;
  /** Secondary composited display context. `screenshot` remains the exact target/action frame;
   * this image shows occlusion, sheets, menus, Dock and other applications like a human sees them.
   * Its pixels are context-only and must never be used as ComputerTool x/y coordinates. */
  displayScreenshot?: string;
  displayWidth?: number; displayHeight?: number;
  /** Stable digest of captured pixels, used to measure actual visual progress. */
  frameHash?: string;
  /** Identity of the frame these coordinates belong to (see frame.ts). Echo it back on the acting
   * verb planned from this observation and a superseded frame is refused instead of clicking
   * whatever now occupies those pixels. */
  frameId?: string;
  /** The input landed, but the automatic post-action screenshot could not be captured. */
  visualEvidenceError?: string;
  /** What the live preview panel is showing, attached to observations.
   *
   * The preview is presentation-only: no verb can look at it, so a model asked "what is the live
   * preview showing?" has no ground truth to answer from. Observed twice in real sessions, it
   * answered anyway — naming an app after every switch, having never queried anything. Stating the
   * preview's real state alongside the observation is what makes the honest answer available. */
  preview?: string;
  /** Set when an app was opened but did not actually become frontmost — reported, never hidden. */
  frontmostWarning?: string;
  /** Typed verification of whether THIS action actually changed the screen (Stage 6): the runtime
   * judges the action by the fresh frame, not by the driver's success return. */
  progressCheck?: VerificationResult;
  /** The honest per-action outcome contract: delivery status, observed state, semantic
   * postcondition, confidence, and failure reason. Pixel change is supporting evidence only —
   * `confidence: 'proven'` requires a matched semantic postcondition. */
  actionResult?: ActionResult;
  /** Product-level attribution for the executor that handled this action. The mechanism remains in
   * diagnostics, while `level` is the one semantic → physical → visual → stop vocabulary
   * defined by the product reset. Omitted when a legacy/uninstrumented path acted, rather than
   * inventing a flattering attribution after the fact. */
  executor?: {
    level: ExecutorLevel;
    mechanism: AutomationMechanism | null;
    description: string;
  };
  /** Why a natural-language semantic query resolved to this control. This makes fuzzy targeting
   * inspectable in traces and benchmarks instead of hiding the resolver behind a click. */
  targeting?: {
    query: string;
    confidence: 'high' | 'medium';
    margin: number;
    label?: string;
    role?: string;
    elementIndex?: number;
    elementToken?: string;
    reasons: string[];
  };
  /** Auditable prepare → preflight → commit → receipt facts for physical input. */
  actionReceipt?: {
    kind: 'pointer' | 'keyboard';
    target: { app?: string; pid: number; windowId?: number; element?: string; role?: string };
    preflight: {
      /**
       * Did the intended window prove it would receive the event? `undefined` means the probe could
       * not answer — which is NOT the same as true, and must never be rendered as if it were. Both
       * this field and `commit.recipientApp` are omitted rather than defaulted to the intended
       * target, because restating the request as its own confirmation is how a click delivered into
       * a different application still produced a receipt naming the one that was asked for.
       */
      recipientPid?: number; recipientApp?: string; windowMatched?: boolean;
      elementMatched?: boolean; elementConfidence?: 'high' | 'medium' | 'none';
      stable?: boolean; editable?: boolean | null; reason: string;
    };
    /** `recipientApp` is what the driver observed receiving the event; absent when it did not say. */
    commit: { delivered: boolean; recipientApp?: string };
    postcondition?: { query: string; matched: boolean };
  };
  /** Nudge attached after several consecutive no-effect actions — re-observe / retarget / wait. */
  recoveryHint?: string;
  /** The bounded recovery controller's decision for THIS action (Stage 6): continue / retry /
   * recover / escalate / stop-success / stop-failure. Once it latches stop-failure, the runtime
   * refuses further acting verbs until the agent re-observes. */
  recoveryDecision?: RecoveryDecision;
  screenWidth?: number; screenHeight?: number;
  x?: number; y?: number;
  app?: string;
  accessibility?: boolean | null;
  screenRecording?: boolean | null;
  displays?: DesktopDisplay[];
  pid?: number;
  windowId?: number;
  elements?: unknown[];
  /** How many elements the capture resolved when the payload deliberately does not list them
   * (`screenshot`). The map itself is cached on the runtime, so semantic targeting is unaffected. */
  elementCount?: number;
  /** Internal native sampler result. Model-visible observations receive compact evidence per item. */
  visualSignatures?: Array<NativeVisualSignature & { id?: unknown }>;
  /** On-device Vision fallback. OCR text is content by design; shape results contain geometry only. */
  visualAnalysis?: { texts: NativeVisualText[]; shapes: NativeVisualShape[]; latencyMs?: number; errors?: string[] };
  tree?: string;
  degraded?: boolean;
  /** Pasteboard contents — the OS-level bridge between apps. `changeCount` is the system's
   * monotonic write counter; comparing it across a copy is what proves the copy actually placed
   * something rather than merely delivering a keystroke. -1 means the driver could not report it. */
  clipboard?: { text: string; files: string[]; types: string[]; changeCount: number };
  /** Screens with their visible (menu-bar/Dock-excluded) areas — what layouts are computed against. */
  screens?: ScreenInfo[];
  /** Items on the desktop, with their rectangles in global screen points. */
  icons?: Array<{ name: string; frame: ScreenRect }>;
  /** The window's ACTUAL rectangle after a geometry change. Apps enforce minimum sizes and size
   * increments, so this frequently differs from what was requested — reported, never assumed. */
  windowFrame?: ScreenRect;
  requestedFrame?: ScreenRect;
  /** The rectangle of an OS-confirmed modal sheet/dialog, when one is blocking this app. */
  modalFrame?: ScreenRect;
  /** Did the app accept the request to publish its full accessibility tree? Native apps refuse. */
  applied?: boolean;
  /** The window that would actually receive a click at a probed point — the OS's answer, not ours. */
  windowAt?: {
    window_id: number; owner_pid: number; owner_name: string; layer: number; bounds: ScreenRect;
    top_owner_name?: string; top_window_id?: number; top_layer?: number;
    element_chain?: AXElementIdentity[];
  };
  /** Current native keyboard recipient, used before and after text/key delivery. */
  focusedElement?: AXElementIdentity;
  focusChain?: AXElementIdentity[];
  /** Did a single-window raise succeed? Floating panels can stay above regardless. */
  raised?: boolean;
  fullscreen?: boolean;
  /** Launch Services' bundle id for an app name, when the OS could resolve one. */
  bundleId?: string;
  /** Is that application currently running? */
  running?: boolean;
  /** False when the window exposes no fullscreen capability at all (a panel, a utility window). */
  fullscreenSupported?: boolean;
  /** Did the window actually settle into the requested fullscreen state? */
  fullscreenMatched?: boolean;
  verification?: { query: string; matched: boolean; matchCount: number };
  recording?: { enabled: boolean; outputDir?: string; videoPath?: string; error?: string;
    /** What the recording captures (Stage 8): a specific agent window vs the whole display. */
    scope?: string;
    /** True when the recording is scoped to a capture-safe agent surface (no unrelated windows). */
    captureSafe?: boolean };
  details?: unknown;
  /** Coordinate contract attached to observations so a model never mixes AX global points with
   * screenshot pixels. Element frames exposed in results use the same pixels as x/y. */
  coordinateSpace?: { xY: 'screenshot_pixels'; elementFrames: 'screenshot_pixels'; normalized: '0-1000' };
  completionGuidance?: string;
  summary: string;
}

const COMPUTER_COMPLETION_GUIDANCE = 'Match the answer type the user requested. A categorical state such as Normal, On, or Connected is not a percentage or other numeric value. Battery health means both Battery Condition and Maximum Capacity percentage when macOS exposes them; open the Battery Health info sheet instead of stopping at Normal. If the exact requested datum is not visible, use the Details, info, or disclosure control on the same row/section as that datum in the newest screenshot; never substitute an unrelated Options or ellipsis menu. Repeated generic controls may be enriched with their row context (for example, "Show Detail — Battery Health"); choose that exact control and never click structural containers such as Window, Sidebar, Outline, Group, or Scroll Area. Set sliders with set_value on their fresh semantic handle: maximum/full/100% maps to 1 and minimum/mute/0% maps to 0; never click or drag a slider to approximate an exact value. A visible modal, sheet, dialog, or popover blocks the page behind it: interact only with that foreground surface and, after reading it, dismiss it with Done, Close, Cancel, or Escape before navigating or scrolling the underlying page. Dismissing a blocker does not complete the interrupted navigation: retry the original action. Seeing a destination label in a sidebar/menu is not proof that its page is open; require the destination heading in the main content pane. Sidebar entries are navigation, never the requested settings inside that page. Never mark a checklist phase complete when its latest Computer action failed or when no post-action screenshot proves the phase. Otherwise report that the datum could not be retrieved.';
const POST_ACTION_ELEMENT_BUDGET = 80;
/** How many candidate replacement windows a vanished parent capture may be probed against. Each
 * probe costs a screenshot plus an AX walk, and the display-context fallback behind it is always
 * available, so this trades an unbounded worst case for at most a fixed one. */
const TRANSIENT_ADOPTION_ATTEMPTS = 3;
/** Ceiling for the background reopen Apple event. A running app replies in well under a second; the
 * cases that exceed this (an app that ignores the event, or a first-time TCC consent dialog blocking
 * osascript) are better served by falling through to the bounded activation pulse than by waiting. */
const REOPEN_EVENT_TIMEOUT_MS = 4_000;
/** Half-width, in LOGICAL POINTS, of the patch compared across frames around a raw x/y click when no
 * AX control claims that point. Sized to sit inside a typical control rather than span its
 * neighbours; converted to pixels through the capture's scale factor at use. */
const RAW_TARGET_PATCH_POINTS = 24;
/** AX roles that accept typed text. Mirrors the native helper's own `editable` derivation
 * (helper.source.ts), which is the authority when it is present. */
const EDITABLE_AX_ROLES = new Set(['AXTextField', 'AXTextArea', 'AXSearchField', 'AXComboBox']);
/** Can this observed element receive typed text? The helper's explicit `editable` flag wins; role is
 * the fallback for older drivers that do not publish it. */
function isEditableElement(element: { role?: string; editable?: boolean } | undefined): boolean {
  if (!element) return false;
  return element.editable === true || EDITABLE_AX_ROLES.has(String(element.role || ''));
}

/**
 * Should an UNNAMED `type` be refused as ambiguous? Returns the refusal text, or null to allow.
 *
 * Focus already answers "which field?". Counting editable fields alone called a perfectly
 * determined frame ambiguous: measured 2026-08-18 in Spotify/Music, where the search field was
 * visibly focused but its label matched no semantic query, so the model fell back to an unqualified
 * type, was refused for an ambiguity it had no way to resolve, clicked the field, typed, and was
 * refused again — a loop it could not exit.
 *
 * Exactly one FOCUSED editable field is unambiguous. Absent focus information the original refusal
 * stands rather than guessing. This is only a pre-filter: keyboardPreflight re-checks the LIVE
 * focused element and still refuses when it is not editable, so a stale `focused` flag cannot
 * direct keystrokes at the wrong control.
 */
export function unnamedTypingRefusal(
  elements: readonly {
    role?: string; editable?: boolean; focused?: boolean;
    label?: string; value?: string; description?: string;
  }[],
): string | null {
  const editables = elements.filter(isEditableElement);
  if (editables.filter(element => element.focused === true).length === 1) return null;
  const labels = Array.from(new Set(editables
    .map(element => String(element.label || element.value || element.description || element.role || '').trim())
    .filter(Boolean)));
  if (labels.length <= 1) return null;
  return `literal typing is ambiguous because this frame has multiple editable fields (${labels.slice(0, 6).join(', ')}) and none of them holds keyboard focus; name the intended field with query, elementToken/elementIndex, or x+y — or click it first so focus decides`;
}

type ObservedElement = {
  label?: string;
  originalLabel?: string;
  contextLabel?: string;
  role?: string;
  value?: string;
  description?: string;
  frame?: unknown;
  elementToken?: string;
  elementIndex?: number;
  enabled?: boolean;
  focused?: boolean;
  editable?: boolean;
  visual?: VisualFingerprint;
  visualDelta?: VisualDelta;
  visualOnly?: boolean;
  /** AX actions the control publishes, folded from the tree. Absent means the tree did not say;
   * an empty array means it said "none". Only the latter proves background delivery cannot work. */
  axActions?: string[];
};

/** App-level AXWindowCreated notifications are emitted with the AXApplication as their element on
 * some macOS apps (notably Messages). That event says only that AppKit posted a notification; it
 * does not identify a new visible surface and repeatedly fires while the existing window settles.
 * Invalidating a freshly captured frame on that signal creates an observe -> refused click loop.
 * A real created window carries a concrete, positive frame and remains a valid stale-frame signal. */
export function accessibilityEventInvalidatesObservation(event: AccessibilityEvent): boolean {
  if (event.notification !== 'AXWindowCreated') return true;
  const frame = (event.element as any)?.frame;
  const w = Number(frame?.w ?? frame?.width);
  const h = Number(frame?.h ?? frame?.height);
  if (!frame || !(w > 0) || !(h > 0)) return false;
  // A positive frame is not enough: apps publish DECORATIVE windows that no user could interact
  // with. Measured in Notes — a 66x20 `AXWindow` (subrole AXDialog, identifier `_NS:8`, title
  // "Window") is created while the note list settles, and treating it as a real new surface
  // invalidated the frame the caller had just observed. Every click was then refused with "the
  // element you named is no longer in the tree", which reads as the app being unclickable.
  //
  // Direction of safety is deliberate. Ignoring a real new window costs at most one action aimed at
  // a superseded surface, and the geometry/target guards on the frame registry still catch that.
  // Honouring a decoration costs EVERY action, permanently. So a created window has to be big
  // enough to hold a control before it may invalidate anything; any genuine dialog, sheet or
  // palette clears this comfortably.
  return w >= MIN_REAL_WINDOW_W && h >= MIN_REAL_WINDOW_H;
}

/** Smallest created window that could plausibly carry a control the user acts on, in points. */
const MIN_REAL_WINDOW_W = 80;
const MIN_REAL_WINDOW_H = 60;

/** All the text one observed element contributes, normalized for comparison across frames. */
export function observedElementText(element: any): string {
  return `${element?.label || ''} ${element?.value || ''} ${element?.description || ''}`.replace(/\s+/g, ' ').trim();
}

const APPLICATION_FAILURE_TEXT = /\b(?:could not|couldn't|cannot|can't|was not|wasn't|failed to|unable to)\b|\bsomething went wrong\b|\bplease choose a different\b/i;
/** Roles macOS uses only for a surface that IS an error/alert presentation. */
const ALERT_ROLES = new Set(['AXAlert', 'AXDialog', 'AXSheet']);
/** How far from the failure text an app's dismissal button may sit and still belong to it, in AX
 * screen points. An alert keeps its message and its OK button in one small rectangle; this bound is
 * what stops a "Close" control elsewhere in the window from adopting unrelated text. */
const DIALOG_CONTROL_REACH = 200;

/**
 * Detect a failure the APPLICATION ITSELF states in the fresh frame. This caught WhatsApp saying
 * "This photo could not be sent" after its Send button had accepted the click; a pixel change must
 * never turn that explicit rejection into a likely-success receipt.
 *
 * Three independent conditions, because a `rejected` verdict is expensive — it spends a recovery
 * immediately and four of them latch the controller into stop-failure permanently:
 *
 *  1. ROLE OR OWNERSHIP. Either the element's own role is an alert presentation, or a dismissal
 *     button sits near it. The dismissal word must be the WHOLE label: a synthesized name from
 *     `describeUnlabeledControls` always carries a relation and a `#N` ordinal ('right of "Close"
 *     #2'), and an enriched generic label always carries its row context, so neither can be mistaken
 *     for a control the app itself named "Close".
 *  2. PROXIMITY. Frames must actually be near each other, so a dismissible banner at the top of a
 *     window cannot certify an error sentence at the bottom. Unprovable proximity (a missing frame)
 *     does not certify anything either — the alert role in rule 1 is then the only route.
 *  3. FRESHNESS, but only where the evidence is circumstantial. Chat transcripts, mail, documents and
 *     web pages are full of sentences like "I couldn't make it" — they persist frame to frame, so
 *     without freshness a single innocuous message would refuse every subsequent action in that
 *     window until the session was dead.
 *
 *     Freshness therefore applies to the weaker, nearby-dismissal route ONLY. An `AXAlert`/`AXDialog`/
 *     `AXSheet` is unambiguous — a chat bubble is never one — and an alert that is STILL up is still an
 *     unresolved rejection, so requiring novelty there would hide a repeated failure: retry the same
 *     action without dismissing, the identical text persists, and it would silently downgrade to
 *     `no-change`, losing the reason the app gave.
 *
 * Pass `previousTexts` from the pre-action observation. Omitting it disables rule 3 only.
 */
export function visibleApplicationFailure(elements: unknown[], previousTexts?: Iterable<string>): string | null {
  const list = Array.isArray(elements) ? elements as any[] : [];
  const before = previousTexts ? new Set(previousTexts) : null;
  const dismissals = list.filter(element => {
    if (String(element?.role || '') !== 'AXButton') return false;
    const name = String(element?.originalLabel || element?.original_label || element?.label || '').trim();
    return /^(?:ok|dismiss|close|try again|retry)$/i.test(name);
  });
  const failure = list.find(element => {
    const text = observedElementText(element);
    if (!text || !APPLICATION_FAILURE_TEXT.test(text)) return false;
    // Rule 1, strong form: an alert presentation is unambiguous, so it needs no novelty. An alert
    // still on screen is still an unresolved rejection.
    if (ALERT_ROLES.has(String(element?.role || ''))) return true;
    // Rule 3: the nearby-dismissal route is circumstantial, so it requires the text to be new.
    if (before?.has(text)) return false;
    const frame = elementFrame(element);
    return dismissals.some(button => {
      const buttonFrame = elementFrame(button);
      if (!frame || !buttonFrame) return false; // rule 2 unprovable → do not reject on this basis
      return rectsWithin(frame, buttonFrame, DIALOG_CONTROL_REACH);
    });
  });
  return failure ? observedElementText(failure).slice(0, 240) : null;
}

/** Do two rectangles come within `reach` points of each other on both axes? */
function rectsWithin(a: Frame, b: Frame, reach: number): boolean {
  const gapX = Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)));
  const gapY = Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));
  return gapX <= reach && gapY <= reach;
}

type PointPreflight = {
  recipientPid?: number;
  recipientApp?: string;
  recipientWindowId?: number;
  windowMatched?: boolean;
  elementMatch?: ElementMatchReceipt;
  stable?: boolean;
};

type FocusProbe = {
  app?: string;
  pid?: number;
  element?: NativeElementReceipt;
  chain: NativeElementReceipt[];
};

// AXMenuItem earns its place here the moment an open menu became visible at all: a command in an
// open menu is the most actionable thing on the screen. It is only ever present while a menu is
// open — the observation filter drops closed ones — so every heuristic counting actionable controls
// behaves exactly as before on a window with no menu showing.
const ACTIONABLE_AX_ROLES = new Set([
  'AXButton', 'AXCheckBox', 'AXComboBox', 'AXDisclosureTriangle', 'AXLink', 'AXMenuButton',
  'AXMenuItem', 'AXPopUpButton', 'AXRadioButton', 'AXSearchField', 'AXSlider', 'AXSwitch', 'AXTab',
  'AXTextArea', 'AXTextField',
]);
// AXMenu is the open menu's PANEL. It is a container in the same sense as a toolbar — the commands
// are its children — so clicking it is refused with a message naming what to click instead.
const STRUCTURAL_AX_ROLES = new Set(['AXWindow', 'AXOutline', 'AXGroup', 'AXScrollArea', 'AXToolbar', 'AXMenu']);
/** Roles where the visible CENTER is always at least as good a click target as any pixel inside —
 * an edge-grazing raw click on one of these delivers fine yet activates nothing. Text inputs are
 * excluded (the click point places the caret) and sliders are excluded (position IS the value). */
const SNAP_TO_CENTER_AX_ROLES = new Set([
  'AXButton', 'AXCheckBox', 'AXDisclosureTriangle', 'AXLink', 'AXMenuButton', 'AXMenuItem',
  'AXPopUpButton', 'AXRadioButton', 'AXSwitch', 'AXTab',
]);

function elementFrame(element: any): Frame | null {
  const frame = element?.frame;
  if (!frame) return null;
  const parsed = { x: Number(frame.x), y: Number(frame.y), w: Number(frame.w), h: Number(frame.h) };
  return Object.values(parsed).every(Number.isFinite) && parsed.w > 0 && parsed.h > 0 ? parsed : null;
}

/** Accessibility APIs often expose several identical icon buttons ("Show Detail", "Info") while
 * their row labels are separate static-text nodes. Join those two pieces before showing the map to
 * the model so a semantic target describes the control's actual purpose, not just its glyph. */
function enrichControlLabels(elements: any[]): any[] {
  const generic = /^(show detail|details?|info(?:rmation)?|more|disclosure|ellipsis)$/i;
  const textRoles = new Set(['AXStaticText', 'AXHeading', 'AXLabel']);
  return elements.map(element => {
    const role = String(element?.role || '');
    const label = String(element?.label || '').trim();
    const control = elementFrame(element);
    const needsContext = role === 'AXSlider' ? !label : generic.test(label);
    if (!control || !ACTIONABLE_AX_ROLES.has(role) || !needsContext) return element;

    const centerY = control.y + control.h / 2;
    const rowTexts = elements
      .filter(candidate => candidate !== element && textRoles.has(String(candidate?.role || '')))
      .map(candidate => ({ candidate, frame: elementFrame(candidate) }))
      .filter(({ frame }) => {
        if (!frame) return false;
        const candidateCenterY = frame.y + frame.h / 2;
        const rowTolerance = Math.max(16, Math.min(36, (control.h + frame.h) / 2));
        return Math.abs(candidateCenterY - centerY) <= rowTolerance
          && frame.x + frame.w <= control.x + 8
          && control.x - (frame.x + frame.w) <= (role === 'AXSlider' ? 200 : 450);
      })
      .sort((a, b) => a.frame!.x - b.frame!.x)
      .map(({ candidate }) => String(candidate?.label || candidate?.value || '').trim())
      .filter(text => text && !/^(?:decrease|increase)\s+volume$/i.test(text));
    const contextParts = Array.from(new Set(rowTexts)).slice(role === 'AXSlider' ? -1 : -3);
    let contextLabel = contextParts.join(' · ').slice(0, 120);
    if (role === 'AXSlider' && !contextLabel) {
      const rowButtons = elements
        .filter(candidate => String(candidate?.role || '') === 'AXButton')
        .map(candidate => ({ label: String(candidate?.label || ''), frame: elementFrame(candidate) }))
        .filter(candidate => candidate.frame
          && Math.abs((candidate.frame.y + candidate.frame.h / 2) - centerY) <= 24
          && candidate.frame.x >= control.x - 60
          && candidate.frame.x <= control.x + control.w + 60)
        .map(candidate => candidate.label);
      const hasVolumeStepper = rowButtons.some(text => /^decrease volume$/i.test(text))
        && rowButtons.some(text => /^increase volume$/i.test(text));
      const outputSliderBelow = elements.some(candidate => {
        const frame = elementFrame(candidate);
        return String(candidate?.role || '') === 'AXSlider'
          && /output volume/i.test(String(candidate?.label || candidate?.value || ''))
          && !!frame && frame.y > control.y;
      });
      if (hasVolumeStepper && outputSliderBelow) contextLabel = 'Alert volume';
    }
    if (!contextLabel || contextLabel.toLocaleLowerCase() === label.toLocaleLowerCase()) return element;
    const controlName = label || role.replace(/^AX/, '');
    return {
      ...element,
      original_label: element.label,
      context_label: contextLabel,
      label: `${controlName} — ${contextLabel}`,
    };
  });
}

/**
 * Verb synonyms models reach for that are not in the schema enum. Live runs showed `snapshot`
 * called in nearly every episode — the model wanted a fresh frame, got "unsupported computer
 * action: snapshot", and burned the step. These are all unambiguous one-to-one synonyms, so
 * mapping them is strictly better than failing a step on vocabulary.
 *
 * SECURITY: normalization must run BEFORE the governor's gating decision, never after. Several
 * targets here (`key`, `type`, `open`) are gated actions — normalizing downstream of the gate
 * would let `press` slip through as an unrecognized, ungated verb and then execute as `key`.
 */
const DESKTOP_ACTION_ALIASES: Record<string, string> = {
  snapshot: 'screenshot', capture: 'screenshot', screen_shot: 'screenshot', screen_capture: 'screenshot',
  look: 'observe', inspect: 'observe', read_screen: 'observe', get_state: 'observe', get_window_state: 'observe',
  press: 'key', keypress: 'key', key_press: 'key', hotkey: 'key', send_keys: 'key',
  write: 'type', type_text: 'type', input_text: 'type', enter_text: 'type',
  launch: 'open', open_app: 'open',
  // These three mean "switch to an app that is already open" — route them to focus, which does
  // exactly that without the re-launch (and second-instance risk) that open would incur.
  activate: 'focus', focus_app: 'focus', switch_app: 'focus', switch_to: 'focus',
  mouse_move: 'move', move_mouse: 'move', left_click: 'click', mouse_click: 'click',
};

/** Map a model-supplied verb onto the real action, or return it unchanged. */
export function normalizeDesktopAction(action: string): string {
  const key = String(action || '').trim().toLocaleLowerCase();
  return DESKTOP_ACTION_ALIASES[key] || action;
}

/** Text fields on a driver element that a human — or a `query` — would ever read. */
const ELEMENT_TEXT_KEYS = ['label', 'value', 'description', 'original_label', 'context_label', 'title', 'placeholder'];

/**
 * Another application's window owns the point, so the physical channel cannot reach the target.
 *
 * Distinguished from every other preflight refusal because nothing is wrong with the caller's
 * target: the element identity still holds, only the pixel route to it is blocked. A caller that
 * named its target semantically can therefore be re-routed through accessibility instead of refused,
 * while a caller that supplied raw pixels genuinely has nowhere else to go.
 */
export class OccludedPointError extends Error {
  constructor(message: string, readonly occluder: { pid?: number; name?: string }) {
    super(message);
    this.name = 'OccludedPointError';
  }
}

/** The coordinate-free way to address an element, if this element has one. */
function accessibilityHandle(element?: { elementToken?: string; elementIndex?: number }):
  { element_token: string } | { element_index: number } | null {
  if (element?.elementToken) return { element_token: element.elementToken };
  if (element?.elementIndex != null) return { element_index: Math.floor(element.elementIndex) };
  return null;
}

/**
 * Turn a named layout into a rectangle inside a screen's VISIBLE area.
 *
 * Everything is derived from `visible` rather than the full screen frame, so a tiled window sits
 * below the menu bar and clear of the Dock instead of hiding behind them. Halves are computed by
 * splitting and then deriving the second half from the first, so two tiles always meet exactly on
 * an odd-width screen rather than leaving a one-pixel seam or overlapping by one.
 */
export function layoutRect(layout: WindowLayout, visible: ScreenRect): ScreenRect {
  const halfW = Math.floor(visible.w / 2);
  const halfH = Math.floor(visible.h / 2);
  const rightW = visible.w - halfW;
  const bottomH = visible.h - halfH;
  const midX = visible.x + halfW;
  const midY = visible.y + halfH;
  const thirdW = Math.floor(visible.w / 3);
  const lastThirdW = visible.w - 2 * thirdW;
  switch (layout) {
    case 'left': return { x: visible.x, y: visible.y, w: halfW, h: visible.h };
    case 'right': return { x: midX, y: visible.y, w: rightW, h: visible.h };
    case 'top': return { x: visible.x, y: visible.y, w: visible.w, h: halfH };
    case 'bottom': return { x: visible.x, y: midY, w: visible.w, h: bottomH };
    case 'top-left': return { x: visible.x, y: visible.y, w: halfW, h: halfH };
    case 'top-right': return { x: midX, y: visible.y, w: rightW, h: halfH };
    case 'bottom-left': return { x: visible.x, y: midY, w: halfW, h: bottomH };
    case 'bottom-right': return { x: midX, y: midY, w: rightW, h: bottomH };
    // Thirds use the same "derive the later tiles from the earlier ones" rule as halves, so three
    // columns always tile the full width exactly — no seam and no overlap on a width that is not
    // divisible by three.
    case 'left-third': return { x: visible.x, y: visible.y, w: thirdW, h: visible.h };
    case 'center-third': return { x: visible.x + thirdW, y: visible.y, w: thirdW, h: visible.h };
    case 'right-third': return { x: visible.x + 2 * thirdW, y: visible.y, w: lastThirdW, h: visible.h };
    case 'left-two-thirds': return { x: visible.x, y: visible.y, w: 2 * thirdW, h: visible.h };
    case 'right-two-thirds': return { x: visible.x + thirdW, y: visible.y, w: visible.w - thirdW, h: visible.h };
    case 'center': {
      const w = Math.round(visible.w * 0.6), h = Math.round(visible.h * 0.7);
      return { x: visible.x + Math.round((visible.w - w) / 2), y: visible.y + Math.round((visible.h - h) / 2), w, h };
    }
    case 'maximize':
    default: return { ...visible };
  }
}

/** The screen a rectangle mostly sits on — so arranging a window uses ITS display, not always the
 *  main one. Falls back to the main screen when nothing overlaps (a window parked off-screen). */
export function screenForRect(rect: ScreenRect | undefined, screens: ScreenInfo[]): ScreenInfo | null {
  if (!screens.length) return null;
  const main = screens.find(s => s.main) || screens[0];
  if (!rect) return main;
  let best: { screen: ScreenInfo; area: number } | null = null;
  for (const screen of screens) {
    const overlapW = Math.max(0, Math.min(rect.x + rect.w, screen.frame.x + screen.frame.w) - Math.max(rect.x, screen.frame.x));
    const overlapH = Math.max(0, Math.min(rect.y + rect.h, screen.frame.y + screen.frame.h) - Math.max(rect.y, screen.frame.y));
    const area = overlapW * overlapH;
    if (area > 0 && (!best || area > best.area)) best = { screen, area };
  }
  return best?.screen || main;
}

/** How closely did the window actually land on what was asked for? Apps enforce minimum sizes and
 *  size increments, so an exact match is the exception rather than the rule. */
function frameMatches(want: ScreenRect, got: ScreenRect | undefined, tolerance = 2): boolean {
  if (!got) return false;
  return Math.abs(want.x - got.x) <= tolerance && Math.abs(want.y - got.y) <= tolerance
    && Math.abs(want.w - got.w) <= tolerance && Math.abs(want.h - got.h) <= tolerance;
}

/**
 * Combos macOS handles at the WindowServer level, which change WHICH SPACE — and therefore which
 * windows — are visible.
 *
 * These are not application keystrokes: they never reach the focused app, and after one runs the
 * previously targeted window may be on a Space that is no longer on screen. Capturing that window
 * then yields an empty frame, which reads as a broken app rather than "you changed Spaces". The
 * runtime has to recognise them up front and re-establish what it is looking at afterwards.
 *
 *  - 'switch':   Ctrl+Left/Right moves between Spaces and fullscreen apps; Ctrl+1..9 jumps to one.
 *  - 'overview': Ctrl+Up (Mission Control) and Ctrl+Down (App Exposé) overlay every window, so no
 *                single app window is meaningfully capturable until the overlay is dismissed.
 */
export function classifySpaceCombo(combo: string): 'switch' | 'overview' | null {
  const keys = String(combo || '').toLocaleLowerCase().split('+').map(k => k.trim()).filter(Boolean);
  if (keys.length < 2) return null;
  const key = keys[keys.length - 1];
  const modifiers = new Set(keys.slice(0, -1));
  if (!modifiers.has('ctrl') && !modifiers.has('control')) return null;
  if (key === 'left' || key === 'right' || /^[1-9]$/.test(key)) return 'switch';
  if (key === 'up' || key === 'down') return 'overview';
  return null;
}

/**
 * Is `inner` substantially contained within `outer`? Used to tell a modal SHEET (which macOS draws
 * attached to and inside its parent window) apart from a floating palette or inspector, which is
 * also smaller than the main window but sits outside it and must never be treated as a modal
 * blocker. Driver bounds are `{x,y,width,height}`; a small slack absorbs shadow/rounding.
 */
function rectMostlyInside(inner: any, outer: any, minOverlapRatio = 0.8): boolean {
  const ix = Number(inner?.x), iy = Number(inner?.y);
  const iw = Number(inner?.width), ih = Number(inner?.height);
  const ox = Number(outer?.x), oy = Number(outer?.y);
  const ow = Number(outer?.width), oh = Number(outer?.height);
  if (![ix, iy, iw, ih, ox, oy, ow, oh].every(Number.isFinite) || iw <= 0 || ih <= 0) return false;
  const overlapW = Math.max(0, Math.min(ix + iw, ox + ow) - Math.max(ix, ox));
  const overlapH = Math.max(0, Math.min(iy + ih, oy + oh) - Math.max(iy, oy));
  return (overlapW * overlapH) / (iw * ih) >= minOverlapRatio;
}

/**
 * Resolve a desktop item by name. Exact match wins outright; otherwise a single unambiguous
 * case-insensitive partial match is accepted. Several partial matches are refused with the
 * candidates listed, because silently picking one would move the wrong file.
 */
export function resolveDesktopIcon(
  icons: Array<{ name: string; frame: ScreenRect }>, query: string,
): { name: string; frame: ScreenRect } {
  const wanted = query.trim().toLocaleLowerCase();
  if (!wanted) throw new Error('desktop item name is empty');
  const named = icons.filter(i => i.name);
  const exact = named.filter(i => i.name.toLocaleLowerCase() === wanted);
  if (exact.length === 1) return exact[0];
  const partial = named.filter(i => i.name.toLocaleLowerCase().includes(wanted));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(`"${query}" matches several desktop items (${partial.map(i => i.name).join(', ')}) — use the exact name`);
  }
  throw new Error(`no desktop item named "${query}"${named.length ? ` (on the desktop: ${named.map(i => i.name).join(', ')})` : ' — the desktop appears empty'}`);
}

/** A clipboard snapshot the runtime can compare across an action. */
type ClipboardSnapshot = { text: string; files: string[]; types: string[]; changeCount: number };

/**
 * Did the pasteboard actually receive new content between two snapshots?
 *
 * changeCount is the OS's monotonic write counter and is the ONLY reliable signal: it advances even
 * when an app writes content identical to what was already there, which a text comparison would
 * report as "nothing happened". Drivers that cannot read it report -1, and only then do we fall back
 * to comparing content — weaker, because re-copying the same text is then indistinguishable from a
 * copy that did nothing.
 */
function clipboardAdvanced(before: ClipboardSnapshot, after: ClipboardSnapshot): boolean {
  if (before.changeCount >= 0 && after.changeCount >= 0) return after.changeCount !== before.changeCount;
  return after.text !== before.text || after.files.join('|') !== before.files.join('|');
}

/** Human-readable one-liner for a clipboard snapshot, with text truncated for the transcript. */
function describeClipboard(clip: ClipboardSnapshot): string {
  if (clip.files.length) return `${clip.files.length} file(s): ${clip.files.join(', ')}`;
  const text = clip.text.replace(/\s+/g, ' ').trim();
  if (!text) return 'clipboard is empty';
  return `${clip.text.length} chars: "${text.length > 160 ? `${text.slice(0, 160)}…` : text}"`;
}

/**
 * Driver >=0.12 reports element text WITH the invisible bidi marks macOS embeds; 0.8 handed them
 * over already stripped. `trim()` does not remove them, so they poison BOTH ends of the pipeline:
 * the model is shown "‎Chats" and cannot retype it, and — worse — an EXACT label match
 * silently degrades into a substring match, because `"‎chats" === "chats"` is false while
 * `"‎chats".includes("chats")` is true. The resolver's exact tier (score 0) therefore goes
 * empty, every marked label collapses into the same "contains" bucket, and a precise query like
 * "Chats" is rejected as ambiguous against every other marked label. That is what pushed the model
 * off `query` and onto guessed element indices in live WhatsApp runs. Strip the marks at the one
 * place driver elements enter Bimax state, so both the model-visible list and the resolver see the
 * same clean text.
 */
export function sanitizeDriverElements(elements: any[]): any[] {
  return elements.map(element => {
    if (!element || typeof element !== 'object') return element;
    let cleaned = element;
    for (const key of ELEMENT_TEXT_KEYS) {
      const raw = element[key];
      if (typeof raw !== 'string') continue;
      const stripped = stripInvisibleMarks(raw);
      if (stripped === raw) continue;
      if (cleaned === element) cleaned = { ...element };
      cleaned[key] = stripped;
    }
    return cleaned;
  });
}

/**
 * Reach when hunting for the text that names an icon — deliberately ADJACENCY, not proximity.
 *
 * A flat radius does not describe how labelling works. With a 260×120pt box, WhatsApp's window
 * close/minimize/zoom buttons were named `unlabeled Button near "New chat"` after a heading 248pt
 * away across the window; the model read that as the New Chat control, clicked it, and reopened the
 * same popover on every retry. Text names a control when it sits in the control's ROW or its
 * COLUMN, so require alignment on one axis before distance on the other counts for anything.
 */
const UNLABELED_TEXT_REACH = { alongRow: 200, alongColumn: 80 };

/**
 * Roles that COVER the window: while one is open the accessibility tree exposes only its contents,
 * so every control of the underlying page is simply absent from the observation.
 */
const FOREGROUND_SURFACE_ROLES = new Set(['AXPopover', 'AXSheet', 'AXMenu', 'AXDialog']);

/**
 * Name the foreground surface covering the window, if one is open.
 *
 * A popover usually carries NO label, so the observation just looks like a window whose controls
 * vanished. That is what stranded a real run: with WhatsApp's "New chat" popover open, the tree
 * held 24 contact rows and no composer, so the model hunted for an attachment button that was not
 * in the map, clicked contacts instead, and looped. Saying "a popover is covering the window"
 * turns an invisible dead end into a recoverable one.
 */
function foregroundSurfaceNotice(elements: any[]): string | null {
  const windowFrame = elementFrame(elements.find(element => String(element?.role || '') === 'AXWindow'));
  const surface = elements.find(element => FOREGROUND_SURFACE_ROLES.has(String(element?.role || '')));
  if (!surface) return null;
  const frame = elementFrame(surface);
  const kind = String(surface.role || '').replace(/^AX/, '').toLocaleLowerCase();
  const where = frame && windowFrame
    ? ` at ${Math.round(frame.x)},${Math.round(frame.y)} (${Math.round(frame.w)}×${Math.round(frame.h)})`
    : '';
  return `A ${kind} is open${where} and is covering the window: the elements listed are ITS contents, `
    + `and every control of the page behind it is absent from this observation — not missing from the app. `
    + `If what you need is not listed, dismiss the ${kind} first (press escape, or click outside it), `
    + `re-observe, and only then look for the control.`;
}

/**
 * Warn when the app publishes almost nothing nameable.
 *
 * Some Chromium and Electron shells publish almost no accessibility text. Silence there is expensive
 * — the model keeps issuing `query` for an "attachment button" that is not in the map, and every miss
 * looks like a broken click. Naming the condition lets it switch to the screenshot, which is the only
 * place that information exists.
 *
 * The opposite failure is worse, and it is what this used to do. WhatsApp was the app this notice was
 * written for ("31 elements of which 22 unlabeled"), but re-measured on 2026-08-05 it publishes a NAME
 * for nearly every control — Heman, Dad, Mom 2, Park+, Send, Compose message. The old count only ever
 * measured how many controls a rewrite had touched, so the notice fired on a perfectly nameable app
 * and told the model to stop using names. Thin trees are a real shape; WhatsApp is not one, and a
 * low element COUNT is not the same thing as a low name count.
 */
export function thinTreeNotice(elements: any[]): string | null {
  const actionable = elements.filter(element => ACTIONABLE_AX_ROLES.has(String(element?.role || '')));
  if (actionable.length === 0) return null;
  const unlabeled = actionable.filter(element => !hasSayableName(element));
  if (unlabeled.length < 6 || unlabeled.length / actionable.length < 0.6) return null;
  return `This app exposes little accessibility text: ${unlabeled.length} of ${actionable.length} controls have no name of their own `
    + `(the "unlabeled …" entries are positions this runtime assigned, not names the app supplied). `
    + `Do not keep re-querying for a control by a name you expect — it is not in the map. Read the SCREENSHOT to find the control, `
    + `then click the nearest listed element or its screenshot pixel, and verify from the next frame.`;
}

/** Recommend a universal preparation step when a cramped, icon-heavy window makes precision poor.
 * The rule is geometric rather than app-specific, so it applies equally to software not yet known. */
export function windowPreparationNotice(elements: any[], width?: number, height?: number): string | null {
  if (!width || !height) return null;
  const actionable = elements.filter(element => ACTIONABLE_AX_ROLES.has(String(element?.role || '')));
  const unlabeled = actionable.filter(element => !hasSayableName(element));
  const compact = actionable.filter(element => {
    const frame = elementFrame(element);
    return !!frame && (frame.w < 24 || frame.h < 24);
  });
  if ((width >= 720 && height >= 520) || (unlabeled.length < 6 && compact.length < 8)) return null;
  return `This ${width}×${height} window is cramped for precision targeting (${unlabeled.length} unlabeled and ${compact.length} compact controls). `
    + `Before speculative pixel clicks, use arrange layout=maximize (or fullscreen when an isolated Space benefits the task), then act only from the fresh resized frame.`;
}

/** Does `text` sit in the control's row or column closely enough to be its name? */
function textNamesControl(control: Frame, dx: number, dy: number): boolean {
  const sameRow = dy <= Math.max(20, control.h) && dx <= UNLABELED_TEXT_REACH.alongRow;
  const sameColumn = dx <= Math.max(20, control.w) && dy <= UNLABELED_TEXT_REACH.alongColumn;
  return sameRow || sameColumn;
}

/**
 * The macOS close/minimize/zoom buttons, which are AXButtons with no label like any icon control.
 *
 * They must never be offered as click targets: they are window management, they are reachable
 * through `close` and `arrange`, and a mis-aimed click on one destroys the window the task is
 * running in. Identified by the platform invariant — a small button in the window's top-left
 * corner — rather than by app, because every macOS window puts them in exactly that spot.
 */
function isWindowChrome(control: Frame, windowFrame: Frame | null): boolean {
  if (!windowFrame) return false;
  return control.w <= 22 && control.h <= 22
    && control.x - windowFrame.x <= 70
    && control.y - windowFrame.y <= 26;
}

/**
 * Strip window chrome from a driver element list. Applied to the RAW elements, before anything
 * splits into the model-visible map and the internal hit-test list — filtering only one of those
 * leaves the buttons clickable by raw x/y through the other.
 */
export function withoutWindowChrome(elements: any[]): any[] {
  const windowFrame = elementFrame(elements.find(element => String(element?.role || '') === 'AXWindow')) || null;
  if (!windowFrame) return elements;
  return elements.filter(element => {
    if (String(element?.role || '') !== 'AXButton') return true;
    const frame = elementFrame(element);
    return !frame || !isWindowChrome(frame, windowFrame);
  });
}

/**
 * Give every UNLABELED actionable control something a model can recognize and address.
 *
 * Icon-only buttons (send, attach, emoji, back, the WhatsApp sidebar rail) expose no AX label at
 * all, so they arrive as `AXButton ""`. `enrichControlLabels` cannot help: it only rewrites labels
 * that are GENERIC ("Info", "More"), and an empty label matches none of those patterns. The model
 * was therefore shown a row of indistinguishable blank buttons, could not name one in a `query`,
 * and fell back to guessing raw coordinates — the user-visible "it can't click unlabeled things".
 *
 * Name them by the nearest text in any direction (an icon's meaning usually sits beside or beneath
 * it), and when there is no nearby text at all, by stable position within the window. Position is a
 * weak name but a HONEST one: it distinguishes three blank buttons from each other, which is the
 * difference between an addressable control and a coin flip. The synthesized text goes to
 * `context_label`/`label` only — `original_label` stays empty so nothing pretends the app supplied
 * a name.
 */
export function describeUnlabeledControls(elements: any[]): any[] {
  const textRoles = new Set(['AXStaticText', 'AXHeading', 'AXLabel']);
  const texts = elements
    .map(candidate => ({ candidate, frame: elementFrame(candidate) }))
    .filter((entry): entry is { candidate: any; frame: Frame } =>
      !!entry.frame && textRoles.has(String(entry.candidate?.role || ''))
      && !!String(entry.candidate?.label || entry.candidate?.value || '').trim());
  const named = (entry: { candidate: any }) =>
    String(entry.candidate?.label || entry.candidate?.value || '').trim();

  // Window bounds anchor the positional fallback, so "top-left" means the window's corner rather
  // than the display's — the model reads these frames in window space.
  const actionable = elements
    .map(element => ({ element, frame: elementFrame(element) }))
    .filter((entry): entry is { element: any; frame: Frame } =>
      !!entry.frame && ACTIONABLE_AX_ROLES.has(String(entry.element?.role || '')));
  const windowFrame = elementFrame(elements.find(element => String(element?.role || '') === 'AXWindow')) || null;
  const blanks = actionable.filter(({ element, frame }) =>
    !ELEMENT_TEXT_KEYS.some(key => String(element?.[key] || '').trim())
    && !isWindowChrome(frame, windowFrame));
  if (blanks.length === 0) return elements;
  const window = elements.map(elementFrame).filter((frame): frame is Frame => !!frame);
  const bounds = window.length > 0 ? {
    x: Math.min(...window.map(frame => frame.x)), y: Math.min(...window.map(frame => frame.y)),
    right: Math.max(...window.map(frame => frame.x + frame.w)),
    bottom: Math.max(...window.map(frame => frame.y + frame.h)),
  } : null;

  const describe = ({ element, frame }: { element: any; frame: Frame }, ordinal: number): string => {
    const cx = frame.x + frame.w / 2;
    const cy = frame.y + frame.h / 2;
    const nearest = texts
      .map(entry => {
        const tx = entry.frame.x + entry.frame.w / 2;
        const ty = entry.frame.y + entry.frame.h / 2;
        const dx = Math.abs(tx - cx);
        const dy = Math.abs(ty - cy);
        return { entry, dx, dy, distance: Math.hypot(dx, dy) };
      })
      .filter(({ dx, dy }) => textNamesControl(frame, dx, dy))
      .sort((a, b) => a.distance - b.distance)[0];
    // The ordinal rides along even when nearby text supplies a name: a row of icon buttons commonly
    // shares its nearest text (three controls beside one "Type a message" field), and three controls
    // with the SAME synthesized name are no more addressable than three blank ones.
    if (nearest) {
      const tx = nearest.entry.frame.x + nearest.entry.frame.w / 2;
      const ty = nearest.entry.frame.y + nearest.entry.frame.h / 2;
      const horizontal = cx >= tx ? 'right of' : 'left of';
      const vertical = cy >= ty ? 'below' : 'above';
      const relation = nearest.dx > nearest.dy * 1.4 ? horizontal
        : nearest.dy > nearest.dx * 1.4 ? vertical
          : `${vertical} and ${horizontal}`;
      return `${relation} "${named(nearest.entry).slice(0, 60)}" #${ordinal}`;
    }
    if (!bounds || bounds.right <= bounds.x || bounds.bottom <= bounds.y) return `#${ordinal}`;
    const vertical = cy < bounds.y + (bounds.bottom - bounds.y) / 3 ? 'top'
      : cy > bounds.bottom - (bounds.bottom - bounds.y) / 3 ? 'bottom' : 'middle';
    const horizontal = cx < bounds.x + (bounds.right - bounds.x) / 3 ? 'left'
      : cx > bounds.right - (bounds.right - bounds.x) / 3 ? 'right' : 'center';
    return `${vertical}-${horizontal} #${ordinal}`;
  };

  // Order blanks top-to-bottom then left-to-right so the ordinal in a positional name is stable
  // across observations of an unchanged window instead of following driver walk order.
  const ordered = [...blanks].sort((a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x);
  const descriptions = new Map<any, string>();
  ordered.forEach((entry, index) => descriptions.set(entry.element, describe(entry, index + 1)));

  return elements.map(element => {
    const description = descriptions.get(element);
    if (!description) return element;
    const role = String(element?.role || '').replace(/^AX/, '') || 'Control';
    // Mark the name as OURS. A positional placeholder reads like a label and sits in the same field
    // as one, so without this marker the only way to tell it from a name the app published is to
    // sniff the "unlabeled " prefix — and the notices below, which must count exactly these, instead
    // guessed from `original_label` and got the answer backwards.
    return {
      ...element, context_label: description, label_source: 'synthesized',
      label: `unlabeled ${role} ${description}`,
    };
  });
}

/** Why background delivery cannot activate this control, and what does work.
 *
 * Background delivery activates an element through its published AX action, and plenty of ordinary
 * controls publish none: a Notes note row advertises `actions=[showmenu]` and nothing else, so
 * AXPress answers -25206 and the row cannot be activated that way AT ALL — while a foreground click
 * opens the same row in ~1.0s. Two callers reach this: one that read the published actions before
 * trying, and one that got -25206 back from the attempt. `evidence` is the only difference.
 *
 * Deliberately a REFUSAL rather than an automatic downgrade to a physical click: foreground delivery
 * moves the real cursor and takes focus, which is precisely what a background caller asked to avoid,
 * and silently swapping it is the same dishonesty the off-Space guard refuses. */
function noAxPressRefusal(name: string, evidence: string): string {
  return `"${name}" publishes no accessibility press action, so it cannot be activated by background delivery `
    + `(${evidence}). This is a property of the control, not a transient failure — retrying background delivery will fail identically. `
    + 'Use deliveryMode="foreground" to deliver a real click to the same target, which does activate it; that brings the window forward and moves the cursor.';
}

/** Can a caller name this control out loud and expect it to resolve?
 *
 * True for a name the app published, and equally true for one folded out of the tree text — that is
 * text the app rendered inside the control, so the user can see it and say it. False only when there
 * is no text anywhere, or when the sole "name" is a positional placeholder this runtime invented.
 *
 * Deliberately NOT `original_label`: that field holds the name a control had BEFORE a rewrite, so it
 * exists only on rewritten controls. Reading its absence as namelessness inverts the question and
 * was measured on WhatsApp reporting 29 of 31 controls nameless while every row carried its name. */
function hasSayableName(element: any): boolean {
  if (String(element?.label_source || '') === 'synthesized') return false;
  return ELEMENT_TEXT_KEYS.some(key => String(element?.[key] || '').trim());
}

export interface DesktopRuntimePort {
  run(cmd: DesktopCommand, ctx?: { cwd?: string; signal?: AbortSignal }): Promise<DesktopResult>;
  /** Cheap, non-spawning snapshot for the /computer hub: driver tier + last-known permissions. */
  quickStatus(): { driver: string; ready: boolean; accessibility: boolean | null; screenRecording: boolean | null };
  frontmostApp(): Promise<string>;
  /** Long-running, event-driven accessibility invalidation feed. Returns a synchronous disposer. */
  watchAccessibility?(pid: number, onEvent: (event: AccessibilityEvent) => void): () => void;
  /** Value-safe label/role for the fresh semantic handle an action is about to use. */
  describeTarget?(cmd: DesktopCommand): { label?: string; role?: string; value?: string } | null;
  dispose?(): Promise<void>;
  /** Best-effort: start any lazy cold-start work now so it overlaps with human decision time. */
  warm?(): void;
  /** The surface the agent is currently operating on (Stage 1), when the runtime tracks surfaces. */
  activeSurface?(): ExecutionSurface | null;
  /** User takeover (Stage 3): hand input to the user; acting verbs are refused until resume(). */
  pauseForUser?(): { ok: boolean; surface?: string };
  resume?(): { ok: boolean; surface?: string };
  /** Long-run durability (Stage 7): the bounded, compressed action history for this session. */
  history?(): ActionHistorySummary;
  /** Long-run durability (Stage 7): current bounded-state footprint (nothing accumulates unbounded). */
  memoryFootprint?(): { historyKept: number; observedElements: number; indexedElements: number; surfaces: number };
  /** PiP presentation status: enabled, target display/window identity, and honest privacy scope. */
  pipStatus?(): Promise<LivePipStatus>;
  /** What the next record_start would capture — so the approval layer can phrase the prompt honestly. */
  recordingScopePreview?(scope?: 'window' | 'display'): { scope: string; captureSafe: boolean };
  /** Mint a single-use whole-display recording approval token AFTER the user explicitly approved
   * that scope. Only the tool/approval layer calls this; models can never reach it. */
  authorizeFullDisplayRecording?(): string;
}

/** Pure: 0–1000 normalized → screen points (clamped). Retained name; the canonical implementation
 * now lives in the coordinate-transform layer (coordinates.ts) so all conversions share one audited
 * source. Still exported here for existing callers/tests. */
export const scaleNormalizedPoint = normalizedToPixel;

/** Read PNG IHDR dimensions without decoding the image. The native driver can report logical
 * macOS points alongside a Retina PNG; click coordinates must follow the actual PNG pixels. */
export function pngDimensionsFromBytes(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function exec(bin: string, args: string[], timeoutMs = 15_000, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, signal }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${bin} ${args[0] || ''}: ${String(stderr || err.message).trim().slice(0, 400)}`));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** Same as exec(), but feeds `input` on stdin — needed for pbcopy/xclip, which read the payload
 * from stdin rather than argv (and must, since clipboard text can be arbitrarily large). */
function execWithInput(bin: string, args: string[], input: string, timeoutMs = 15_000, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, signal }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${bin} ${args[0] || ''}: ${String(stderr || err.message).trim().slice(0, 400)}`));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
    child.stdin?.on('error', () => { /* the callback above reports the real failure */ });
    child.stdin?.end(input, 'utf8');
  });
}

function binExists(name: string): boolean {
  const dirs = (process.env.PATH || '').split(path.delimiter).concat(['/usr/bin', '/usr/sbin', '/opt/homebrew/bin', '/usr/local/bin']);
  return dirs.some(d => { try { fs.accessSync(path.join(d, name), fs.constants.X_OK); return true; } catch { return false; } });
}

const WAIT_MIN = 50, WAIT_MAX = 5000;

/** How long a cross-application drag holds over the destination before releasing. A receiving app
 *  has to be scheduled, process dragging-entered, and decide it accepts the type; the intra-window
 *  path finishes in under 100ms, which is reliably too fast for a background application. */
const CROSS_APP_DRAG_DWELL_MS = 700;

/** Keep .bimax/computer from growing unbounded during hours-long runs: this Mac's APFS gets
 * flaky under disk pressure, and screenshots are only evidence for the CURRENT few steps. */
export function sweepShots(dir: string, keep = 30): void {
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.png'))
      .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(keep)) fs.rmSync(path.join(dir, f), { force: true });
  } catch { /* hygiene is best-effort */ }
}

/** Verbs that ACT on the desktop (vs pure observation) — every one must yield ONE ActionResult. */
const ACTING_VERBS = new Set<DesktopAction>([
  'open', 'focus', 'click', 'type', 'key', 'set_value', 'drag', 'scroll', 'move',
  'hover', 'hold', 'mouse_down', 'mouse_up', 'copy', 'paste', 'clipboard',
  'arrange', 'desktop', 'close', 'quit_app', 'wait',
]);

/** Sidecar RPCs that can change app/system state; reads deliberately stay available while paused. */
const MUTATING_DRIVER_CALLS = new Set([
  'bring_to_front', 'click', 'drag', 'hotkey', 'launch_app', 'move_cursor', 'press_key',
  'scroll', 'set_value', 'stop_recording', 'type_text',
]);

/** Actions that consume the active window's latest visual/semantic context. Keep this separate
 * from ACTING_VERBS: focus creates a new frame, while clipboard and desktop operate on OS-global
 * state and therefore do not consume a window frame. */
const FRAME_GATED_VERBS = new Set<DesktopAction>([
  'click', 'type', 'key', 'set_value', 'drag', 'scroll',
  'hover', 'hold', 'mouse_down', 'mouse_up', 'copy', 'paste', 'arrange',
]);

/** Frame-gated verbs addressed by an IDENTITY the element map cannot invalidate.
 *
 * They still require a fresh frame of the intended window — laying out the wrong window, or typing
 * into the wrong app, is as bad as clicking the wrong control — but an accessibility event cannot
 * invalidate them the way it invalidates a coordinate or an element handle.
 *
 * `arrange` is addressed by WINDOW identity: the window id is still the window id. Refusing it for
 * "the app changed after observation" is self-inflicted, and measured — `open` mints AXWindowCreated
 * for the very window the following `arrange` was told to lay out, so `arrange` failed in ~1ms
 * against a window that had existed for one call.
 *
 * `key` is addressed by FOCUS identity: a combo carries no coordinate and no element handle, and the
 * key path never reads the element map — it hands the combo to the focused app. The guard's own
 * sentence is "the visible element map may no longer own those coordinates", and there are none.
 * Measured live on WhatsApp 2026-08-05: opening the app raised its own "New chat" popover, the
 * runtime's guidance said to dismiss it with escape, and escape was refused because of the app's own
 * AXFocusedUIElementChanged. The guard was contradicting the advice, and escape is exactly how a
 * caller answers a surface that just appeared.
 *
 * Same family as the semantic re-grounding below, which exists because opening Messages refused the
 * operation's own next step. Note what is NOT here: `type` and `paste` insert content and are aimed
 * by focus too, but a focus change is precisely what puts that content in the wrong field, so they
 * keep the guard and recover through re-grounding. */
const IDENTITY_SCOPED_FRAME_VERBS = new Set<DesktopAction>(['arrange', 'key']);

/** Content insertion aimed by keyboard focus rather than by a coordinate or an element handle.
 *
 * These cannot be exempted from the frame gate wholesale — the sentence above says why: a focus
 * change is what puts the content in the wrong field. But "an accessibility event happened" is not
 * the same fact as "focus moved", and using the first as a proxy for the second refuses the
 * operation's own side effects. */
const FOCUS_ADDRESSED_INSERT_VERBS = new Set<DesktopAction>(['type', 'paste']);

/**
 * The accessibility notifications that can actually move keyboard focus off the intended field.
 *
 * The watcher subscribes at two levels (`watch-events` in helper.source.ts). App-level events say
 * focus or window composition changed. The rest are registered on the CURRENTLY FOCUSED ELEMENT by
 * registerChangingElement — so AXValueChanged, AXSelectedChildrenChanged and AXSelectedTextChanged
 * are emitted BY the very field the text is going into. They mean "the thing you are typing into
 * changed", which is what typing does.
 *
 * Measured live 2026-08-06: `key cmd+shift+g` opened Finder's Go to Folder sheet, whose completion
 * list posted AXSelectedChildrenChanged, and the `type` that was the entire point of opening the
 * sheet was refused at epoch 7 — with the message "the visible element map may no longer own those
 * coordinates" for an action that carries no coordinates. Intermittent, because it is a race with
 * the app's own autocompletion.
 *
 * Focus itself is still verified at delivery, and more precisely than any event can: the type and
 * paste paths run keyboardAppPreflight, which reads who actually owns keyboard focus and refuses
 * when it is not the target. This set narrows a proxy; it does not remove the guarantee.
 */
const FOCUS_INVALIDATING_AX_NOTIFICATIONS = new Set([
  'AXFocusedUIElementChanged',
  'AXFocusedWindowChanged',
  'AXUIElementDestroyed',
]);

/** Operations that mutate the one active perception/target pipeline. Observe and screenshot do not
 * move input, but they replace the global frame, element map and PiP geometry; allowing one to finish
 * during an app switch is enough to pair Notes pixels with a WhatsApp input target. */
const PIPELINE_SERIALIZED_VERBS = new Set<DesktopAction>([
  ...ACTING_VERBS,
  'observe', 'screenshot',
]);

/** Invariant: every acting verb's result carries exactly one honest ActionResult. Results that
 * already computed one (post-action evidence, verified close/quit) pass through; anything else
 * gets the truthful default — delivered-but-unverified on success, failed on error. */
export function ensureActionResult(result: DesktopResult): DesktopResult {
  if (result.actionResult || !ACTING_VERBS.has(result.action)) return result;
  if (!result.ok) {
    return { ...result, actionResult: { delivered: false, observed: 'failed', confidence: 'unknown', failureReason: result.error || result.summary } };
  }
  return { ...result, actionResult: { delivered: true, observed: 'unverified', confidence: 'unknown' } };
}

/** Committing verbs whose summary must carry the evidence verdict inline. The structured
 * actionResult already states it, but models act on the summary SENTENCE: in a live WhatsApp run,
 * the model clicked to open a chat and reported "Sent the message. Done." with nothing typed or
 * sent. Put the verdict where it cannot be skipped so a non-committing action cannot read as done. */
const VERDICT_VERBS = new Set<DesktopAction>(['click', 'type', 'key', 'set_value', 'drag', 'scroll']);

export function stampSummaryVerdict(result: DesktopResult): DesktopResult {
  const outcome = result.actionResult;
  if (!result.ok || !outcome || !result.summary || !VERDICT_VERBS.has(result.action)) return result;
  if (outcome.confidence === 'proven') return result;
  const clause = outcome.observed === 'no-change'
    ? ' — screen did NOT change: the input landed but nothing visibly happened; re-observe and adjust rather than assuming it worked'
    : outcome.observed === 'expectation-missed'
      ? ' — EXPECTED RESULT NOT FOUND in the fresh frame; recover or choose a different action instead of claiming completion'
    : outcome.observed === 'expectation-indeterminate'
      ? ' — your expect described a state instead of naming on-screen text, so it proves NOTHING either way: this is not a failure and not a success. Judge the effect from this frame; do not repeat a delivered action on the strength of it'
    : outcome.observed === 'rejected'
      ? ` — APPLICATION REJECTED THE OPERATION${outcome.failureReason ? `: ${outcome.failureReason.replace(/^application visibly rejected the operation:\s*/i, '')}` : ''}; do not claim success or repeat the same approach`
    : outcome.observed === 'unverified'
      ? ' — UNVERIFIED: no fresh evidence proves any effect; re-observe before relying on it'
      : outcome.observed === 'changed'
        ? ' — screen changed; confirm the intended result is actually visible in this frame before calling the task done'
        : '';
  return clause ? { ...result, summary: `${result.summary}${clause}` } : result;
}

/** The Bimax-branded label for the pinned sidecar, kept in ONE place so the version bump in
 * scripts/stage-computer-use-driver.sh has a single companion edit here instead of four. */
export const BIMAX_DRIVER_LABEL = 'bimax-computer-use 0.12.3';

/** App names vary slightly between APIs ("Calculator" vs "Calculator.app"). macOS also wraps
 * localized names in invisible bidi format marks — System Events on macOS 26 reports "‎WhatsApp"
 * — which `trim()` does NOT remove. Comparing without stripping them made a frontmost app look
 * not-frontmost, failing every keyboard action with "could not focus X; frontmost app is X". */
export function appNamesMatch(actual: string, expected: string): boolean {
  return !!appKey(actual) && appKey(actual) === appKey(expected);
}

/**
 * Does this string look like a bundle identifier rather than an app a human would name?
 *
 * Reverse-DNS with no whitespace. Deliberately shape-based and not a list: the point is to notice
 * that the caller addressed the OS in the wrong field, which is app-agnostic. "Adobe Photoshop 2024"
 * has spaces, "Messages" has no dot — neither is mistaken for an identifier.
 */
export function looksLikeBundleId(value: string): boolean {
  const candidate = stripInvisibleMarks(String(value || '')).trim();
  return /^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9][A-Za-z0-9-]*){2,}$/.test(candidate);
}

/** The canonical form of an app name — the same normalization appNamesMatch compares on. Use it as a
 * map/set key so per-app state cannot be split across "WhatsApp", "WhatsApp.app" and the bidi-marked
 * name the driver reports. */
export function appKey(name: string): string {
  return stripInvisibleMarks(String(name || '')).toLowerCase().replace(/\.app$/, '');
}

/** A marked name is poison beyond comparison: driver >=0.12 reports names WITH the marks (0.8
 * reported them clean), and once one enters target state, `open -a` cannot find the app — focus
 * and every keyboard action after it die on a name that renders identically to the working one.
 * Strip marks wherever a driver-reported name ENTERS Bimax state, not only where names compare. */
export function stripInvisibleMarks(name: string): string {
  return name.replace(/[\u200B-\u200F\u2060-\u2069\u061C\uFEFF]/g, '').trim();
}

export class DesktopRuntime implements DesktopRuntimePort {
  public constructor(private readonly beforeMutation: () => Promise<void> = async () => {}) {}

  private helperPath: string | null | undefined; // undefined = not resolved yet, null = unavailable
  private lastStatus: { accessibility: boolean | null; screenRecording: boolean | null } = { accessibility: null, screenRecording: null };
  private displaysCache: DesktopDisplay[] | null = null;

  // ---- driver resolution ----------------------------------------------------------------------

  /**
   * Resolve the build-time helper. Phase 9 forbids runtime Swift compilation on user machines, so
   * this only ever LOCATES an already-built binary — it never builds one.
   *
   * Discovery, not just the environment override. The Electron app and the Go TUI each locate this
   * binary themselves and inject `BIMAX_DESKTOP_HELPER` when they spawn the engine, so every path
   * that does NOT go through those hosts — `bimax mcp-computer`, a headless engine, a smoke script —
   * resolved to null and silently lost every capability built on the helper: the AX hit test that
   * proves which app will receive a click, the AXManualAccessibility/AXEnhancedUserInterface opt-in
   * that makes Electron and AppKit apps publish a real tree, and the modal-frame probe. Those did
   * not fail loudly; they degraded, and the click preflight in particular then reported "not
   * probed" as "verified". The engine must be able to find its own helper.
   */
  private resolveHelper(): string | null {
    if (this.helperPath !== undefined) return this.helperPath;
    this.helperPath = null;
    if (process.platform !== 'darwin') return null;
    const override = process.env.BIMAX_DESKTOP_HELPER?.trim();
    if (override) {
      this.helperPath = fs.existsSync(override) ? override : null;
      return this.helperPath;
    }
    // `__dirname` is <repo>/src/computer under tsx and <repo>/dist/computer once built; both are two
    // levels below the repo root, which is where the hosts stage the binary.
    const root = path.resolve(__dirname, '..', '..');
    const candidates = [
      path.join(root, 'app', 'native-service', 'bimax-desktop-helper'),
      path.join(root, 'tui', 'embed', 'bimax-desktop-helper'),
      path.join(os.homedir(), '.bimax', 'native', 'bimax-desktop-helper'),
    ];
    this.helperPath = candidates.find(candidate => fs.existsSync(candidate)) ?? null;
    return this.helperPath;
  }

  private driverName(): string {
    if (process.platform === 'darwin') {
      if (this.resolveHelper()) return 'native-helper';
      if (binExists('cliclick')) return 'cliclick';
      return 'applescript';
    }
    if (process.platform === 'linux') return binExists('xdotool') ? 'xdotool' : 'unavailable';
    return 'unavailable';
  }

  public quickStatus() {
    // Never compiles: report the tier we WOULD use, plus permissions from the last real probe.
    let driver: string;
    if (process.platform === 'darwin') {
      if (this.helperPath) driver = 'native-helper';
      else if (this.helperPath === null && binExists('cliclick')) driver = 'cliclick';
      else if (this.helperPath === null) driver = 'applescript';
      else driver = binExists('cliclick') ? 'cliclick' : 'applescript';
    } else {
      driver = this.driverName();
    }
    return { driver, ready: driver !== 'unavailable', ...this.lastStatus };
  }

  // NOTE: the Grok-ported circuit breaker that wrapped this helper was removed. It only guarded
  // the FALLBACK driver (never the real sidecar path), so the same action was governed by two
  // conflicting failure policies depending on which driver happened to be active — a misleading
  // half-protection. The runtime's own recovery controller + per-action errors are the one policy.
  private async helper(args: string[], signal?: AbortSignal, timeoutMs = 15_000): Promise<any> {
    const bin = this.resolveHelper();
    if (!bin) throw new Error('native helper unavailable');
    const { stdout } = await exec(bin, args, timeoutMs, signal);
    return JSON.parse(stdout.trim());
  }

  public watchAccessibility(pid: number, onEvent: (event: AccessibilityEvent) => void): () => void {
    const bin = this.resolveHelper();
    if (!bin || process.platform !== 'darwin' || !Number.isInteger(pid) || pid <= 0) return () => {};
    const child = spawn(bin, ['watch-events', String(pid)], {
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: false,
    });
    let pending = '';
    let stopped = false;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const raw = JSON.parse(line);
          const event: AccessibilityEvent = {
            pid: Number(raw.pid || pid),
            notification: String(raw.notification || 'unknown'),
            timestampMs: Number(raw.timestamp_ms || Date.now()),
            ...(raw.element && typeof raw.element === 'object' ? { element: raw.element } : {}),
          };
          if (event.pid === pid) onEvent(event);
        } catch { /* a partial/malformed diagnostic line cannot invalidate the control loop */ }
      }
    });
    child.on('error', () => { /* optional observer tier; frame/hash gates remain active */ });
    return () => {
      if (stopped) return;
      stopped = true;
      if (!child.killed) child.kill('SIGTERM');
    };
  }

  public async frontmostApp(): Promise<string> {
    try {
      if (process.platform === 'darwin') {
        if (this.resolveHelper()) return stripInvisibleMarks(String((await this.helper(['frontmost'])).app || ''));
        const { stdout } = await exec('osascript', ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true']);
        return stripInvisibleMarks(stdout);
      }
      if (process.platform === 'linux' && binExists('xdotool')) {
        const { stdout } = await exec('xdotool', ['getactivewindow', 'getwindowname']);
        return stdout.trim();
      }
    } catch { /* observation is best-effort */ }
    return '';
  }

  private async waitForApp(app: string, shouldMatch: boolean, signal?: AbortSignal): Promise<string> {
    let actual = '';
    for (let i = 0; i < 20; i++) {
      if (signal?.aborted) throw new Error('desktop action aborted');
      actual = await this.frontmostApp();
      if (appNamesMatch(actual, app) === shouldMatch) return actual;
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error(shouldMatch
      ? `could not focus ${app}; frontmost app is ${actual || '(unknown)'}`
      : `${app} did not close; it is still frontmost`);
  }

  private async activateApp(app: string, signal?: AbortSignal): Promise<string> {
    if (!app.trim()) throw new Error('keyboard action needs an intended app; open the app first or pass app');
    if (process.platform === 'darwin') {
      await exec('open', ['-a', app.trim()], 20_000, signal);
      return this.waitForApp(app, true, signal);
    }
    if (process.platform === 'linux' && binExists('xdotool')) {
      const { stdout } = await exec('xdotool', ['search', '--name', app.trim()], 15_000, signal);
      const id = stdout.trim().split(/\s+/)[0];
      if (!id) throw new Error(`could not find a window for ${app}`);
      await exec('xdotool', ['windowactivate', '--sync', id], 15_000, signal);
      return this.frontmostApp();
    }
    throw new Error(`app activation is not supported on ${process.platform}`);
  }

  // ---- geometry -------------------------------------------------------------------------------

  private async displays(signal?: AbortSignal): Promise<DesktopDisplay[]> {
    if (this.displaysCache) return this.displaysCache;
    if (process.platform === 'darwin') {
      if (this.resolveHelper()) {
        const st = await this.helper(['status'], signal);
        this.lastStatus = { accessibility: !!st.accessibility, screenRecording: !!st.screenRecording };
        this.displaysCache = st.displays as DesktopDisplay[];
        return this.displaysCache!;
      }
      // Finder bounds used to trigger an unrelated Apple Events permission dialog that could cover
      // the very app being controlled. Probe a disposable OS screenshot instead. macOS captures
      // Retina displays at 2x; infer that common scale conservatively so screenshot pixels remain
      // aligned with global screen points even when the compiled helper is unavailable.
      const probe = path.join(os.tmpdir(), `bimax-display-${process.pid}-${Date.now()}.png`);
      try {
        await exec('/usr/sbin/screencapture', ['-x', '-D', '1', '-t', 'png', probe], 20_000, signal);
        const { stdout } = await exec('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', probe], 15_000, signal);
        const pixelW = parseInt((stdout.match(/pixelWidth:\s*(\d+)/) || [])[1] || '0', 10);
        const pixelH = parseInt((stdout.match(/pixelHeight:\s*(\d+)/) || [])[1] || '0', 10);
        if (!pixelW || !pixelH) throw new Error('could not read fallback display dimensions');
        const scale = pixelW >= 2500 && pixelH >= 1400 ? 2 : 1;
        this.displaysCache = [{ index: 1, width: Math.round(pixelW / scale), height: Math.round(pixelH / scale), scale, main: true }];
      } finally {
        try { fs.rmSync(probe, { force: true }); } catch { /* disposable probe */ }
      }
      return this.displaysCache;
    }
    if (process.platform === 'linux' && binExists('xdotool')) {
      const { stdout } = await exec('xdotool', ['getdisplaygeometry'], 15_000, signal);
      const [w, h] = stdout.trim().split(/\s+/).map(n => parseInt(n, 10));
      this.displaysCache = [{ index: 1, width: w || 0, height: h || 0, scale: 1, main: true }];
      return this.displaysCache;
    }
    throw new Error('cannot determine display geometry on this platform');
  }

  private async denormalize(cmd: DesktopCommand, signal?: AbortSignal): Promise<DesktopCommand> {
    if (!cmd.normalized) return cmd;
    const main = (await this.displays(signal)).find(d => d.main) || (await this.displays(signal))[0];
    if (!main || !main.width || !main.height) throw new Error('normalized coordinates need a known main display');
    const out = { ...cmd };
    if (out.x != null) out.x = scaleNormalizedPoint(out.x, main.width);
    if (out.y != null) out.y = scaleNormalizedPoint(out.y, main.height);
    if (out.toX != null) out.toX = scaleNormalizedPoint(out.toX, main.width);
    if (out.toY != null) out.toY = scaleNormalizedPoint(out.toY, main.height);
    return out;
  }

  // ---- screenshot -----------------------------------------------------------------------------

  private async screenshot(cmd: DesktopCommand, cwd: string, signal?: AbortSignal): Promise<DesktopResult> {
    const dir = path.join(cwd, '.bimax', 'computer');
    fs.mkdirSync(dir, { recursive: true });
    sweepShots(dir);
    const file = path.join(dir, `shot-${Date.now()}.png`);
    const displayIndex = Math.max(1, Math.floor(cmd.display || 1));

    if (process.platform === 'darwin') {
      try {
        await exec('/usr/sbin/screencapture', ['-x', '-D', String(displayIndex), '-t', 'png', file], 20_000, signal);
      } catch (err: any) {
        // Without Screen Recording permission newer macOS refuses the capture outright.
        if (/could not create image/i.test(String(err?.message))) {
          throw new Error('screen capture refused — Screen Recording permission is missing. Run action=request_access, approve the terminal running BiMax in System Settings → Privacy & Security → Screen Recording, then retry.', { cause: err });
        }
        throw err;
      }
      let screenW = 0, screenH = 0;
      try {
        const all = await this.displays(signal);
        const d = all[displayIndex - 1] || all.find(x => x.main) || all[0];
        if (d) { screenW = d.width; screenH = d.height; }
      } catch { /* dims stay unknown; image ships at capture size */ }
      // Retina captures are 2x pixel size — downscale to POINT size so image coords == click coords.
      if (screenW > 0 && screenH > 0) {
        try {
          const { stdout } = await exec('sips', ['-g', 'pixelWidth', file], 15_000, signal);
          const pixelW = parseInt((stdout.match(/pixelWidth:\s*(\d+)/) || [])[1] || '0', 10);
          if (pixelW > screenW) await exec('sips', ['-z', String(screenH), String(screenW), file], 20_000, signal);
        } catch { /* un-scaled screenshot is still usable */ }
      }
      const st = this.lastStatus;
      if (st.screenRecording === false) {
        return {
          ok: false, action: 'screenshot', driver: this.driverName(), screenshot: file,
          error: 'Screen Recording permission is not granted — the capture shows the wallpaper only. Run action=request_access, approve BiMax\'s terminal in System Settings → Privacy & Security → Screen Recording, then retry.',
          summary: 'screenshot blocked by missing Screen Recording permission',
        };
      }
      const app = await this.frontmostApp();
      return {
        ok: true, action: 'screenshot', driver: this.driverName(), screenshot: file,
        app: app || undefined,
        width: screenW || undefined, height: screenH || undefined,
        screenWidth: screenW || undefined, screenHeight: screenH || undefined,
        summary: `screenshot of display ${displayIndex}${app ? ` with ${app} frontmost` : ''} → ${path.relative(cwd, file)} (screen points${screenW ? ` ${screenW}×${screenH}` : ''})`,
      };
    }

    if (process.platform === 'linux') {
      const chain: Array<[string, string[]]> = [
        ['grim', [file]],
        ['gnome-screenshot', ['-f', file]],
        ['import', ['-window', 'root', file]],
        ['scrot', [file]],
      ];
      for (const [bin, args] of chain) {
        if (!binExists(bin)) continue;
        await exec(bin, args, 20_000, signal);
        return { ok: true, action: 'screenshot', driver: bin, screenshot: file, summary: `screenshot → ${path.relative(cwd, file)}` };
      }
      throw new Error('no screenshot tool found — install one of: grim, gnome-screenshot, imagemagick (import), scrot');
    }
    throw new Error(`screenshots are not supported on ${process.platform}`);
  }

  // ---- input drivers --------------------------------------------------------------------------

  private async runDarwin(cmd: DesktopCommand, signal?: AbortSignal): Promise<Partial<DesktopResult>> {
    // Launch Services lookups, answered by osascript so they work at EVERY driver tier (osascript
    // ships with macOS; the Swift helper needs Xcode CLT). Asking the OS about an app beats keeping
    // a hand-written table of well-known bundle ids that only ever covers the apps someone thought
    // of. Both are best-effort: an unresolvable name simply falls back to launching by name.
    if (cmd.action === 'bundle_id') {
      const name = (cmd.app || '').trim();
      if (!name) return { summary: 'no app name to resolve' };
      try {
        const { stdout } = await exec('osascript', ['-e', `id of application ${JSON.stringify(name)}`], 10_000, signal);
        const id = stdout.trim();
        return { bundleId: /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/.test(id) ? id : undefined, summary: `bundle id for ${name}` };
      } catch { return { summary: `no bundle id for ${name}` }; }
    }
    if (cmd.action === 'app_running') {
      const name = (cmd.app || '').trim();
      if (!name) return { running: false, summary: 'no app name to check' };
      try {
        const { stdout } = await exec('osascript', ['-e', `application ${JSON.stringify(name)} is running`], 10_000, signal);
        return { running: stdout.trim() === 'true', summary: `${name} running check` };
      } catch { return { running: false, summary: `could not check whether ${name} is running` }; }
    }
    const helper = this.resolveHelper();
    if (helper) {
      switch (cmd.action) {
        case 'status': {
          const st = await this.helper(['status'], signal);
          this.lastStatus = { accessibility: !!st.accessibility, screenRecording: !!st.screenRecording };
          this.displaysCache = st.displays;
          return { accessibility: st.accessibility, screenRecording: st.screenRecording, displays: st.displays, app: st.frontmost, summary: `driver native-helper · accessibility ${st.accessibility ? 'granted' : 'NOT granted'} · screen recording ${st.screenRecording ? 'granted' : 'NOT granted'}` };
        }
        case 'request_access': {
          const st = await this.helper(['request-access'], signal, 60_000);
          this.lastStatus = { accessibility: !!st.accessibility, screenRecording: !!st.screenRecording };
          return { accessibility: st.accessibility, screenRecording: st.screenRecording, summary: 'permission prompts triggered — approve in System Settings, then action=status to confirm' };
        }
        case 'visual_signatures': {
          if (!cmd.imagePath || !Array.isArray(cmd.regions)) {
            throw new Error('visual_signatures needs an imagePath and screenshot-pixel regions');
          }
          const payload = Buffer.from(JSON.stringify({ imagePath: cmd.imagePath, regions: cmd.regions }), 'utf8').toString('base64');
          const sampled = await this.helper(['visual-signatures', payload], signal, 30_000);
          return {
            visualSignatures: Array.isArray(sampled?.signatures) ? sampled.signatures : [],
            details: { colorSpace: sampled?.color_space || 'sRGB', width: sampled?.width, height: sampled?.height },
            summary: `sampled ${Array.isArray(sampled?.signatures) ? sampled.signatures.length : 0} sRGB element fingerprints`,
          };
        }
        case 'visual_analysis': {
          if (!cmd.imagePath || !Array.isArray(cmd.regions)) {
            throw new Error('visual_analysis needs an imagePath and screenshot-pixel regions');
          }
          const payload = Buffer.from(JSON.stringify({
            imagePath: cmd.imagePath,
            regions: cmd.regions,
            query: cmd.query || '',
          }), 'utf8').toString('base64');
          const started = Date.now();
          const analysed = await this.helper(['visual-analysis', payload], signal, 30_000);
          const texts = Array.isArray(analysed?.texts) ? analysed.texts : [];
          const shapes = Array.isArray(analysed?.shapes) ? analysed.shapes : [];
          return {
            visualAnalysis: {
              texts, shapes, latencyMs: Date.now() - started,
              ...(Array.isArray(analysed?.errors) && analysed.errors.length ? { errors: analysed.errors.map(String) } : {}),
            },
            summary: `on-device vision found ${texts.length} text region(s) and analysed ${shapes.length} shape region(s)`,
          };
        }
        case 'cursor': { const r = await this.helper(['cursor'], signal); return { x: r.x, y: r.y, summary: `cursor at ${r.x},${r.y}` }; }
        case 'frontmost': { const r = await this.helper(['frontmost'], signal); const app = stripInvisibleMarks(String(r.app || '')); return { app, summary: `frontmost app: ${app || '(unknown)'}` }; }
        case 'focused_element': {
          const r = await this.helper(['focused-element'], signal, 5_000);
          return {
            app: stripInvisibleMarks(String(r.app || '')),
            pid: Number(r.pid || r.focused?.pid || 0) || undefined,
            focusedElement: r.focused && typeof r.focused === 'object' ? r.focused : undefined,
            focusChain: Array.isArray(r.chain) ? r.chain : [],
            summary: r.focused
              ? `keyboard focus is on ${r.focused.role || 'an element'}${r.focused.title ? ` "${r.focused.title}"` : ''}`
              : 'the frontmost app exposes no focused accessibility element',
          };
        }
        case 'move': {
          const r = await this.helper(['move', String(cmd.x), String(cmd.y)], signal);
          // The helper waits for the cursor to be observably at the point and reports where it
          // actually is; a miss is surfaced rather than smoothed over.
          const exact = r.exact !== false;
          return {
            x: r.x, y: r.y,
            summary: exact
              ? `moved to ${cmd.x},${cmd.y}`
              : `move to ${cmd.x},${cmd.y} ended at ${r.x},${r.y} — the cursor did not reach the point (is the mouse being held?)`,
          };
        }
        case 'click': {
          const r = await this.helper(['click', String(cmd.x), String(cmd.y), cmd.button || 'left', String(cmd.count || 1), (cmd.modifier || []).join(',')], signal);
          return { app: r.app, x: r.x, y: r.y, summary: `${cmd.count === 2 ? 'double-' : cmd.count === 3 ? 'triple-' : ''}${cmd.button || 'left'} click at ${cmd.x},${cmd.y}${r.app ? ` in ${r.app}` : ''}` };
        }
        case 'drag': {
          // dwellMs turns the fast intra-window path into the slower paced one a cross-application
          // drop requires; omitted, the helper keeps its original timing exactly.
          const dwell = Number(cmd.ms || 0) > 0 ? [String(Math.round(cmd.ms!)), '16'] : [];
          await this.helper(['drag', String(cmd.x), String(cmd.y), String(cmd.toX), String(cmd.toY), ...dwell], signal, 60_000);
          return { summary: `dragged ${cmd.x},${cmd.y} → ${cmd.toX},${cmd.toY}` };
        }
        case 'hover': { const r = await this.helper(['hover', String(cmd.x), String(cmd.y), String(cmd.ms ?? 400)], signal); return { app: r.app, summary: `hovered at ${cmd.x},${cmd.y}${r.app ? ` in ${r.app}` : ''}` }; }
        case 'hold': { const r = await this.helper(['hold', String(cmd.x), String(cmd.y), String(cmd.ms ?? 800), cmd.button || 'left'], signal); return { app: r.app, summary: `${cmd.button || 'left'} click-and-hold ${cmd.ms ?? 800}ms at ${cmd.x},${cmd.y}` }; }
        case 'mouse_down': await this.helper(['mousedown', String(cmd.x), String(cmd.y), cmd.button || 'left'], signal); return { summary: `${cmd.button || 'left'} button down at ${cmd.x},${cmd.y}` };
        case 'mouse_up': await this.helper(['mouseup', String(cmd.x), String(cmd.y), cmd.button || 'left'], signal); return { summary: `${cmd.button || 'left'} button up at ${cmd.x},${cmd.y}` };
        case 'scroll': await this.helper(['scroll', String(cmd.x), String(cmd.y), String(cmd.dx || 0), String(cmd.dy || 0)], signal); return { summary: `scrolled (${cmd.dx || 0},${cmd.dy || 0}) at ${cmd.x},${cmd.y}` };
        case 'key': { const r = await this.helper(['key', cmd.combo || ''], signal); return { app: r.app, summary: `pressed ${cmd.combo}${r.app ? ` in ${r.app}` : ''}` }; }
        case 'type': {
          const r = await this.helper(['type', Buffer.from(cmd.text || '', 'utf8').toString('base64')], signal, 60_000);
          return { app: r.app, summary: `typed ${(cmd.text || '').length} chars${r.app ? ` into ${r.app}` : ''}` };
        }
        case 'desktop_icons': {
          const r = await this.helper(['desktop-icons'], signal);
          return { icons: Array.isArray(r.icons) ? r.icons : [], summary: `found ${r.count || 0} desktop item(s)` };
        }
        case 'screens': {
          const r = await this.helper(['screens'], signal);
          return { screens: Array.isArray(r.screens) ? r.screens : [], summary: `found ${r.screens?.length || 0} screen(s)` };
        }
        case 'window_frame': {
          const r = await this.helper(['window-frame', String(cmd.pid)], signal);
          return { windowFrame: r.frame, fullscreen: !!r.fullscreen, summary: 'read the window frame' };
        }
        case 'window_at': {
          const r = await this.helper(['window-at', String(cmd.x), String(cmd.y)], signal, 5_000);
          return { windowAt: r.window || undefined, summary: r.window ? `${r.window.owner_name} window ${r.window.window_id}` : 'no window at that point' };
        }
        case 'window_raise': {
          const f = cmd.bounds!;
          const r = await this.helper(['window-raise', String(cmd.pid), String(f.x), String(f.y), String(f.w), String(f.h)], signal, 10_000);
          return { raised: !!r.raised, summary: r.raised ? 'raised the window' : 'the window could not be raised' };
        }
        case 'ax_enable': {
          const r = await this.helper(['ax-enable', String(cmd.pid)], signal, 5_000);
          const accepted = [r.manual ? 'manual' : '', r.enhanced ? 'enhanced' : ''].filter(Boolean).join('+');
          return {
            applied: !!r.applied,
            summary: r.applied ? `requested the full accessibility tree (${accepted})` : 'app declined the accessibility opt-in',
          };
        }
        case 'modal_frame': {
          const r = await this.helper(['modal-frame', String(cmd.pid)], signal, 5_000);
          return { modalFrame: r.modal || undefined, summary: r.modal ? 'a modal sheet or dialog is open' : 'no modal blocker' };
        }
        case 'window_set_frame': {
          const f = cmd.bounds!;
          const r = await this.helper(['window-set-frame', String(cmd.pid), String(f.x), String(f.y), String(f.w), String(f.h)], signal, 30_000);
          return { windowFrame: r.frame, requestedFrame: r.requested, summary: 'set the window frame' };
        }
        case 'window_fullscreen': {
          // The transition is animated and the helper polls until it settles, so allow well past
          // the ~1s animation before calling it a driver timeout.
          const r = await this.helper(['window-fullscreen', String(cmd.pid), cmd.value === 'true' ? 'true' : 'false'], signal, 30_000);
          return { fullscreen: !!r.fullscreen, fullscreenSupported: !!r.supported, fullscreenMatched: !!r.matched, summary: `fullscreen ${r.fullscreen ? 'on' : 'off'}` };
        }
        case 'clipboard_read': {
          const r = await this.helper(['clipboard-read'], signal);
          return {
            clipboard: {
              text: Buffer.from(String(r.textBase64 || ''), 'base64').toString('utf8'),
              files: Array.isArray(r.files) ? r.files.map(String) : [],
              types: Array.isArray(r.types) ? r.types.map(String) : [],
              changeCount: Number(r.changeCount ?? -1),
            },
            summary: 'read the clipboard',
          };
        }
        case 'clipboard_write': {
          const r = await this.helper(['clipboard-write', Buffer.from(cmd.text || '', 'utf8').toString('base64')], signal);
          return { clipboard: { text: cmd.text || '', files: [], types: [], changeCount: Number(r.changeCount ?? -1) }, summary: `wrote ${(cmd.text || '').length} chars to the clipboard` };
        }
        case 'clipboard_write_files': {
          const paths = (cmd.paths || []).filter(Boolean);
          if (!paths.length) throw new Error('clipboard file write needs at least one path');
          const r = await this.helper(['clipboard-write-files', ...paths], signal);
          return { clipboard: { text: '', files: paths, types: ['public.file-url'], changeCount: Number(r.changeCount ?? -1) }, summary: `put ${paths.length} file(s) on the clipboard` };
        }
      }
    }
    return this.runDarwinFallback(cmd, signal);
  }

  /** Degraded macOS path (no Xcode CLT): cliclick when present, else AppleScript System Events. */
  private async runDarwinFallback(cmd: DesktopCommand, signal?: AbortSignal): Promise<Partial<DesktopResult>> {
    const cli = binExists('cliclick');
    const osa = (script: string) => exec('osascript', ['-e', script], 30_000, signal);
    switch (cmd.action) {
      case 'status': {
        let displays: DesktopDisplay[] = [];
        try { displays = await this.displays(signal); } catch { /* status must still identify the usable fallback */ }
        return { accessibility: null, screenRecording: null, displays, summary: `driver ${cli ? 'cliclick' : 'applescript'} (degraded — native helper unavailable) · permissions verified by the first action` };
      }
      case 'request_access':
        // No CGRequest APIs without the helper: the first real action triggers the OS prompt.
        return { accessibility: null, screenRecording: null, summary: 'no native helper — macOS will prompt on the first real action instead' };
      case 'visual_signatures':
        // Colour evidence is an optional perception tier. A machine without Xcode CLT keeps all AX
        // targeting and screenshots; it simply does not claim RGB evidence it could not sample.
        return { visualSignatures: [], summary: 'sRGB element sampling unavailable without the native helper' };
      case 'visual_analysis':
        return { visualAnalysis: { texts: [], shapes: [] }, summary: 'on-device Vision analysis unavailable without the native helper' };
      case 'cursor': {
        if (cli) { const { stdout } = await exec('cliclick', ['p'], 15_000, signal); const m = stdout.match(/(\d+),(\d+)/); return { x: +(m?.[1] || 0), y: +(m?.[2] || 0), summary: `cursor at ${stdout.trim()}` }; }
        throw new Error('cursor position needs the native helper or cliclick');
      }
      case 'frontmost': { const app = await this.frontmostApp(); return { app, summary: `frontmost app: ${app || '(unknown)'}` }; }
      case 'focused_element':
        return { app: await this.frontmostApp(), summary: 'focused-element metadata unavailable without the native helper' };
      case 'move':
        if (cli) { await exec('cliclick', [`m:${cmd.x},${cmd.y}`], 15_000, signal); return { summary: `moved to ${cmd.x},${cmd.y}` }; }
        throw new Error('move needs the native helper or cliclick');
      case 'click': {
        if (cli) {
          const op = cmd.button === 'right' ? 'rc' : cmd.count === 3 ? 'tc' : cmd.count === 2 ? 'dc' : 'c';
          if (cmd.button === 'middle') throw new Error('middle click needs the native helper');
          await exec('cliclick', [`${op}:${cmd.x},${cmd.y}`], 15_000, signal);
        } else {
          if (cmd.button && cmd.button !== 'left') throw new Error(`${cmd.button} click needs the native helper or cliclick`);
          for (let i = 0; i < (cmd.count || 1); i++) await osa(`tell application "System Events" to click at {${cmd.x}, ${cmd.y}}`);
        }
        const app = await this.frontmostApp();
        return { app, summary: `${cmd.button || 'left'} click at ${cmd.x},${cmd.y}${app ? ` in ${app}` : ''}` };
      }
      case 'drag':
        if (cli) { await exec('cliclick', [`dd:${cmd.x},${cmd.y}`, 'w:120', `du:${cmd.toX},${cmd.toY}`], 20_000, signal); return { summary: `dragged ${cmd.x},${cmd.y} → ${cmd.toX},${cmd.toY}` }; }
        throw new Error('drag needs the native helper or cliclick');
      case 'hover':
        if (cli) { await exec('cliclick', [`m:${cmd.x},${cmd.y}`], 15_000, signal); return { summary: `hovered at ${cmd.x},${cmd.y}` }; }
        throw new Error('hover needs the native helper or cliclick');
      case 'hold':
        if (cli) { await exec('cliclick', [`dd:${cmd.x},${cmd.y}`, `w:${Math.max(50, Math.min(5000, cmd.ms ?? 800))}`, `du:${cmd.x},${cmd.y}`], 20_000, signal); return { summary: `click-and-hold at ${cmd.x},${cmd.y}` }; }
        throw new Error('hold needs the native helper or cliclick');
      case 'mouse_down':
        if (cli) { await exec('cliclick', [`dd:${cmd.x},${cmd.y}`], 15_000, signal); return { summary: `button down at ${cmd.x},${cmd.y}` }; }
        throw new Error('mouse_down needs the native helper or cliclick');
      case 'mouse_up':
        if (cli) { await exec('cliclick', [`du:${cmd.x},${cmd.y}`], 15_000, signal); return { summary: `button up at ${cmd.x},${cmd.y}` }; }
        throw new Error('mouse_up needs the native helper or cliclick');
      case 'scroll':
        throw new Error('scroll needs the native helper (install Xcode Command Line Tools: xcode-select --install)');
      case 'key': {
        const combo = (cmd.combo || '').toLowerCase();
        const mods = combo.split('+').slice(0, -1).map(m => ({ cmd: 'command', command: 'command', meta: 'command', shift: 'shift', alt: 'option', option: 'option', opt: 'option', ctrl: 'control', control: 'control' } as any)[m]).filter(Boolean);
        const keyName = combo.split('+').pop() || '';
        const codes: Record<string, number> = { return: 36, enter: 36, tab: 48, space: 49, delete: 51, backspace: 51, escape: 53, esc: 53, left: 123, right: 124, down: 125, up: 126, home: 115, end: 119, pageup: 116, pagedown: 121 };
        const using = mods.length ? ` using {${mods.map(m => `${m} down`).join(', ')}}` : '';
        if (codes[keyName] != null) await osa(`tell application "System Events" to key code ${codes[keyName]}${using}`);
        else if (keyName.length === 1) await osa(`tell application "System Events" to keystroke "${keyName.replace(/(["\\])/g, '\\$1')}"${using}`);
        else throw new Error(`key "${keyName}" needs the native helper`);
        return { app: await this.frontmostApp(), summary: `pressed ${cmd.combo}` };
      }
      case 'type':
        await osa(`tell application "System Events" to keystroke "${(cmd.text || '').replace(/([\\"])/g, '\\$1')}"`);
        return { app: await this.frontmostApp(), summary: `typed ${(cmd.text || '').length} chars` };
      // pbcopy/pbpaste ship with macOS, so the clipboard bridge keeps working without Xcode CLT.
      // The one thing this path CANNOT provide is NSPasteboard.changeCount, so it reports -1 and the
      // runtime falls back to comparing content across the copy instead of trusting a counter.
      case 'clipboard_read': {
        const { stdout } = await exec('pbpaste', [], 15_000, signal);
        return { clipboard: { text: stdout, files: [], types: [], changeCount: -1 }, summary: 'read the clipboard' };
      }
      case 'clipboard_write': {
        await execWithInput('pbcopy', [], cmd.text || '', 15_000, signal);
        return { clipboard: { text: cmd.text || '', files: [], types: [], changeCount: -1 }, summary: `wrote ${(cmd.text || '').length} chars to the clipboard` };
      }
      case 'clipboard_write_files':
        // Putting FILE REFERENCES on the pasteboard is an NSPasteboard operation; pbcopy only moves
        // text. Say so plainly rather than silently copying the paths as a string, which would paste
        // the literal text "/Users/…/photo.jpg" into the app instead of attaching the photo.
        throw new Error('putting files on the clipboard needs the native helper — install Xcode Command Line Tools (xcode-select --install), or attach the file through the app\'s own file picker instead');
    }
    throw new Error(`unsupported action: ${cmd.action}`);
  }

  private async runLinux(cmd: DesktopCommand, signal?: AbortSignal): Promise<Partial<DesktopResult>> {
    if (!binExists('xdotool')) throw new Error('desktop control on Linux needs xdotool (and X11/XWayland)');
    const xdo = (args: string[]) => exec('xdotool', args, 20_000, signal);
    switch (cmd.action) {
      case 'status': { const displays = await this.displays(signal); return { accessibility: null, screenRecording: null, displays, summary: 'driver xdotool' }; }
      case 'request_access': return { summary: 'no permission model on X11 — actions work directly' };
      case 'cursor': { const { stdout } = await xdo(['getmouselocation']); const m = stdout.match(/x:(\d+)\s+y:(\d+)/); return { x: +(m?.[1] || 0), y: +(m?.[2] || 0), summary: `cursor at ${m?.[1]},${m?.[2]}` }; }
      case 'frontmost': { const app = await this.frontmostApp(); return { app, summary: `active window: ${app || '(unknown)'}` }; }
      case 'move': await xdo(['mousemove', String(cmd.x), String(cmd.y)]); return { summary: `moved to ${cmd.x},${cmd.y}` };
      case 'click': {
        const btn = cmd.button === 'right' ? '3' : cmd.button === 'middle' ? '2' : '1';
        await xdo(['mousemove', String(cmd.x), String(cmd.y), 'click', '--repeat', String(cmd.count || 1), btn]);
        const app = await this.frontmostApp();
        return { app, summary: `${cmd.button || 'left'} click at ${cmd.x},${cmd.y}${app ? ` in ${app}` : ''}` };
      }
      case 'drag':
        await xdo(['mousemove', String(cmd.x), String(cmd.y), 'mousedown', '1', 'mousemove', String(cmd.toX), String(cmd.toY), 'mouseup', '1']);
        return { summary: `dragged ${cmd.x},${cmd.y} → ${cmd.toX},${cmd.toY}` };
      case 'hover': await xdo(['mousemove', String(cmd.x), String(cmd.y)]); return { summary: `hovered at ${cmd.x},${cmd.y}` };
      case 'hold': {
        const btn = cmd.button === 'right' ? '3' : cmd.button === 'middle' ? '2' : '1';
        await xdo(['mousemove', String(cmd.x), String(cmd.y), 'mousedown', btn]);
        await new Promise(r => setTimeout(r, Math.max(50, Math.min(5000, cmd.ms ?? 800))));
        await xdo(['mouseup', btn]);
        return { summary: `click-and-hold at ${cmd.x},${cmd.y}` };
      }
      case 'mouse_down': await xdo(['mousemove', String(cmd.x), String(cmd.y), 'mousedown', cmd.button === 'right' ? '3' : '1']); return { summary: `button down at ${cmd.x},${cmd.y}` };
      case 'mouse_up': await xdo(['mousemove', String(cmd.x), String(cmd.y), 'mouseup', cmd.button === 'right' ? '3' : '1']); return { summary: `button up at ${cmd.x},${cmd.y}` };
      case 'scroll': {
        const notches = Math.max(1, Math.round(Math.abs(cmd.dy || 0) / 40));
        await xdo(['mousemove', String(cmd.x), String(cmd.y), 'click', '--repeat', String(notches), (cmd.dy || 0) > 0 ? '5' : '4']);
        return { summary: `scrolled ${(cmd.dy || 0) > 0 ? 'down' : 'up'} ${notches} notch(es)` };
      }
      case 'key': await xdo(['key', (cmd.combo || '').replace(/\bcmd\b|\bcommand\b|\bmeta\b/gi, 'super').replace(/\+/g, '+')]); return { app: await this.frontmostApp(), summary: `pressed ${cmd.combo}` };
      case 'type': await xdo(['type', '--delay', '12', cmd.text || '']); return { app: await this.frontmostApp(), summary: `typed ${(cmd.text || '').length} chars` };
      // X11 has no changeCount equivalent, so -1 sends the runtime down the content-comparison path.
      case 'clipboard_read': {
        if (!binExists('xclip')) throw new Error('reading the clipboard on Linux needs xclip');
        const { stdout } = await exec('xclip', ['-selection', 'clipboard', '-o'], 15_000, signal);
        return { clipboard: { text: stdout, files: [], types: [], changeCount: -1 }, summary: 'read the clipboard' };
      }
      case 'clipboard_write': {
        if (!binExists('xclip')) throw new Error('writing the clipboard on Linux needs xclip');
        await execWithInput('xclip', ['-selection', 'clipboard'], cmd.text || '', 15_000, signal);
        return { clipboard: { text: cmd.text || '', files: [], types: [], changeCount: -1 }, summary: `wrote ${(cmd.text || '').length} chars to the clipboard` };
      }
      case 'clipboard_write_files':
        // xclip can advertise text/uri-list, but only for as long as it stays running to serve the
        // selection — an ownership model this single-shot driver cannot satisfy. Refuse rather than
        // copy the paths as plain text, which would paste a filename string instead of the file.
        throw new Error('putting files on the clipboard is not supported on X11 from this driver — attach the file through the app\'s own file picker instead');
    }
    throw new Error(`unsupported action: ${cmd.action}`);
  }

  // ---- entry ----------------------------------------------------------------------------------

  public async run(cmd: DesktopCommand, ctx?: { cwd?: string; signal?: AbortSignal }): Promise<DesktopResult> {
    // Provider-hosted compatibility input gets one last app-authority check here, immediately
    // before this fallback can activate an app or synthesize native input.
    if (ACTING_VERBS.has(cmd.action)) await this.beforeMutation();
    return ensureActionResult(await this.runInner(cmd, ctx));
  }

  private async runInner(cmd: DesktopCommand, ctx?: { cwd?: string; signal?: AbortSignal }): Promise<DesktopResult> {
    const cwd = ctx?.cwd || process.cwd();
    const driver = this.driverName();
    try {
      if (cmd.action === 'wait') {
        const ms = Math.max(WAIT_MIN, Math.min(WAIT_MAX, Math.floor(cmd.ms || 500)));
        await new Promise(r => setTimeout(r, ms));
        return { ok: true, action: 'wait', driver, summary: `waited ${ms}ms` };
      }
      if (cmd.action === 'open') {
        if (!cmd.app?.trim()) throw new Error('open needs app');
        if (process.platform === 'darwin') await exec('open', ['-a', cmd.app.trim()], 20_000, ctx?.signal);
        else if (process.platform === 'linux' && binExists('gtk-launch')) await exec('gtk-launch', [cmd.app.trim()], 20_000, ctx?.signal);
        else throw new Error(`open is not supported on ${process.platform}`);
        const app = await this.waitForApp(cmd.app.trim(), true, ctx?.signal);
        return { ok: true, action: 'open', driver, app, summary: `opened and focused ${app}` };
      }
      if (cmd.action === 'reopen_background') {
        if (!cmd.app?.trim()) throw new Error('background reopen needs app');
        if (process.platform !== 'darwin') throw new Error(`background reopen is not supported on ${process.platform}`);
        // The standard kAEReopenApplication Apple event is what a Dock-icon click delivers when an
        // app is running with no visible windows. `open -g -a` merely activates some Catalyst apps
        // in the background and was measured leaving WhatsApp with only its 33px proxy strips;
        // `reopen` materializes the real window while preserving the foreground application.
        //
        // Bounded deliberately tightly. A running app answers this event in well under a second, so a
        // long ceiling buys nothing and costs a great deal in the two cases that do stall: an app that
        // does not implement the event lets the Apple event sit until it times out, and the FIRST
        // reopen of any app can raise the TCC "wants to control" consent dialog, which blocks osascript
        // until a human answers it. Either way the caller's next rung — the single bounded activation
        // pulse in reopenClosedMainWindow — is a better use of the time than waiting here, so fail fast
        // and let it run. A timeout throws, which that caller already treats as "still closed".
        const escapedApp = cmd.app.trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        await exec('osascript', ['-e', `tell application "${escapedApp}" to reopen`], REOPEN_EVENT_TIMEOUT_MS, ctx?.signal);
        return { ok: true, action: 'reopen_background', driver, app: cmd.app.trim(), summary: `sent ${cmd.app.trim()} the standard background reopen event` };
      }
      if (cmd.action === 'screenshot') return await this.screenshot(cmd, cwd, ctx?.signal);

      // Approval prompts and the TUI both run in Terminal and can steal focus. Restore focus only
      // after approval, immediately before native input, and refuse to report success on mismatch.
      if (cmd.action === 'type' || cmd.action === 'key' || cmd.action === 'close' || cmd.action === 'quit_app') {
        await this.activateApp(cmd.app || '', ctx?.signal);
      }

      if (cmd.action === 'close') {
        // close = close the SELECTED WINDOW only (Cmd+W / Ctrl+W). Quitting the entire application
        // is the separate, high-impact `quit_app` action — close must never tear down other windows
        // or discard unsaved state app-wide.
        const partial = process.platform === 'darwin'
          ? await this.runDarwin({ action: 'key', combo: 'cmd+w', app: cmd.app }, ctx?.signal)
          : process.platform === 'linux'
            ? await this.runLinux({ action: 'key', combo: 'ctrl+w', app: cmd.app }, ctx?.signal)
            : (() => { throw new Error(`desktop control is not supported on ${process.platform}`); })();
        // TRUTHFUL: this driver cannot enumerate windows, so it can DELIVER Cmd+W but cannot verify
        // the window actually closed. Never claim a verified outcome here.
        return {
          ok: true, action: 'close', driver: this.driverName(), ...partial, app: cmd.app,
          actionResult: { delivered: true, observed: 'unverified', postcondition: { query: 'target window closed', matched: false }, confidence: 'unknown', failureReason: undefined },
          summary: `sent close-window (Cmd+W/Ctrl+W) to ${cmd.app} — delivery only; this driver cannot verify the window closed (the application keeps running; use quit_app to quit it entirely)`,
        };
      }

      if (cmd.action === 'quit_app') {
        // High-impact by contract: quits the whole application and may discard unsaved state.
        const partial = process.platform === 'darwin'
          ? await this.runDarwin({ action: 'key', combo: 'cmd+q', app: cmd.app }, ctx?.signal)
          : process.platform === 'linux'
            ? await this.runLinux({ action: 'key', combo: 'alt+f4', app: cmd.app }, ctx?.signal)
            : (() => { throw new Error(`desktop control is not supported on ${process.platform}`); })();
        await this.waitForApp(cmd.app || '', false, ctx?.signal);
        return {
          ok: true, action: 'quit_app', driver: this.driverName(), ...partial, app: cmd.app,
          actionResult: { delivered: true, observed: 'changed', postcondition: { query: 'app no longer frontmost', matched: true }, confidence: 'likely' },
          summary: `quit ${cmd.app} (verified it is no longer frontmost)`,
        };
      }

      const resolved = await this.denormalize(cmd, ctx?.signal);
      for (const field of ['x', 'y', 'toX', 'toY'] as const) {
        const v = resolved[field];
        // Global display coordinates may legitimately be negative when a monitor is arranged to
        // the left of or above the main display. Reject only non-finite or implausibly remote points.
        if (v != null && (!Number.isFinite(v) || Math.abs(v) > 100_000)) throw new Error(`${field} out of range: ${v}`);
      }
      const partial = process.platform === 'darwin'
        ? await this.runDarwin(resolved, ctx?.signal)
        : process.platform === 'linux'
          ? await this.runLinux(resolved, ctx?.signal)
          : (() => { throw new Error(`desktop control is not supported on ${process.platform}`); })();
      if ((cmd.action === 'type' || cmd.action === 'key') && cmd.app && !appNamesMatch(partial.app || '', cmd.app)) {
        throw new Error(`${cmd.action} went to ${partial.app || '(unknown app)'}, expected ${cmd.app}; no success was claimed`);
      }
      return { ok: true, action: cmd.action, driver: this.driverName(), summary: `${cmd.action} done`, ...partial };
    } catch (err: any) {
      return { ok: false, action: cmd.action, driver, error: String(err?.message || err).slice(0, 500), summary: `${cmd.action} failed` };
    }
  }
}

// Transport-level helpers (branding, MCP decode, timeouts) live in transport.ts;
// target-ownership rules live in target.ts. Re-export the target type for existing importers.
export type { ComputerTarget } from './target';

/**
 * Bimax Computer Use — a long-lived, private MCP connection to the embedded native sidecar.
 *
 * The sidecar is derived from trycua/cua 0.12.3 (MIT) but no Cua surface leaks into Bimax: the
 * executable path, session, tool schema, diagnostics, output and fallback are all Bimax-owned.
 * Keeping one live connection is essential because accessibility element tokens are scoped to the
 * observation that created them; spawning a process per action would silently discard that cache.
 */
export class BimaxComputerRuntime implements DesktopRuntimePort {
  private readonly session = `bimax-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  /** Driver transport — the ONE place a sidecar RPC can happen (see transport.ts). */
  private readonly transport: SidecarTransportPort = new SidecarTransport(this.session);
  /** Target ownership — the single authority on which app/window an action goes to (target.ts). */
  private readonly targets = new TargetOwnership();
  private indexedElements = new Map<string, ObservedElement>();
  private observedElements: ObservedElement[] = [];
  /** The target app's other windows at last window selection — recovery detail for a failed query. */
  private siblingWindows: Array<{ windowId: number; title: string }> = [];
  /**
   * A window the CALLER named explicitly, which the heuristic picker must not overrule.
   *
   * `refreshTargetWindow` picks by focus/size because usually nothing better is known. But once a
   * caller has enumerated `windows` and said which one it wants — the recovery this runtime itself
   * recommends when a query misses — re-deriving the "good" window silently discards that choice and
   * the caller is stuck on the same surface no matter what it asks for.
   */
  private pinnedWindow: { pid: number; windowId: number } | null = null;
  /**
   * Apps proven undriveable in background delivery, latched for the session.
   *
   * Background delivery reads an app through its accessibility tree. Mac Catalyst and some Electron
   * apps publish that tree only while ACTIVE: measured on WhatsApp within one session, background
   * observation returned 41 Vision-OCR items with zero editable fields and no actionable handle,
   * while foreground returned 43 real AX nodes including the composer and the attachment control.
   *
   * With no handle to target, a background click still reports "delivered" and the screen never
   * changes. That single fact is what every downstream fallback — Vision element synthesis, transient
   * adoption, display context, reopen, the activation pulse — was separately compensating for, and
   * what makes a run bounce between guards instead of doing the task. Detect the condition ONCE at
   * observation and escalate this app to foreground for the rest of the session; the fallbacks then
   * stop being load-bearing rather than each needing to be smarter.
   */
  private backgroundUnviableApps = new Set<string>();
  /** Latest visual state per recently observed window. Eight bounded surfaces support normal
   * multi-app work while preventing an hours-long session from accumulating screenshot state. */
  private visualHistory = new Map<string, Map<string, VisualFingerprint>>();
  /** Newest desktop enumeration, so a move can be judged against where items were beforehand. */
  private desktopIcons: Array<{ name: string; frame: ScreenRect }> = [];
  private observedTarget: { pid: number; windowId?: number; degraded: boolean; width?: number; height?: number } | null = null;
  /** Exact PNG that produced observedTarget. A raw click can use a local patch from this image to
   * distinguish a moved/relabelled target from harmless animation elsewhere in the window. */
  private observedScreenshotFile: string | null = null;
  /** WindowServer ids present in the exact-window observation. A click-created id that appears
   * later is evidence of a real child surface (popover, picker, sheet), not a reason to fall back
   * immediately to display pixels that may only show the PiP preview. */
  private observedWindowIds = new Set<number>();
  /** Event-driven AX invalidation. Screenshots are snapshots; focus/value/window events that arrive
   * afterwards make their semantic handles stale even when geometry and hashes still match. */
  private axWatcherStop: (() => void) | null = null;
  private axWatcherPid: number | null = null;
  private axEventEpoch = 0;
  private observedAxEventEpoch = 0;
  private latestAxEvent: AccessibilityEvent | null = null;
  private observedWindowFrame: { x: number; y: number; w: number; h: number } | null = null;
  /** CoreGraphics bounds sampled with the observation, even when an AX frame was selected as the
   * screenshot mapping authority. Comparing later CG bounds to this baseline detects a real resize
   * without mistaking an AX/CG disagreement that already existed at capture time for new staleness. */
  private observedLiveWindowFrame: Frame | null = null;
  /** Frame identity (frame.ts) — binds an action to the exact picture it was planned from, so a
   * stale frame of the SAME window is caught, not just a target switch. */
  private readonly frames = new FrameRegistry();
  /** Backing scale of the main display, refreshed whenever screen geometry is read. Descriptive
   * only: window screenshots are already point-scaled, so no transform multiplies by it. */
  private mainDisplayScale = 1;
  /** Measured target-switch latencies (switch.ts), so the p95 target is reported, not asserted. */
  private readonly switchLatency = new SwitchLatencyLog();
  private lastSwitch: TargetSwitch | null = null;
  /** The ONE serialized native-input executor (input.executor.ts). There is one physical mouse; two
   * overlapping actions would interleave into a sequence nobody designed. Also the record of which
   * buttons are physically held, so a cancel/dispose can release them. */
  private readonly input = new InputExecutor();
  /** Where each window sat before this session last arranged it, keyed by pid — what layout=restore
   * puts back. Bounded by the number of apps a session touches. */
  private readonly priorWindowBounds = new Map<number, ScreenRect>();
  /** The window owned before the last turn boundary — remembered, never auto-acted on. */
  private lastOwnedTarget: ComputerTarget | null = null;
  /** Which surface the newest image describes. Context menus/popovers are separate OS windows that
   * a window-scoped PNG can never show, so right-click switches to a full-display observation:
   * pixels map through that display's global point bounds, and physical input skips activation
   * because bring_to_front would dismiss the very menu the model is about to click. */
  private observedSurfaceKind: 'window' | 'display-transient' = 'window';
  /** System Settings reports a sheet as the first app window while its screenshot is composed in
   * the larger parent-window coordinate space. Track the sheet independently so pixels keep mapping
   * through the parent and background clicks can be rejected instead of silently doing nothing. */
  private transientDialogFrame: Frame | null = null;
  /** Processes already asked for a full accessibility tree — the opt-in is idempotent but not free. */
  private axEnabledPids = new Set<number>();
  /** Single owner of recording state (see recording.ts). Recording is explicit-opt-in only:
   * nothing in the action path may start it — only the record_start case below. */
  private readonly recording = new RecordingController();
  /** Which surfaces this session is operating on, who owns input, and which is active. Recorded
   * additively — Stage 1 of the surface architecture. Delivery routing still lives in run(). */
  private readonly surfaces = new SurfaceRegistry();
  private lastMechanismChoice: AutomationMechanism | null = null;
  private lastExecutorChoice: ExecutorLevel | null = null;
  /** Whether this action's target came from screenshot pixels or on-device Vision. Delivery may
   * still use AX or a native event; the weaker visual grounding is what the receipt must disclose. */
  private lastVisualGrounding = false;
  /** Set when the live app invalidated the caller's frame and perception was re-run for its query,
   * so the returned summary can disclose that the action used a replacement picture. */
  private lastSemanticRegrounding: { notification: string; windowChanged: boolean; reacquiredHandle?: string } | null = null;

  /** Read and clear the pending re-grounding disclosure. */
  private takeSemanticRegrounding(): { notification: string; windowChanged: boolean; reacquiredHandle?: string } | null {
    const pending = this.lastSemanticRegrounding;
    this.lastSemanticRegrounding = null;
    return pending;
  }
  /** Pixel digest of the most recent frame — the baseline the NEXT action's outcome is judged against. */
  private prevFrameHash: string | undefined;
  /** Consecutive no-effect actions, for runtime-level no-progress detection. */
  private noChangeStreak = 0;
  /** Bounded recovery authority (Stage 6): turns the per-action verification stream into a
   * continue/retry/recover/escalate/stop decision with hard budgets. When it latches stop-failure
   * the runtime refuses further acting verbs so a stuck agent stops thrashing instead of looping. */
  private readonly recovery = new RecoveryController();
  /** Bounded, compressed action log for durability + resume (Stage 7). */
  private actionHistory = new ActionHistory();
  /** Whether this process has already attempted a one-time resume from the persisted session file. */
  private resumedFromDisk = false;
  private activeAction = '';
  /** Delivery contract for the operation currently inside the serialized runtime.
   *
   * Automatic evidence is allowed to re-focus a target only for an explicitly foreground
   * operation. A background operation may return AX-thin/degraded evidence, but it must never steal
   * focus merely to improve that evidence. */
  private activeDelivery: 'foreground' | 'background' = 'foreground';
  /** Optional postcondition for the action currently inside the serialized control loop. Keeping it
   * here lets every delivery path (pointer, keyboard, drag, paste…) share one verifier. */
  private activeExpectation: {
    query: string;
    mode: 'present' | 'absent';
    /** Whether the requested end-state was already true in the action's input frame. A postcondition
     * must be a transition caused by this action, not an old chat bubble/document sentence. */
    desiredBefore: boolean;
  } | null = null;
  private lastCwd = process.cwd();
  private lastPersistAt = 0;
  private lastStatus = { accessibility: null as boolean | null, screenRecording: null as boolean | null };
  /** Immediate delivery/grounding failures do not reach postActionEvidence, so the visual recovery
   * controller cannot count them. Bound those separately and require a fresh observation. */
  private failedActingStreak = 0;
  /** Presentation-only continuous ScreenCaptureKit preview. Its process and failures are isolated
   * from the action sidecar and exact model screenshot path. */
  private pipGeneration = 0;
  private pipPaused = false;

  private readonly fallback: DesktopRuntimePort;
  private readonly livePip: LivePipPort;
  /** Stable Bimax task identity. Omitted by direct/test callers to retain the legacy file path. */
  private readonly persistenceSessionId?: string;

  public constructor(
    fallback?: DesktopRuntimePort,
    livePip: LivePipPort = new NativeLivePip(),
    persistenceSessionId?: string,
    private readonly takeoverGuard?: {
      begin(): Promise<void>;
      require(): Promise<void>;
      end(): void;
    },
  ) {
    const rawFallback = fallback ?? new DesktopRuntime();
    // The compatibility runtime has many recovery paths, but they all cross `fallback.run`.
    // Wrap that one port so even an injected/test fallback cannot bypass the final takeover read.
    this.fallback = this.takeoverGuard
      ? new Proxy(rawFallback, {
        get: (target, property, receiver) => {
          if (property === 'run') {
            return async (cmd: DesktopCommand, ctx?: { cwd?: string; signal?: AbortSignal }) => {
              if (ACTING_VERBS.has(cmd.action)) await this.takeoverGuard!.require();
              return target.run(cmd, ctx);
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      })
      : rawFallback;
    this.livePip = livePip;
    this.persistenceSessionId = persistenceSessionId;
  }

  private watchTargetAccessibility(target: ComputerTarget): void {
    if (!target.pid || this.axWatcherPid === target.pid) return;
    this.axWatcherStop?.();
    this.axWatcherStop = null;
    this.axWatcherPid = null;
    this.latestAxEvent = null;
    if (!this.fallback.watchAccessibility) return;
    this.axWatcherPid = target.pid;
    this.axWatcherStop = this.fallback.watchAccessibility(target.pid, event => {
      if (event.pid !== this.axWatcherPid || event.notification === 'observer-ready') return;
      if (!accessibilityEventInvalidatesObservation(event)) return;
      this.latestAxEvent = event;
      this.axEventEpoch++;
    });
  }

  public quickStatus() {
    if (!this.transport.available()) return this.fallback.quickStatus();
    return { driver: BIMAX_DRIVER_LABEL, ready: true, ...this.lastStatus };
  }

  /** Record/refresh the active native-window surface from the current target + observed geometry.
   * Additive: this tracks WHAT the agent is operating on and who owns input; it does not change how
   * actions are delivered (that routing stays in run() until Stage 3 moves it behind chooseMechanism). */
  private syncSurface(opts: { focusOwner?: InputOwner; syncPip?: boolean } = {}): void {
    const target = this.targets.current();
    if (!target?.pid) return;
    this.surfaces.register({
      id: `native:${target.pid}`,
      kind: 'native-window',
      app: target.app || undefined,
      pid: target.pid,
      windowId: target.windowId,
      // A human-view observation maps the model image through the whole display, but the active
      // execution surface is still the exact native window. Keep those geometries distinct or a
      // display observation makes arrange/PiP avoidance believe the window fills the desktop.
      bounds: (this.observedLiveWindowFrame || this.observedWindowFrame)
        ? { ...(this.observedLiveWindowFrame || this.observedWindowFrame)! }
        : undefined,
      ...(opts.focusOwner ? { focusOwner: opts.focusOwner } : {}),
    });
    if (opts.syncPip !== false) this.syncLivePip();
  }

  /** The surface the agent is currently operating on (native window, browser tab, …), or null. */
  public activeSurface(): ExecutionSurface | null { return this.surfaces.active(); }
  /** All surfaces tracked this session, for the /computer hub and PiP surface selection. */
  public surfaceSnapshot(): ExecutionSurface[] { return this.surfaces.all(); }
  /** The delivery mechanism chosen for the most recent acting verb, for observability/tests. */
  public lastMechanism(): AutomationMechanism | null { return this.lastMechanismChoice; }
  /** Product-level ladder row for the most recent routed action. Cleared at every public run. */
  public lastExecutor(): ExecutorLevel | null { return this.lastExecutorChoice; }
  /** Measured target-switch latency this session (count/p50/p95/worst, ms). Nulls before any
   * switch has happened — an unmeasured percentile is reported as unknown, never as zero. */
  public switchLatencySummary(): { count: number; p50: number | null; p95: number | null; worst: number | null } {
    return this.switchLatency.summary();
  }

  /** Per-phase durations of the most recent switch. A slow switch is only actionable once the time
   * is attributed to the step that spent it, so the trace is kept rather than just the total. */
  public lastSwitchPhases(): Array<{ phase: string; ms: number }> {
    return this.lastSwitch ? this.lastSwitch.phaseDurations() : [];
  }

  /** The exact agent window used for capture-safe recording and for selecting PiP's target display.
   * Returns null when no stable native window exists; whole-display recording then needs approval. */
  private captureSurface(): { pid: number; windowId: number; label: string } | null {
    const s = this.surfaces.active();
    if (s?.kind === 'native-window' && s.captureSafe && s.pid && s.windowId) {
      return { pid: s.pid, windowId: s.windowId, label: `${s.app || 'window'} window ${s.windowId}` };
    }
    return null;
  }

  /** Keep the three independently-maintained identities—ownership, active surface and PiP—locked
   * to the command target. Surface drift is repaired from TargetOwnership; a preview that still
   * names another window is synchronously retargeted before physical input may continue. */
  private async ensureTargetPipeline(target: ComputerTarget): Promise<string | null> {
    const owned = this.targets.current();
    if (!owned || owned.pid !== target.pid || owned.windowId !== target.windowId) {
      return `target ownership changed before input (wanted ${target.app || target.pid} window ${target.windowId ?? '?'}, owned ${owned?.app || owned?.pid || 'none'} window ${owned?.windowId ?? '?'})`;
    }
    let surface = this.surfaces.active();
    if (!surface || surface.pid !== target.pid || surface.windowId !== target.windowId) {
      this.syncSurface({ syncPip: false });
      surface = this.surfaces.active();
    }
    if (!surface || surface.pid !== target.pid || surface.windowId !== target.windowId) {
      return 'active surface does not match the owned input window';
    }
    const preview = this.livePip.status();
    if (preview.enabled && (!preview.target
      || preview.target.pid !== target.pid || preview.target.windowId !== target.windowId)) {
      await this.syncLivePipNow();
      const repaired = this.livePip.status();
      if (repaired.enabled && (!repaired.target
        || repaired.target.pid !== target.pid || repaired.target.windowId !== target.windowId)) {
        return repaired.target
          ? `live preview is still attached to pid ${repaired.target.pid} window ${repaired.target.windowId}`
          : 'live preview has no target after synchronous retargeting';
      }
    }
    return null;
  }

  /** PiP is a presentation-only preview. It is never used as an input or coordinate surface. */
  public async pipStatus(): Promise<LivePipStatus> {
    const cfg = await loadConfig().catch(() => ({ computerPip: false } as any));
    const current = this.livePip.status();
    return {
      ...current,
      enabled: cfg.computerPip === true,
      // PiP is deliberately the composited human view now, so it can include unrelated windows.
      // Recording remains separately window-scoped and capture-safe via captureSurface().
      captureSafe: current.captureSafe,
      surface: current.surface || (this.captureSurface() ? `Human view · ${this.captureSurface()!.label}` : undefined),
    };
  }

  /** Resolve configuration asynchronously without making an observe/action wait for UI startup.
   * Generation checks prevent a late config read from resurrecting PiP after dispose or retarget. */
  private syncLivePip(): void { void this.syncLivePipNow().catch(() => { /* preview is cosmetic */ }); }

  /** Retarget the presentation preview and optionally await the process hand-off. App switches use
   * the awaited form so the old app cannot remain visible in PiP once input is released to the new
   * app. Routine geometry refreshes keep the fire-and-forget wrapper above. */
  private async syncLivePipNow(): Promise<void> {
    const generation = ++this.pipGeneration;
    const target = this.pipPaused ? null : this.captureSurface();
    // An environment override is already the highest-precedence configuration value. Honor it
    // synchronously instead of starting a file read whose callback can outlive a short command or
    // test process (and briefly resurrect/retarget PiP after the caller thought it was finished).
    try {
      const envOverride = process.env.BIMAX_COMPUTER_PIP;
      if (envOverride !== undefined && envOverride !== '') {
        await this.livePip.sync(target, envOverride !== '0' && envOverride !== 'false');
        return;
      }
      const cfg = await loadConfig();
      if (generation !== this.pipGeneration) return;
      await this.livePip.sync(target, cfg.computerPip === true);
    } catch {
      if (generation === this.pipGeneration) {
        try { await this.livePip.sync(null, false); } catch { /* preview failure never blocks input */ }
      }
    }
  }

  /** Remove the old preview before a target switch begins. A blank/hidden preview during the
   * transaction is honest; showing Notes while the input lock already belongs to WhatsApp is not. */
  private async suspendLivePipForSwitch(): Promise<void> {
    const current = this.livePip.status();
    if (!current.enabled && !current.running) return;
    ++this.pipGeneration; // invalidate any config read / retarget already in flight
    try { await this.livePip.sync(null, current.enabled); }
    catch {
      // If retarget teardown itself fails, make one direct stop attempt. A missing preview is safe;
      // leaving the old app visible while a new app receives input is not.
      try { await this.livePip.stop(); }
      catch { throw new Error('could not clear the old live preview safely, so the app switch was stopped before input could move to a different window'); }
    }
  }

  private sessionStorageDir(cwd: string): string {
    if (!this.persistenceSessionId) return path.join(cwd, '.bimax', 'computer');
    const safe = this.persistenceSessionId.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80);
    return path.join(cwd, '.bimax', 'computer', 'sessions', safe);
  }

  private sessionStateFile(cwd: string): string {
    return path.join(this.sessionStorageDir(cwd), 'session.json');
  }

  /** Where the durable session state currently lives (active surface + compressed action history). */
  private buildSessionState(): ComputerSessionState {
    const s = this.surfaces.active();
    return {
      version: 1, updatedAt: Date.now(),
      surface: s ? { id: s.id, kind: s.kind, app: s.app, pid: s.pid, windowId: s.windowId, bounds: s.bounds, focusOwner: s.focusOwner } : null,
      history: this.actionHistory.summary(8),
      recordingDir: this.recording.outputDir,
    };
  }

  /** Record an acting verb into the bounded history and persist the session state (throttled).
   * The frame the action was planned from is stamped from the registry, so the history answers
   * "which picture was this click chosen from" without the call sites having to thread it. */
  private recordAction(action: string, app: string | undefined, outcome?: string): void {
    this.actionHistory.record(action, { app, outcome, frameId: this.frames.current()?.frameId });
    const now = Date.now();
    if (now - this.lastPersistAt < 1500) return; // durable-but-throttled: at most ~1 write/1.5s
    this.lastPersistAt = now;
    try { writeSessionState(this.sessionStateFile(this.lastCwd), this.buildSessionState()); }
    catch { /* persistence is best-effort; a run must not fail because the disk is full */ }
  }

  /** Compressed action history for /computer, telemetry, and resume decisions. */
  public history(): ActionHistorySummary { return this.actionHistory.summary(); }
  /** The current durable session snapshot (active surface + history). */
  public sessionSummary(): ComputerSessionState { return this.buildSessionState(); }
  /** Reload a persisted session (active app/window + history) to resume after an interruption. */
  public loadPersistedState(cwd: string = process.cwd()): ComputerSessionState | null {
    return readSessionState(this.sessionStateFile(cwd));
  }

  /**
   * One-time resume: on the first `open` of a fresh process, if a persisted session for THIS app is
   * on disk, restore its bounded action history so an interrupted long run keeps its trajectory
   * count and no-change streak instead of silently starting over. Scoped deliberately narrow — we
   * restore only the compressed history, never the prior process's live pid/window (that would point
   * at a dead or reused process); the current `open` re-establishes the real surface itself.
   */
  private maybeResumeHistory(cwd: string): void {
    if (this.resumedFromDisk || this.actionHistory.total > 0) { this.resumedFromDisk = true; return; }
    this.resumedFromDisk = true;
    const persisted = readSessionState(this.sessionStateFile(cwd));
    const app = this.targets.current()?.app;
    if (!persisted?.surface || !app || persisted.surface.app !== app) return;
    this.actionHistory = ActionHistory.fromSummary(persisted.history);
    if (this.actionHistory.total > 0) {
      cliEvents.emit('status', `Resumed ${app} computer-use session — ${this.actionHistory.total} prior action${this.actionHistory.total === 1 ? '' : 's'} restored`);
    }
  }
  /** Watchdog view: is the sidecar connected, and how long since the last real activity? */
  public health(): { connected: boolean; idleMs: number; lastActivityAt: number } {
    return this.transport.health();
  }
  /** Cheap memory-footprint reporter — everything here is bounded; this surfaces the current sizes. */
  public memoryFootprint(): { historyKept: number; observedElements: number; indexedElements: number; surfaces: number } {
    return { historyKept: this.actionHistory.size, observedElements: this.observedElements.length, indexedElements: this.indexedElements.size, surfaces: this.surfaces.all().length };
  }

  /** User takeover: hand input ownership of the active surface to the user. While paused, acting
   * verbs are refused (the agent will not fight the human for the cursor) until resume() is called. */
  public pauseForUser(): { ok: boolean; surface?: string } {
    const s = this.surfaces.active();
    if (s) this.surfaces.update(s.id, { focusOwner: 'user' });
    this.pipPaused = true;
    // A takeover in the middle of a staged selection would leave the user's own mouse fighting a
    // button the agent is still holding. Hand the desktop back neutral. Deliberately not awaited:
    // pauseForUser must return instantly so the human regains control without waiting on IO.
    void this.releaseHeldInput('user took control');
    this.syncLivePip();
    cliEvents.emit('status', s
      ? `Computer use paused — you have control of ${s.app || 'the surface'}; the agent will not act until you resume`
      : 'Computer use paused — the agent will not act until you resume');
    return { ok: true, surface: s?.id };
  }

  /** Resume agent control of the active surface after a user takeover. */
  public resume(): { ok: boolean; surface?: string } {
    const s = this.surfaces.active();
    if (s) this.surfaces.claimInput(s.id, 'agent', { force: true });
    this.pipPaused = false;
    this.syncLivePip();
    cliEvents.emit('status', 'Computer use resumed — the agent has control again');
    return { ok: true, surface: s?.id };
  }

  /**
   * Return the desktop to a neutral input state: post a mouse-up for every button the agent is
   * still physically holding.
   *
   * Called on dispose and on user takeover — the two moments a held button would otherwise outlive
   * the code that owns it. Failures are collected and reported, never retried in a loop: a button
   * that will not release is something the human needs told about, not something to hammer.
   */
  public async releaseHeldInput(reason: string): Promise<{ released: number; errors: string[] }> {
    const owed = this.input.takeReleasePlan();
    if (!owed.length) return { released: 0, errors: [] };
    const errors: string[] = [];
    for (const held of owed) {
      try {
        const result = await this.fallback.run({ action: 'mouse_up', x: held.x, y: held.y, button: held.button, normalized: false });
        if (!result.ok) errors.push(`${held.button} at ${held.x},${held.y}: ${result.error || result.summary}`);
      } catch (err: any) {
        errors.push(`${held.button} at ${held.x},${held.y}: ${String(err?.message || err)}`);
      }
    }
    const note = `released ${owed.length - errors.length}/${owed.length} held mouse button(s) (${reason})`;
    cliEvents.emit('status', errors.length ? `${note}; STILL HELD: ${errors.join('; ')}` : note);
    return { released: owed.length - errors.length, errors };
  }

  public describeTarget(cmd: DesktopCommand) {
    const key = cmd.elementToken ? `token:${cmd.elementToken}`
      : cmd.elementIndex != null ? `index:${Math.floor(cmd.elementIndex)}` : '';
    return key ? this.indexedElements.get(key) || null : null;
  }

  /**
   * The durable part of a label this runtime may have synthesized.
   *
   * An anonymous list row gets its name by folding its descendant `AXStaticText` leaves into one
   * string, so the "label" of a chat row is really `name, last message, date`. Every one of those
   * trailing components is live content: a new message, a date rolling over, or one extra leaf
   * appearing in the next walk rewrites the composite while the row itself never changed. The
   * leading component is the one the fold puts first and the one that identifies the row.
   */
  private stableLabelCore(label: unknown): string {
    return String(label ?? '').split(',')[0]!.trim();
  }

  /**
   * Re-acquire a named handle in a freshly walked tree.
   *
   * Exact equality on role+label+value is the only fully safe match and stays the first choice. It
   * is not sufficient on its own, though, and the failure is not hypothetical: a Messages
   * conversation row was refused as "no longer in the tree" — killing the run — because the
   * composite WE synthesized for it had picked up a different trailing segment. Refusing there is
   * as wrong as clicking blindly; the row was visible on screen the whole time.
   *
   * So fall back, but never to a best guess. Each weaker key is accepted only when it matches
   * EXACTLY ONE element: ambiguity is still a refusal, because a near-miss is a silent click on the
   * wrong control and that is the failure this guard exists to prevent.
   */
  public reacquireByIdentity(identity: ObservedElement): ObservedElement | null {
    // Every element is registered under BOTH `token:` and `index:`, so `.values()` yields each one
    // twice. `find()` never noticed; a uniqueness test does — it saw two hits for a single row and
    // refused it as ambiguous. Dedupe by object identity: both keys hold the same reference.
    const candidates = [...new Set(this.indexedElements.values())];
    const sameRole = (element: ObservedElement) =>
      String(element.role || '') === String(identity.role || '');

    const exact = candidates.find(element => sameRole(element)
      && String(element.label ?? '') === String(identity.label ?? '')
      && String(element.value ?? '') === String(identity.value ?? ''));
    if (exact) return exact;

    // The element's OWN AX label, before any folding — untouched by what its descendants did.
    const originalLabel = String(identity.originalLabel ?? '').trim();
    if (originalLabel) {
      const byOriginal = candidates.filter(element => sameRole(element)
        && String(element.originalLabel ?? '').trim() === originalLabel);
      if (byOriginal.length === 1) return byOriginal[0]!;
    }

    const core = this.stableLabelCore(identity.label);
    // A one-word core like "Open" repeats across a window; requiring uniqueness already refuses
    // those, but a very short core is not worth attempting at all.
    if (core.length >= 3) {
      const byCore = candidates.filter(element => sameRole(element)
        && this.stableLabelCore(element.label) === core);
      if (byCore.length === 1) return byCore[0]!;
    }
    return null;
  }

  public async dispose(): Promise<void> {
    const wasRecording = this.recording.started;
    // Release anything the desktop is still physically holding BEFORE tearing state down. A turn
    // aborted between mouse_down and mouse_up leaves the button down at the OS level, which outlives
    // this process and breaks the user's own mouse. This is the one cleanup that must not be
    // best-effort-and-forget, so a failure is reported rather than swallowed silently.
    await this.releaseHeldInput('session ended');
    // Persist a final durable snapshot (active surface + compressed history) BEFORE tearing state
    // down, so an interrupted run can be resumed via loadPersistedState() on the next launch.
    try { writeSessionState(this.sessionStateFile(this.lastCwd), this.buildSessionState()); }
    catch { /* best-effort */ }
    // Session-scoped identity and observations must never leak into the next user turn. In
    // particular, closing the client is what removes the experimental PiP window.
    // The identity is REMEMBERED (not owned) across the boundary so a follow-up turn can re-acquire
    // the same window via observe — see reacquireLastTarget(). Remembering cannot deliver input:
    // ownership is still dropped here, and acting verbs still require a fresh frame.
    this.lastOwnedTarget = this.targets.current() ?? this.lastOwnedTarget;
    this.axWatcherStop?.();
    this.axWatcherStop = null;
    this.axWatcherPid = null;
    this.latestAxEvent = null;
    this.targets.clear();
    this.pinnedWindow = null;
    this.pipGeneration++;
    this.pipPaused = false;
    this.indexedElements.clear();
    this.observedElements = [];
    this.visualHistory.clear();
    this.desktopIcons = [];
    this.observedTarget = null;
    this.observedScreenshotFile = null;
    this.observedWindowIds.clear();
    this.observedWindowFrame = null;
    this.observedLiveWindowFrame = null;
    this.observedSurfaceKind = 'window';
    this.frames.invalidate();
    this.priorWindowBounds.clear();
    this.transientDialogFrame = null;
    this.recording.reset();
    this.surfaces.clear();
    this.prevFrameHash = undefined;
    this.noChangeStreak = 0;
    this.recovery.reset();
    this.actionHistory.reset();
    this.resumedFromDisk = false; // a session ended; the next open may resume from disk again
    this.lastPersistAt = 0;
    await Promise.all([
      this.transport.dispose({ stopRecording: wasRecording }),
      this.livePip.stop(),
    ]);
  }

  /** Start (or join) the sidecar spawn/handshake without waiting on it — lets boot time overlap
   * with human read/decision time (e.g. an approval prompt) instead of starting after Enter. */
  public warm(): void { this.transport.warm(); }

  /** One sidecar RPC, via the extracted transport (spawn/handshake/timeouts live there). */
  private async call(name: string, args: Record<string, unknown> = {}): Promise<any> {
    if (MUTATING_DRIVER_CALLS.has(name)) await this.takeoverGuard?.require();
    return this.transport.call(name, args);
  }

  /** The user owns the visibility policy. Foreground uses the physical cursor; background uses
   * semantic AX handles first and the PID-scoped sidecar only when no handle exists. ComputerTool
   * strips model-supplied deliveryMode, so only config (or this internal test seam) can choose it. */
  private async defaultDelivery(cmd: DesktopCommand): Promise<'background' | 'foreground'> {
    if (cmd.deliveryMode) return cmd.deliveryMode;
    const cfg = await loadConfig().catch(() => ({ computerVisible: true } as any));
    return cfg.computerVisible === false ? 'background' : 'foreground';
  }

  /**
   * Say — once per app — when a background observation produced nothing clickable.
   *
   * This DIAGNOSES and does not act. Two earlier attempts to make it act were both wrong and are
   * recorded here so they are not tried again:
   *
   *   - Auto-activating the app inside the observation. Measured: bring_to_front succeeded, the tree
   *     stayed Vision-only anyway, so it was a fallback that mostly did not work.
   *   - Auto-switching the app to foreground delivery. That breaks capabilities which are SUPPOSED to
   *     work without handles — typing at a visible placeholder point, and PID-scoped copy/paste, both
   *     of which run without fronting anything. "No actionable handles" means clicks have no target;
   *     it does not mean background is useless.
   *
   * So the honest scope is: report the cause, name the setting that governs it, and change nothing.
   */
  private noteBackgroundViability(app: string | undefined, delivery: 'background' | 'foreground'): string | null {
    if (delivery !== 'background' || !app) return null;
    if (this.backgroundUnviableApps.has(appKey(app))) return null;
    const actionable = this.observedElements.filter(element =>
      ACTIONABLE_AX_ROLES.has(String(element.role || '')) && element.visualOnly !== true);
    if (actionable.length > 0) return null;
    this.backgroundUnviableApps.add(appKey(app));
    return `${app} exposes NO clickable accessibility element while it is inactive, so element clicks in this app have nothing to target and would report as delivered while changing nothing — target it by query="<visible label>" or x/y, or use typing, which does not need a handle. Measured cause: with computerVisible false this app is read only by on-screen text recognition; setting computerVisible true (BIMAX_COMPUTER_VISIBLE=1) restores its real accessibility tree.`;
  }

  /** Single-use whole-display approval tokens. Minted ONLY by authorizeFullDisplayRecording()
   * (called by the tool layer AFTER a governor-approved whole-display prompt) and consumed by the
   * next record_start. Unforgeable by the model: its arguments are stripped of any token field. */
  private readonly fullDisplayTokens = new Set<string>();

  /** What the next record_start would capture — lets the approval layer phrase the prompt honestly
   * BEFORE any recording starts. */
  public recordingScopePreview(scope: 'window' | 'display' = 'window'): { scope: string; captureSafe: boolean } {
    if (scope === 'display') return { scope: 'whole display', captureSafe: false };
    const scoped = this.captureSurface();
    return { scope: scoped ? scoped.label : 'whole display', captureSafe: !!scoped };
  }

  /** Mint a single-use whole-display recording approval token. MUST only be called after the user
   * explicitly approved whole-display capture (the governor prompt in the tool layer). */
  public authorizeFullDisplayRecording(): string {
    const token = crypto.randomBytes(16).toString('hex');
    this.fullDisplayTokens.add(token);
    return token;
  }

  /**
   * Explicit recording start (the ONLY path that can begin a recording — there is no auto-record):
   *   - requires the opt-in `computerRecord` config to be true;
   *   - scopes the capture to the agent's own window when one exists;
   *   - refuses whole-display VIDEO capture unless a valid governor-issued single-use token is
   *     presented (a model-supplied boolean or guessed token can never authorize it).
   */
  private async startRecording(cwd: string, cmd: DesktopCommand): Promise<any> {
    const cfg = await loadConfig().catch(() => ({} as any));
    if (cfg.computerRecord !== true) {
      // Deliberately NOT model-settable: recording the user's screen is a decision the user makes,
      // never one an agent can talk itself into. But the remediation has to be honest about who can
      // perform it — an MCP caller has no `/computer` command, so telling it to run one sends it
      // into a retry loop against a gate it cannot open.
      throw new Error('screen recording is disabled — it is opt-in and only the user can enable it, '
        + 'by running `/computer record on` in the Bimax CLI (or setting computerRecord: true in the '
        + 'Bimax config) and restarting this server. It cannot be enabled through this tool; do not retry.');
    }
    // Consume the token exactly once, and only if it was genuinely minted by this runtime.
    const approvedFullDisplay = !!cmd.fullDisplayToken && this.fullDisplayTokens.delete(cmd.fullDisplayToken);
    return this.recording.start({
      cwd,
      outputDir: cmd.outputDir,
      storageRoot: path.join(this.sessionStorageDir(cwd), 'recordings'),
      recordVideo: cmd.recordVideo !== false,
      approveFullDisplay: approvedFullDisplay,
      scopeTarget: cmd.captureScope === 'display' ? null : this.captureSurface(),
      call: (name, args) => this.call(name, args),
    });
  }

  private resolveObservedElement(query: string, target: ComputerTarget): ObservedElement & { targeting: NonNullable<DesktopResult['targeting']> } {
    if (!this.observedTarget || this.observedTarget.pid !== target.pid || this.observedTarget.windowId !== target.windowId) {
      throw new Error('semantic targeting needs a fresh observe of the current window');
    }
    if (!query.trim()) throw new Error('semantic query cannot be empty');
    const ranked = rankSemanticTargets(query, this.observedElements);
    if (ranked.ranked.length === 0 || ranked.confidence === 'none') {
      const labels = this.observedElements.map(element => element.label).filter(Boolean).slice(0, 12).join(', ');
      const siblings = this.siblingWindows
        .map(w => `${w.windowId}${w.title ? ` ("${w.title}")` : ''}`)
        .slice(0, 4).join(', ');
      throw new Error(`no semantic element matched "${query}"${labels ? `; visible labels include: ${labels}` : ''}`
        + (siblings
          ? `. ${target.app || 'This app'} has other window(s): ${siblings} — if what you named is on one of those, call focus with app="${target.app}" and windowId=<id>, then observe.`
          : ''));
    }
    const top = ranked.ranked[0];
    if (ranked.ambiguous || ranked.confidence === 'low') {
      // Name the handle for each choice: when duplicates share a label ("Chats" appears twice in
      // WhatsApp's sidebar) the labels alone give the model nothing to choose BETWEEN, and it
      // resorts to guessing coordinates. An elementIndex is something it can act on directly.
      const choices = ranked.ranked.slice(0, 6)
        .map(candidate => `${candidate.element.role || 'element'} "${candidate.element.label || candidate.element.value || '?'}"`
          + (candidate.element.elementIndex != null ? ` (elementIndex ${candidate.element.elementIndex})` : '')
          + ` [score ${candidate.score}]`)
        .join(', ');
      throw new Error(`semantic query "${query}" has ${ranked.confidence} confidence (margin ${ranked.margin}): ${choices}; use the exact elementIndex/token, add a role or positional phrase, or observe with a narrower query`);
    }
    if (top.element.visualOnly) this.lastVisualGrounding = true;
    return {
      ...top.element,
      targeting: {
        query,
        confidence: ranked.confidence as 'high' | 'medium',
        margin: ranked.margin,
        label: top.element.label || top.element.value,
        role: top.element.role,
        elementIndex: top.element.elementIndex,
        elementToken: top.element.elementToken,
        reasons: top.reasons,
      },
    };
  }

  private assertClickableSemanticTarget(element: { role?: string; label?: string }): void {
    const role = String(element.role || '');
    if (STRUCTURAL_AX_ROLES.has(role)) {
      throw new Error(`"${element.label || role.replace(/^AX/, '')}" is a structural container, not a clickable control; choose a labeled button/field/row or a visible screenshot point`);
    }
    if (role === 'AXSlider') {
      throw new Error(`"${element.label || 'Slider'}" is a slider; use set_value with its fresh query/elementToken/elementIndex (1 = maximum, 0 = minimum) instead of an approximate click`);
    }
  }

  /** Innermost observed actionable control whose visible frame contains a raw screenshot point.
   * The smallest containing frame wins, so a button inside a large row resolves to the button, not
   * its container. A raw x/y click is the model's GUESS; this reveals what the pixel actually hits
   * so the summary can NAME it and (for compact controls) snap to its center. */
  private actionableElementAtScreenshotPoint(point: { x: number; y: number }): { element: ObservedElement; screenshotFrame: Frame } | null {
    const shot = this.observedTarget;
    const windowFrame = this.observedWindowFrame;
    if (!shot?.width || !shot?.height || !windowFrame) return null;
    let best: { element: ObservedElement; screenshotFrame: Frame } | null = null;
    for (const element of this.observedElements) {
      if (!ACTIONABLE_AX_ROLES.has(String(element.role || ''))) continue;
      const frame = elementFrame(element);
      if (!frame) continue;
      const screenshotFrame = globalFrameToScreenshot(
        frame,
        { width: shot.width, height: shot.height },
        windowFrame,
      );
      if (!screenshotFrame || !pointInFrame(point, screenshotFrame)) continue;
      if (!best || screenshotFrame.w * screenshotFrame.h < best.screenshotFrame.w * best.screenshotFrame.h) {
        best = { element, screenshotFrame };
      }
    }
    return best;
  }

  private normalizedControlValue(role: string, value: string): { value: string; endpoint?: 'maximum' | 'minimum' } {
    const clean = value.trim().toLocaleLowerCase();
    if (role !== 'AXSlider') return { value };
    if (/^(?:1(?:\.0+)?|100\s*%|max(?:imum)?|full)$/i.test(clean)) {
      return { value: '1', endpoint: 'maximum' };
    }
    if (/^(?:0(?:\.0+)?|0\s*%|min(?:imum)?|mute(?:d)?|off)$/i.test(clean)) {
      return { value: '0', endpoint: 'minimum' };
    }
    const numeric = Number(clean.replace(/\s*%$/, ''));
    if (!Number.isFinite(numeric)) {
      throw new Error('slider set_value needs a number from 0 to 1, a percentage from 0% to 100%, or maximum/full/minimum/mute');
    }
    const normalized = clean.endsWith('%') ? numeric / 100 : numeric;
    if (normalized < 0 || normalized > 1) throw new Error('slider set_value must be between 0 and 1 (or 0% and 100%)');
    return { value: String(normalized) };
  }

  private elementCenterInScreenshot(frame: unknown): { x: number; y: number } | null {
    const f = frame as any;
    const w = this.observedWindowFrame;
    const shot = this.observedTarget;
    if (!f || !w || !shot?.width || !shot?.height || !w.w || !w.h) return null;
    return elementCenterToScreenshot(
      { x: Number(f.x), y: Number(f.y), w: Number(f.w), h: Number(f.h) },
      { width: shot.width, height: shot.height }, w,
    );
  }

  private resolveObservedHandle(target: ComputerTarget, cmd: Pick<DesktopCommand, 'elementToken' | 'elementIndex'>) {
    if (!this.observedTarget || this.observedTarget.pid !== target.pid || this.observedTarget.windowId !== target.windowId) {
      throw new Error('element targeting needs a fresh observe of this exact window');
    }
    const key = cmd.elementToken
      ? `token:${cmd.elementToken}`
      : cmd.elementIndex != null ? `index:${Math.floor(cmd.elementIndex)}` : '';
    const resolved = key ? this.indexedElements.get(key) : undefined;
    if (resolved) {
      if (resolved.visualOnly) this.lastVisualGrounding = true;
      return resolved;
    }

    // Distinguish "YOUR handle went stale" from "this frame HAS no usable handles". Re-observing
    // fixes the first and can never fix the second. Two ways a window reaches the second state, both
    // common on Catalyst/Electron apps: the AX walk yields only structural containers (a bare
    // AXWindow), or it yields nothing at all and the observation is rebuilt from on-device Vision,
    // whose items carry a label and a rectangle but no element_index/token by construction.
    //
    // In either case "observe again and use a handle from the newest result" describes an action that
    // cannot exist, and an obedient model follows it — observe, click, fail, observe — forever.
    // Measured live: a `send hi on WhatsApp` run burned its entire turn in exactly that cycle while
    // the chat it wanted was plainly visible on screen the whole time.
    //
    // Note this counts ACTIONABLE handles, not entries. A lone AXWindow registers an index, so a
    // simple size check would call the thin tree "addressable" and reproduce the loop; and a
    // structural container is refused by assertClickableSemanticTarget anyway.
    const actionableHandles = [...this.indexedElements.values()]
      .filter(element => !STRUCTURAL_AX_ROLES.has(String(element.role || '')));
    // A truncated list must never read as a complete one. Measured 2026-08-18 in Music: the frame
    // carried 33 elements at indexes 0-32, and this refusal announced "addressable indexes in the
    // current frame: 0 ... 11" and eight labels — all of them sidebar chrome, none of the user's
    // playlists. A model that believes the refusal then confines itself to the handles it was
    // shown, so the truncation actively steers it away from the content it is looking for.
    const summarize = (values: readonly string[], limit: number): string => {
      if (values.length <= limit) return values.join(', ');
      return `${values.slice(0, limit).join(', ')}, … and ${values.length - limit} more (${values.length} total)`;
    };
    const allLabels = this.observedElements
      .map(element => element.label || element.value)
      .filter(Boolean)
      .map(String);
    const visibleLabels = summarize(allLabels, 8);
    if (actionableHandles.length === 0) {
      throw new Error('this window exposes no actionable accessibility handles — its tree is only structural or was rebuilt from on-device Vision, so element indexes and tokens do not exist for it and observing again will not create any. Target it by query="<visible label>" or by x/y read from the screenshot instead'
        + (visibleLabels ? `; visible labels include: ${visibleLabels}` : ''));
    }
    // Indexes are numeric and dense, so a range says more in less space than a truncated list —
    // and, unlike the old slice, it never implies the tail does not exist.
    const indexValues = [...this.indexedElements.keys()]
      .filter(entry => entry.startsWith('index:'))
      .map(entry => Number(entry.slice(6)))
      .filter(value => Number.isFinite(value))
      .sort((a, b) => a - b);
    const validIndexes = indexValues.length > 12
      ? `${indexValues[0]}-${indexValues[indexValues.length - 1]} (${indexValues.length} total)`
      : indexValues.join(', ');
    throw new Error(`element handle is stale or missing; observe again and use a handle from the newest result${validIndexes ? ` (addressable indexes in the current frame: ${validIndexes})` : ''}`
      + (visibleLabels ? `. Visible labels, targetable with query=: ${visibleLabels}` : ''));
  }

  /**
   * Record the frame identity for a capture that has just been stored in `observedTarget` /
   * `observedWindowFrame`. Returns null when the capture has no usable mapping geometry — a frame
   * without bounds cannot anchor a coordinate, and minting one anyway would hand out an id that
   * validates but transforms wrongly.
   */
  private mintFrame(spec: {
    captureKind: 'window' | 'display';
    target: ComputerTarget;
    bounds: Frame | null;
    image: { width?: number; height?: number };
    frameHash?: string;
  }): FrameMetadata | null {
    const { bounds, image } = spec;
    if (!bounds?.w || !bounds?.h || !image.width || !image.height) return null;
    return this.frames.mint({
      captureKind: spec.captureKind,
      pid: spec.target.pid,
      windowId: spec.target.windowId,
      app: spec.target.app,
      bounds: { ...bounds },
      image: { width: image.width, height: image.height },
      // Window screenshots reach the model at POINT resolution (see the coordinate contract at the
      // top of this file), so the mapping never multiplies by the backing scale. It is recorded as
      // descriptive metadata — whenever a `screens` read has told us what it is.
      displayScale: this.mainDisplayScale,
      frameHash: spec.frameHash,
    });
  }

  private screenshotPixelToGlobalPoint(point: { x: number; y: number }, liveFrame?: Frame | null): { x: number; y: number } | null {
    const shot = this.observedTarget;
    const frame = liveFrame || this.observedWindowFrame;
    if (!shot?.width || !shot?.height || !frame?.w || !frame?.h) return null;
    return screenshotToGlobal(point, { width: shot.width, height: shot.height }, frame);
  }

  private appNamesMatch(actual: string | undefined, expected: string | undefined): boolean {
    if (!actual || !expected) return true;
    const clean = (value: string) => value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '');
    const a = clean(actual), e = clean(expected);
    return a === e || a.includes(e) || e.includes(a);
  }

  /** Activate the owned window and prove its application became frontmost before posting physical
   * input. A click sent while a window is merely visible but not key is often consumed as an
   * activation click by macOS, which looks exactly like “cursor clicked, control did nothing”. */
  private async ensurePhysicalTargetFrontmost(target: ComputerTarget): Promise<void> {
    await this.call('bring_to_front', { pid: target.pid, window_id: target.windowId });
    for (const waitMs of [25, 50, 100]) {
      await new Promise(resolve => setTimeout(resolve, waitMs));
      const actual = await this.frontmostApp().catch(() => '');
      if (!actual || this.appNamesMatch(actual, target.app)) return;
      await this.call('bring_to_front', { pid: target.pid, window_id: target.windowId });
    }
    const actual = await this.frontmostApp().catch(() => '');
    throw new Error(`could not make ${target.app || `pid ${target.pid}`} frontmost before physical input${actual ? ` (frontmost is ${actual})` : ''}`);
  }

  /** Resolve the current live window frame after activation. The model acts on screenshot pixels;
   * mapping those pixels through the live bounds makes window moves/resizes between observe and act
   * safe without treating the separately-scaled PiP preview as a coordinate surface. */
  private async liveWindowFrame(target: ComputerTarget): Promise<Frame | null> {
    try {
      const data = await this.call('list_windows', { pid: target.pid });
      const windows = Array.isArray(data?.windows) ? data.windows : [];
      const window = windows.find((candidate: any) => Number(candidate?.window_id) === Number(target.windowId));
      const bounds = window?.bounds;
      const frame = bounds && {
        x: Number(bounds.x), y: Number(bounds.y),
        w: Number(bounds.width ?? bounds.w), h: Number(bounds.height ?? bounds.h),
      };
      if (frame && [frame.x, frame.y, frame.w, frame.h].every(Number.isFinite) && frame.w > 0 && frame.h > 0) return frame;
    } catch { /* the observed AX frame remains a safe fallback */ }
    return this.observedLiveWindowFrame || this.observedWindowFrame;
  }

  /** Capture the target's FULL display as the newest observation. Used after right-click: the
   * context menu is its own OS window, invisible in any window-scoped PNG — without this the model
   * chose its next click blind. Display pixels are mapped through real point geometry (including
   * Retina scale and non-zero secondary-display origins). */
  private async displayObservation(target: ComputerTarget, ctx?: { cwd?: string; signal?: AbortSignal }): Promise<Record<string, any>> {
    const targetWindowBounds = this.observedLiveWindowFrame || this.observedWindowFrame;
    let screens: ScreenInfo[] = [];
    try {
      const read = await this.fallback.run({ action: 'screens' }, ctx);
      screens = Array.isArray(read.screens) ? read.screens : [];
    } catch { /* primary-display fallback below */ }
    const screen = screenForRect(targetWindowBounds || undefined, screens);
    const displayIndex = screen?.index || 1;
    const shot = await this.fallback.run({ action: 'screenshot', display: displayIndex }, ctx);
    if (!shot.ok || !shot.screenshot) {
      return { visualEvidenceError: shot.error || 'full-display capture failed after opening the transient surface' };
    }
    let dims: { width: number; height: number } | null = null;
    try { dims = pngDimensionsFromBytes(fs.readFileSync(shot.screenshot)); } catch { /* handled below */ }
    if (!dims?.width || !dims?.height) return { visualEvidenceError: 'full-display capture has unreadable dimensions' };
    this.indexedElements.clear();
    this.observedElements = [];
    this.observedTarget = { pid: target.pid, windowId: target.windowId, degraded: true, width: dims.width, height: dims.height };
    // Display coordinates are a distinct transient action surface. Never retain a prior
    // window-scoped PNG as the raw-pixel freshness baseline for it.
    this.observedScreenshotFile = null;
    this.observedWindowFrame = screen?.frame
      ? { ...screen.frame }
      : { x: 0, y: 0, w: dims.width, h: dims.height };
    this.observedSurfaceKind = 'display-transient';
    const frameHash = this.screenshotHash(shot.screenshot);
    if (frameHash) this.prevFrameHash = frameHash;
    const frame = this.mintFrame({
      captureKind: 'display', target, frameHash,
      bounds: this.observedWindowFrame,
      image: { width: dims.width, height: dims.height },
    });
    return {
      app: target.app, pid: target.pid, windowId: target.windowId,
      screenshot: shot.screenshot, frameHash, frameId: frame?.frameId, width: dims.width, height: dims.height,
      displayFrontmostApp: shot.app,
      elements: [], degraded: true,
      coordinateSpace: { xY: 'screenshot_pixels', elementFrames: 'screenshot_pixels', normalized: '0-1000' },
      completionGuidance: `${COMPUTER_COMPLETION_GUIDANCE} This image is the FULL DISPLAY because a context menu/popover may be open as its own window, or the target window may be hidden/off-Space. First inspect whether the intended app or transient is actually visible. If a menu/dialog is visible, click it by x/y in THIS image or press key escape to dismiss it; if the intended app is absent, focus/open it instead of clicking unrelated pixels. Element handles from earlier window observations are no longer valid. Display ${displayIndex} geometry is applied automatically, including Retina scaling.`,
      summary: `captured full display ${displayIndex} because ${target.app || `pid ${target.pid}`} window ${target.windowId || '(unknown)'} was not a usable window-capture surface`,
    };
  }

  /** Adopt a window created after the last exact-window frame. This bridges detection that a parent
   * capture vanished with a concrete replacement surface. Candidates must be same-pid, newly
   * enumerated, and large enough to act on; ownership moves only after an exact capture succeeds. */
  private async newTransientWindowObservation(
    target: ComputerTarget, cwd: string, session: string,
  ): Promise<DesktopResult | null> {
    let windows: any[];
    try {
      const listed = await this.call('list_windows', { pid: target.pid });
      windows = Array.isArray(listed?.windows) ? listed.windows : [];
    } catch { return null; }
    // WindowServer allocates CGWindowIDs monotonically, so the surface created by the input we just
    // delivered carries a HIGHER id than every window the last observation enumerated. That ordering
    // is a real property of the id space. An earlier draft sorted on `z_index`, which `list_windows`
    // does not return (the OS stacking field this codebase actually receives is `layer`, and only
    // from the native window_at probe) — every candidate scored 0 and the sort ordered nothing.
    const newestObservedId = Math.max(0, ...this.observedWindowIds);
    const candidates = windows
      .filter((window: any) => {
        const id = Number(window?.window_id || 0);
        const width = Number(window?.bounds?.width || 0);
        const height = Number(window?.bounds?.height || 0);
        return id > 0 && id !== Number(target.windowId || 0)
          && !this.observedWindowIds.has(id)
          && width > 100 && height > 80;
      })
      .sort((a: any, b: any) => Number(b?.window_id || 0) - Number(a?.window_id || 0));
    // Windows minted after the last observation first; anything else is a pre-existing sibling that
    // merely went unseen, and is a far weaker explanation for the parent capture vanishing.
    const ordered = [
      ...candidates.filter((window: any) => Number(window?.window_id || 0) > newestObservedId),
      ...candidates.filter((window: any) => Number(window?.window_id || 0) <= newestObservedId),
    ];
    const previousWindowId = this.targets.current()?.windowId;
    // Each attempt is a full screenshot plus an AX walk. Bounded so an app with many windows cannot
    // turn one failed click into a dozen captures before the display fallback is even tried.
    for (const candidate of ordered.slice(0, TRANSIENT_ADOPTION_ATTEMPTS)) {
      const transient: ComputerTarget = { ...target, windowId: Number(candidate.window_id) };
      this.targets.retargetWindow(target.pid, transient.windowId);
      try {
        const observed = await this.observeTarget(transient, cwd, session, {
          action: 'observe', maxElements: POST_ACTION_ELEMENT_BUDGET,
        }, 1, 1);
        if (!observed.screenshot) throw new Error('new window produced no exact screenshot');
        this.syncSurface({ syncPip: false });
        await this.syncLivePipNow();
        return {
          ...observed,
          summary: `adopted new ${target.app || `pid ${target.pid}`} transient window ${transient.windowId}; ${observed.summary}`,
        };
      } catch {
        this.targets.retargetWindow(target.pid, previousWindowId);
      }
    }
    return null;
  }

  /** Attach the complete display as context while preserving the exact target window as the one
   * and only action/coordinate frame. This is a genuine two-image observation: the model can see
   * the same desktop a human sees without losing the clean, high-resolution app view required for
   * background operation. Semantic handles, frame ids and receipts remain window-scoped. */
  private async humanDisplayObservation(
    target: ComputerTarget,
    observed: DesktopResult,
    ctx?: { cwd?: string; signal?: AbortSignal },
  ): Promise<DesktopResult> {
    const targetWindowBounds = this.observedLiveWindowFrame || this.observedWindowFrame;
    if (!targetWindowBounds?.w || !targetWindowBounds?.h || !observed.screenshot) return observed;

    let screens: ScreenInfo[] = [];
    try {
      const read = await this.fallback.run({ action: 'screens' }, ctx);
      screens = Array.isArray(read.screens) ? read.screens : [];
    } catch { /* primary-display fallback below remains valid */ }
    const screen = screenForRect(targetWindowBounds || undefined, screens);
    const displayIndex = screen?.index || 1;
    let shot: DesktopResult;
    try {
      shot = await this.fallback.run({ action: 'screenshot', display: displayIndex }, ctx);
    } catch (err: any) {
      return {
        ...observed,
        details: {
          ...(observed.details as any || {}),
          perception: {
            ...((observed.details as any)?.perception || {}),
            view: { mode: 'window-fallback', visual: 'exact-window', semantics: 'exact-window', reason: String(err?.message || err).slice(0, 240) },
          },
        },
      };
    }
    if (!shot.ok || !shot.screenshot) {
      return {
        ...observed,
        details: {
          ...(observed.details as any || {}),
          perception: {
            ...((observed.details as any)?.perception || {}),
            view: { mode: 'window-fallback', visual: 'exact-window', semantics: 'exact-window', reason: shot.error || 'display capture unavailable' },
          },
        },
      };
    }
    let dims: { width: number; height: number } | null = null;
    try { dims = pngDimensionsFromBytes(fs.readFileSync(shot.screenshot)); } catch { /* handled below */ }
    const displayImage = {
      width: dims?.width || Number(shot.width || 0),
      height: dims?.height || Number(shot.height || 0),
    };
    if (!displayImage.width || !displayImage.height) return observed;
    const displayBounds: Frame = screen?.frame || { x: 0, y: 0, w: displayImage.width, h: displayImage.height };
    return {
      ...observed,
      displayScreenshot: shot.screenshot,
      displayWidth: displayImage.width,
      displayHeight: displayImage.height,
      details: {
        ...(observed.details as any || {}),
        perception: {
          ...((observed.details as any)?.perception || {}),
          view: {
            mode: 'dual-frame', actionVisual: 'exact-window', contextVisual: 'display', semantics: 'exact-window',
            display: displayIndex, displayBounds, targetWindowBounds,
            frontmostApp: shot.app,
          },
        },
      },
      completionGuidance: [
        observed.completionGuidance || COMPUTER_COMPLETION_GUIDANCE,
        `The primary image and all x/y coordinates belong only to ${target.app || `pid ${target.pid}`} window ${target.windowId}.`,
        'A second composited DISPLAY CONTEXT image shows what the human sees, including occlusion, sheets, popovers, menu bar and Dock; never use its pixels for x/y.',
      ].join(' '),
      summary: `${observed.summary}; exact target frame plus human-view display ${displayIndex} context attached`,
    };
  }

  private async preparePhysicalPoint(
    target: ComputerTarget,
    screenshotPoint: { x: number; y: number },
    expectedElement?: ObservedElement,
  ): Promise<{ x: number; y: number; preflight?: PointPreflight }> {
    if (this.observedSurfaceKind === 'display-transient') {
      // A context menu/popover is a separate OS window. Raising or re-focusing the parent would
      // dismiss the transient surface before the click, so this narrowly-scoped mode maps the
      // visible display point directly. It is never used for ordinary human-view observations.
      const global = this.screenshotPixelToGlobalPoint(screenshotPoint, this.observedWindowFrame);
      if (!global) throw new Error('could not map the display point; take a fresh screenshot');
      return global;
    }
    await this.ensurePhysicalTargetFrontmost(target);
    const liveFrame = await this.liveWindowFrame(target);
    const currentFrame = this.frames.current();
    // Translating an unchanged window is safe: screenshot-local content did not reflow, so map the
    // same local point through the new origin. Resizing is not safe because controls can re-layout.
    const baseline = this.observedLiveWindowFrame ?? currentFrame?.bounds;
    const validationBounds = liveFrame && currentFrame && baseline
      ? {
          x: currentFrame.bounds.x,
          y: currentFrame.bounds.y,
          w: currentFrame.bounds.w + (liveFrame.w - baseline.w),
          h: currentFrame.bounds.h + (liveFrame.h - baseline.h),
        }
      : liveFrame;
    const check = this.frames.check({
      pid: target.pid,
      windowId: target.windowId,
      liveBounds: validationBounds ?? undefined,
    });
    if (!check.ok) {
      throw new Error(`stale frame (${check.reason}): ${check.note}`);
    }
    // A pure translation maps through the live origin. Width/height were validated against the
    // immutable frame above, so a resize cannot silently remap an old screenshot onto a new layout.
    const frame = liveFrame ?? check.frame?.bounds ?? this.observedWindowFrame;
    const global = this.screenshotPixelToGlobalPoint(screenshotPoint, frame);
    if (!global || (frame && !pointInFrame(global, frame))) {
      throw new Error('could not map the screenshot point into the live target window; re-observe after moving or resizing the window');
    }
    if (this.transientDialogFrame && !pointInFrame(global, this.transientDialogFrame)) {
      throw new Error('a foreground dialog is blocking that background point — click Done/Close/Cancel inside the dialog or press Escape before navigating the page behind it');
    }
    const preflight = await this.ensureTargetReceivesPoint(target, global, frame, expectedElement);
    return { ...global, preflight };
  }

  /**
   * Prove the target app would actually RECEIVE a click at this point before posting one.
   *
   * A single-window capture excludes whatever covers the window, but a synthesized click goes to
   * whichever surface is topmost at that point on the real screen. When something is on top, the
   * picture and the input disagree: the model reasons about pixels from one window and the click
   * lands in another. Nothing here noticed that until now, which is what "the clicks are inaccurate
   * and the model doesn't know what it's clicking" was.
   *
   * The authority is the ACCESSIBILITY hit test, not the window stack. Measured live, the driver's
   * own click-through overlay sits at layer 0 across the whole target window, so a stack-based test
   * called every point blocked; AX resolves what would truly receive the event, so click-through
   * windows correctly fall through. Anything the probe cannot answer leaves the click alone —
   * a guard that cannot see must not veto.
   */
  /**
   * Is the target window actually on the Space the user is looking at?
   *
   * A window capture happily photographs a window parked on an inactive Space or behind a fullscreen
   * app, but a synthesized CGEvent goes to screen COORDINATES — so the model reasons about a picture
   * of one app and the click lands in whatever occupies that rectangle on the visible Space.
   * Measured live: with ChatGPT fullscreen, every click aimed at a Notes row was delivered into
   * ChatGPT, selecting its text, while the receipt reported the click as owned by Notes.
   *
   * `is_on_screen` is the right signal and was verified to mean what is needed here rather than
   * assumed: with two apps on the active Space, the BACKGROUND one still reports true (so ordinary
   * click-behind-a-window is not refused), while windows on another Space, minimized, or hidden
   * report false. Only a positive false refuses; silence leaves the click alone.
   */
  private async targetWindowOffScreen(target: ComputerTarget): Promise<boolean> {
    if (!target.pid || !target.windowId) return false;
    try {
      const data = await this.call('list_windows', { pid: target.pid });
      const windows: any[] = Array.isArray(data?.windows) ? data.windows : [];
      const window = windows.find((w: any) => Number(w?.window_id) === target.windowId);
      return window?.is_on_screen === false;
    } catch { return false; }
  }

  private async ensureTargetReceivesPoint(
    target: ComputerTarget, point: { x: number; y: number }, frame: Frame | null,
    expectedElement?: ObservedElement,
  ): Promise<PointPreflight> {
    if (await this.targetWindowOffScreen(target)) {
      throw new Error(
        `${target.app || `pid ${target.pid}`} window ${target.windowId} is not on the active Space — it is behind a fullscreen app, minimized, or on another desktop. `
        + 'The screenshot still shows it because a window capture ignores Spaces, but a physical click goes to screen coordinates and would land in whatever app is actually visible there. '
        + `Call focus with app="${target.app || ''}" to bring it to the visible Space, observe again, then retry. `
        + 'To act WITHOUT bringing it forward, use deliveryMode="background" with a NAMED target (query/elementToken/elementIndex) so the input routes through accessibility — background delivery aimed at a bare x/y still has to synthesize a real cursor event and is refused here for the same reason.',
      );
    }
    const recipientAt = async (): Promise<{ pid: number; name: string; windowId: number; topName: string; chain: NativeElementReceipt[] } | null> => {
      try {
        const probe = await this.fallback.run({ action: 'window_at', x: point.x, y: point.y });
        const hit = probe.ok ? probe.windowAt : undefined;
        if (!hit || !Number(hit.owner_pid)) return null;
        return {
          pid: Number(hit.owner_pid), name: String(hit.owner_name || ''),
          windowId: Number(hit.window_id || hit.top_window_id || 0),
          topName: String(hit.top_owner_name || ''),
          chain: Array.isArray(hit.element_chain) ? hit.element_chain : [],
        };
      } catch { return null; }
    };
    let who = await recipientAt();
    const validateElement = async (recipient: NonNullable<typeof who>): Promise<PointPreflight> => {
      // AX proves the receiving PROCESS. When the top stack entry belongs to that same target app,
      // CGWindow also gives us the exact native window. This is the missing multi-window check:
      // Notes/WhatsApp/TextEdit can have two overlapping windows in one pid, and a pid-only receipt
      // incorrectly called a click on the wrong document successful.
      const stackNamesTarget = !!recipient.topName && this.appNamesMatch(recipient.topName, target.app);
      const exactWindowKnown = stackNamesTarget && !!recipient.windowId && !!target.windowId;
      if (exactWindowKnown && recipient.windowId !== target.windowId) {
        throw new Error(`window preflight refused the click: the live point is in ${target.app} window ${recipient.windowId}, but the observed/PiP target is window ${target.windowId}. Focus or observe the intended window again.`);
      }
      if (!expectedElement || !recipient.chain.length) {
        return {
          recipientPid: recipient.pid, recipientApp: recipient.name,
          recipientWindowId: recipient.windowId || undefined,
          windowMatched: exactWindowKnown ? recipient.windowId === target.windowId : undefined,
        };
      }
      const observedFrame = elementFrame(expectedElement);
      const translatedFrame = observedFrame && frame && this.observedWindowFrame
        ? {
            x: observedFrame.x + frame.x - this.observedWindowFrame.x,
            y: observedFrame.y + frame.y - this.observedWindowFrame.y,
            w: observedFrame.w, h: observedFrame.h,
          }
        : observedFrame;
      const first = matchHitElement(expectedElement, recipient.chain, translatedFrame);
      if (!first.matched) {
        const actual = recipient.chain[0];
        throw new Error(`element preflight refused the click: expected ${expectedElement.role || 'element'} "${expectedElement.label || expectedElement.value || '?'}", but the live point resolves to ${actual?.role || 'unknown'} "${actual?.title || actual?.description || '?'}" (${first.reason}). Re-observe before acting.`);
      }
      // A second cheap hit test catches controls moving under an animation/layout transition. When
      // the helper cannot answer twice, retain the first proven identity but mark stability unknown.
      await new Promise(resolve => setTimeout(resolve, 20));
      const secondRecipient = await recipientAt();
      if (secondRecipient?.pid && secondRecipient.pid !== target.pid) {
        throw new Error(`${secondRecipient.name || `pid ${secondRecipient.pid}`} moved over the target during click preflight; re-observe after the interface settles`);
      }
      if (secondRecipient?.chain?.length) {
        const second = matchHitElement(expectedElement, secondRecipient.chain, translatedFrame);
        if (!second.matched || sameNativeElement(first.recipient, second.recipient) === false) {
          throw new Error('the target element moved or changed during the 20ms preflight stability check; wait for the interface to settle and re-observe');
        }
        return {
          recipientPid: recipient.pid, recipientApp: recipient.name,
          recipientWindowId: recipient.windowId || undefined,
          windowMatched: exactWindowKnown ? recipient.windowId === target.windowId : undefined,
          elementMatch: second, stable: true,
        };
      }
      return {
        recipientPid: recipient.pid, recipientApp: recipient.name,
        recipientWindowId: recipient.windowId || undefined,
        windowMatched: exactWindowKnown ? recipient.windowId === target.windowId : undefined,
        elementMatch: first,
      };
    };
    if (!who) return {};
    if (who.pid === target.pid) return validateElement(who);

    // Our own Live Preview is a floating panel: raising the target can never get above it (Apple
    // documents floating windows as staying above kAXRaiseAction), so ask the panel to step aside.
    if (this.livePip.pid?.() === who.pid && frame) {
      this.livePip.avoid?.(frame);
      await new Promise(resolve => setTimeout(resolve, 250));
      who = await recipientAt();
      if (!who) return {};
      if (who.pid === target.pid) return validateElement(who);
    }

    // Some other window is over the point. Raise the target WINDOW (not merely its app) and re-test.
    if (frame) {
      try { await this.fallback.run({ action: 'window_raise', pid: target.pid, bounds: frame }); }
      catch { /* the re-test below is the real check */ }
      await new Promise(resolve => setTimeout(resolve, 200));
      who = await recipientAt();
      if (!who) return {};
      if (who.pid === target.pid) return validateElement(who);
    }

    throw new OccludedPointError(
      `${who.name || `pid ${who.pid}`} is on top of (${point.x},${point.y}), so the click would land there `
      + `instead of in ${target.app || `pid ${target.pid}`}. The screenshot does not show it, because a window capture `
      + `excludes whatever covers the window. Move or close that window (or use arrange to place them side by side), then re-observe.`,
      { pid: who.pid, name: who.name },
    );
  }

  /**
   * Activate a semantically resolved element through Accessibility because the physical point is
   * covered by another window.
   *
   * The pixel route and the element identity fail independently: an overlay blocks the former and
   * leaves the latter untouched. Refusing the whole click in that situation strands a target the OS
   * can still activate, which is what made an occluded control permanently unreachable.
   *
   * This mechanism is genuinely weaker than a real CGEvent — measured, native AX activation reports a
   * no-op in some apps — so it is never trusted on the driver's return alone. The post-action frame
   * must actually differ; when it does not, the original occlusion refusal is raised WITH the fact
   * that activation changed nothing. An honest failure, never a false success.
   */
  private async clickThroughAccessibility(input: {
    target: ComputerTarget;
    cwd: string;
    session: string;
    driver: string;
    cmd: DesktopCommand;
    args: Record<string, unknown>;
    handle: { element_token: string } | { element_index: number };
    occlusion: OccludedPointError;
    resolvedLabel: string;
    targeting: DesktopResult['targeting'];
    expectedElement?: ObservedElement;
  }): Promise<DesktopResult> {
    const { target, cwd, session, driver, cmd, args, handle, occlusion } = input;
    const { resolvedLabel, targeting, expectedElement } = input;
    const named = resolvedLabel || cmd.query || 'the target';
    const occluder = occlusion.occluder.name
      || (occlusion.occluder.pid ? `pid ${occlusion.occluder.pid}` : 'another window');
    const failed = (why: string) => new Error(`${occlusion.message} Accessibility activation of `
      + `"${named}" was attempted instead and ${why}`);

    const axArgs: Record<string, unknown> = { ...args, ...handle };
    delete axArgs.x;
    delete axArgs.y;
    const data = await this.call('click', axArgs);
    if (data?.ok === false) {
      throw failed(`failed: ${data.error || data.summary || 'no reason reported'}`);
    }
    const evidence = await this.postActionEvidence(target, cwd, session);
    this.synthesizeStatefulClickPostcondition(expectedElement, evidence);
    if (evidence.progressCheck && !evidence.progressCheck.frameChanged) {
      throw failed('changed nothing on screen, so the click did not happen. Move or close the '
        + 'covering window, then click the visible control.');
    }
    this.lastMechanismChoice = 'accessibility';
    return {
      ok: true, action: cmd.action, driver, app: target.app, pid: target.pid, windowId: target.windowId,
      details: { path: 'accessibility-activation', occludedBy: occlusion.occluder, result: data },
      actionReceipt: {
        kind: 'pointer',
        target: {
          app: target.app, pid: target.pid, windowId: target.windowId,
          element: expectedElement?.label || expectedElement?.value, role: expectedElement?.role,
        },
        preflight: {
          recipientPid: occlusion.occluder.pid,
          recipientApp: occlusion.occluder.name,
          // The physical point demonstrably belonged to someone else. Recording that honestly is the
          // point of the receipt; what changed is that delivery no longer depended on the point.
          windowMatched: false,
          reason: `physical point was covered by ${occluder}, so the named element was activated through accessibility instead`,
        },
        commit: { delivered: true, recipientApp: target.app },
        ...(evidence.actionResult?.postcondition ? { postcondition: evidence.actionResult.postcondition } : {}),
      },
      targeting,
      ...evidence,
      summary: `${occluder} covers that point, so "${named}" was activated through accessibility instead `
        + `of the physical cursor — no pointer moved, and the screen changed. Confirm the intended result `
        + `in the attached frame before calling the task done.`,
    };
  }

  private verifyPhysicalClick(target: ComputerTarget, requested: { x: number; y: number }, result: DesktopResult): void {
    if (result.x != null && result.y != null && Math.hypot(result.x - requested.x, result.y - requested.y) > 3) {
      throw new Error(`native cursor did not land at the requested point (${requested.x},${requested.y}); it reported ${result.x},${result.y}`);
    }
    if (result.app && !this.appNamesMatch(result.app, target.app)) {
      throw new Error(`physical click landed while ${result.app} was frontmost, not ${target.app || `pid ${target.pid}`}`);
    }
  }

  /**
   * Which application actually received the click. Answers the model's real question — "what did I
   * just click?" — with the OS's answer rather than "an event was delivered", which was true even
   * when a floating panel swallowed it.
   */
  private async clickRecipient(point: { x: number; y: number }): Promise<string> {
    try {
      const probe = await this.fallback.run({ action: 'window_at', x: point.x, y: point.y });
      return probe.ok && probe.windowAt ? String(probe.windowAt.owner_name || '') : '';
    } catch { return ''; }
  }

  /** Resolve a point in the exact latest screenshot. The final screenshot→global mapping happens
   * only after activation, through the live window frame, so a move/resize cannot offset input. */
  private groundScreenshotPoint(target: ComputerTarget, cmd: Pick<DesktopCommand, 'x' | 'y' | 'normalized'>, verb: string): { x: number; y: number } {
    if (cmd.x == null || cmd.y == null) throw new Error(`${verb} needs x and y`);
    if (!this.observedTarget || this.observedTarget.pid !== target.pid || this.observedTarget.windowId !== target.windowId) {
      throw new Error(`${verb} needs a fresh image of this exact window; observe once, then act on the visible point`);
    }
    const width = this.observedTarget.width, height = this.observedTarget.height;
    if (!width || !height) throw new Error('latest screenshot has no usable dimensions');
    const x = cmd.normalized ? normalizedToPixel(cmd.x, width - 1) : Math.round(cmd.x);
    const y = cmd.normalized ? normalizedToPixel(cmd.y, height - 1) : Math.round(cmd.y);
    if (x < 0 || y < 0 || x >= width || y >= height) throw new Error(`${verb} point ${x},${y} is outside the latest image (${width}x${height})`);
    return { x, y };
  }

  /** hover/hold/mouse_down/mouse_up: physical-cursor primitives delivered by the native helper after
   * bringing the target window to front. These ARE the real cursor, so they only run foreground. */
  private async pointerPrimitive(
    primitive: 'hover' | 'hold' | 'mouse_down' | 'mouse_up', target: ComputerTarget, cmd: DesktopCommand,
    cwd: string, session: string, ctx?: { cwd?: string; signal?: AbortSignal },
  ): Promise<DesktopResult> {
    const driver = BIMAX_DRIVER_LABEL;
    const screenshotPoint = this.groundScreenshotPoint(target, cmd, primitive);
    const global = await this.preparePhysicalPoint(target, screenshotPoint);
    const button = heldButtonFor(cmd.button);
    // Account for a possibly-posted down BEFORE awaiting the helper. A timeout/error can happen
    // after CGEvent posts the down event; recording only after a successful return left that button
    // physically held with no cleanup record. hold is tracked too because it performs down+up inside
    // one helper call and can fail between those two events.
    if (primitive === 'mouse_down' || primitive === 'hold') {
      this.input.noteButtonDown(button, global.x, global.y);
    }
    let native: DesktopResult;
    try {
      native = await this.fallback.run({ action: primitive, x: global.x, y: global.y, button: cmd.button, ms: cmd.ms, app: target.app, normalized: false }, ctx);
      if (!native.ok) throw new Error(native.error || native.summary);
    } catch (err: any) {
      if (primitive === 'mouse_down' || primitive === 'hold') {
        const released = await this.fallback.run({ action: 'mouse_up', x: global.x, y: global.y, button: cmd.button, app: target.app, normalized: false }, ctx)
          .catch((releaseErr: any) => ({ ok: false, error: String(releaseErr?.message || releaseErr) } as DesktopResult));
        if (released.ok) this.input.noteButtonUp(button);
        else {
          throw new Error(
            `${String(err?.message || err)}; emergency ${button} mouse-up also failed: ${released.error || released.summary}`,
            { cause: err },
          );
        }
      }
      throw err;
    }
    // Held-button bookkeeping. `mouse_down` leaves a physical button down across calls, and a turn
    // that is aborted in that gap would otherwise leave the desktop wedged for the human. Recording
    // it here is what lets dispose/takeover compute the exact compensating mouse-up.
    if (primitive === 'hold' || primitive === 'mouse_up') this.input.noteButtonUp(button);
    // A bare mouse_down leaves the button physically held; do NOT capture a settling screenshot that
    // could itself move focus. hover/hold/mouse_up have completed a gesture, so fresh evidence is safe.
    // mouse_down leaves the button held and skips a settling screenshot, so it never reaches
    // postActionEvidence — record it here so a held-button state still lands in the durable history.
    if (primitive === 'mouse_down') this.recordAction('mouse_down', target.app, 'unverified');
    const evidence = primitive === 'mouse_down' ? {} : await this.postActionEvidence(target, cwd, session);
    return {
      ok: true, action: cmd.action, driver, app: target.app, pid: target.pid, windowId: target.windowId,
      details: { path: 'native-global-cgevent', primitive, at: global }, ...evidence,
      summary: `visible native ${primitive.replace('_', '-')} delivered to ${target.app || `pid ${target.pid}`}${primitive === 'mouse_down' ? ' (button held — issue mouse_up to release)' : '; fresh screen attached'}`,
    };
  }

  /** Delegates to the extracted TargetOwnership (target.ts) — the one authority on the recipient. */
  private targetFor(cmd: DesktopCommand): ComputerTarget | null {
    return this.targets.resolveFor(cmd);
  }

  /**
   * Re-establish ownership of the window this runtime drove before the last turn boundary.
   *
   * dispose() deliberately drops target ownership after every user turn so a stale identity cannot
   * silently receive input. But the app it was driving is still on screen, and a follow-up request
   * ("now reply to her") continues the same workflow — so dropping the identity outright stranded
   * the model with no legal move: observe needs a target, input needs a frame only observe can
   * produce, and `open` looks wrong for an app that is demonstrably already open.
   *
   * Re-acquire only when the remembered process is STILL ALIVE and still has a real window: a
   * quit-and-relaunched app gets a new pid, and re-adopting a dead one would aim input at whatever
   * inherited it. Returns null when the app is gone, leaving the caller's honest error intact.
   */
  private async reacquireLastTarget(): Promise<ComputerTarget | null> {
    const remembered = this.lastOwnedTarget;
    if (!remembered?.pid) return null;
    const refreshed = await this.refreshTargetWindow({ ...remembered, windowId: undefined });
    if (!refreshed.windowId) return null;
    this.targets.set(refreshed);
    this.lastOwnedTarget = refreshed;
    cliEvents.emit('status', `re-acquired ${refreshed.app || `pid ${refreshed.pid}`} window ${refreshed.windowId} from the previous turn`);
    return refreshed;
  }

  private screenshotPath(cwd: string): string {
    const dir = this.persistenceSessionId
      ? path.join(this.sessionStorageDir(cwd), 'frames')
      : this.sessionStorageDir(cwd);
    fs.mkdirSync(dir, { recursive: true });
    sweepShots(dir);
    return path.join(dir, `window-${Date.now()}.png`);
  }

  private screenshotHash(file: string): string | undefined {
    try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16); }
    catch { return undefined; }
  }

  /** Raw pixels are the one targeting mode that cannot follow a control when the UI changes while
   * the model is thinking. Re-capture pixels only (one AX node, no model-visible state mutation).
   * A changed whole-window digest is narrowed to the intended click patch so unrelated animation
   * cannot permanently starve a stable target; inability to prove that patch stable still refuses.
   * Semantic handles skip this cost, preserving the fast path and giving the model a concrete
   * reason to prefer them. */
  /**
   * The screenshot-pixel rectangle to compare across frames when deciding whether the control under
   * a raw x/y click actually moved.
   *
   * Prefer the real bounds of the control the point lands on: that is exact, needs no constant, and
   * is precisely the region whose stability the caller cares about. Only when no AX control claims
   * the point does this fall back to a square around it — sized in LOGICAL POINTS and converted
   * through the capture's own scale factor, because a fixed pixel radius means two different physical
   * areas on Retina and non-Retina displays (48px is a sub-button patch on one and a multi-control
   * patch on the other, silently changing how often the guard refuses).
   */
  private rawTargetPatch(point: { x: number; y: number }, image: Frame | { width: number; height: number }): Frame {
    const width = (image as any).width as number;
    const height = (image as any).height as number;
    const control = this.actionableElementAtScreenshotPoint(point)?.screenshotFrame;
    const windowFrame = this.observedWindowFrame;
    const scale = windowFrame?.w && width ? Math.max(1, width / windowFrame.w) : 1;
    const box = control ?? (() => {
      const radius = Math.round(RAW_TARGET_PATCH_POINTS * scale);
      return { x: point.x - radius, y: point.y - radius, w: radius * 2, h: radius * 2 };
    })();
    const x = Math.max(0, Math.min(Math.round(box.x), width - 1));
    const y = Math.max(0, Math.min(Math.round(box.y), height - 1));
    return { x, y, w: Math.max(0, Math.min(Math.round(box.w), width - x)), h: Math.max(0, Math.min(Math.round(box.h), height - y)) };
  }

  private async assertRawPixelFrameCurrent(
    target: ComputerTarget, cwd: string, session: string, point: { x: number; y: number },
  ): Promise<void> {
    const frame = this.frames.current();
    if (!frame?.frameHash || frame.captureKind !== 'window' || !target.windowId) return;
    const screenshot = this.screenshotPath(cwd);
    const data = await this.call('get_window_state', {
      pid: target.pid,
      window_id: target.windowId,
      session,
      include_screenshot: true,
      screenshot_out_file: screenshot,
      max_elements: 1,
    });
    const file = String(data?.screenshot_file_path || screenshot);
    const currentHash = this.screenshotHash(file);
    if (!currentHash) {
      throw new Error('could not verify that the raw screenshot point is still current — observe again or use a semantic element handle');
    }
    if (currentHash !== frame.frameHash) {
      // A whole-window digest is deliberately the first, cheapest test, but a blinking caret,
      // clock, progress indicator, video or incoming-message badge can change distant pixels while
      // the intended button stays perfectly stable. Compare a bounded patch around the ACTUAL click
      // in the old and current images before invalidating the entire frame. This retains fail-closed
      // behaviour when local sampling is unavailable or the target region itself changed.
      let localTargetStable = false;
      const previousFile = this.observedScreenshotFile;
      const image = frame.image;
      if (previousFile && fs.existsSync(previousFile) && image.width > 0 && image.height > 0) {
        const region = { id: 'raw-target', ...this.rawTargetPatch(point, image) };
        if (region.w > 0 && region.h > 0) {
          try {
            const [beforeSample, afterSample] = await Promise.all([
              this.fallback.run({ action: 'visual_signatures', imagePath: previousFile, regions: [region] }),
              this.fallback.run({ action: 'visual_signatures', imagePath: file, regions: [region] }),
            ]);
            const before = parseVisualFingerprint(beforeSample.visualSignatures?.[0] || {});
            const after = parseVisualFingerprint(afterSample.visualSignatures?.[0] || {});
            if (before && after) {
              const delta = diffVisualFingerprints(before, after, 0.02);
              localTargetStable = !delta.changed && !delta.dominantChanged
                && Math.abs(after.entropy - before.entropy) < 0.08;
            }
          } catch { /* no local proof means fail closed below */ }
        }
      }
      if (localTargetStable) return;
      this.frames.invalidate();
      this.observedTarget = null;
      this.observedScreenshotFile = null;
      this.observedWindowIds.clear();
      this.observedWindowFrame = null;
      this.observedLiveWindowFrame = null;
      this.indexedElements.clear();
      this.observedElements = [];
      throw new Error('the window pixels changed after the screenshot was shown, so this raw click was refused before delivery — observe again and re-pick the visible target');
    }
  }

  /** One capture path for explicit observes and automatic post-action evidence. Keeping the AX
   * cache and the PNG from the same native call prevents coordinates from being applied to a
   * different frame than the one the model saw. */
  private async observeTarget(
    target: ComputerTarget,
    cwd: string,
    session: string,
    cmd: Pick<DesktopCommand, 'action' | 'query' | 'maxElements' | 'includeScreenshot' | 'focusIfBackground'>,
    windowReconcileAttempt = 0,
    windowAcquireAttempt = 0,
    focusAttempt = 0,
  ): Promise<DesktopResult> {
    if (!target.windowId) throw new Error('observe needs pid + windowId; open or select an application window first');
    phaseTrace.sync('watch_accessibility', () => this.watchTargetAccessibility(target));
    const screenshot = this.screenshotPath(cwd);
    const maxElements = Math.max(1, Math.min(2000, Math.floor(cmd.maxElements ?? 60)));
    // macOS exposes the application menu tree alongside the window. Traverse deeply, then remove
    // menu boilerplate and apply the small model-visible budget below.
    // Most actionable controls appear in the first few hundred AX nodes. A 1000-node traversal on
    // every automatic post-action frame made each visible click feel sluggish. Perception therefore
    // starts with a cheap pass and deepens only when an explicit query was not found or the tree was
    // genuinely swallowed by menu/shell nodes.
    // The scan cap is the single biggest cost in an observe, so it is sized from MEASUREMENT.
    // Benchmarked on this machine against the 0.12.3 driver (Notes, screenshot off):
    //   cap   50 →   22ms      cap  400 → 1491ms
    //   cap  100 →   56ms      cap  800 → 3013ms
    //   cap  200 →  585ms      cap 2000 → 6125ms
    // ~3.7ms per node, linear — NOT the "~0.2s even at 2000" this code previously assumed. A flat
    // +500 "menu allowance" was added on that wrong estimate and made every observe walk 800 nodes,
    // so each one cost ~3s: the sluggishness the smaller floors below were introduced to remove.
    // The same measurement shows the premise was also wrong — the driver returned ZERO menu-role
    // nodes at every cap from 50 to 800, so the allowance bought nothing at all.
    //
    // The menu-first walk it guarded against is real for some apps, but it is already handled far
    // more cheaply by the escalation below: if the walk hit its cap without yielding a single
    // window element, rescan once at the ceiling. That pays 6s only for the apps that need it,
    // instead of 3s for every observe of every app.
    const DRIVER_MAX_SCAN = 2000;
    // Chromium apps publish a placeholder tree until asked; do it before the scan, not after, or
    // this observation is the thin one and the model acts on it.
    await phaseTrace.time('ax_enable', () => this.enableRichAccessibility(target.pid));
    const firstScan = Math.min(DRIVER_MAX_SCAN, cmd.query
      ? Math.max(180, maxElements)
      : Math.max(120, maxElements));
    // The driver's own `query` parameter is deliberately NOT forwarded. It does not widen or narrow
    // the element walk — measured at caps 180 and 600 in Notes, the returned `element_index` set is
    // identical with and without it — but it replaces `tree_markdown` with just the matched node's
    // ancestry: 367 lines became 8. That tree is the only place AXStaticText leaves appear, and
    // folding them onto their container is what gives an anonymous list row its name, so forwarding
    // the query destroyed every name EXCEPT the one being searched for.
    //
    // The cost fell on the frame the model plans its NEXT action from. `postActionEvidence` re-
    // observes with the active expectation as its query, so after any action carrying `expect` the
    // whole element map came back as bare `ICMNoteListCell` — 46 indistinguishable rows — and the
    // following click by name resolved to the OCR twin or refused as ambiguous. Nothing here needs
    // the driver to do the matching: `verification`, the match ordering below and the semantic
    // resolver all run locally over the elements this walk returns.
    const requestWindowState = (cap: number) => this.call('get_window_state', {
      pid: target.pid,
      window_id: target.windowId,
      session,
      include_screenshot: cmd.includeScreenshot !== false,
      screenshot_out_file: screenshot,
      max_elements: cap,
    });
    // An OPEN menu is part of the window's surface; the app's static menu BAR is not.
    //
    // Every menu role used to be dropped here, which made right-click context menus invisible to the
    // model — the one thing a right-click exists to produce. Measured live in Finder on 2026-08-06,
    // both halves of that:
    //
    //   * the menu is NOT a separate window. list_windows returned 55 windows before the right-click
    //     and the same 55 after, no new entry. It arrives inside the owned window's own element list
    //     (`AXWindow > AXList("icon view") > AXMenu`), which this observation already fetches.
    //   * dropping every menu role was the only reason it was unusable. The raw payload carried the
    //     real thing: AXMenu at 269x509+587+125 with AXMenuItem children labelled Open, Open With,
    //     Always Open With — frames and names, ready to click.
    //
    // The blanket filter still had a real job, so it is narrowed rather than removed: the same
    // payload carries Finder's whole menu bar, 380 nodes against the window's 28 rows, and surfacing
    // that would bury the window's actual controls.
    //
    // The separator is layout state, and it is exact. macOS lays a menu out only while it is open,
    // so a frame IS the proof it is on screen: with nothing open 321 of 330 menu nodes had no frame
    // at all, with the context menu open 33 gained one, and after Escape it fell back to 9. The nine
    // that always have one are the menu bar and its top-level titles, filtered by role below.
    //
    // Stating it as "laid out" rather than "is a context menu" is what makes it universal. A menu-bar
    // menu the user pulls down is also laid out only while open, so File > Save As surfaces through
    // this same test with no rule of its own — and when no menu is open anywhere, nothing survives
    // and every observation is byte-for-byte what it was before.
    const menuChromeRoles = new Set(['AXMenuBar', 'AXMenuBarItem']);
    const openableMenuRoles = new Set(['AXMenu', 'AXMenuItem']);
    const keepsMenuElement = (element: any): boolean => {
      const role = String(element?.role || '');
      if (menuChromeRoles.has(role)) return false;
      if (!openableMenuRoles.has(role)) return true;
      if (!elementFrame(element)) return false;
      // A separator is an AXMenuItem with no name of any kind. It activates nothing, so offering it
      // would cost a turn to discover that — and describeUnlabeledControls would otherwise hand it a
      // positional placeholder that reads exactly like a real command.
      return role !== 'AXMenuItem' || ELEMENT_TEXT_KEYS.some(key => String(element?.[key] || '').trim());
    };
    // Describe the blanks only AFTER the generic-label pass, so a control that enrichControlLabels
    // could name from its row keeps that real name instead of a positional placeholder.
    // Fold the tree's text onto its containers FIRST. The driver's `elements` omit AXStaticText
    // leaves entirely — they are not addressable — so a list row arrives anonymous or carrying its
    // AX identifier, and both later passes would then paper over it: enrichControlLabels only
    // rewrites labels it considers generic, and describeUnlabeledControls would replace a real name
    // it never saw with a positional placeholder. Naming from the tree first means those passes only
    // handle what genuinely has no text anywhere.
    const windowElementsOf = (raw: any[], tree: string) => describeUnlabeledControls(enrichControlLabels(
      foldTreeTextIntoElements(raw, tree).filter(keepsMenuElement),
    ));
    const scanCaps: number[] = [];
    const requestMeasured = async (cap: number) => {
      scanCaps.push(cap);
      return phaseTrace.time(`driver:get_window_state(cap=${cap})`, () => requestWindowState(cap));
    };
    const rawContainsQuery = (elements: any[]): boolean => {
      const needle = String(cmd.query || '').trim().toLocaleLowerCase();
      return !!needle && elements.some(element => JSON.stringify(element).toLocaleLowerCase().includes(needle));
    };
    let scanElements = firstScan;
    let data = await requestMeasured(scanElements);
    let rawElements: any[] = phaseTrace.sync('sanitize_elements', () => withoutWindowChrome(sanitizeDriverElements(Array.isArray(data?.elements) ? data.elements : [])));
    let windowElements = phaseTrace.sync('enrich_labels', () => windowElementsOf(rawElements, String(data?.tree_markdown || '')));
    // A retry at a DELIBERATELY NARROWER cap used to sit here, on the theory that a wider element
    // walk truncates the tree and deletes the names it was widening to find. That theory was wrong,
    // and the measurement that replaced it is worth keeping: tree coverage grows monotonically with
    // the cap. Named rows in Notes went 9 (cap 80), 16 (120), 25 (180), 35 (260), 52 (400), 77 (600),
    // 127 (1000) — never a collapse. The collapse the retry was chasing came entirely from
    // forwarding `query` to the driver, which is fixed at the request above, so scanning narrower
    // buys strictly less evidence for an extra round trip and the retry is gone.
    //
    // A named target instead gets a progressive search. Common controls resolve in the cheap pass; a target
    // below the fold/tree boundary pays for 600 and then 2000 nodes only when the prior pass was
    // actually truncated. maxElements=2000 is also the explicit exhaustive/absence-proof path.
    if (cmd.query && !rawContainsQuery(windowElements) && scanElements < DRIVER_MAX_SCAN && rawElements.length >= scanElements) {
      const nextCaps = maxElements >= DRIVER_MAX_SCAN ? [DRIVER_MAX_SCAN] : [600, DRIVER_MAX_SCAN];
      for (const cap of nextCaps) {
        if (cap <= scanElements) continue;
        scanElements = cap;
        data = await requestMeasured(scanElements);
        rawElements = withoutWindowChrome(sanitizeDriverElements(Array.isArray(data?.elements) ? data.elements : []));
        windowElements = windowElementsOf(rawElements, String(data?.tree_markdown || ''));
        if (rawContainsQuery(windowElements) || rawElements.length < scanElements) break;
      }
    }
    // An unusually large menu tree can still swallow the whole budget. When the walk hit the cap
    // without yielding a single window element, rescan once at the driver's ceiling before
    // declaring the window degraded.
    if (windowElements.length === 0 && rawElements.length >= scanElements && scanElements < DRIVER_MAX_SCAN) {
      data = await requestMeasured(DRIVER_MAX_SCAN);
      rawElements = withoutWindowChrome(sanitizeDriverElements(Array.isArray(data?.elements) ? data.elements : []));
      windowElements = windowElementsOf(rawElements, String(data?.tree_markdown || ''));
    }
    // A walk that yields not one window element has not observed the window — it has observed the
    // application's menu bar. That is a FAILED WINDOW ACQUISITION, not a thin tree: the window this
    // observation is scoped to may have been closed, replaced by a new one, or never became real.
    // Measured live, this produced an "observation" of 255 elements that were 100% menu items, with
    // no window content and no frame to mint, handed back as a successful observe.
    //
    // Re-derive the application's current top window once and observe that instead. Ownership
    // (pid/app) is untouched — only the window component is re-derived, exactly as the Cmd+N and
    // zero-pixel recoveries already do. Bounded to one attempt so a genuinely AX-silent window
    // still returns a screenshot-only observation rather than looping.
    if (windowElements.length === 0 && windowAcquireAttempt === 0) {
      try {
        const reacquired = await this.refreshTargetWindow({ ...target, windowId: undefined });
        if (reacquired.windowId && reacquired.windowId !== target.windowId) {
          target.windowId = reacquired.windowId;
          this.targets.retargetWindow(target.pid, reacquired.windowId);
          return this.observeTarget(target, cwd, session, cmd, windowReconcileAttempt, 1);
        }
      } catch { /* fall through to the honest degraded observation below */ }
    }
    // A menu-only walk is usually not an AX-silent window — it is a BACKGROUND app. Measured
    // 2026-07-31 against driver 0.12.3, one window, one cap, nothing else varied:
    //   Terminal in background → 355 elements, 355 of them menu roles, 0 window elements
    //   Terminal frontmost     → 365 elements, 9 window elements including its AXWindow
    // windowElementsOf strips the menu roles, so the background read lands here with zero and the
    // observation is rebuilt from OCR. That is how a healthy window returns a vision-only frame with
    // no handles, and why the degraded summary's "observing again will not produce handles for this
    // window" was actively false — observing again AFTER a focus does produce them.
    //
    // Neither escalation above can reach this: the walk was not truncated (355 < cap), so the
    // ceiling rescan is skipped, and the window id is perfectly valid, so re-acquisition is a no-op.
    //
    // Focus is a visible side effect, so only observations made ON BEHALF OF AN ACTION take it
    // (post-action evidence, semantic re-grounding) — those are already driving this app and cannot
    // use a menu-only frame for anything. A user-issued observe never steals focus; it reports the
    // cause instead, via the summary and guidance below.
    let backgroundAppBlockedWalk = '';
    if (windowElements.length === 0 && target.app) {
      backgroundAppBlockedWalk = await this.frontmostMismatch(target.app);
      if (backgroundAppBlockedWalk && cmd.focusIfBackground && focusAttempt === 0) {
        try {
          try { await this.call('bring_to_front', { pid: target.pid, window_id: target.windowId }); }
          catch { await this.fallback.run({ action: 'open', app: target.app }); }
          await waitUntil(async () => !(await this.frontmostMismatch(target.app!)), { timeoutMs: 900, intervalMs: 40 });
          return this.observeTarget(target, cwd, session, cmd, windowReconcileAttempt, windowAcquireAttempt, 1);
        } catch { /* fall through and report the cause rather than pretending the tree is silent */ }
      }
    }
    const screenshotFile = String(data?.screenshot_file_path || screenshot);
    let pngDimensions: { width: number; height: number } | null = null;
    if (cmd.includeScreenshot !== false) {
      try { pngDimensions = pngDimensionsFromBytes(fs.readFileSync(screenshotFile)); }
      catch { /* the visual-evidence checks below surface an absent screenshot */ }
    }
    const screenshotWidth = pngDimensions?.width || Number(data?.screenshot_width || 0) || undefined;
    const screenshotHeight = pngDimensions?.height || Number(data?.screenshot_height || 0) || undefined;
    if (cmd.includeScreenshot !== false && (!screenshotWidth || !screenshotHeight)) {
      const nativeFrontmost = await this.fallback.frontmostApp().catch(() => '');
      if (/loginwindow/i.test(nativeFrontmost)) {
        throw new Error('the Mac screen is locked (loginwindow is frontmost), so no window screenshot or mouse action can be verified — unlock the Mac and retry');
      }
      // Do NOT assert a permission problem we have not established. This message used to name
      // Screen Recording as the cause outright, so on a minimized/other-Space window the model
      // relayed "please enable Screen Recording" to a user who already had it granted — a false
      // diagnosis that ended the task. A window that is hidden, minimized, or on another Space
      // captures empty for reasons that have nothing to do with TCC, and macOS strips AX detail
      // there too. Name what we actually know, and only raise permissions when it is still plausible.
      const permissionKnownGood = this.lastStatus.screenRecording === true;
      throw new Error(`the sidecar returned no usable pixels for ${target.app || `pid ${target.pid}`} window ${target.windowId}`
        + ' — the window is most likely minimized, hidden, or on another macOS Space (all of which also strip its accessibility detail).'
        + ` Bring it back with action=open app="${target.app}" and observe again`
        + (permissionKnownGood ? '.' : ', or run action=status if you suspect Screen Recording permission.'));
    }
    const degraded = windowElements.length === 0;
    // The PNG is captured for target.windowId, so THAT window's live CG bounds are the authoritative
    // mapping frame. The first AXWindow in the walk can belong to a DIFFERENT window of the same app
    // (a sheet vs its parent) — mapping pixels through the wrong window's frame is exactly how a
    // click "lands on a random control". Validate candidates against the PNG's aspect ratio and
    // fall back to the AX frame only when the CG bounds are unavailable or geometrically implausible.
    const axWindowFrame = windowElements.find((element: any) => String(element?.role || '') === 'AXWindow')?.frame;
    const axFrame: Frame | null = axWindowFrame && Number(axWindowFrame.w) > 0 && Number(axWindowFrame.h) > 0
      ? { x: Number(axWindowFrame.x), y: Number(axWindowFrame.y), w: Number(axWindowFrame.w), h: Number(axWindowFrame.h) }
      : null;
    let cgFrame: Frame | null = null;
    let liveWindows: any[] = [];
    try {
      const wins = await phaseTrace.time('driver:list_windows', () => this.call('list_windows', { pid: target.pid }));
      liveWindows = Array.isArray(wins?.windows) ? wins.windows : [];
      const win = liveWindows
        .find((candidate: any) => Number(candidate?.window_id) === Number(target.windowId));
      const bounds = win?.bounds;
      // Require an explicit origin: a bounds record without x/y cannot anchor a pixel mapping.
      const parsed = bounds && {
        x: Number(bounds.x), y: Number(bounds.y),
        w: Number(bounds.width ?? bounds.w), h: Number(bounds.height ?? bounds.h),
      };
      if (parsed && [parsed.x, parsed.y, parsed.w, parsed.h].every(Number.isFinite) && parsed.w > 0 && parsed.h > 0) cgFrame = parsed;
    } catch { /* AX frame remains the fallback authority */ }
    this.observedWindowIds = new Set(liveWindows
      .map((window: any) => Number(window?.window_id || 0))
      .filter((id: number) => id > 0));
    if (target.windowId) this.observedWindowIds.add(target.windowId);
    // Reconcile the captured window with the real top recipient inside the SAME application. A pid
    // is not enough: TextEdit/Notes/WhatsApp can expose several overlapping windows from one pid.
    // If the centre of the captured window is actually owned by another CGWindow of that app,
    // retarget and recapture before minting a frame. Bounded to one retry to avoid oscillation if a
    // window is animating; the event epoch and exact-window click preflight remain the final gates.
    if (windowReconcileAttempt === 0 && cgFrame && target.windowId) {
      try {
        const centre = frameCenter(cgFrame);
        const probe = await phaseTrace.time('helper:window_at', () => this.fallback.run({ action: 'window_at', x: centre.x, y: centre.y }));
        const hit = probe.windowAt;
        const liveId = Number(hit?.window_id || hit?.top_window_id || 0);
        const sameProcess = Number(hit?.owner_pid || 0) === target.pid;
        const sameTopApp = !!hit?.top_owner_name && this.appNamesMatch(String(hit.top_owner_name), target.app);
        const live = liveWindows.find((candidate: any) => Number(candidate?.window_id) === liveId
          && candidate?.is_on_screen !== false
          && Number(candidate?.bounds?.width || 0) > 100
          && Number(candidate?.bounds?.height || 0) > 100);
        if (sameProcess && sameTopApp && live && liveId !== target.windowId) {
          target.windowId = liveId;
          this.targets.retargetWindow(target.pid, liveId);
          return this.observeTarget(target, cwd, session, cmd, 1);
        }
      } catch { /* exact-window preflight still refuses any unresolved mismatch before input */ }
    }
    const pngAspect = screenshotWidth && screenshotHeight ? screenshotWidth / screenshotHeight : null;
    const aspectMatchesPng = (frame: Frame) => pngAspect == null || Math.abs(frame.w / frame.h - pngAspect) <= pngAspect * 0.03;
    this.observedWindowFrame =
      (cgFrame && aspectMatchesPng(cgFrame) ? cgFrame : null)
      || (axFrame && aspectMatchesPng(axFrame) ? axFrame : null)
      || axFrame;
    this.observedLiveWindowFrame = cgFrame;
    this.observedSurfaceKind = 'window';
    this.observedTarget = {
      pid: target.pid, windowId: target.windowId, degraded,
      width: screenshotWidth,
      height: screenshotHeight,
    };
    this.observedScreenshotFile = cmd.includeScreenshot === false ? null : screenshotFile;

    // Fuse pixels with semantics while both coordinate authorities are fresh. Native AX frames are
    // global screen points; the sampler accepts only screenshot pixels, so every rectangle passes
    // through the same audited transform used for model-visible element frames below.
    let visualSampled = 0;
    let visualChanged = 0;
    let foveatedTriggered = false;
    let foveatedTextCount = 0;
    let foveatedShapeCount = 0;
    let foveatedLatencyMs: number | undefined;
    const canSampleVisuals = cmd.includeScreenshot !== false
      && !!this.observedWindowFrame && !!screenshotWidth && !!screenshotHeight
      && this.fallback.quickStatus().driver.startsWith('native-helper');
    if (canSampleVisuals) {
      const candidates = phaseTrace.sync('visual_candidates', () => windowElements.map((element: any, order: number) => {
        const frame = elementFrame(element);
        const screenshotFrame = frame && globalFrameToScreenshot(
          frame,
          { width: screenshotWidth!, height: screenshotHeight! },
          this.observedWindowFrame!,
        );
        return { element, order, screenshotFrame };
      }).filter(candidate => candidate.screenshotFrame)
        .sort((a, b) => Number(ACTIONABLE_AX_ROLES.has(String(b.element?.role || '')))
          - Number(ACTIONABLE_AX_ROLES.has(String(a.element?.role || ''))) || a.order - b.order)
        .slice(0, 120));
      const regions = candidates.map((candidate, index) => ({
        id: `visual-${index}`,
        x: candidate.screenshotFrame!.x, y: candidate.screenshotFrame!.y,
        w: candidate.screenshotFrame!.w, h: candidate.screenshotFrame!.h,
      }));
      if (regions.length) {
        try {
          const sampled = await phaseTrace.time(`helper:visual_signatures(${regions.length})`, () => this.fallback.run({
            action: 'visual_signatures', imagePath: screenshotFile, regions,
          }));
          const byId = new Map((sampled.visualSignatures || []).map(signature => [String(signature.id || ''), signature]));
          const surfaceKey = `${target.pid}:${target.windowId}`;
          const previous = this.visualHistory.get(surfaceKey) || new Map<string, VisualFingerprint>();
          const current = new Map<string, VisualFingerprint>();
          candidates.forEach((candidate, index) => {
            const fingerprint = parseVisualFingerprint(byId.get(`visual-${index}`) || {});
            if (!fingerprint) return;
            const identities = visualElementIdentities({ ...candidate.element, frame: candidate.screenshotFrame });
            const before = identities.map(identity => previous.get(identity)).find(Boolean);
            const delta = before ? diffVisualFingerprints(before, fingerprint) : undefined;
            candidate.element.visual = fingerprint;
            if (delta) candidate.element.visual_delta = delta;
            if (delta?.changed) visualChanged++;
            identities.forEach(identity => current.set(identity, fingerprint));
            visualSampled++;
          });
          // Only a successful, non-empty sample supersedes history. A missing toolchain or a
          // malformed PNG cannot erase the last trustworthy baseline.
          if (current.size) {
            this.visualHistory.delete(surfaceKey);
            this.visualHistory.set(surfaceKey, current);
            while (this.visualHistory.size > 8) this.visualHistory.delete(this.visualHistory.keys().next().value!);
          }
        } catch { /* optional perception tier; AX + screenshot remain authoritative */ }
      }
    }
    // Vision is an ambiguity fallback, not a tax on every frame. Trigger it only when a named
    // target survived the exhaustive AX search unresolved, or when the app exposes a thin shell
    // dominated by unnamed controls. OCR covers the window once; contour work is foveated into the
    // actual ambiguous rectangles and never pretends a shape has a semantic icon name.
    const nativeQueryMissing = !!cmd.query?.trim() && !rawContainsQuery(windowElements);
    const unnamedActionables = windowElements.filter((element: any) =>
      ACTIONABLE_AX_ROLES.has(String(element?.role || ''))
      && (!String(element?.label || '').trim() || /^unlabeled\b/i.test(String(element?.label || ''))));
    const actionableCount = windowElements.filter((element: any) => ACTIONABLE_AX_ROLES.has(String(element?.role || ''))).length;
    const thinUnnamedTree = degraded || unnamedActionables.length >= Math.max(4, Math.ceil(actionableCount * 0.45));
    // A tree can be perfectly labeled and STILL expose none of the window's rendered output. Both
    // triggers above judge the quality of ACTIONABLE CONTROLS, but what an agent needs in order to
    // verify the effect of an action is usually non-interactive text: a computed result, a status
    // line, an error message, a field's displayed value. When a window publishes controls but no
    // readable text at all, the AX tree is not healthy — it is silently missing its output, and the
    // observation would report success while the one fact the turn depends on exists only in pixels.
    // Measured 2026-07-27: Calculator showing "216,174" returns 24 elements, every one of them
    // AXButton/AXWindow/AXToolbar, and no element carries the result. Because every button is
    // correctly labeled, `thinUnnamedTree` is false and OCR was skipped — so the healthy
    // window-scoped path returned LESS information than the degraded full-display fallback, which
    // did read the number. This trigger removes that inversion.
    const readableTextRoles = new Set(['AXStaticText', 'AXHeading', 'AXLabel', 'AXValueIndicator', 'VisualText']);
    const exposesReadableText = windowElements.some((element: any) =>
      readableTextRoles.has(String(element?.role || '')) || String(element?.value ?? '').trim().length > 0);
    const outputInvisible = actionableCount > 0 && !exposesReadableText;
    // The most degraded tree of all — NO elements whatsoever — used to trigger nothing, because
    // every test above measures the quality of elements that exist. `thinUnnamedTree` needs at least
    // four unnamed actionables and `outputInvisible` needs actionableCount > 0, so a window that
    // publishes an empty tree scored as healthy and the observation returned zero targets with no
    // fallback attempted. Measured on the ChatGPT desktop app: System Events confirms the window has
    // no UI elements at all, the AX opt-ins are refused (-25205 / -25208 on macOS 26.5), and the
    // model was handed an empty element list for a window full of visible, readable content.
    //
    // An app that publishes nothing is exactly the case vision exists for. Any AX-opaque surface —
    // a web-view app, a canvas, a game, a remote desktop, a video player — lands here.
    const emptyTree = windowElements.length === 0;
    if (canSampleVisuals && (nativeQueryMissing || thinUnnamedTree || outputInvisible || emptyTree)) {
      foveatedTriggered = true;
      const shapeRegions = unnamedActionables.map((element: any, index: number) => {
        const global = elementFrame(element);
        const local = global && globalFrameToScreenshot(
          global, { width: screenshotWidth!, height: screenshotHeight! }, this.observedWindowFrame!,
        );
        return local ? { id: `shape-${index}`, ...local } : null;
      }).filter(Boolean).slice(0, 16) as Array<{ id: string; x: number; y: number; w: number; h: number }>;
      const regions = [
        { id: 'ocr-window', x: 0, y: 0, w: screenshotWidth!, h: screenshotHeight! },
        ...shapeRegions,
      ];
      try {
        const analysed = await phaseTrace.time(`helper:visual_analysis(${regions.length})`, () => this.fallback.run({
          action: 'visual_analysis', imagePath: screenshotFile, regions, query: cmd.query,
        }));
        const vision = analysed.visualAnalysis;
        const texts = (vision?.texts || []).filter(item =>
          typeof item?.text === 'string' && item.text.trim() && Number(item.confidence) >= 0.3);
        foveatedTextCount = texts.length;
        foveatedShapeCount = vision?.shapes?.length || 0;
        foveatedLatencyMs = vision?.latencyMs;
        const seen = new Set<string>();
        const visualElements = texts.flatMap(item => {
          const local = elementFrame({ frame: item.frame });
          if (!local || !pixelInImage({ x: local.x, y: local.y }, { width: screenshotWidth!, height: screenshotHeight! })) return [];
          const topLeft = screenshotToGlobal(
            { x: local.x, y: local.y }, { width: screenshotWidth!, height: screenshotHeight! }, this.observedWindowFrame!,
          );
          const bottomRight = screenshotToGlobal(
            { x: local.x + local.w, y: local.y + local.h },
            { width: screenshotWidth!, height: screenshotHeight! }, this.observedWindowFrame!,
          );
          if (!topLeft || !bottomRight) return [];
          const label = item.text.trim();
          const key = `${label.toLocaleLowerCase()}@${Math.round(local.x / 4)},${Math.round(local.y / 4)}`;
          if (seen.has(key)) return [];
          seen.add(key);
          return [{
            role: 'VisualText', label,
            description: `on-device OCR (${Math.round(Number(item.confidence) * 100)}% confidence)`,
            frame: { x: topLeft.x, y: topLeft.y, w: Math.max(1, bottomRight.x - topLeft.x), h: Math.max(1, bottomRight.y - topLeft.y) },
            enabled: true, visual_only: true,
          }];
        });
        if (visualElements.length) {
          windowElements = [...windowElements, ...visualElements];
          rawElements = [...rawElements, ...visualElements];
        }
      } catch { /* native AX + screenshot remain authoritative when Vision is unavailable */ }
    }
    this.indexedElements.clear();
    this.observedElements = [];
    const enrichedByIndex = new Map(windowElements
      .filter((element: any) => element?.element_index != null)
      .map((element: any) => [Number(element.element_index), element]));
    const enrichedByToken = new Map(windowElements
      .filter((element: any) => element?.element_token)
      .map((element: any) => [String(element.element_token), element]));
    // The executable handle registry must be the exact same population the model can see. Walking
    // rawElements here used to register app-menu entries that windowElementsOf deliberately hid.
    // A model-visible Safari index could consequently resolve to a global "Calculator" menu item
    // from the same raw AX walk: the screenshot and action registry described different worlds.
    // Iterate the filtered/enriched window collection only, so an unseen element is unaddressable.
    phaseTrace.sync('index_elements', () => { for (const windowElement of windowElements as any[]) {
      const element = (windowElement?.element_token && enrichedByToken.get(String(windowElement.element_token)))
        || (windowElement?.element_index != null && enrichedByIndex.get(Number(windowElement.element_index)))
        || windowElement;
      const safe = {
        label: element?.label, role: element?.role, value: element?.value,
        originalLabel: element?.original_label, contextLabel: element?.context_label,
        description: element?.description, frame: element?.frame,
        elementToken: element?.element_token ? String(element.element_token) : undefined,
        elementIndex: element?.element_index != null ? Number(element.element_index) : undefined,
        enabled: element?.enabled == null ? undefined : !!element.enabled,
        focused: element?.focused == null ? undefined : !!element.focused,
        editable: element?.editable == null ? undefined : !!element.editable,
        visual: element?.visual as VisualFingerprint | undefined,
        visualDelta: element?.visual_delta as VisualDelta | undefined,
        visualOnly: element?.visual_only === true,
        axActions: Array.isArray(element?.ax_actions) ? element.ax_actions as string[] : undefined,
      };
      if (element?.element_token) this.indexedElements.set(`token:${element.element_token}`, safe);
      if (element?.element_index != null) this.indexedElements.set(`index:${Number(element.element_index)}`, safe);
      this.observedElements.push(safe);
    } });
    const verificationQuery = cmd.query?.trim() || '';
    const queryNeedle = verificationQuery.toLocaleLowerCase();
    const matchesQuery = (element: any) => !!queryNeedle
      && JSON.stringify(element).toLocaleLowerCase().includes(queryNeedle);
    const semanticMatches = queryNeedle ? windowElements.filter(matchesQuery) : [];
    const orderedElements = semanticMatches.length > 0
      ? [...semanticMatches, ...windowElements.filter((element: any) => !matchesQuery(element))]
      : (windowElements.length > 0
        ? [...windowElements.filter((element: any) => ACTIONABLE_AX_ROLES.has(String(element?.role || ''))),
          ...windowElements.filter((element: any) => !ACTIONABLE_AX_ROLES.has(String(element?.role || '')))]
        // When there are no window elements, rawElements is by construction exactly the menu-role
        // nodes windowElementsOf just excluded — the application's menu bar, whose frames live
        // outside this window entirely. Offering them as the targets of a window-scoped observation
        // is a lie, and a costly one: they are registered in indexedElements below, so the model can
        // address one, while observedElements deliberately excludes them so the semantic resolver
        // refuses to reason about them. Return no targets and let the screenshot be the truth, which
        // is what the degraded guidance already instructs.
        : []);
    const elements = phaseTrace.sync('serialize_elements', () => orderedElements.slice(0, maxElements).map((element: any) => {
      const compact: Record<string, unknown> = {};
      for (const key of ['element_index', 'element_token', 'role', 'label', 'context_label', 'value', 'description', 'enabled', 'focused', 'editable', 'label_source', 'frame']) {
        if (element?.[key] === undefined || element?.[key] === null || element?.[key] === '') continue;
        if (key === 'frame' && this.observedWindowFrame && screenshotWidth && screenshotHeight) {
          compact.frame = globalFrameToScreenshot(
            { x: Number(element.frame.x), y: Number(element.frame.y), w: Number(element.frame.w), h: Number(element.frame.h) },
            { width: screenshotWidth, height: screenshotHeight }, this.observedWindowFrame,
          ) || undefined;
        } else compact[key] = element[key];
      }
      const visual = compactVisualEvidence(element?.visual, element?.visual_delta);
      if (visual) compact.visual = visual;
      if (element?.visual_only === true) compact.source = 'on_device_vision';
      // Say up front when a control cannot be activated in the background, so the caller can CHOOSE
      // foreground rather than spend a turn discovering it. Emitted only when the tree published an
      // action list that lacks `press` — silence stays silent, and the full list is left off the wire
      // because "press or not" is the only part that changes what a caller can do.
      // The window itself is not a click target — it publishes `raise` and nothing else by nature, so
      // flagging it would only tell a caller to "use foreground" for something nobody clicks.
      if (Array.isArray(element?.ax_actions) && element.ax_actions.length
        && !element.ax_actions.includes('press')
        && String(element?.role || '') !== 'AXWindow') compact.background_activatable = false;
      return compact;
    }));
    const treeLines = phaseTrace.sync('tree_markdown', () => String(data?.tree_markdown || '').split('\n'));
    const tree = treeLines.length > 120
      ? `${treeLines.slice(0, 120).join('\n')}\n… ${treeLines.length - 120} more tree lines omitted; observe with query for a narrower view`
      : treeLines.join('\n');
    const matchCount = semanticMatches.length;
    const verification = verificationQuery
      ? { query: verificationQuery, matched: matchCount > 0, matchCount }
      : undefined;
    // Refresh the surface's bounds from the geometry we just observed, so window moves/resizes keep
    // the tracked surface (and any PiP built on it) aligned with the real window.
    const activeTarget = this.targets.current();
    if (activeTarget?.pid === target.pid && activeTarget.windowId === target.windowId) phaseTrace.sync('sync_surface', () => this.syncSurface());
    const frameHash = cmd.includeScreenshot === false ? undefined : phaseTrace.sync('screenshot_hash', () => this.screenshotHash(screenshotFile));
    // Any fresh frame becomes the baseline the next action's outcome is judged against.
    if (frameHash) this.prevFrameHash = frameHash;
    // Mint the frame identity this observation's coordinates belong to. Every acting verb planned
    // from this picture is checked against it, so a stale frame of the SAME window is caught rather
    // than silently clicking whatever now occupies those pixels.
    const frame = phaseTrace.sync('mint_frame', () => this.mintFrame({
      captureKind: 'window', target, frameHash,
      bounds: this.observedWindowFrame,
      image: { width: screenshotWidth, height: screenshotHeight },
    }));
    // Everything through frame minting is represented by this observation. Only a later event may
    // invalidate it; taking the baseline earlier would race the AX/tree and screenshot reads.
    this.observedAxEventEpoch = this.axEventEpoch;
    // The observation is complete, so this is the first moment the evidence exists to judge whether
    // background delivery can drive this app at all.
    const backgroundEscalation = this.noteBackgroundViability(target.app,
      await phaseTrace.time('default_delivery', () => this.defaultDelivery({ action: 'observe' } as DesktopCommand)));
    // Deliberately NOT auto-activating here. Fronting the app inside an observation was tried and
    // measured: bring_to_front succeeded, the tree stayed Vision-only, and the result was one more
    // fallback that mostly did not work. The honest, useful thing an observation can do is name the
    // cause once; the user's own visibility setting is the real control, and hiding a broken setting
    // behind an automatic workaround is what made this subsystem hard to reason about.
    const windowObservation: DesktopResult = {
      ok: true, action: cmd.action === 'screenshot' ? 'screenshot' : 'observe', driver: BIMAX_DRIVER_LABEL,
      app: target.app, pid: target.pid, windowId: target.windowId,
      screenshot: screenshotFile, frameHash, frameId: frame?.frameId,
      width: screenshotWidth, height: screenshotHeight,
      coordinateSpace: { xY: 'screenshot_pixels', elementFrames: 'screenshot_pixels', normalized: '0-1000' },
      details: {
        perception: {
          scanCaps, scanned: rawElements.length, visible: elements.length, degraded,
          accessibilityObserver: {
            active: this.axWatcherPid === target.pid,
            epoch: this.observedAxEventEpoch,
          },
          visual: { sampled: visualSampled, changed: visualChanged, colorSpace: visualSampled ? 'sRGB' : undefined },
          foveated: {
            triggered: foveatedTriggered,
            ocrTextRegions: foveatedTextCount,
            shapeRegions: foveatedShapeCount,
            latencyMs: foveatedLatencyMs,
          },
        },
      },
      completionGuidance: [
        COMPUTER_COMPLETION_GUIDANCE,
        backgroundEscalation || '',
        this.transientDialogFrame ? 'A foreground dialog is currently detected; dismiss it before attempting any background control.' : '',
        foregroundSurfaceNotice(elements) || '',
        thinTreeNotice(windowElements) || '',
        windowPreparationNotice(windowElements, screenshotWidth, screenshotHeight) || '',
        visualSampled ? 'Element RGB labels are sRGB-normalized supporting evidence; combine them with native label, role, geometry, and a fresh screenshot rather than clicking by colour alone.' : '',
        foveatedTriggered ? 'Items marked source=on_device_vision were discovered from screenshot pixels. They can propose a target, but input is still refused unless the native hit-test receipt confirms the live app, label/role context, and geometry.' : '',
        backgroundAppBlockedWalk ? `This window exposed no accessibility content because ${backgroundAppBlockedWalk} is frontmost, not ${target.app || 'the target app'}. Do not conclude the app has a thin tree and do not fall back to clicking OCR pixels: focus the target app, then observe again.` : '',
      ].filter(Boolean).join(' '),
      elements, tree, degraded, verification,
      summary: verification
        ? `observed ${target.app || `pid ${target.pid}`} window ${target.windowId}: verification query "${verificationQuery}" ${verification.matched ? `matched ${matchCount} semantic element${matchCount === 1 ? '' : 's'}` : 'was not found in native text; inspect the attached screenshot before deciding whether the state is complete'}`
        : degraded
          // Say what CANNOT be done as well as what can. "Use the screenshot as the source of truth"
          // reads as advice about reading, so the model kept reaching for elementIndex anyway and then
          // followed the stale-handle error into an observe→click→observe loop. Naming the two
          // targeting modes that survive a vision-only frame is what actually redirects it.
          ? (backgroundAppBlockedWalk
            ? `observed ${target.app || `pid ${target.pid}`} window ${target.windowId}: its accessibility walk returned only this app's menu bar because ${backgroundAppBlockedWalk} is frontmost, so this frame has NO element indexes or tokens and its labels come from OCR. This is a FOCUS problem, not a silent tree — focus ${target.app || `pid ${target.pid}`} and observe again to get real handles`
            : `observed ${target.app || `pid ${target.pid}`} window ${target.windowId}: native text is degraded, so this frame has NO element indexes or tokens — target by query="<visible label>" or by x/y read from the attached screenshot, which is the source of truth. Observing again will not produce handles for this window`)
          : `observed ${target.app || `pid ${target.pid}`} window ${target.windowId}: fresh screenshot + ${elements.length} optional native targets`,
    };
    return cmd.includeScreenshot === false
      ? windowObservation
      : this.humanDisplayObservation(target, windowObservation, { cwd });
  }

  /** OpenAI-style action loop: every delivered input immediately yields the next pixels. This saves
   * an entire model/tool round per step and makes a stale screenshot impossible to reuse silently. */
  private async postActionEvidence(target: ComputerTarget, cwd: string, session: string): Promise<Partial<DesktopResult>> {
    try {
      // Actions such as Cmd+N and info buttons can create a document window or sheet. Reacquire the
      // visible window before capture; otherwise a launch-time 33px menu proxy remains pinned and
      // every later screenshot is a black strip even though the real document is on screen.
      const refreshed = await this.refreshTargetWindow(target);
      this.targets.retargetWindow(target.pid, refreshed.windowId);
      // Capture the pre-action baseline BEFORE observeTarget overwrites it with the fresh frame.
      const prev = this.prevFrameHash;
      // The text that was ALREADY on screen. An application error is recognised by being new; every
      // negative sentence that survives from the previous frame is document/chat/page content.
      const previousTexts = new Set(this.observedElements.map(observedElementText).filter(Boolean));
      // A 24-element budget was exhausted by the System Settings sidebar before the first main-pane
      // control appeared. Preserve enough fresh targets for details/info/disclosure controls while
      // the sidecar still performs the same bounded 1000-element internal scan.
      const expectation = this.activeExpectation;
      const observed = await this.observeTarget(refreshed, cwd, session, {
        action: 'observe',
        // Proving absence requires exhausting the tree; presence can use the progressive query path.
        maxElements: expectation?.mode === 'absent' ? 2000 : POST_ACTION_ELEMENT_BUDGET,
        ...(expectation ? { query: expectation.query } : {}),
        // A foreground click that hands focus to another app makes the post-action walk menu-only,
        // which reads as "the effect vanished" and fails every postcondition. Re-focus once for an
        // explicitly foreground operation. Background delivery must remain background even when
        // that means returning an AX-thin/degraded observation.
        focusIfBackground: allowsEvidenceFocus(this.activeDelivery),
      });
      // The observation may reconcile the initially selected same-app window to another
      // WindowServer surface. Its returned pixels/frame are final: keep ownership and the action
      // receipt on that exact id so the next input consumes the frame it was actually shown.
      // FrameRegistry is the last writer in observeTarget and therefore the strongest authority.
      // A same-process sheet can disappear between the native capture and result assembly, leaving
      // the result's provisional window id different from the immutable frame that owns its pixels.
      const capturedFrame = this.frames.current();
      const evidenceWindowId = capturedFrame?.pid === refreshed.pid && capturedFrame.windowId
        ? capturedFrame.windowId
        : Number(observed.windowId || 0) || refreshed.windowId;
      observed.windowId = evidenceWindowId;
      if (evidenceWindowId && evidenceWindowId !== refreshed.windowId) {
        refreshed.windowId = evidenceWindowId;
        this.targets.retargetWindow(refreshed.pid, evidenceWindowId);
      }
      // `observed.verification` answers "did the SEARCH query appear", which is a substring test and
      // the right contract for observe. A postcondition is a different question and gets the real
      // evaluator, judged against the full post-action population rather than the capped list.
      const expectationCheck = expectation
        ? evaluateExpectation(expectation.query, JSON.stringify(this.observedElements))
        : null;
      const desiredAfter = expectation
        ? expectation.mode === 'present'
          ? expectationCheck!.matched
          : !expectationCheck!.matched && !expectationCheck!.indeterminate
        : undefined;
      // Expectations prove effects, not static screen contents. Without this transition check a
      // model can click an arbitrary old conversation and use an already-visible message as proof
      // that it just sent that message in the current turn.
      const expectationMatched = expectation
        ? desiredAfter === true && !expectation.desiredBefore
        : undefined;
      // A transition that failed because the text was ALREADY there is a real, decidable miss, so
      // indeterminacy is only ever inherited from the evaluator itself.
      const expectationIndeterminate = !!expectationCheck?.indeterminate;
      // Judge against the FULL post-action population, not the serialized `observed.elements`: that
      // list is capped and reordered for the model, so an error dialog past the cap would be invisible
      // here, and it drops `originalLabel` — the only way to tell an app-supplied "Close" from one
      // describeUnlabeledControls synthesized out of neighbouring text.
      const observedFailure = visibleApplicationFailure(this.observedElements, previousTexts);
      // Judge the action by the SCREEN, not by the driver's success return (Stage 6).
      const progressCheck = classifyVerification({
        ok: true, prevFrameHash: prev, nextFrameHash: observed.frameHash,
        hadScreenshot: !!observed.screenshot,
        expectedApp: target.app || undefined, actualApp: observed.app || undefined,
        targetWindowId: evidenceWindowId, actualWindowId: observed.windowId,
        queryMatched: expectationMatched,
        queryRequired: !!expectation,
        queryIndeterminate: expectationIndeterminate,
        observedFailure: observedFailure || undefined,
      });
      const verb = this.activeAction || 'action';
      // Only genuinely state-mutating verbs feed the no-progress accounting. Verbs that are
      // legitimately visually static (wait, hover, move, a mouse_up completing a gesture) must not
      // accrue a false "stuck" state just because the pixels didn't change.
      const countsForProgress = ['click', 'type', 'key', 'set_value', 'drag', 'scroll', 'open'].includes(verb);
      if (countsForProgress) {
        if (progressCheck.outcome === 'no-change' || progressCheck.outcome === 'expectation-missed') this.noChangeStreak++;
        else this.noChangeStreak = 0;
      }
      // Durable, bounded record of what the agent did and whether it worked (Stage 7).
      this.recordAction(verb, target.app, progressCheck.outcome);
      // Feed the outcome to the bounded recovery authority (Stage 6). Its decision is surfaced to the
      // model, and once it latches stop-failure the run() guard refuses further acting verbs.
      // A proven per-action postcondition is progress, not proof that the user's entire multi-step
      // task is finished. Feed it as changed so the task-level recovery controller never latches a
      // premature stop-success after an intermediate step.
      // An unjudgeable postcondition is not evidence of failure, so it must not spend the recovery
      // budget either. Feed the frame-level truth instead: the action either changed the screen or
      // it did not, and the model decides from the attached frame.
      const recoveryOutcome = progressCheck.outcome === 'confirmed' ? 'changed'
        : progressCheck.outcome === 'expectation-indeterminate'
          ? (progressCheck.frameChanged ? 'changed' : 'no-change')
          : progressCheck.outcome;
      const recoveryDecision: RecoveryDecision = countsForProgress ? this.recovery.record(recoveryOutcome) : 'continue';
      const recoveryHint = recoveryDecision === 'stop-failure'
        ? `no visible progress after repeated attempts — stopping to avoid a loop; re-observe (screenshot/observe) and target a different element, or ask the user`
        : recoveryDecision === 'escalate'
          ? `cheap recovery options are exhausted — re-observe and try a clearly different approach, or ask the user before continuing`
          : progressCheck.outcome === 'expectation-missed'
            ? `the requested semantic postcondition was not found in the fresh frame — inspect the returned candidates and recover instead of repeating the same action`
          : progressCheck.outcome === 'expectation-indeterminate'
            ? `expect="${expectation?.query || ''}" describes a state instead of naming text that appears on screen${expectationCheck?.missing.length ? ` (not in this frame: ${expectationCheck.missing.slice(0, 6).join(', ')})` : ''}, so it proves nothing either way. Read the attached frame to decide, and do NOT repeat a delivered action on the strength of this — for a send/submit that would commit it twice. Next time pass the exact text that will appear.`
          : progressCheck.outcome === 'rejected'
            ? `the application explicitly rejected this operation${observedFailure ? `: ${observedFailure}` : ''}; dismiss the error and choose a different supported approach`
          : this.noChangeStreak >= 3
            ? `${this.noChangeStreak} consecutive actions produced no visible change — re-observe, target a different element, or wait for the UI to update instead of repeating the same action`
            : undefined;
      const postcondition = expectation ? {
        query: expectation.mode === 'absent'
          ? `${expectation.desiredBefore ? 'new ' : ''}absence of "${expectation.query}"`
          : `${expectation.desiredBefore ? 'new ' : ''}presence of "${expectation.query}"`,
        matched: expectationMatched === true,
        ...(expectationIndeterminate ? { indeterminate: true } : {}),
      } : undefined;
      return {
        // The post-action capture SUPERSEDES the frame the action was planned from, so the caller
        // must be handed the new id — otherwise the next action would echo back the pre-action
        // frameId and be correctly, but uselessly, refused as stale.
        screenshot: observed.screenshot, frameHash: observed.frameHash, frameId: observed.frameId,
        width: observed.width, height: observed.height,
        coordinateSpace: observed.coordinateSpace,
        completionGuidance: observed.completionGuidance,
        elements: observed.elements, degraded: observed.degraded, windowId: evidenceWindowId,
        progressCheck, actionResult: toActionResult(progressCheck, postcondition),
        recoveryDecision, ...(recoveryHint ? { recoveryHint } : {}),
      };
    } catch (err: any) {
      const visualEvidenceError = bimaxBrand(String(err?.message || err)).slice(0, 500);
      // A successful click can open a menu, popover, picker, or other transient OS window that
      // temporarily makes the parent-window PNG unavailable. This is not a perception failure: the
      // human-visible display is now the only truthful surface. Promote that composited display to
      // the next action frame so the caller can inspect and target the foreground transient instead
      // of blindly retrying the now-covered parent. Right-click already takes this path eagerly;
      // this covers ordinary buttons (attachment +, colour pickers, combo-box popovers) whose
      // separate-window behavior is discoverable only after the click.
      const transientDisplayEligible = ['click', 'open', 'focus'].includes(this.activeAction || '');
      if (transientDisplayEligible && /no usable pixels|unreadable dimensions|capture failed/i.test(visualEvidenceError)) {
        const beforeTransientHash = this.prevFrameHash;
        try {
          const transient = await this.newTransientWindowObservation(target, cwd, session);
          if (transient?.screenshot) {
            const progressCheck = classifyVerification({
              ok: true, prevFrameHash: beforeTransientHash, nextFrameHash: transient.frameHash,
              hadScreenshot: true, expectedApp: target.app || undefined, actualApp: transient.app || undefined,
            });
            const verb = this.activeAction || 'action';
            this.recordAction(verb, target.app, progressCheck.outcome);
            return {
              ...transient,
              progressCheck,
              actionResult: toActionResult(progressCheck),
              recoveryDecision: this.recovery.record(progressCheck.outcome === 'confirmed' ? 'changed' : progressCheck.outcome),
              recoveryHint: `A new same-app transient window replaced the parent capture after ${verb}; BiMax adopted its exact pixels and coordinates. Act on this frame, not on the display-context PiP.`,
            };
          }
        } catch { /* full-display context remains the bounded fallback below */ }
        const beforeDisplayHash = this.prevFrameHash;
        try {
          const display = await this.displayObservation(target, { cwd });
          if (display.screenshot) {
            const progressCheck = classifyVerification({
              ok: true, prevFrameHash: beforeDisplayHash, nextFrameHash: display.frameHash,
              hadScreenshot: true, expectedApp: target.app || undefined,
            });
            const verb = this.activeAction || 'action';
            this.recordAction(verb, target.app, progressCheck.outcome);
            return {
              ...display,
              progressCheck,
              actionResult: toActionResult(progressCheck),
              recoveryDecision: this.recovery.record(progressCheck.outcome === 'confirmed' ? 'changed' : progressCheck.outcome),
              recoveryHint: `The target window became unavailable after ${verb}. Inspect this full-display frame to determine whether a foreground transient opened or the app is hidden/off-Space; act only on what is visibly proven, or focus/open the app again.`,
            };
          }
        } catch { /* fall through to the honest stale-perception result below */ }
      }
      // The action may have changed the UI, so the pre-action frame and all handles are now stale.
      // Invalidate them immediately; the observe-before-act gate will refuse another input until a
      // real fresh capture succeeds.
      this.observedTarget = null;
      this.observedScreenshotFile = null;
      this.observedWindowIds.clear();
      this.observedWindowFrame = null;
      this.observedLiveWindowFrame = null;
      this.observedSurfaceKind = 'window';
      this.frames.invalidate();
      this.indexedElements.clear();
      this.observedElements = [];
      this.prevFrameHash = undefined;
      const progressCheck = classifyVerification({
        ok: true,
        hadScreenshot: false,
        expectedApp: target.app || undefined,
        targetWindowId: target.windowId,
      });
      this.recordAction(this.activeAction || 'action', target.app, progressCheck.outcome);
      return {
        visualEvidenceError,
        progressCheck,
        actionResult: toActionResult(progressCheck),
        recoveryDecision: this.recovery.record(progressCheck.outcome),
        recoveryHint: 'Perception is stale. Re-observe before any next input.',
      };
    }
  }

  private async refreshTargetWindow(target: ComputerTarget): Promise<ComputerTarget> {
    // A freshly created/activated window (e.g. Finder's Desktop window, a new document) briefly
    // reports a toolbar-only STRIP — full width but ~35px tall — before its content renders. Capturing
    // that strip gives the model a screenshot no click can be mapped against (the live "1559×35" bug).
    // Poll briefly for a properly-sized window instead of pinning the strip. A window already rendered
    // is found on the first attempt with no delay; only the not-yet-drawn case pays the wait.
    let windows: any[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      const data = await this.call('list_windows', { pid: target.pid });
      windows = Array.isArray(data?.windows) ? data.windows : [];
      // `is_on_screen=false` does not mean "not a real window". It is how WindowServer reports an
      // ordinary app window that is hidden, minimized, or on another Space — precisely the state
      // background delivery is designed to operate in. (It is NOT merely "another app is in front":
      // a window sitting behind another app on the ACTIVE Space still reports true, which is what
      // makes the signal usable as the Space guard in ensureTargetReceivesPoint.) Reject by
      // geometry first, then prefer an on-screen surface when one exists; if none does, retain the
      // real off-screen document instead of collapsing onto a 33px menu-bar/toolbar proxy.
      const usable = windows.filter((w: any) =>
        Number(w?.bounds?.width || 0) > 100 && Number(w?.bounds?.height || 0) > 100);
      if (usable.length > 0) {
        const onScreen = usable.filter((w: any) => w?.is_on_screen !== false);
        const selectable = onScreen.length > 0 ? onScreen : usable;
        const area = (w: any) => Number(w?.bounds?.width || 0) * Number(w?.bounds?.height || 0);
        const largest = selectable.reduce((best: any, candidate: any) => area(candidate) > area(best) ? candidate : best, selectable[0]);
        const current = selectable.find((w: any) => Number(w.window_id) === target.windowId);
        // A modal sheet can be listed before the main window, while the sidecar PNG is the full
        // composed main window. Pinning the sheet id therefore compressed every screenshot
        // coordinate into its tiny frame. Use the main surface for capture/mapping and retain the
        // sheet bounds as a modal input guard.
        //
        // Shape alone CANNOT identify a sheet, and assuming it could is what broke clicking in
        // ordinary apps: an Electron app (WhatsApp) enumerates incidental child windows that are
        // smaller than and inside the main window, so every one of them was read as a modal and
        // every click outside its rectangle was refused as "a foreground dialog is blocking that
        // background point". Geometry only NARROWS the candidates here; macOS itself confirms
        // modality via AX (see the helper's modal-frame probe), which is app-agnostic and correct.
        const candidate = selectable.find((w: any) => Number(w.window_id) !== Number(largest.window_id)
          && area(w) >= 20_000 && area(w) < area(largest) * 0.5
          && rectMostlyInside(w?.bounds, largest?.bounds));
        // Direction of safety: an absent guard costs one refused click that the OS would have
        // blocked anyway, while a phantom guard blocks EVERY click in the app. So anything short of
        // a positive OS confirmation — no candidate, no helper, no permission — means no guard.
        this.transientDialogFrame = candidate ? await this.confirmedModalFrame(target) : null;
        // WindowServer identifies the visible same-process surfaces, while Accessibility identifies
        // which normal window is focused. Join them by geometry so a click-created document becomes
        // the target even when the older document is the same size (or larger).
        let focused: any | undefined;
        try {
          const probe = await this.fallback.run({ action: 'window_frame', pid: target.pid });
          const rect = probe.ok ? probe.windowFrame : undefined;
          const focusedFrame = rect && Number(rect.w) > 0 && Number(rect.h) > 0
            ? { x: Number(rect.x), y: Number(rect.y), w: Number(rect.w), h: Number(rect.h) }
            : undefined;
          const focusedMatches = focusedFrame
            ? selectable.filter((w: any) => frameMatches(focusedFrame, {
                x: Number(w?.bounds?.x || 0), y: Number(w?.bounds?.y || 0),
                w: Number(w?.bounds?.width || 0), h: Number(w?.bounds?.height || 0),
              }, 4))
            : [];
          // AX exposes focused-window geometry but not its CGWindowID. When two same-process
          // windows overlap at identical bounds, geometry cannot distinguish them; selecting the
          // first enumeration entry silently changes ownership. Retain the exact currently-owned
          // id in that ambiguous case. A unique geometry match still adopts a newly focused window.
          focused = focusedMatches.length === 1
            ? focusedMatches[0]
            : focusedMatches.find((w: any) => Number(w?.window_id) === Number(target.windowId));
          // A focused sheet blocks its parent but is not a stable capture surface. Keep the parent
          // plus its exact modal guard rather than shrinking the capture coordinate space to it.
          if (focused && this.transientDialogFrame && frameMatches(focusedFrame!, this.transientDialogFrame, 4)) {
            focused = undefined;
          }
          // Address suggestions, autocomplete panels, colour pickers and similar transient child
          // surfaces can briefly become the AX-focused "window" even though the stable capture is
          // still their parent. Safari's Cmd+L popup was measured as 759×273 inside a 1470×865
          // page: adopting it made the next frame claim window 2244 while its pixels/coordinates
          // still belonged to parent 2209, creating an endless target-changed loop. A genuinely new
          // document window is comparable in area (covered by the focused-window test below), so
          // only suppress a substantially smaller focused surface contained by the largest window.
          const focusedIsTransientChild = focused
            && Number(focused.window_id) !== Number(largest.window_id)
            && area(focused) < area(largest) * 0.5
            && rectMostlyInside(focused?.bounds, largest?.bounds);
          if (focusedIsTransientChild) focused = undefined;
        } catch { /* AX unavailable: retain the current/largest WindowServer fallback below */ }
        // An explicit caller choice outranks every heuristic below, as long as that window is still
        // a real, usable surface of this process.
        const pinned = this.pinnedWindow?.pid === target.pid
          ? selectable.find((w: any) => Number(w?.window_id) === this.pinnedWindow!.windowId)
          : undefined;
        const good = pinned || focused || (current && area(current) >= area(largest) * 0.5 ? current : largest);
        // Remember the app's OTHER surfaces. An app routinely owns a main window plus a document
        // window (Notes: the note list, and a note opened in its own window), and only one of them
        // can be the observed target. When a semantic query then fails, "no element matched" is a
        // dead end unless the model is told the thing it named may simply be on another window of
        // the same app — which it cannot discover without being told to go and enumerate.
        this.siblingWindows = selectable
          .filter((w: any) => Number(w?.window_id || 0) && Number(w.window_id) !== Number(good?.window_id || 0))
          .map((w: any) => ({ windowId: Number(w.window_id), title: String(w?.title || '').trim() }));
        return { ...target, windowId: Number(good?.window_id || 0) || target.windowId };
      }
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1))); // let it finish rendering
    }
    // Nothing properly sized after retrying. Do not NEWLY PIN a degenerate strip merely because
    // enumeration listed it first: a 1559x35 capture poisons PiP, coordinate mapping and every later
    // model decision while pretending acquisition succeeded, so callers that deliberately cleared the
    // window component (the reacquisition paths, which pass windowId: undefined) get "no capturable
    // window" and the bounded recovery that comes with it.
    //
    // But an id we ALREADY HOLD must survive this. WindowServer's per-pid enumeration is routinely
    // unhelpful for an app whose only surfaces are the desktop or menu-bar proxies — Finder with no
    // folder window open is the everyday case — while direct window capture of the held id works
    // perfectly. Measured live: discarding it here turned `open Finder` into "observe needs pid +
    // windowId" and refused 14 downstream actions that pass at HEAD. Enumeration being unhelpful is
    // not evidence that the window we are already driving is degenerate.
    if (windows.length === 0 || target.windowId) return target;
    return { ...target, windowId: undefined };
  }

  /**
   * Ask macOS whether this app currently has a real modal blocker, and where it is.
   *
   * Only called once geometry has found a plausible candidate, so the common case (no contained
   * child window) never pays for the probe. Returns null on any doubt — see the caller for why the
   * failure direction matters.
   */
  /**
   * Ask a Chromium-based app to publish its real accessibility tree, once per process.
   *
   * Electron apps (WhatsApp, Slack, Discord, VS Code, Notion) ship a placeholder tree until a
   * client opts in: measured live, WhatsApp exposed 31 elements — 22 of them unlabeled buttons —
   * where a native app of the same size exposed 397 labelled ones. With nothing nameable in the
   * map, `query` cannot resolve anything and the model falls back to guessing raw pixels, which is
   * what "the clicks are inaccurate and meaningless" actually was.
   *
   * Best-effort by construction: native apps refuse the attribute, and a refusal (or a missing
   * helper) simply leaves the observation as it was.
   */
  private async enableRichAccessibility(pid: number): Promise<void> {
    if (process.platform !== 'darwin' || !pid || this.axEnabledPids.has(pid)) return;
    this.axEnabledPids.add(pid);
    try { await this.fallback.run({ action: 'ax_enable', pid }); }
    catch { /* the observation is still usable, just thinner */ }
  }

  private async confirmedModalFrame(target: ComputerTarget): Promise<Frame | null> {
    if (process.platform !== 'darwin' || !target.pid) return null;
    try {
      const probe = await this.fallback.run({ action: 'modal_frame', pid: target.pid });
      const rect = probe.ok ? probe.modalFrame : undefined;
      if (!rect || !(Number(rect.w) > 0) || !(Number(rect.h) > 0)) return null;
      return { x: Number(rect.x), y: Number(rect.y), w: Number(rect.w), h: Number(rect.h) };
    } catch {
      return null; // no helper / no Accessibility permission — never guess a blocker into existence
    }
  }

  /**
   * Poll briefly for a usable window before concluding the app has none.
   *
   * The Cmd+N recovery this gates is DESTRUCTIVE in a document app: in Notes it creates a real note
   * in the user's library, in an editor an untitled document. A cold launch routinely has no drawn
   * window for a few hundred milliseconds, so a single-shot check declared "no window" for an app
   * that was merely still starting, and fired the recovery anyway. Measured across one session that
   * never asked for a new note: Notes went from 193 notes to 195, one empty note per cold `open`.
   *
   * Waiting costs nothing when the window is already there — the first poll returns immediately, and
   * only the genuinely windowless case pays. Recovery still runs for an app that really has closed
   * its last window, which is the case it was written for.
   */
  private async waitForUsableTargetWindow(target: ComputerTarget, timeoutMs = 2000): Promise<boolean> {
    // The common case costs nothing: a window that is already there answers on the first probe, with
    // no timer at all. Only a genuinely windowless app pays the budget.
    //
    // Budget from measurement, not from taste: a cold Notes draws its first window 0.79s after it is
    // ACTIVATED (it draws nothing at all while merely launched in the background, which is how
    // `launch_app` starts it). 2s gives that ~2.5x headroom on a memory-pressured machine, while
    // 1.5s was measured as too short — the recovery fired and created a note. Callers that have
    // ALREADY paid this wait once (the re-check after the reopen event) pass a short budget instead,
    // so the windowless path stays bounded rather than waiting the full grace twice.
    if (await this.hasUsableTargetWindow(target)) return true;
    const settled = await waitUntil(() => this.hasUsableTargetWindow(target), { timeoutMs, intervalMs: 120 });
    return settled.settled;
  }

  private async hasUsableTargetWindow(target: ComputerTarget): Promise<boolean> {
    try {
      const data = await this.call('list_windows', { pid: target.pid });
      const windows = Array.isArray(data?.windows) ? data.windows : [];
      const usable = (w: any) => w?.is_on_screen !== false
        && Number(w?.bounds?.width || 0) > 100
        && Number(w?.bounds?.height || 0) > 100;
      // `windowId` is OPTIONAL on a target, and the id match silently answered "no window" for
      // every target that lacked one — `Number(w.window_id) === undefined` is false for all of
      // them. The windowless recovery below is Cmd+N, which in a document app creates user data,
      // so an app that was plainly on screen got a new document instead of being observed.
      // Measured 2026-08-18: a target reported as "process 46395, window not reported" left a
      // filled-in New Playlist sheet sitting in the user's Music library.
      //
      // A target pinned to a specific window still asks about THAT window. A target with no id is
      // asking the question the recovery actually cares about — does this process have any usable
      // window at all — and any usable window disproves "windowless".
      if (!target.windowId) return windows.some(usable);
      return windows.some((w: any) => Number(w?.window_id) === target.windowId && usable(w));
    } catch {
      return false;
    }
  }

  /** Fire the macOS "reopen" event (`open -a`, which triggers applicationShouldHandleReopen) to
   * materialize a CLOSED main window — WhatsApp/Spotify/Discord keep running with no window when you
   * close it, and `open` then captured a blank placeholder with no window controls (a degraded
   * observation). Re-acquire the window and re-capture. Returns the new target + evidence plus
   * whether the window is STILL unusable, so the caller can warn honestly. Best-effort; harmless
   * (a no-op that just fronts the app) when the window was already open. */
  private async reopenClosedMainWindow(
    target: ComputerTarget, cwd: string, session: string, ctx?: { cwd?: string; signal?: AbortSignal },
    delivery: 'foreground' | 'background' = 'foreground',
  ): Promise<{ target: ComputerTarget; evidence: Partial<DesktopResult>; stillClosed: boolean }> {
    const waitForWindow = (timeoutMs: number) => waitFor(
      async () => {
        const candidate = await this.refreshTargetWindow({ ...target, windowId: undefined });
        return candidate.windowId ? candidate : null;
      },
      { timeoutMs, intervalMs: 80 },
    );
    let appeared: Awaited<ReturnType<typeof waitForWindow>>;
    try {
      await this.fallback.run({ action: delivery === 'background' ? 'reopen_background' : 'open', app: target.app }, ctx);
      appeared = await waitForWindow(1500);
    } catch {
      return { target, evidence: {}, stillClosed: true };
    }

    // Some Catalyst/Electron apps can still refuse the standard background reopen event until they
    // become active. Preserve true background semantics with one
    // bounded activation pulse: remember the user's foreground app, materialize and identify the
    // target window, then restore that app BEFORE any screenshot or input. This is never repeated
    // in a loop and no user action is delivered while the target is temporarily frontmost.
    if (delivery === 'background' && !appeared.value) {
      const priorFrontmost = await this.fallback.frontmostApp().catch(() => '');
      try {
        await this.fallback.run({ action: 'open', app: target.app }, ctx);
        appeared = await waitForWindow(1500);
      } catch { /* handled by the still-closed result below */ }
      finally {
        if (priorFrontmost && !appNamesMatch(priorFrontmost, target.app)) {
          try { await this.fallback.run({ action: 'open', app: priorFrontmost }, ctx); }
          catch { /* capture below remains window-scoped; a restore failure is reported by occlusion gates */ }
        }
      }
    }

    // Poll for the window to materialize instead of sleeping a fixed 450 ms: WindowServer is
    // usually far quicker, and when it is not, a fixed wait would have declared failure early.
    const reacquired = appeared.value ?? await this.refreshTargetWindow({ ...target, windowId: undefined });
    this.targets.set(reacquired);
    if (!reacquired.windowId) return { target: reacquired, evidence: {}, stillClosed: true };
    const evidence = await this.postActionEvidence(reacquired, cwd, session);
    const stillClosed = !!evidence.visualEvidenceError || evidence.degraded === true;
    return { target: reacquired, evidence, stillClosed };
  }

  /**
   * Bring a target forward, settle it, and capture its first trustworthy frame.
   *
   * Shared by `open` (after launch_app) and `focus` (which switches to an app the session already
   * has open, without re-launching it). These two must never drift: the activation escalation and
   * the closed-window recovery below are the difference between a frame that describes the intended
   * app and one that describes whatever was in front of it.
   */
  private async activateAndCapture(
    initial: ComputerTarget, cwd: string, session: string,
    delivery: 'foreground' | 'background', ctx?: { cwd?: string; signal?: AbortSignal },
    /** The target that was active BEFORE the caller claimed ownership of `initial`. Both `open` and
     * `focus` register the new target first, so reading it here would always report the new app and
     * every switch would look like a no-op re-focus — which is exactly how the latency measurement
     * silently recorded nothing. Callers that reassign ownership must pass the real predecessor. */
    previous: ComputerTarget | null = this.targets.current(),
  ): Promise<{ target: ComputerTarget; evidence: Partial<DesktopResult>; frontmostWarning?: string; switchMs?: number }> {
    let opened = initial;
    let frontmostWarning: string | undefined;
    // Phase 4 — the switch is a TRANSACTION, not a call. Freezing input is the first thing that
    // happens and it is enforced, not advisory: invalidating the frame registry means every acting
    // verb's freshness gate refuses until a frame of the NEW target exists. That is what closes the
    // window in which a click could still be delivered to the app we are switching away from.
    const transaction = new TargetSwitch(
      previous ? { app: previous.app, pid: previous.pid, windowId: previous.windowId } : null,
      { app: initial.app, pid: initial.pid, windowId: initial.windowId },
    );
    transaction.resolve();
    transaction.freezeInput('frame registry invalidated — no input can reach the previous target');
    // Stop the old app's preview while the target is in flight. The transaction does not release
    // input until a new frame exists AND the replacement preview process has been started.
    await this.suspendLivePipForSwitch();
    // Invalidate the whole perception snapshot, not just its frame id. If activation/capture throws
    // (especially on a same-app re-focus), leaving observedTarget populated lets the old screenshot
    // pass the pid/window gate after the frame registry has been cleared.
    this.frames.invalidate();
    this.observedTarget = null;
    this.observedScreenshotFile = null;
    this.observedWindowIds.clear();
    this.observedWindowFrame = null;
    this.observedLiveWindowFrame = null;
    this.observedSurfaceKind = 'window';
    this.indexedElements.clear();
    this.observedElements = [];
    if (delivery === 'foreground') {
      transaction.activate();
      let activated = false;
      for (let attempt = 0; attempt < 4 && !activated; attempt++) {
        try {
          await this.call('bring_to_front', { pid: opened.pid, window_id: opened.windowId });
          activated = true;
        } catch {
          await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
          opened = await this.refreshTargetWindow(opened);
          this.targets.set(opened);
        }
      }
      if (!activated) {
        // Some apps publish their process before AppKit accepts activation. `open -a` is the
        // native foreground contract and handles hidden/launching applications reliably.
        const nativeOpen = await this.fallback.run({ action: 'open', app: opened.app }, ctx);
        if (!nativeOpen.ok) throw new Error(nativeOpen.error || nativeOpen.summary);
      }
      // bring_to_front returning ok does NOT mean the app actually came forward — some apps
      // (Electron/Catalyst) accept the call yet leave the terminal frontmost. Verify the truth; if a
      // different app is positively still in front, escalate to the native `open -a` contract and
      // re-check. Only then do we trust that it is focused.
      //
      // POLL for that rather than sleeping a fixed 250 ms and hoping. An app that fronts in 30 ms
      // costs 30 ms; one that needs 600 ms gets 600 ms instead of being misjudged as failed. The
      // budget is the honest upper bound, not the normal cost.
      const fronted = await waitUntil(async () => !(await this.frontmostMismatch(opened.app)), { timeoutMs: 900, intervalMs: 40 });
      let stillWrong = fronted.settled ? '' : await this.frontmostMismatch(opened.app);
      if (stillWrong) {
        try { await this.fallback.run({ action: 'open', app: opened.app }, ctx); } catch { /* re-checked below */ }
        const retried = await waitUntil(async () => !(await this.frontmostMismatch(opened.app)), { timeoutMs: 900, intervalMs: 40 });
        stillWrong = retried.settled ? '' : await this.frontmostMismatch(opened.app);
      }
      if (stillWrong) {
        frontmostWarning = `${opened.app} was activated but ${stillWrong} is still frontmost — its window may be hidden or blocked; screenshots and clicks may land on the wrong app until it is brought forward`;
        cliEvents.emit('status', frontmostWarning);
      }
      opened = await this.refreshTargetWindow(opened);
      this.targets.set(opened);
      // An app can be genuinely frontmost while exposing no usable document window — a system app
      // showing only its menu/desktop proxy, or any app whose last window was closed. Ask the app
      // for a new window once (Cmd+N) and reacquire. Probed, never keyed on an app name, so every
      // app with this shape gets the same recovery.
      if (process.platform === 'darwin' && !await this.waitForUsableTargetWindow(opened)) {
        // Cmd+N is the LAST resort, because in a document app it creates user data — a note in
        // Notes, an untitled document in an editor. Try the OS reopen event first: it asks the app
        // to show its existing main window (applicationShouldHandleReopen) and creates nothing when
        // a window is merely hidden or still starting. Only if that yields no window do we ask for
        // a brand new one.
        try { await this.fallback.run({ action: 'open', app: opened.app }, ctx); } catch { /* fall through to Cmd+N */ }
        const reopenedWindow = await this.waitForUsableTargetWindow(opened, 1200);
        if (reopenedWindow) {
          opened = await this.refreshTargetWindow(opened);
          this.targets.set(opened);
        }
        const newWindow = reopenedWindow
          ? { ok: false }
          : await this.fallback.run({ action: 'key', combo: 'cmd+n', app: opened.app }, ctx);
        if (newWindow.ok) {
          // Wait for the new window to actually exist rather than assuming 350 ms was enough.
          const created = await waitFor(
            async () => {
              const candidate = await this.refreshTargetWindow({ ...opened, windowId: undefined });
              return candidate.windowId ? candidate : null;
            },
            { timeoutMs: 1200, intervalMs: 80 },
          );
          opened = created.value ?? await this.refreshTargetWindow({ ...opened, windowId: undefined });
          this.targets.set(opened);
        }
      }
      transaction.confirmFrontmost(frontmostWarning);
    } else {
      // Background delivery never fronts anything, so there is nothing to confirm — but the phases
      // must still be walked in order so the trace of a background switch is comparable.
      transaction.activate('background delivery — no activation performed');
      transaction.confirmFrontmost();
      if (!opened.windowId) {
        opened = await this.refreshTargetWindow(opened);
        this.targets.set(opened);
      }
    }
    transaction.confirmWindow(opened.windowId);
    let evidence = opened.windowId
      ? await this.postActionEvidence(opened, cwd, session)
      : { visualEvidenceError: 'target application has no capturable window yet' };
    // App running with its main window CLOSED: the first frame is a blank placeholder with no window
    // controls (degraded), which the model reads as "not the right window, can't proceed". Fire the
    // native reopen event once and re-capture; if it is still unusable, WARN plainly instead of
    // claiming a clean activation.
    let shouldReopenClosedWindow = delivery === 'foreground'
      ? evidence.degraded === true || !!evidence.visualEvidenceError
      : !opened.windowId;
    // A COLD LAUNCH makes that first capture degraded for a reason that is not "the window is
    // closed": the app is running but has not drawn yet. Everything below escalates toward Cmd+N,
    // which in a document app CREATES USER DATA — an empty note in Notes, an untitled document in
    // an editor. Measured: every cold `open` of Notes added a note, so a session that never asked
    // for one still moved the library from 193 notes to 195.
    //
    // So wait for the window to actually appear and capture once more before believing the first
    // frame. This does not weaken the recovery it guards: an app whose last window really is closed
    // never produces a usable window here, and the "zombie" case — geometry-valid window that
    // captures zero pixels — still comes back degraded from the second capture and still escalates.
    if (shouldReopenClosedWindow && delivery === 'foreground' && await this.waitForUsableTargetWindow(opened, 1200)) {
      evidence = await this.postActionEvidence(opened, cwd, session);
      shouldReopenClosedWindow = evidence.degraded === true || !!evidence.visualEvidenceError;
    }
    if (shouldReopenClosedWindow) {
      const initialCaptureWasEmpty = !!evidence.visualEvidenceError;
      const reopened = await this.reopenClosedMainWindow(opened, cwd, session, ctx, delivery);
      opened = reopened.target;
      this.targets.set(opened);
      if (!reopened.stillClosed && !reopened.evidence.visualEvidenceError) {
        evidence = reopened.evidence;
      } else {
        // Some document apps keep a geometry-valid zombie window after the last document closes:
        // `open -a` fronts the process but the stale CGWindow still captures zero pixels. The same
        // standard New Window command already used above for apps with no geometry is the bounded
        // final recovery. App/pid ownership stays fixed and the old window id is deliberately not
        // reused; if the app does not support Cmd+N, the failed capture remains an honest failure.
        if (initialCaptureWasEmpty && delivery === 'foreground') {
          try {
            const madeWindow = await this.fallback.run({ action: 'key', combo: 'cmd+n', app: opened.app }, ctx);
            if (madeWindow.ok) {
              const created = await waitFor(
                async () => {
                  const candidate = await this.refreshTargetWindow({ ...opened, windowId: undefined });
                  return candidate.windowId ? candidate : null;
                },
                { timeoutMs: 1500, intervalMs: 80 },
              );
              const candidate = created.value ?? await this.refreshTargetWindow({ ...opened, windowId: undefined });
              this.targets.set(candidate);
              if (candidate.windowId) {
                const recaptured = await this.postActionEvidence(candidate, cwd, session);
                if (!recaptured.visualEvidenceError && recaptured.degraded !== true) {
                  opened = candidate;
                  evidence = recaptured;
                }
              }
            }
          } catch { /* the original capture failure remains below */ }
        }
        if (evidence.visualEvidenceError || evidence.degraded === true) {
          if (reopened.evidence.screenshot) evidence = reopened.evidence;
          // Never overwrite a focus warning with this one. When the app never came forward AND the
          // frame is empty, the focus failure is the likely CAUSE of the empty frame, and it names the
          // app actually holding the screen — drop that and the report blames a closed window for what
          // is really another app sitting in front.
          const closedWindowWarning = `${opened.app} is running but its main window appears closed — the captured frame has no window content. Reopen the window (click its Dock icon, or use the app's "Open main window" menu), then observe again.`;
          frontmostWarning = frontmostWarning
            ? `${frontmostWarning}; additionally, ${closedWindowWarning}`
            : closedWindowWarning;
          cliEvents.emit('status', frontmostWarning);
        }
      }
    }
    if (evidence.visualEvidenceError) {
      transaction.abort(evidence.visualEvidenceError);
      throw new Error(evidence.visualEvidenceError);
    }
    // postActionEvidence may have re-acquired a better window — read the owned truth back.
    opened = this.targets.current() ?? opened;
    // The agent owns input on this surface only when it is genuinely frontmost in visible mode.
    // syncSurface also re-points PiP capture at the new target, so this IS the capture switch.
    this.syncSurface({
      focusOwner: (delivery === 'foreground' && !frontmostWarning) ? 'agent' : 'none',
      syncPip: false,
    });
    await this.syncLivePipNow();
    transaction.switchCapture(`PiP retargeted to ${opened.app} window ${opened.windowId ?? '(none)'}`);
    // A frame of the new target now exists (postActionEvidence minted it), so input may resume.
    transaction.acquireFrame(evidence.frameId);
    transaction.commit();
    this.lastSwitch = transaction;
    if (transaction.isRealSwitch) this.switchLatency.record(transaction.elapsedMs);
    return { target: opened, evidence, frontmostWarning, switchMs: transaction.elapsedMs };
  }

  /**
   * Deliver a Space / Mission-Control shortcut and then re-establish what the agent is looking at.
   *
   * The naive path — post the combo, screenshot the target window — is what made these shortcuts
   * unusable: after the switch the previously active window is on a Space that is no longer on
   * screen, its capture comes back empty, and the empty frame is indistinguishable from a crashed
   * app. So instead: deliver, let the animation finish, ask the OS what is actually in front now,
   * and re-target only if that app is one this session already knows. Anything else drops activation
   * (registrations survive) so the next input has to go through an explicit focus with a fresh frame.
   */
  private async runSpaceCombo(
    cmd: DesktopCommand, target: ComputerTarget, kind: 'switch' | 'overview',
    cwd: string, session: string, driver: string, ctx?: { cwd?: string; signal?: AbortSignal },
  ): Promise<DesktopResult> {
    // Start from the target's own Space, so "next Space" means next relative to what the agent was
    // working on rather than relative to whatever the user last touched.
    await this.ensurePhysicalTargetFrontmost(target);
    const delivered = await this.fallback.run({ action: 'key', combo: cmd.combo, app: target.app }, ctx);
    if (!delivered.ok) throw new Error(delivered.error || delivered.summary);
    // The Space transition is animated; capturing mid-flight catches a half-slid screen.
    await new Promise(resolve => setTimeout(resolve, 900));
    // A new Space is an entirely fresh visual context — never judge progress against the old one.
    this.prevFrameHash = undefined;
    this.noChangeStreak = 0;
    this.recovery.reset();

    if (kind === 'overview') {
      // Mission Control / App Exposé overlay every window. No single app window is a meaningful
      // capture target until the overlay is dismissed, so do not pretend to still own one.
      this.targets.deactivate();
      this.syncLivePip();
      return {
        ok: true, action: cmd.action, driver, app: target.app, pid: target.pid,
        actionResult: { delivered: true, observed: 'changed', confidence: 'likely' },
        summary: `pressed ${cmd.combo} — the window overview is now covering the screen. No app window can be captured while it is open: press escape to dismiss it, then focus the app you want.`,
      };
    }

    const frontmost = await this.frontmostApp().catch(() => '');
    const known = frontmost ? this.targets.find(frontmost) : null;
    if (known) {
      this.targets.activate(known.pid);
      const reacquired = await this.refreshTargetWindow(known);
      this.targets.set(reacquired);
      const evidence = await this.postActionEvidence(reacquired, cwd, session);
      this.syncSurface({ focusOwner: 'agent' });
      const samePlace = reacquired.pid === target.pid;
      return {
        ok: true, action: cmd.action, driver, app: reacquired.app, pid: reacquired.pid,
        windowId: reacquired.windowId, ...evidence,
        actionResult: {
          delivered: true, observed: samePlace ? 'no-change' : 'changed',
          postcondition: { query: 'a different Space is now showing', matched: !samePlace },
          confidence: samePlace ? 'unknown' : 'proven',
        },
        summary: samePlace
          ? `pressed ${cmd.combo} but ${reacquired.app} is still frontmost — there may be no further Space in that direction (only fullscreen apps and additional desktops are switchable)`
          : `pressed ${cmd.combo} — now on the Space showing ${reacquired.app}; it is already open in this session and is now the active target; fresh screen attached`,
      };
    }
    // Landed somewhere this session does not manage. Keep every registration, but stop claiming an
    // active target: the old window is on a hidden Space and would capture empty.
    this.targets.deactivate();
    this.syncLivePip();
    const registered = this.targets.all().map(t => t.app).filter(Boolean);
    return {
      ok: true, action: cmd.action, driver,
      actionResult: { delivered: true, observed: 'changed', postcondition: { query: 'a different Space is now showing', matched: true }, confidence: 'proven' },
      summary: `pressed ${cmd.combo} — now on a Space showing ${frontmost || 'an app this session has not opened'}. `
        + `No app is the active target any more, because ${target.app} is on a Space that is no longer visible and would capture empty. `
        + (registered.length ? `Use action=focus for one of: ${registered.join(', ')}, or ` : 'Use ')
        + `action=open for ${frontmost || 'the app you want'} to control what is on screen now.`,
    };
  }

  /**
   * Drag from the active window into ANOTHER application's window.
   *
   * Two things make this different from an ordinary drag, and both were why cross-app drops
   * silently failed:
   *
   *  1. Coordinate space. The source point is a pixel in the source window's screenshot; the
   *     destination is a pixel in a DIFFERENT window's screenshot. Each has to be mapped through its
   *     own live window frame into global screen points before either is usable.
   *  2. Physical timing. A drop is only accepted after the receiving app has processed
   *     dragging-entered; the intra-window drag path completes far faster than a background app is
   *     typically scheduled, so the button came back up before the destination knew a drag existed.
   *
   * Both windows must be simultaneously visible, which is what `arrange` is for. If the source
   * window covers the drop point this refuses rather than dropping onto the source itself.
   */
  private async runCrossAppDrag(
    cmd: DesktopCommand, source: ComputerTarget, cwd: string, session: string, driver: string,
    ctx?: { cwd?: string; signal?: AbortSignal },
  ): Promise<DesktopResult> {
    const wantedApp = cmd.toApp!.trim();
    const destination = this.targets.find(wantedApp);
    if (!destination) {
      const known = this.targets.all().map(t => t.app).filter(Boolean);
      throw new Error(`drag destination "${wantedApp}" is not open in this session${known.length ? ` (open: ${known.join(', ')})` : ''} — open it first, and make sure both windows are visible at once (arrange one left and the other right)`);
    }
    if (destination.pid === source.pid) {
      throw new Error(`drag toApp "${wantedApp}" is the app already being dragged from — omit toApp for a drag inside one window`);
    }
    // The source must be frontmost to originate the press, and its frame is needed to map the
    // source pixel. Both come from the normal single-window path.
    if (!this.observedTarget || this.observedTarget.pid !== source.pid) {
      throw new Error('drag needs a fresh image of the source window — observe it first');
    }
    const sw = this.observedTarget.width, sh = this.observedTarget.height;
    if (!sw || !sh) throw new Error('latest screenshot has no usable dimensions');
    const hasSourceHandle = !!(cmd.query?.trim() || cmd.elementToken || cmd.elementIndex != null);
    if (!hasSourceHandle && (cmd.x == null || cmd.y == null)) {
      throw new Error('drag needs a source: query/elementToken/elementIndex from the newest observation, or x+y screenshot pixels');
    }
    const sourcePixel = hasSourceHandle
      ? (() => {
        const resolved = cmd.query?.trim()
          ? this.resolveObservedElement(cmd.query, source)
          : this.resolveObservedHandle(source, cmd);
        const point = this.elementCenterInScreenshot(resolved.frame);
        if (!point) throw new Error('drag source element has no visible screenshot rectangle; observe again');
        return point;
      })()
      : {
        x: cmd.normalized ? scaleNormalizedPoint(cmd.x!, sw - 1) : Math.round(cmd.x!),
        y: cmd.normalized ? scaleNormalizedPoint(cmd.y!, sh - 1) : Math.round(cmd.y!),
      };

    await this.ensurePhysicalTargetFrontmost(source);
    const sourceFrame = await this.liveWindowFrame(source);
    const globalFrom = this.screenshotPixelToGlobalPoint(sourcePixel, sourceFrame);
    if (!globalFrom) throw new Error('could not map the drag source into screen coordinates — re-observe the source window');

    // The destination window's own live frame is the only correct basis for its point; the source
    // window's screenshot says nothing about where the destination is on screen.
    const destFrame = await this.liveWindowFrame(destination);
    if (!destFrame || !destFrame.w || !destFrame.h) {
      throw new Error(`could not locate ${destination.app}'s window on screen — it may be minimized or on another Space; bring it into view (action=focus, then arrange) so both windows are visible at once`);
    }
    // Default to the destination window's centre: for a drop target that fills its window (a chat
    // transcript, a document body, a folder view) the centre is the sane landing point.
    const globalTo = {
      x: Math.round(cmd.toX != null ? destFrame.x + (cmd.normalized ? scaleNormalizedPoint(cmd.toX, destFrame.w - 1) : cmd.toX) : destFrame.x + destFrame.w / 2),
      y: Math.round(cmd.toY != null ? destFrame.y + (cmd.normalized ? scaleNormalizedPoint(cmd.toY, destFrame.h - 1) : cmd.toY) : destFrame.y + destFrame.h / 2),
    };
    if (!pointInFrame(globalTo, destFrame)) {
      throw new Error(`the drop point falls outside ${destination.app}'s window (${destFrame.w}x${destFrame.h}) — pass toX/toY inside it, or omit them to drop on its centre`);
    }
    // The source is frontmost, so wherever it overlaps the drop point it will receive the drop
    // instead of the destination. Refuse rather than dropping the file back into the app it came
    // from, and name the fix.
    if (sourceFrame && pointInFrame(globalTo, sourceFrame)) {
      throw new Error(`${source.app}'s window is covering the drop point in ${destination.app}, so the drop would land back on ${source.app}. Put them side by side first: focus ${source.app} → arrange layout=left, focus ${destination.app} → arrange layout=right.`);
    }

    const machine = new DragMachine(globalFrom, globalTo);
    machine.locateSource();
    const sourceInside = !sourceFrame || pointInFrame(globalFrom, sourceFrame);
    machine.verifySource(sourceInside, sourceInside ? 'source is inside the source window' : 'source point is outside the source window');
    if (!sourceInside) {
      return {
        ok: false, action: cmd.action, driver, app: source.app, pid: source.pid, windowId: source.windowId,
        details: { dragTrace: machine.trace },
        error: 'drag source is outside the source window — re-observe and pick a point that is on it',
        summary: `cross-app drag refused: source is outside ${source.app || `pid ${source.pid}`}`,
      };
    }
    machine.mouseDown().startDrag().moveThrough([globalTo]).locateDestination();
    machine.verifyDestination(true, `destination is inside ${destination.app}'s window (cross-application drop)`);
    const delivered = await this.fallback.run({
      action: 'drag', x: globalFrom.x, y: globalFrom.y, toX: globalTo.x, toY: globalTo.y,
      app: source.app, normalized: false,
      // Paced delivery: without this the button is released before the destination app has been
      // scheduled to process the drag at all.
      ms: CROSS_APP_DRAG_DWELL_MS,
    }, ctx);
    if (!delivered.ok) {
      machine.cancel('native drag failed');
      if (machine.releaseOwed) {
        try { await this.fallback.run({ action: 'mouse_up', x: globalTo.x, y: globalTo.y, app: source.app, normalized: false }, ctx); }
        catch { /* best-effort release so a failed drag never leaves the button stuck */ }
      }
      throw new Error(delivered.error || delivered.summary);
    }
    machine.mouseUp('native drag completed');
    // The RESULT of the drop is in the destination app, so that is the window worth capturing —
    // photographing the source would show the app the file left, which proves nothing.
    this.targets.activate(destination.pid);
    const reacquired = await this.refreshTargetWindow(destination);
    this.targets.set(reacquired);
    this.prevFrameHash = undefined;
    const evidence = await this.postActionEvidence(reacquired, cwd, session);
    machine.verifyResult(true, `fresh post-drop screen captured from ${destination.app}`);
    this.syncSurface();
    return {
      ok: true, action: cmd.action, driver, app: reacquired.app, pid: reacquired.pid, windowId: reacquired.windowId,
      details: { path: 'cross-app-global-cgevent', from: globalFrom, to: globalTo, sourceApp: source.app, destinationApp: reacquired.app, dragTrace: machine.trace },
      ...evidence,
      // Delivery is not acceptance: an app can refuse a drop type without any error. The caller has
      // to confirm the content arrived from the attached frame.
      actionResult: {
        delivered: true, observed: evidence.progressCheck?.outcome || 'changed',
        postcondition: { query: `content dropped into ${reacquired.app}`, matched: false },
        confidence: 'unknown',
      },
      summary: `dragged from ${source.app || `pid ${source.pid}`} into ${reacquired.app} at (${globalTo.x},${globalTo.y}); ${reacquired.app} is now the active target. Confirm from the attached frame that it accepted the drop — apps silently ignore content types they do not handle.`,
    };
  }

  /** Ask the OS for an app's bundle id. Best-effort: undefined simply means "launch it by name". */
  private async resolveBundleId(app?: string): Promise<string | undefined> {
    if (!app?.trim() || process.platform !== 'darwin') return undefined;
    try {
      const found = await this.fallback.run({ action: 'bundle_id', app });
      return found.ok ? found.bundleId : undefined;
    } catch { return undefined; }
  }

  /** Is this app already running? Used to decide whether a second instance is even possible. */
  private async isAppRunning(app?: string, bundleId?: string): Promise<boolean> {
    if (process.platform !== 'darwin') return false;
    // Prefer the live process list — it is authoritative and needs no extra process spawn.
    try {
      const data = await this.call('list_apps');
      const apps = Array.isArray(data?.apps) ? data.apps : [];
      const wanted = app?.trim();
      if (wanted && apps.some((a: any) => appNamesMatch(String(a?.name || ''), wanted))) return true;
      if (bundleId && apps.some((a: any) => String(a?.bundle_id || '').toLocaleLowerCase() === bundleId.toLocaleLowerCase())) return true;
      if (apps.length) return false;
    } catch { /* fall through to the scripting check */ }
    try {
      const running = await this.fallback.run({ action: 'app_running', app });
      return running.ok && !!running.running;
    } catch { return false; }
  }

  /**
   * Find a RUNNING app's best window without launching anything.
   *
   * `focus` used to serve only apps this session had itself opened, so the very common case — the
   * app is already running because the user left it open — dead-ended: focus refused with "not open
   * in this session" and the only escape was `open`, which re-launches and discards the app's state.
   * hermes-agent models focus_app as a pure window SELECTOR over `list_windows` for this reason
   * (tools/computer_use/cua_backend.py), and that is what this is.
   *
   * Matching order is exact-before-substring, also from hermes: querying "Code" must not select
   * "Visual Studio Code" merely because it happens to be in front. Among the windows that do match,
   * the frontmost (highest `z_index`) wins, and `preferWindowId` overrides everything so a caller
   * that already enumerated `windows` can name the exact surface it wants.
   *
   * Only on-screen windows are eligible: an off-screen one cannot receive foreground input at all
   * (see the Space guard in ensureTargetReceivesPoint), so adopting one would hand back a target
   * that refuses every subsequent click.
   */
  private async adoptRunningApp(app?: string, preferWindowId?: number): Promise<ComputerTarget | null> {
    const wanted = app?.trim();
    if (!wanted) return null;
    let windows: any[];
    try {
      const data = await this.call('list_windows', {});
      windows = Array.isArray(data?.windows) ? data.windows : [];
    } catch { return null; }
    const onScreen = windows.filter((w: any) => w?.is_on_screen !== false && Number(w?.pid || 0) > 0);
    const nameOf = (w: any) => String(w?.app_name || '').trim();
    const exact = onScreen.filter((w: any) => nameOf(w).toLocaleLowerCase() === wanted.toLocaleLowerCase());
    const loose = onScreen.filter((w: any) => nameOf(w) && appNamesMatch(nameOf(w), wanted));
    const candidates = exact.length ? exact : loose;
    if (!candidates.length) return null;
    const byWindowId = preferWindowId
      ? candidates.find((w: any) => Number(w?.window_id) === preferWindowId)
      : undefined;
    // Frontmost first: cua-driver defines a higher z_index as closer to the front.
    const ordered = [...candidates].sort((a: any, b: any) => Number(b?.z_index || 0) - Number(a?.z_index || 0));
    const chosen = byWindowId || ordered[0];
    return {
      app: nameOf(chosen) || wanted,
      pid: Number(chosen.pid),
      windowId: Number(chosen.window_id || 0) || undefined,
    };
  }

  /** Read the pasteboard through whichever driver tier is available. */
  private async readClipboard(ctx?: { cwd?: string; signal?: AbortSignal }): Promise<ClipboardSnapshot> {
    const read = await this.fallback.run({ action: 'clipboard_read' }, ctx);
    if (!read.ok || !read.clipboard) throw new Error(read.error || read.summary || 'could not read the clipboard');
    return read.clipboard;
  }

  /**
   * Does the newest observation contain this text anywhere? Used to verify a paste actually landed
   * in the target — the pasted content should now be readable in the app's accessibility tree.
   * Whitespace-insensitive and case-insensitive, because apps re-wrap and re-case what they display;
   * long content is checked by its leading slice, since a text view may truncate what it exposes.
   */
  private observedTextIncludes(text: string): boolean {
    const needle = text.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
    if (!needle) return false;
    const probe = needle.length > 120 ? needle.slice(0, 120) : needle;
    return this.observedElements.some(element => {
      for (const value of [element.label, element.value, element.description, element.contextLabel, element.originalLabel]) {
        if (typeof value !== 'string') continue;
        if (value.replace(/\s+/g, ' ').trim().toLocaleLowerCase().includes(probe)) return true;
      }
      return false;
    });
  }

  /** Derive a conservative control-state postcondition without asking the model to author one.
   * Generic buttons are intentionally excluded: a pixel change after "Save" is not semantic proof
   * of saving. Stateful controls expose a value/focus/colour transition we can actually inspect. */
  private synthesizeStatefulClickPostcondition(
    before: ObservedElement | undefined,
    evidence: Partial<DesktopResult>,
  ): void {
    if (!before || this.activeExpectation || !evidence.progressCheck) return;
    const role = String(before.role || '');
    if (!new Set(['AXCheckBox', 'AXSwitch', 'AXRadioButton', 'AXTab', 'AXDisclosureTriangle']).has(role)) return;
    const beforeIds = new Set(visualElementIdentities(before));
    const after = this.observedElements.find(element => visualElementIdentities(element).some(identity => beforeIds.has(identity)))
      || this.observedElements.find(element => element.role === before.role
        && String(element.label || element.value || '') === String(before.label || before.value || ''));
    const valueChanged = !!after && before.value !== after.value
      && (before.value != null || after.value != null);
    const focusChanged = !!after && before.focused !== true && after.focused === true;
    const visualChanged = after?.visualDelta?.changed === true;
    const matched = valueChanged || focusChanged || visualChanged;
    const label = before.label || before.value || role.replace(/^AX/, '') || 'control';
    evidence.actionResult = toActionResult(evidence.progressCheck, {
      query: `${label} changed its native or visual state`, matched,
    });
  }

  /** Resolve a human app name for a pid from the sidecar's app list. launch_app sometimes returns
   * an empty or bundle-id-looking name; without this the model and the user saw "opened ?". */
  private async resolveAppName(pid: number, fallback: string): Promise<string> {
    const looksLikeBundleId = (s: string) => /^[a-z0-9_-]+(\.[a-z0-9_-]+){1,}$/i.test(s);
    const clean = stripInvisibleMarks(fallback);
    if (clean && clean !== '?' && !looksLikeBundleId(clean)) return clean;
    try {
      const data = await this.call('list_apps');
      const apps = Array.isArray(data?.apps) ? data.apps : [];
      const name = stripInvisibleMarks(String(apps.find((a: any) => Number(a?.pid) === pid)?.name || ''));
      if (name) return name;
    } catch { /* best-effort — keep the fallback */ }
    return clean;
  }

  /** Best-effort truth check for activation. Returns the observed frontmost app name ONLY when it
   * is positively a DIFFERENT app (so callers can escalate/warn); returns '' when it matches or is
   * unknown. Observation is best-effort and must never manufacture a false activation failure. */
  private async frontmostMismatch(app: string): Promise<string> {
    if (!app.trim()) return '';
    try {
      const actual = await this.frontmostApp();
      if (actual && !appNamesMatch(actual, app)) return actual;
    } catch { /* unknown — no mismatch we can prove */ }
    return '';
  }

  /** Visible-cursor guarantee for keyboard actions: glide the one native cursor into the target
   * window before delivering keystrokes when it is currently outside it, so typing/shortcuts
   * visibly originate from the agent's cursor instead of firing while it rests over the terminal.
   * A cursor a prior click already placed inside the window is left exactly where it is. */
  private async ensureCursorInTargetWindow(target: ComputerTarget, ctx?: { cwd?: string; signal?: AbortSignal }): Promise<void> {
    const frame = await this.liveWindowFrame(target);
    if (!frame || !frame.w || !frame.h) return;
    if (!this.observedTarget || this.observedTarget.pid !== target.pid) return;
    try {
      const pos = await this.fallback.run({ action: 'cursor' }, ctx);
      const inside = pos.ok && pos.x != null && pos.y != null
        && pos.x >= frame.x && pos.x <= frame.x + frame.w
        && pos.y >= frame.y && pos.y <= frame.y + frame.h;
      if (inside) return;
      const center = { x: Math.round(frame.x + frame.w / 2), y: Math.round(frame.y + frame.h / 2) };
      await this.fallback.run({ action: 'move', x: center.x, y: center.y, normalized: false }, ctx);
    } catch { /* cursor positioning is best-effort; the keyboard action still proceeds */ }
  }

  private async probeKeyboardFocus(ctx?: { cwd?: string; signal?: AbortSignal }): Promise<FocusProbe | null> {
    try {
      const probe = await this.fallback.run({ action: 'focused_element' }, ctx);
      if (!probe.ok) return null;
      return {
        app: probe.app, pid: probe.pid,
        element: probe.focusedElement as NativeElementReceipt | undefined,
        chain: Array.isArray(probe.focusChain) ? probe.focusChain as NativeElementReceipt[] : [],
      };
    } catch { return null; }
  }

  /** Focus a specifically named text target before literal typing. This makes vague instructions
   * such as "type hello in the message field" one grounded operation instead of requiring the
   * model to manually split click-then-type and hope focus survived between calls. */
  private async focusRequestedTextTarget(
    target: ComputerTarget,
    cmd: DesktopCommand,
    ctx?: { cwd?: string; signal?: AbortSignal },
  ): Promise<{ element?: ObservedElement; preflight?: PointPreflight }> {
    if (!cmd.query?.trim() && !cmd.elementToken && cmd.elementIndex == null) return {};
    const element = cmd.query?.trim()
      ? this.resolveObservedElement(cmd.query, target)
      : this.resolveObservedHandle(target, cmd);
    const role = String(element.role || '');
    if (!isEditableElement(element)) {
      throw new Error(`literal typing target "${element.label || element.value || role || '?'}" is ${role || 'not an editable field'}; choose a text field/composer instead`);
    }
    const screenshotPoint = this.elementCenterInScreenshot(element.frame);
    if (!screenshotPoint) throw new Error('the requested typing field has no visible rectangle; re-observe or scroll it into view');
    const global = await this.preparePhysicalPoint(target, screenshotPoint, element);
    const clicked = await this.fallback.run({
      action: 'click', x: global.x, y: global.y, button: 'left', count: 1,
      app: target.app, normalized: false,
    }, ctx);
    if (!clicked.ok) throw new Error(clicked.error || clicked.summary);
    this.verifyPhysicalClick(target, global, clicked);
    await new Promise(resolve => setTimeout(resolve, 20));
    return { element, preflight: global.preflight };
  }

  /** Prove the current native keyboard recipient before literal text is posted. */
  private async keyboardPreflight(
    target: ComputerTarget,
    expected: ObservedElement | undefined,
    ctx?: { cwd?: string; signal?: AbortSignal },
  ): Promise<{ probe: FocusProbe | null; element?: NativeElementReceipt; reason: string }> {
    const probe = await this.probeKeyboardFocus(ctx);
    if (!probe) return { probe: null, reason: 'native focused-element metadata was unavailable' };
    if (probe.pid && probe.pid !== target.pid) {
      throw new Error(`keyboard preflight refused input: focus belongs to ${probe.app || `pid ${probe.pid}`}, not ${target.app || `pid ${target.pid}`}`);
    }
    let element = probe.element;
    if (expected && probe.chain.length) {
      const matched = matchHitElement(expected, probe.chain);
      if (!matched.matched) {
        throw new Error(`keyboard preflight refused input: the requested field "${expected.label || expected.value || '?'}" did not become focused (${matched.reason})`);
      }
      element = matched.recipient;
    }
    // "Focus a text field first" is only actionable advice when the window HAS one. Calculator,
    // games, and shortcut-driven apps expose no editable element at all and are driven by typing
    // straight at the window — for them this guard removed the only way to interact, and it is why
    // `npm run test:computer` could not get past its own type step. Same test the type path already
    // uses to decide between naming a field and typing at the surface: if an editable field exists,
    // focus belonging to something else really is a mistake; if none exists, it is the normal state.
    const exposesEditableField = this.observedElements.some(isEditableElement);
    const surfaceHasNoField = this.observedElements.length > 0 && !exposesEditableField;
    if (element?.editable === false && !surfaceHasNoField) {
      throw new Error(`keyboard preflight refused literal typing because the focused ${element.role || 'element'} "${element.title || element.description || '?'}" is not editable; focus a text field first`);
    }
    return {
      probe, element,
      reason: element
        ? `target pid ${target.pid} owns editable ${element.role || 'element'} focus`
        : `target pid ${target.pid} is frontmost; it exposes no focused-element metadata`,
    };
  }

  private async keyboardAppPreflight(
    target: ComputerTarget,
    ctx?: { cwd?: string; signal?: AbortSignal },
  ): Promise<FocusProbe | null> {
    const probe = await this.probeKeyboardFocus(ctx);
    if (probe?.pid && probe.pid !== target.pid) {
      throw new Error(`keyboard preflight refused input: focus belongs to ${probe.app || `pid ${probe.pid}`}, not ${target.app || `pid ${target.pid}`}`);
    }
    return probe;
  }

  public async frontmostApp(): Promise<string> {
    // Ask the cheapest authority that can actually answer.
    //
    // This used to go straight to the sidecar's `list_apps`, which enumerates every running
    // application in order to read one name. Measured on this machine: 642ms median, versus 4ms for
    // the native helper's NSWorkspace read — 160× cheaper, and the two agree. It matters because
    // this is the activation-confirmation probe, called on every target switch and polled while
    // waiting: at 642ms per probe the "poll every 40ms" loop managed a single sample inside its
    // 900ms budget, so the switch paid ~750ms to learn something it could have had in 4ms AND the
    // poll could not actually track the app coming forward.
    // Only take the fast path when the helper is ALREADY built. `quickStatus` never compiles, so
    // this cannot turn a 4ms read into a first-use swiftc build on the critical path — which is
    // exactly what it did when the preference was unconditional.
    if (this.fallback.quickStatus().driver === 'native-helper') {
      try {
        const native = await this.fallback.frontmostApp();
        if (native) return native;
      } catch { /* the helper may have gone away — the sidecar can still answer */ }
    }
    if (!this.transport.available()) return this.fallback.frontmostApp();
    try {
      const data = await this.call('list_apps');
      const active = (Array.isArray(data?.apps) ? data.apps : []).find((app: any) => app.active);
      return String(active?.name || '');
    } catch {
      return '';
    }
  }

  public async run(cmd: DesktopCommand, ctx?: { cwd?: string; signal?: AbortSignal }): Promise<DesktopResult> {
    // Defense in depth: the tool layer already normalizes before gating, but /computer and other
    // direct callers reach the runtime without passing through it.
    cmd = { ...cmd, action: normalizeDesktopAction(cmd.action) as DesktopCommand['action'] };
    // Attribution belongs to THIS public action. Keeping the previous choice made an observation or
    // an early refusal look as if it had used the prior click's executor.
    this.lastMechanismChoice = null;
    this.lastExecutorChoice = null;
    const sourceUsesPixels = cmd.x != null && cmd.y != null
      && !cmd.query?.trim() && !cmd.elementToken && cmd.elementIndex == null;
    const destinationUsesPixels = cmd.action === 'drag' && cmd.toX != null && cmd.toY != null
      && !cmd.toQuery?.trim() && !cmd.toElementToken && cmd.toElementIndex == null;
    this.lastVisualGrounding = sourceUsesPixels || destinationUsesPixels;
    // Cleared per call rather than in runInner, which returns early on the fallback path — a
    // disclosure left over from a previous call would attach itself to an unrelated result.
    this.takeSemanticRegrounding();
    // Serialize every operation that can replace the active target or perception snapshot. There is
    // one physical mouse AND one current frame: an overlapping observation finishing late can be as
    // dangerous as overlapping clicks because it rewrites the coordinates the next action trusts.
    const execute = async (): Promise<DesktopResult> => {
      const mutating = ACTING_VERBS.has(cmd.action);
      if (mutating) await this.takeoverGuard?.begin();
      try {
        return stampSummaryVerdict(ensureActionResult(await this.runInner(cmd, ctx)));
      } finally {
        if (mutating) this.takeoverGuard?.end();
      }
    };
    const result = PIPELINE_SERIALIZED_VERBS.has(cmd.action)
      ? await this.input.run(execute)
      : await execute();
    if (result.visualEvidenceError && ACTING_VERBS.has(cmd.action)) {
      result.summary = `${cmd.action} was delivered, but the fresh post-action screen could not be captured. Re-observe before any next input: ${result.visualEvidenceError}`;
    }
    // Never let a replaced picture pass as the caller's own. The action succeeded against a tree
    // the model has not seen, and an adopted window is a surface change it must know about.
    const regrounded = this.takeSemanticRegrounding();
    if (regrounded && result.ok) {
      const how = cmd.query?.trim()
        ? `"${cmd.query}" was re-resolved from a fresh observation`
        : regrounded.reacquiredHandle
          // The caller's index/token is dead the moment the tree is re-walked, so say which element
          // identity was re-acquired and that the handle it names is a different number now.
          ? `the element you addressed by handle ("${regrounded.reacquiredHandle}") was re-acquired by identity in a fresh observation and now carries a different index/token`
          : 'a fresh observation replaced it before the action was delivered';
      result.summary = `${result.summary || `${cmd.action} completed`} (your planning frame was superseded — ${regrounded.notification}; ${how}${regrounded.windowChanged ? ` on newly adopted window ${result.windowId}` : ''}; plan the next action from the attached screen)`;
      result.details = { ...(result.details as object || {}), semanticRegrounding: regrounded };
    }
    if (result.ok && (ACTING_VERBS.has(cmd.action) || cmd.action === 'observe' || cmd.action === 'screenshot')) {
      this.failedActingStreak = 0;
    } else if (!result.ok && ACTING_VERBS.has(cmd.action) && !/\brefused:/.test(result.summary || '')) {
      // Our own latch refusals are not new delivery failures — counting them would let the
      // three-strike guard inflate itself while the model is already being told to re-observe.
      this.failedActingStreak++;
    }
    // Stamp once, after every early return, reroute and verifier has settled. A refusal is the stop
    // row. A delivered path is attributed only when the runtime recorded the real mechanism; the
    // compatibility fallback remains visibly unattributed until it is removed from production.
    const refused = ACTING_VERBS.has(cmd.action) && result.actionResult?.delivered === false;
    if (refused || (ACTING_VERBS.has(cmd.action) && this.lastMechanismChoice)) {
      const evidence = {
        mechanism: this.lastMechanismChoice,
        visualOnlyTarget: this.lastVisualGrounding,
        refused,
      };
      const level = classifyExecutorLevel(evidence);
      this.lastExecutorChoice = level;
      result.executor = {
        level,
        mechanism: this.lastMechanismChoice,
        description: describeLevel(level, evidence),
      };
    }
    return result;
  }

  private async runInner(cmd: DesktopCommand, ctx?: { cwd?: string; signal?: AbortSignal }): Promise<DesktopResult> {
    if (!this.transport.available()) return this.fallback.run(cmd, ctx);
    const cwd = ctx?.cwd || process.cwd();
    this.lastCwd = cwd;
    this.activeAction = cmd.action;
    const expected = cmd.expect?.trim();
    const expectationMode = cmd.expectMode || 'present';
    // Same evaluator as the post-action check, or the transition test compares two different
    // questions and a state-shaped expect would look "new" purely because neither side could match.
    const expectedPresentBefore = expected
      ? evaluateExpectation(expected, JSON.stringify(this.observedElements)).matched
      : false;
    this.activeExpectation = expected ? {
      query: expected,
      mode: expectationMode,
      desiredBefore: expectationMode === 'present' ? expectedPresentBefore : !expectedPresentBefore,
    } : null;
    const driver = BIMAX_DRIVER_LABEL;
    try {
      if (ctx?.signal?.aborted) throw new Error('computer action aborted');
      const target = this.targetFor(cmd);
      const session = cmd.session || this.session;
      const delivery = await this.defaultDelivery(cmd);
      this.activeDelivery = delivery;

      // Stage 3 — input ownership + mechanism routing. For acting verbs, consult the active surface
      // BEFORE delivering: (1) if the user has taken over, refuse rather than fight for the cursor;
      // (2) pick the honest mechanism for this (surface, action, delivery) and refuse combinations
      // that cannot be delivered safely; (3) record who owns input. Delivery itself is unchanged for
      // the working foreground path — this adds the guard and the ownership bookkeeping around it.
      const consumesFrame = FRAME_GATED_VERBS.has(cmd.action);
      const routesInput = consumesFrame || cmd.action === 'move';
      let semanticFrameRegrounded = false;
      if (routesInput) {
        // Hard observe-before-act gate. Naming a pid/app is not visual evidence, and a failed
        // post-action capture invalidates the old frame. `move` changes no application state.
        const needsFreshFrame = consumesFrame;
        const frameMatchesTarget = !!target
          && !!this.observedTarget
          && this.observedTarget.pid === target.pid
          && this.observedTarget.windowId === target.windowId
          && !!this.observedTarget.width
          && !!this.observedTarget.height;
        if (needsFreshFrame && !frameMatchesTarget) {
          return {
            ok: false, action: cmd.action, driver,
            error: 'a fresh screenshot of the exact target window is required before input — open or observe it first, then choose one action from that frame',
            summary: `${cmd.action} refused: observe the target window first`,
          };
        }
        if (needsFreshFrame && !IDENTITY_SCOPED_FRAME_VERBS.has(cmd.action)
          && target && this.axWatcherPid === target.pid
          && this.axEventEpoch !== this.observedAxEventEpoch) {
          const event = this.latestAxEvent;
          // A semantic query describes the user's intended control, not a cached coordinate or
          // ephemeral AX handle. Re-run perception for that query and resolve it from the new tree
          // in this same serialized transaction. This is what lets continuously updating apps
          // (Messages, chat clients, live dashboards) make progress without weakening the raw-pixel
          // stale-frame guard.
          //
          // AXWindowCreated is NOT excluded here, and that exclusion was measured as the cause of a
          // dead messaging flow: opening Messages creates its own window, and typing a contact into
          // Search creates the results surface, so the very events this operation produces refused
          // the operation's own next semantic action — observe, refuse, observe, refuse, turn over.
          // Surface identity is still protected, by evidence rather than by refusal: the
          // re-observation below adopts and reports a genuinely different window id, refreshes the
          // AX-confirmed modal guard (which refuses any point outside a real blocker), and the
          // pre-click accessibility hit test proves the target would receive the click. A query that
          // no longer exists fails semantic resolution instead of landing somewhere arbitrary.
          // An elementIndex/elementToken is a NAMED target too. It reads like a coordinate because
          // it is a number, but it is a reference into a snapshot this runtime still holds, so the
          // element's own identity (role + label) can be recovered from that snapshot BEFORE the
          // re-observation and re-acquired by identity afterwards. Refusing it instead was measured
          // on 2026-07-31 to be unrecoverable in practice: Messages with iCloud sync emits AX events
          // continuously, so two consecutive indexed clicks were refused at epoch 3 and epoch 9 and
          // no indexed click could ever be planned from a frame. The handle is NOT carried across —
          // indexes are re-numbered by every walk (the same conversation row was 28, then 5, then 6
          // in three successive frames of one run), so carrying it over is precisely the bug the
          // guard exists to prevent.
          const handleIdentity = !cmd.query?.trim() && (cmd.elementToken || cmd.elementIndex != null)
            ? this.describeTarget(cmd)
            : null;
          const identityText = (handleIdentity?.label || handleIdentity?.value || '').trim();
          const regroundQuery = cmd.query?.trim() || identityText;
          // A focus-addressed insertion with nothing to re-ground survives an event that cannot have
          // moved focus. An unnamed event does NOT qualify — not knowing what happened is a reason to
          // refuse, not a reason to proceed.
          const insertionSurvivesEvent = FOCUS_ADDRESSED_INSERT_VERBS.has(cmd.action)
            && !!event?.notification
            && !FOCUS_INVALIDATING_AX_NOTIFICATIONS.has(String(event.notification));
          if (regroundQuery) {
            try {
              const refreshed = await this.observeTarget(target, cwd, session, {
                action: 'observe',
                query: regroundQuery,
                maxElements: cmd.maxElements,
                includeScreenshot: true,
                // Re-grounding against a menu-only background frame resolves nothing and reports it
                // as "no semantic element matched", naming OCR strings as the visible labels.
                focusIfBackground: true,
              });
              if (!refreshed.ok) throw new Error(refreshed.error || refreshed.summary);
              // Re-acquire the SAME element by identity in the new tree and rewrite the handle to
              // that frame's numbering. An exact role+label match only: a near-miss here would be a
              // silent click on a different control, which is worse than the refusal it replaces.
              if (handleIdentity) {
                const reacquired = this.reacquireByIdentity(handleIdentity);
                if (!reacquired) {
                  throw new Error(`the element you named (${handleIdentity.role || 'element'} "${identityText}") is no longer in the tree after the app changed`);
                }
                cmd.elementToken = reacquired.elementToken;
                cmd.elementIndex = reacquired.elementToken ? undefined : reacquired.elementIndex;
              }
              const captured = this.frames.current();
              const windowChanged = !!(captured?.pid === target.pid && captured.windowId
                && captured.windowId !== target.windowId);
              if (windowChanged) {
                target.windowId = captured!.windowId!;
                this.targets.retargetWindow(target.pid, captured!.windowId!);
              }
              semanticFrameRegrounded = true;
              this.lastSemanticRegrounding = {
                notification: event?.notification || 'native UI event',
                windowChanged,
                ...(handleIdentity ? { reacquiredHandle: identityText || String(handleIdentity.role || 'element') } : {}),
              };
            } catch (error: any) {
              return {
                ok: false, action: cmd.action, driver,
                error: `the target accessibility state changed after the screenshot and semantic re-grounding failed: ${String(error?.message || error)}`,
                summary: `${cmd.action} refused: the app changed and the named target could not be reacquired`,
                details: { accessibilityInvalidation: event || { pid: target.pid, epoch: this.axEventEpoch } },
              };
            }
          } else if (!insertionSurvivesEvent) {
            return {
              ok: false, action: cmd.action, driver,
              error: `the target accessibility state changed after the screenshot (${event?.notification || 'native UI event'} at epoch ${this.axEventEpoch}); the visible element map may no longer own those coordinates — observe again before input`,
              summary: `${cmd.action} refused: the app changed after observation`,
              details: { accessibilityInvalidation: event || { pid: target.pid, epoch: this.axEventEpoch } },
            };
          }
        }
        if (target) {
          const pipelineIssue = await this.ensureTargetPipeline(target);
          if (pipelineIssue) {
            return {
              ok: false, action: cmd.action, driver,
              error: `computer target lock refused input: ${pipelineIssue}. Focus or observe the intended app again.`,
              summary: `${cmd.action} refused: preview, frame, and input target are not the same window`,
            };
          }
        }
        const surface = this.surfaces.active();
        if (surface?.focusOwner === 'user') {
          return { ok: false, action: cmd.action, driver, error: 'computer use is paused for user takeover — resume before the agent acts', summary: `${cmd.action} refused: you currently have control` };
        }
        // Bounded recovery authority (Stage 6): once the controller has latched a no-progress
        // failure, the agent may not keep hammering the same stuck UI. Refuse until it re-observes
        // (which resets the budget) or reopens the app — a hard cap on blind repetition, not advice.
        if (this.recovery.done && !this.recovery.succeeded) {
          const c = this.recovery.counters;
          return { ok: false, action: cmd.action, driver,
            error: `computer-use recovery budget exhausted — the last actions produced no visible progress (${c.noProgress} no-change, ${c.recoveries} recoveries); re-observe (screenshot/observe) and target a different element before acting again, or ask the user`,
            summary: `${cmd.action} refused: no progress after repeated attempts — re-observe before acting again` };
        }
        // Immediate failures and visual no-progress are independent latches. When both are active,
        // preserve the more specific recovery-budget diagnosis; otherwise the generic three-strike
        // guard would mask it after a failed observe and make recovery state appear to have changed.
        if (this.failedActingStreak >= 3) {
          return { ok: false, action: cmd.action, driver,
            error: 'three consecutive input actions failed — do not click again until you re-observe or reopen the intended app and use handles from that fresh target',
            summary: `${cmd.action} refused: repeated input failures require a fresh observation` };
        }
        // Frame identity (Phase 2). The gate above proves the newest capture is of the right WINDOW;
        // this proves it is the right PICTURE — the stale-frame-of-the-same-window case that pid and
        // windowId cannot see. Deliberately LAST of the refusal checks: the recovery and repeated-
        // failure latches carry more specific diagnoses, and a generic staleness message must not
        // mask them.
        //
        // Applied only when a frame was actually minted, or when the caller named one. A capture
        // with no usable mapping geometry (a degraded window capture) mints no frame, and those
        // paths are already vouched for by the observe-before-act gate above — refusing them here
        // would break working behaviour in the name of a check that has nothing to check against.
        if (needsFreshFrame && (this.frames.current() || cmd.frameId)) {
          const currentFrame = this.frames.current();
          const liveBounds = target && currentFrame?.captureKind === 'window'
            ? await this.liveWindowFrame(target)
            : undefined;
          const baseline = this.observedLiveWindowFrame ?? currentFrame?.bounds;
          const validationBounds = liveBounds && currentFrame && baseline
            ? {
                x: currentFrame.bounds.x,
                y: currentFrame.bounds.y,
                w: currentFrame.bounds.w + (liveBounds.w - baseline.w),
                h: currentFrame.bounds.h + (liveBounds.h - baseline.h),
              }
            : liveBounds;
          const check = this.frames.check({
            // A successful semantic refresh deliberately supersedes the model's old picture. The
            // query is resolved below from the replacement tree; only raw/handle actions remain
            // bound to the caller's original frame id.
            frameId: semanticFrameRegrounded ? undefined : cmd.frameId,
            pid: target?.pid,
            windowId: target?.windowId,
            liveBounds: validationBounds ?? undefined,
          });
          if (!check.ok) {
            // "Your picture is old" is a refreshable condition, not a failure — unless the caller
            // supplied raw pixels, which are meaningless against any other picture. A keystroke and
            // a named target both survive a new capture, so refuse only what genuinely cannot.
            //
            // Refusing them was a deadlock, observed live: the messaging phase gate told the model
            // that pressing Return was the ONLY legal action, while this check refused that same
            // Return as expired and told it to observe first. Each side demanded what the other
            // forbade, and the run spun until the user killed it.
            const usesRawCoordinates = cmd.x != null || cmd.y != null
              || cmd.toX != null || cmd.toY != null;
            const refreshable = !usesRawCoordinates
              && (check.reason === 'expired' || check.reason === 'superseded' || check.reason === 'geometry-changed');
            if (!refreshable) {
              return {
                ok: false, action: cmd.action, driver,
                error: `stale frame (${check.reason}): ${check.note}`,
                summary: `${cmd.action} refused: ${check.reason} — observe again before acting`,
              };
            }
            if (!target) {
              return {
                ok: false, action: cmd.action, driver,
                error: `stale frame (${check.reason}): ${check.note}`,
                summary: `${cmd.action} refused: ${check.reason} — observe the intended window before acting`,
              };
            }
            try {
              // Capture only; observation deliberately never fronts the app, so keyboard focus —
              // the thing a pending Return depends on — is untouched.
              const refreshed = await this.observeTarget(target, cwd, session, {
                action: 'observe',
                ...(cmd.query?.trim() ? { query: cmd.query } : {}),
                maxElements: cmd.maxElements,
                includeScreenshot: true,
              });
              if (!refreshed.ok) throw new Error(refreshed.error || refreshed.summary);
              semanticFrameRegrounded = true;
              this.lastSemanticRegrounding = {
                notification: `stale frame (${check.reason})`,
                windowChanged: false,
              };
            } catch (error: any) {
              return {
                ok: false, action: cmd.action, driver,
                error: `the planning frame was ${check.reason} and could not be refreshed: ${String(error?.message || error)}`,
                summary: `${cmd.action} refused: ${check.reason} — observe again before acting`,
              };
            }
          }
        }
        const hasAxHandle = !!(cmd.elementToken || cmd.elementIndex != null || cmd.query?.trim());
        const choice = chooseMechanism(
          surface ?? { kind: 'native-window', backgroundCapable: true },
          cmd.action, { delivery, hasAxHandle },
        );
        this.lastMechanismChoice = choice.mechanism;
        if (choice.mechanism === 'unsupported') {
          return { ok: false, action: cmd.action, driver, error: choice.reason, summary: `${cmd.action} refused: ${choice.reason}` };
        }
        // Foreground physical delivery moves the ONE real cursor and needs the window in front — that
        // is an agent takeover of input, so record it (and emit a visible status) rather than have
        // the cursor move with no indication of who is driving.
        if (choice.requiresForeground && surface) {
          this.surfaces.claimInput(surface.id, 'agent', { force: true });
        }
      }

      switch (cmd.action) {
        case 'status': {
          const data = await this.call('health_report');
          const checks = Array.isArray(data?.checks) ? data.checks : [];
          const ax = checks.find((c: any) => c.name === 'tcc_accessibility');
          const screen = checks.find((c: any) => c.name === 'tcc_screen_recording');
          this.lastStatus = {
            accessibility: ax ? ax.status === 'pass' : null,
            screenRecording: screen ? screen.status === 'pass' : null,
          };
          // Embedded mode intentionally runs as a child of ai.bimax.cli, so the helper executable
          // has no standalone CFBundleIdentifier. TCC grants belong to the responsible host. The
          // upstream health report calls that expected identity shape a failure even when every
          // real observation/input capability passes; do not misreport a fully working runtime as
          // degraded for that one inapplicable check.
          const failedChecks = checks.filter((check: any) => check?.status === 'fail');
          const embeddedIdentityOnly = this.lastStatus.accessibility === true
            && this.lastStatus.screenRecording === true
            && failedChecks.length === 1
            && failedChecks[0]?.name === 'bundle_identity';
          const overall = embeddedIdentityOnly ? 'ready' : (data?.overall || 'ready');
          const details = embeddedIdentityOnly
            ? {
              ...data, overall: 'ready', attribution: 'embedded_host',
              note: 'Bundle identity is supplied by the responsible Bimax host; native permissions and capabilities passed.',
            }
            : data;
          // Surface the session's measured switch latency alongside permissions: the p95 target for
          // target switching is only meaningful if the number is readable without a debugger.
          const switchStats = this.switchLatency.summary();
          // `health_report` is NOT session-scoped: it answered "session_active: pass, overall:
          // ready" while every session-scoped call was being rejected for a retired session. A
          // status that cannot be wrong about liveness is the whole point of a status verb, so
          // probe a real session-scoped call when there is a target to probe it against, and say
          // plainly when there is not — never let the driver's self-report stand in for evidence.
          let sessionProbe: { probed: boolean; reachable: boolean | null; note: string };
          if (target?.pid && target?.windowId) {
            try {
              await this.call('get_window_state', {
                pid: target.pid, window_id: target.windowId, session,
                include_screenshot: false, max_elements: 1,
              });
              sessionProbe = { probed: true, reachable: true, note: 'a session-scoped call succeeded' };
            } catch (probeErr: any) {
              sessionProbe = {
                probed: true, reachable: false,
                note: `a session-scoped call was rejected: ${String(probeErr?.message || probeErr).slice(0, 200)}`,
              };
            }
          } else {
            sessionProbe = {
              probed: false, reachable: null,
              note: 'no target window yet, so session liveness was NOT probed — permissions below say nothing about it. Run open/observe first.',
            };
          }
          const liveOverall = sessionProbe.reachable === false ? 'degraded' : overall;
          return {
            ok: liveOverall !== 'failed' && sessionProbe.reachable !== false,
            action: cmd.action, driver, ...this.lastStatus,
            details: {
              ...(details as Record<string, unknown>),
              overall: liveOverall,
              sessionProbe,
              targetSwitchLatencyMs: switchStats,
            },
            summary: `Bimax Computer Use ${liveOverall}${sessionProbe.reachable === false ? ' — session unreachable' : ''}`
              + `${sessionProbe.probed ? '' : ' (session liveness unprobed)'}`
              + `${switchStats.count ? ` · target switch p50 ${switchStats.p50}ms / p95 ${switchStats.p95}ms over ${switchStats.count}` : ''}`,
          };
        }
        case 'request_access': {
          const data = await this.call('check_permissions', { prompt: true });
          this.lastStatus = { accessibility: !!data?.accessibility, screenRecording: !!data?.screen_recording };
          return { ok: true, action: cmd.action, driver, ...this.lastStatus, details: data, summary: 'Bimax Computer Use permission check completed' };
        }
        case 'record_start': {
          const data = await this.startRecording(cwd, cmd);
          return {
            ok: true, action: cmd.action, driver, details: data,
            recording: { enabled: true, outputDir: this.recording.outputDir, scope: this.recording.scope, captureSafe: this.recording.captureSafe },
            summary: `computer-use recording started${cmd.recordVideo === false ? '' : ' with screen video'} → ${this.recording.outputDir} (capturing ${this.recording.scope}${this.recording.captureSafe ? '' : ' — WHOLE DISPLAY, explicitly approved'})`,
          };
        }
        case 'record_status': {
          const data = await this.call('get_recording_state');
          const enabled = !!data?.enabled;
          return {
            ok: true, action: cmd.action, driver, details: data,
            recording: {
              enabled, outputDir: String(data?.output_dir || this.recording.outputDir || '') || undefined,
              videoPath: String(data?.last_video_path || '') || undefined,
              error: String(data?.last_error || this.recording.error || '') || undefined,
              scope: enabled ? this.recording.scope : undefined,
              captureSafe: enabled ? this.recording.captureSafe : undefined,
            },
            summary: enabled ? `computer-use recording active → ${data?.output_dir || this.recording.outputDir}` : 'computer-use recording is off',
          };
        }
        case 'record_stop': {
          const wasRecording = this.recording.started;
          const data = await this.call('stop_recording');
          this.recording.markStopped();
          const videoPath = String(data?.last_video_path || data?.video_path || '') || undefined;
          // "Stopped" with nothing to show for it is a success report for work that never happened:
          // record_start is gated behind an opt-in the caller may never have satisfied, and stopping
          // a recording that was never running still answered ok:true, "recording stopped".
          if (!videoPath && !wasRecording) {
            return {
              ok: false, action: cmd.action, driver, details: data,
              recording: { enabled: false, outputDir: this.recording.outputDir },
              actionResult: { delivered: false, observed: 'no-change', confidence: 'proven', failureReason: 'no recording was running' },
              error: 'no recording was running, so nothing was stopped and no video exists',
              summary: 'record_stop: nothing was recording',
            };
          }
          return {
            ok: true, action: cmd.action, driver, details: data,
            recording: { enabled: false, outputDir: this.recording.outputDir, videoPath },
            summary: `computer-use recording stopped${videoPath ? ` → ${videoPath}` : this.recording.outputDir ? ` → ${this.recording.outputDir}` : ''}`,
          };
        }
        case 'apps': {
          const data = await this.call('list_apps');
          const all: any[] = Array.isArray(data?.apps) ? data.apps : [];
          // `list_apps` returns every installed app carrying a per-app `windows` array the driver
          // never fills — measured empty even for RUNNING apps — plus launch paths and last-used
          // timestamps no caller acts on. 106 apps in that shape cost 22KB of context to answer
          // "what can I open". Project the fields a caller can act on, put running apps first
          // (those are the ones `focus` can reach), and let `query` narrow the rest by name.
          const wanted = String(cmd.query || '').trim().toLocaleLowerCase();
          const projected = all
            .map(app => ({
              name: stripInvisibleMarks(String(app?.name || '')),
              bundle_id: app?.bundle_id,
              running: !!app?.running,
              ...(app?.running ? { pid: Number(app?.pid || 0), active: !!app?.active } : {}),
            }))
            .filter(app => !wanted || app.name.toLocaleLowerCase().includes(wanted)
              || String(app.bundle_id || '').toLocaleLowerCase().includes(wanted))
            .sort((a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name));
          const running = projected.filter(app => app.running).length;
          return {
            ok: true, action: cmd.action, driver,
            details: { apps: projected, total: all.length, running, filteredBy: wanted || undefined },
            summary: `${projected.length} application(s)${wanted ? ` matching "${wanted}"` : ''} — ${running} running`
              + `${projected.length < all.length ? ` (of ${all.length} installed; pass query to narrow)` : ''}`,
          };
        }
        case 'windows': {
          const data = await this.call('list_windows', target?.pid ? { pid: target.pid } : {});
          const all: any[] = Array.isArray(data?.windows) ? data.windows : [];
          // Most of what the WindowServer enumerates cannot be a target: full-width 33px menu-bar
          // proxies, 64×64 service surfaces and 0×0 placeholders, all untitled. Measured 35–52
          // entries per call of which 3 were real. Suppress only the provably unactionable ones —
          // untitled AND degenerate geometry — so a titled window or a legitimately off-screen one
          // (another Space) is never hidden from a caller trying to find it.
          const degenerate = (w: any) => !String(w?.title || '').trim()
            && (Number(w?.bounds?.height || 0) <= 40 || Number(w?.bounds?.width || 0) <= 64);
          // The driver's own capture surface enumerates as a full-screen window above the app it is
          // driving. It is never a target and offering it as one invites a click into our own overlay.
          const isOwnCaptureSurface = (w: any) => /^bimax-computer-use/i.test(String(w?.app_name || ''));
          const windows = all.filter(w => !degenerate(w) && !isOwnCaptureSurface(w));
          const suppressed = all.length - windows.length;
          return {
            ok: true, action: cmd.action, driver, pid: target?.pid,
            details: { ...data, windows, suppressed },
            summary: `found ${windows.length} addressable window(s)${target?.app ? ` for ${target.app}` : ''}`
              + `${suppressed ? ` (${suppressed} untitled menu-bar/service surfaces hidden)` : ''}`,
          };
        }
        case 'open': {
          if (!cmd.app?.trim() && !cmd.bundleId?.trim()) throw new Error('open needs app or bundleId');
          const rawApp = cmd.app?.trim();
          // A bundle id handed in as `app` is a routine model slip — `{"action":"open","app":
          // "com.apple.Messages"}` cost a whole turn on "No installed macOS app found for name
          // 'com.apple.Messages'". Launch Services has no app NAMED that, and asking it to resolve a
          // bundle id as a display name is a guaranteed miss, so recognise the shape and address the
          // OS with the field it actually understands.
          const appIsBundleShaped = !!rawApp && looksLikeBundleId(rawApp);
          const requestedApp = appIsBundleShaped ? undefined : rawApp;
          // The sidecar's name lookup can miss an app whose bundle id launches fine, so resolve the
          // bundle id from the OS when the caller gave only a name. Asking Launch Services covers
          // every app on the machine instead of a hand-maintained list of well-known aliases.
          const requestedBundleId = cmd.bundleId?.trim()
            || (appIsBundleShaped ? rawApp : undefined)
            || await this.resolveBundleId(requestedApp);
          // A second instance is only meaningful for an app the OS is willing to run twice. Rather
          // than carrying a list of macOS singletons, ask whether this app is ALREADY running: a
          // running system process cannot be duplicated, and requesting it fails confusingly.
          const alreadyRunning = cmd.newInstance
            ? await this.isAppRunning(requestedApp, requestedBundleId)
            : false;
          const instanceArgs = cmd.newInstance && !alreadyRunning
            ? { creates_new_application_instance: true }
            : {};
          let data: any;
          try {
            data = await this.call('launch_app', {
              ...(requestedBundleId ? { bundle_id: requestedBundleId } : { name: requestedApp! }),
              ...instanceArgs,
            });
          } catch (err: any) {
            const reason = String(err?.message || err);
            // "No installed app found" is the ONE launch failure that proves nothing started, so it
            // is the only one worth asking a different way. Every other error stands: a timeout or a
            // permission failure may well have delivered, and retrying those risks a second
            // instance the user never asked for.
            if (!/no installed macos app found/i.test(reason)) throw err;
            // Ordered, bounded, each a genuinely DIFFERENT question for Launch Services.
            const retries: Array<Record<string, string>> = [];
            // A model that remembers a historical bundle id often still passes the correct human
            // name beside it (com.apple.iChat + "Messages").
            if (requestedBundleId && requestedApp) retries.push({ name: requestedApp });
            // A bundle id whose LAST component is the app's display name — com.apple.Messages, whose
            // real id is com.apple.MobileSMS, so neither the name nor the id lookup can succeed and
            // the run dead-ends on a wrong guess the model has no way to correct. The leaf is only
            // ever offered to Launch Services as a name: if no such app exists, this still fails.
            if (appIsBundleShaped) {
              const leaf = stripInvisibleMarks(rawApp!).trim().split('.').pop()!.trim();
              if (leaf && !appNamesMatch(leaf, rawApp!)) retries.push({ name: leaf });
            }
            let launched: any;
            let lastError: any = err;
            for (const attempt of retries) {
              try {
                launched = await this.call('launch_app', { ...attempt, ...instanceArgs });
                break;
              } catch (retryError: any) {
                lastError = retryError;
                if (!/no installed macos app found/i.test(String(retryError?.message || retryError))) throw retryError;
              }
            }
            if (!launched) throw lastError;
            data = launched;
          }
          const requestedWindowId = Number(cmd.windowId || 0);
          // `open` with an explicit window is the same caller choice `focus` makes; honour it for the
          // rest of the session, and drop a stale pin when the caller did not name one.
          if (!requestedWindowId) this.pinnedWindow = null;
          let launchedWindows = Array.isArray(data?.windows) ? data.windows : [];
          let window = requestedWindowId
            ? launchedWindows.find((candidate: any) => Number(candidate?.window_id) === requestedWindowId)
            : launchedWindows[0];
          // A caller may already have discovered the exact live window through `windows` (for
          // example, a file handler selected by Launch Services). Honour that identity instead of
          // silently taking the first same-app window. Refresh once because launch responses can
          // omit pre-existing windows even though list_windows can see them.
          if (requestedWindowId && !window && Number(data?.pid || 0)) {
            const listed = await this.call('list_windows', { pid: Number(data.pid) });
            launchedWindows = Array.isArray(listed?.windows) ? listed.windows : launchedWindows;
            window = launchedWindows.find((candidate: any) => Number(candidate?.window_id) === requestedWindowId);
          }
          if (requestedWindowId && !window) {
            throw new Error(`window ${requestedWindowId} is not available in the launched application; run action=windows and choose a current window id`);
          }
          let opened: ComputerTarget = {
            app: stripInvisibleMarks(String(data?.name || cmd.app || cmd.bundleId || '')),
            pid: Number(data?.pid || 0),
            windowId: Number(window?.window_id || 0) || undefined,
          };
          if (!opened.pid) throw new Error(`opened ${opened.app || 'application'} but received no target pid`);
          // Never surface a bundle id or an empty "?" as the app name — resolve the human name.
          opened.app = await this.resolveAppName(opened.pid, opened.app);
          // Remember who was active BEFORE ownership moves, so the switch transaction below knows
          // what it is switching FROM (and can tell a real switch from a re-open of the same app).
          const previousTarget = this.targets.current();
          // open() establishes ownership: from here every action routes to THIS app/window.
          this.targets.set(opened);
          if (requestedWindowId) this.pinnedWindow = { pid: opened.pid, windowId: requestedWindowId };
          // Resume: if this is the first open of a fresh process and a persisted session for this
          // same app is on disk, restore its bounded history before this open records onto it.
          this.maybeResumeHistory(cwd);
          // A new app is a fresh visual context: reset the no-progress baseline so the opened app's
          // first frame is not compared against the previous app's screen, and give the recovery
          // authority a fresh budget for the new app.
          this.prevFrameHash = undefined;
          this.noChangeStreak = 0;
          this.failedActingStreak = 0;
          this.recovery.reset();
          // launch_app intentionally suppresses activation. In visible mode that left the new app
          // off-screen while open() claimed it was ready, so observe walked the global menu bar and
          // every screenshot-local action was grounded against the wrong state. Activate first,
          // allow WindowServer to settle, then reacquire the actual visible application window.
          let activated: { target: ComputerTarget; evidence: Partial<DesktopResult>; frontmostWarning?: string; switchMs?: number };
          try {
            activated = await this.activateAndCapture(opened, cwd, session, delivery, ctx, previousTarget);
          } catch (captureError: any) {
            // The launch ALREADY happened; the app is on the user's machine no matter what this
            // call returns. Letting the capture failure escape as a plain throw reported
            // delivered:false for a side effect that did occur — observed live when a retired
            // session made the first observation fail: `open` said "failed" while TextEdit was
            // starting. The documented consequence of that lie is a retry, i.e. a second open.
            // Report the launch as delivered and the VERIFICATION as the thing that failed.
            const detail = String(captureError?.message || captureError);
            return {
              ok: false, action: cmd.action, driver,
              app: opened.app, pid: opened.pid, windowId: opened.windowId, details: data,
              actionResult: {
                delivered: true, observed: 'unverified', confidence: 'unknown',
                failureReason: `launched, but the first observation failed: ${detail}`,
              },
              error: `${opened.app} LAUNCHED as pid ${opened.pid}, but its first frame could not be captured: ${detail}. Do NOT open it again — it is already running; observe it instead.`,
              summary: `opened ${opened.app} as pid ${opened.pid}, but the first screen capture failed — the app IS running; observe before acting`,
            };
          }
          opened = activated.target;
          const frontmostWarning = activated.frontmostWarning;
          return {
            ok: true, action: cmd.action, driver, app: opened.app, pid: opened.pid,
            windowId: opened.windowId, details: data, ...activated.evidence, frontmostWarning,
            summary: `opened ${opened.app} as pid ${opened.pid}${opened.windowId ? ` window ${opened.windowId}` : ''}${frontmostWarning ? `; WARNING: ${frontmostWarning}` : '; fresh screen attached'}`,
          };
        }
        case 'focus': {
          // Switch to an app this session ALREADY has open, without re-launching it. Re-launching a
          // running app risks a second instance and discards whatever state the app is in — which is
          // exactly what every cross-app workflow (copy here, paste there; pick a file here, drop it
          // there) needs to preserve. focus returns a fresh frame, so input is legal immediately
          // afterwards under the same "act only on the newest frame of the exact target" rule.
          const wanted = cmd.app?.trim();
          const byPid = Number(cmd.pid || 0);
          const wantWindowId = Number(cmd.windowId || 0) || undefined;
          let registered = byPid
            ? this.targets.all().find(t => t.pid === byPid) || null
            : wanted ? this.targets.find(wanted) : this.targets.current();
          // Not opened by this session does NOT mean unavailable: the app is very often already
          // running because the user left it open. Adopt its live window instead of dead-ending on
          // `open`, which would re-launch it and throw away whatever state it is in.
          if (!registered && wanted) {
            const adopted = await this.adoptRunningApp(wanted, wantWindowId);
            if (adopted) {
              this.targets.set(adopted);
              registered = adopted;
            }
          }
          if (!registered) {
            const known = this.targets.all().map(t => t.app).filter(Boolean);
            throw new Error(wanted || byPid
              ? `${wanted || `pid ${byPid}`} is not running (no on-screen window found)${known.length ? `; open in this session: ${known.join(', ')}` : ''} — use action=open to launch it`
              : 'focus needs app or pid');
          }
          // An app can own several windows (a document window plus its main browser/list window).
          // Honour an explicit windowId so a caller that enumerated `windows` can select the exact
          // surface, rather than being pinned to whichever one the picker preferred.
          if (wantWindowId) {
            this.targets.retargetWindow(registered.pid, wantWindowId);
            registered = { ...registered, windowId: wantWindowId };
            this.pinnedWindow = { pid: registered.pid, windowId: wantWindowId };
          } else if (this.pinnedWindow?.pid !== registered.pid) {
            // Focusing a different app, or the same app with no window named: the previous pin is
            // not about this surface any more and must not follow the session around.
            this.pinnedWindow = null;
          }
          // Capture the predecessor before activation moves ownership, so the switch transaction
          // measures a real app-to-app switch rather than reading the destination as its own origin.
          const previousTarget = this.targets.current();
          this.targets.activate(registered.pid);
          // A different app is a different visual context: the no-progress baseline must not compare
          // this app's first frame against the one we just switched away from.
          this.prevFrameHash = undefined;
          this.noChangeStreak = 0;
          this.recovery.reset();
          const switched = await this.activateAndCapture(registered, cwd, session, delivery, ctx, previousTarget);
          return {
            ok: true, action: cmd.action, driver, app: switched.target.app, pid: switched.target.pid,
            windowId: switched.target.windowId, ...switched.evidence, frontmostWarning: switched.frontmostWarning,
            summary: `focused ${switched.target.app} as pid ${switched.target.pid}${switched.target.windowId ? ` window ${switched.target.windowId}` : ''}${switched.frontmostWarning ? `; WARNING: ${switched.frontmostWarning}` : '; fresh screen attached'}`,
          };
        }
        case 'observe':
        case 'screenshot': {
          // Ownership is cleared at every user-turn boundary (dispose), but the APP stays open and
          // the conversation carries straight on ("the chat is open, now send it"). Turn 2 then hit
          // a dead end: observe refused for want of a target, every acting verb refused for want of
          // a fresh frame, and the model never called `open` because — correctly — the app was
          // already open. Re-acquire the remembered window here instead. This restores identity
          // only: no input can ride on it, because acting verbs still demand a fresh frame that
          // only this observation can produce, and the governor still gates them individually.
          let capture = target ?? await this.reacquireLastTarget();
          // Reconcile every explicit observation with AX focus + the visible same-app window list.
          // This both acquires a late-rendering first window and adopts a newly focused document;
          // only a genuinely window-less app falls back, and only for `screenshot`.
          if (capture?.pid) {
            const refreshed = await this.refreshTargetWindow(capture);
            if (refreshed.windowId && refreshed.windowId !== capture.windowId) {
              capture = refreshed;
              this.targets.retargetWindow(capture.pid, refreshed.windowId);
            }
          }
          if (!capture?.windowId) {
            if (cmd.action === 'screenshot') return this.fallback.run(cmd, ctx);
            // Name the app and the ONE verb that fixes this. The bare "open or select an application
            // window first" read as advice rather than an instruction, and the model answered it by
            // retrying observe and click in a loop until the turn was interrupted.
            const stale = this.lastOwnedTarget?.app;
            throw new Error(stale
              ? `no window is currently owned — ${stale} is no longer open at the window Bimax was driving. Call action=open with app="${stale}" to establish a target, then observe.`
              : 'no application window is owned yet; call action=open with the app you want to control before observe or any input');
          }
          const observed = await phaseTrace.time('observeTarget', () => this.observeTarget(capture, cwd, session, cmd));
          // observeTarget can reconcile a transient/focused same-process window to the exact window
          // whose pixels it ultimately captured. Make that captured identity authoritative for the
          // next action. Otherwise ownership can retain the pre-reconciliation child id while the
          // frame registry correctly names its parent, causing an endless target-changed refusal.
          // Commit ownership from the immutable frame that actually owns the returned pixels. A
          // provisional same-app child id may be replaced while the capture is settling; trusting
          // the earlier result field over FrameRegistry split target ownership from coordinates.
          const capturedFrame = this.frames.current();
          const observedWindowId = capturedFrame?.pid === capture.pid && capturedFrame.windowId
            ? capturedFrame.windowId
            : Number(observed.windowId || 0) || capture.windowId;
          observed.windowId = observedWindowId;
          if (observed.ok && observed.pid === capture.pid && observedWindowId
            && observedWindowId !== this.targets.current()?.windowId) {
            this.targets.retargetWindow(capture.pid, observedWindowId);
          }
          // An explicit re-observation that actually produced fresh evidence (a captured frame) is
          // the corrective step the recovery authority requires — only then does a latched
          // no-progress stop clear. Merely issuing observe/screenshot (or a capture that failed to
          // produce a frame) does NOT reset or bypass the latch.
          if (observed.ok && observed.frameHash) this.recovery.reset();
          // `screenshot` and `observe` were the same call under two names: identical payload, same
          // summary, ~21KB each. A caller that only wants to LOOK paid for the full element list
          // every time, and a caller comparing the two learned nothing from having both.
          //
          // They differ now in what they RETURN, not in what they do: the capture, the frame and the
          // element map are produced identically, and the map is cached on the runtime, so `click
          // query=…` works exactly the same after a screenshot. Only the echo of the element arrays
          // is dropped — which is the part that costs the tokens.
          if (cmd.action === 'screenshot' && observed.ok) {
            const { elements, tree, ...picture } = observed;
            const count = Array.isArray(elements) ? elements.length : 0;
            return {
              ...picture,
              elementCount: count,
              summary: `${observed.summary || 'captured'}${count ? ` — ${count} element(s) resolved and kept for targeting, not listed here; use observe to see them` : ''}`,
            };
          }
          return observed;
        }
        case 'cursor': {
          if (delivery === 'foreground') return this.fallback.run({ action: 'cursor' }, ctx);
          const data = await this.call('get_cursor_position');
          return { ok: true, action: cmd.action, driver, x: data?.x, y: data?.y, details: data, summary: `cursor at ${data?.x},${data?.y}` };
        }
        case 'frontmost': {
          const app = await this.frontmostApp();
          return { ok: true, action: cmd.action, driver, app, summary: `frontmost app: ${app || '(unknown)'}` };
        }
        case 'click': {
          if (!target) return this.fallback.run(cmd, ctx);
          const args: any = { pid: target.pid, session, delivery_mode: delivery, button: cmd.button || 'left' };
          if (cmd.modifier?.length) args.modifier = cmd.modifier;
          if (target.windowId) args.window_id = target.windowId;
          let resolvedLabel = '';
          let targeting: DesktopResult['targeting'];
          let expectedElement: ObservedElement | undefined;
          let coordinateSource = '';
          let rawPixelTarget = false;
          if (cmd.query?.trim()) {
            const resolved = this.resolveObservedElement(cmd.query, target);
            targeting = resolved.targeting;
            expectedElement = resolved;
            this.assertClickableSemanticTarget(resolved);
            resolvedLabel = resolved.label || cmd.query;
            const point = this.elementCenterInScreenshot(resolved.frame);
            if (delivery === 'background' && resolved.elementToken) {
              args.element_token = resolved.elementToken;
              coordinateSource = 'accessibility element token';
            } else if (delivery === 'background' && resolved.elementIndex != null) {
              args.element_index = resolved.elementIndex;
              coordinateSource = 'accessibility element index';
            } else if (point) {
              // Use the visible rectangle as the action target. Native AX activation is retained only
              // for controls without geometry; it is slower and frequently reports a no-op in Settings.
              args.x = point.x;
              args.y = point.y;
              coordinateSource = 'native label frame';
            } else if (resolved.elementToken) args.element_token = resolved.elementToken;
            else if (resolved.elementIndex != null) args.element_index = resolved.elementIndex;
          } else if (cmd.elementToken || cmd.elementIndex != null) {
            const resolved = this.resolveObservedHandle(target, cmd);
            expectedElement = resolved;
            this.assertClickableSemanticTarget(resolved);
            resolvedLabel = resolved.label || resolved.value || '';
            if (delivery === 'foreground') {
              const point = this.elementCenterInScreenshot(resolved.frame);
              if (!point) throw new Error('element has no visible screenshot rectangle; observe again or choose a visible x/y point');
              args.x = point.x;
              args.y = point.y;
              coordinateSource = 'semantic element frame';
            } else if (cmd.elementToken) args.element_token = cmd.elementToken;
            else args.element_index = Math.floor(cmd.elementIndex!);
          }
          else {
            if (cmd.x == null || cmd.y == null) throw new Error('click needs query, elementToken/elementIndex, or x+y');
            if (!this.observedTarget || this.observedTarget.pid !== target.pid || this.observedTarget.windowId !== target.windowId) {
              throw new Error('screenshot click needs a fresh image of this exact window; observe once, then click the visible point');
            }
            const width = this.observedTarget?.width;
            const height = this.observedTarget?.height;
            if (!width || !height) throw new Error('latest screenshot has no usable dimensions');
            const x = cmd.normalized ? scaleNormalizedPoint(cmd.x, width - 1) : Math.round(cmd.x);
            const y = cmd.normalized ? scaleNormalizedPoint(cmd.y, height - 1) : Math.round(cmd.y);
            if (x < 0 || y < 0 || x >= width || y >= height) {
              throw new Error(`screenshot click ${x},${y} is outside the latest image (${width}x${height})`);
            }
            args.x = x; args.y = y;
            rawPixelTarget = true;
            coordinateSource = cmd.normalized ? 'normalized screenshot point' : 'screenshot pixel';
            // Resolve what the guessed pixel ACTUALLY lands on: a slider is redirected to set_value;
            // any other control gets NAMED in the summary (so a near-miss onto the wrong icon is
            // visible, not an anonymous "click delivered"), and a compact control is re-centered so
            // an edge-graze can't deliver-but-activate-nothing — the exact WhatsApp send-miss.
            const landed = this.actionableElementAtScreenshotPoint({ x, y });
            if (landed?.element.role === 'AXSlider') {
              throw new Error(`screenshot point ${x},${y} is inside "${landed.element.label || 'Slider'}"; use set_value with its fresh semantic handle so the requested value is exact`);
            }
            if (landed) {
              expectedElement = landed.element;
              resolvedLabel = landed.element.label || landed.element.value || '';
              if (SNAP_TO_CENTER_AX_ROLES.has(String(landed.element.role || ''))) {
                const center = frameCenter(landed.screenshotFrame);
                if (pixelInImage(center, { width, height })) {
                  args.x = center.x; args.y = center.y;
                  coordinateSource = `${coordinateSource}, centered in "${resolvedLabel || landed.element.role}"`;
                }
              }
            }
          }
          if (rawPixelTarget) await this.assertRawPixelFrameCurrent(target, cwd, session, {
            x: Number(args.x), y: Number(args.y),
          });
          if (cmd.count) args.count = Math.floor(cmd.count);
          if (cmd.debugImageOut) args.debug_image_out = path.resolve(cmd.debugImageOut);
          // The sidecar's foreground pixel rung still PID-posts a synthetic event and moves only
          // its overlay cursor. SwiftUI/System Settings can ignore that event. Visible mode means
          // a real global CGEvent: front the pinned window, glide the macOS cursor, click, then use
          // the same sidecar session for the fresh post-action capture.
          // Background delivery is only background when it routes through an ACCESSIBILITY HANDLE.
          // Handed raw coordinates the driver has nothing to address, so it synthesizes a real
          // global CGEvent — the very thing the Space guard below refuses for foreground. The two
          // together were a hole: the guard is foreground-only, and its own remediation text
          // recommends `deliveryMode="background"` as the way to act on an off-Space window. So the
          // documented escape from "this click would land in the wrong app" was a click that landed
          // in the wrong app, unguarded. Measured on an off-Space Notes window: a background click
          // came back `path: "cgevent"` while a fullscreen ChatGPT owned those screen coordinates.
          //
          // Refuse instead of silently downgrading — hermes-agent takes the same line for an
          // unsupported delivery mode (`foreground_unsupported`, tools/computer_use/cua_backend.py):
          // a delivery that cannot be honoured as asked must be reported, never quietly swapped.
          if (delivery === 'background' && args.x != null && args.y != null
            && args.element_token == null && args.element_index == null
            && await this.targetWindowOffScreen(target)) {
            throw new Error(
              `${target.app || `pid ${target.pid}`} window ${target.windowId} is not on the active Space, and this background click has only a screen COORDINATE to aim at — `
              + 'with no accessibility handle the driver must synthesize a real cursor event, which would land in whatever app is actually visible at that point. '
              + 'Background delivery is safe here only through a named target: re-observe and pass query/elementToken/elementIndex so the click routes through accessibility. '
              + `Otherwise call focus with app="${target.app || ''}" to bring the window to the visible Space first.`,
            );
          }
          if (delivery === 'foreground' && args.x != null && args.y != null) {
            const screenshotPoint = { x: Number(args.x), y: Number(args.y) };
            let globalPoint;
            try {
              globalPoint = await this.preparePhysicalPoint(target, screenshotPoint, expectedElement);
            } catch (error) {
              // An occluding window blocks the PIXEL ROUTE, not the target. A semantically named
              // element can still be activated through accessibility, which uses no coordinates and
              // therefore cannot be covered.
              //
              // Only a plain single left click may be re-routed. Accessibility activation is a press:
              // it cannot express a right-click, a modifier-click, or a double-click, and quietly
              // turning one of those into a plain press would deliver a DIFFERENT action than asked.
              // Raw-pixel callers are excluded too — they asked for a point, and when that point is
              // covered the refusal (with its remediation) is the honest answer.
              const reRoutable = !rawPixelTarget
                && (cmd.button || 'left') === 'left'
                && !cmd.modifier?.length
                && (cmd.count || 1) === 1;
              const handle = reRoutable ? accessibilityHandle(expectedElement) : null;
              if (!(error instanceof OccludedPointError) || !handle) throw error;
              return await this.clickThroughAccessibility({
                target, cwd, session, driver, cmd, args, handle, occlusion: error,
                resolvedLabel, targeting, expectedElement,
              });
            }
            const native = await this.fallback.run({
              action: 'click', x: globalPoint.x, y: globalPoint.y,
              button: cmd.button || 'left', count: cmd.count || 1,
              modifier: cmd.modifier,
              app: target.app, normalized: false,
            }, ctx);
            if (!native.ok) throw new Error(native.error || native.summary);
            this.verifyPhysicalClick(target, globalPoint, native);
            // A right-click usually opens a context menu — a separate OS window a window-scoped PNG
            // cannot show. Return the full display so the model actually SEES the menu it opened.
            const evidence = (cmd.button === 'right')
              ? await this.displayObservation(target, ctx)
              : await this.postActionEvidence(target, cwd, session);
            if (cmd.button !== 'right') this.synthesizeStatefulClickPostcondition(expectedElement, evidence);
            // WindowServer can keep a just-dismissed sheet enumerable for a short grace period.
            // Trust the verified physical activation of an explicit dismissal control so the stale
            // window record does not block the very next click on the now-visible parent page.
            if (/^(?:done|close|cancel|ok)$/i.test(resolvedLabel.trim())) {
              this.transientDialogFrame = null;
              evidence.completionGuidance = COMPUTER_COMPLETION_GUIDANCE;
            }
            return {
              ok: true, action: cmd.action, driver, app: target.app, pid: target.pid, windowId: target.windowId,
              details: {
                path: 'native-global-cgevent', screenshotPoint,
                requestedGlobalPoint: { x: globalPoint.x, y: globalPoint.y },
                landedGlobalPoint: native.x != null && native.y != null ? { x: native.x, y: native.y } : undefined,
                inputVerified: native.x != null && native.y != null,
              },
              actionReceipt: {
                kind: 'pointer',
                target: {
                  app: target.app, pid: target.pid, windowId: target.windowId,
                  element: expectedElement?.label || expectedElement?.value, role: expectedElement?.role,
                },
                preflight: {
                  recipientPid: globalPoint.preflight?.recipientPid,
                  recipientApp: globalPoint.preflight?.recipientApp,
                  // Absence of evidence is NOT evidence of ownership. The probe returns an empty
                  // preflight whenever it could not answer — most commonly because the AX hit-test
                  // helper is unavailable — and the old fallback turned that silence into
                  // `windowMatched: true` with the reassuring reason below. Measured live: with the
                  // target window parked on an inactive Space, every click was delivered into a
                  // DIFFERENT app's fullscreen window while the receipt read "target application
                  // owned the live point". A guard that cannot see must not veto, but it must not
                  // vouch either — unknown stays unknown.
                  windowMatched: globalPoint.preflight?.windowMatched
                    ?? (globalPoint.preflight?.recipientPid
                      ? globalPoint.preflight.recipientPid === target.pid
                      : undefined),
                  elementMatched: globalPoint.preflight?.elementMatch?.matched,
                  elementConfidence: globalPoint.preflight?.elementMatch?.confidence,
                  stable: globalPoint.preflight?.stable,
                  reason: globalPoint.preflight?.elementMatch?.reason
                    || (globalPoint.preflight?.recipientPid
                      ? 'target application owned the live point'
                      : 'recipient could not be probed — delivery target was NOT verified'),
                },
                commit: { delivered: true, ...(native.app ? { recipientApp: native.app } : {}) },
                ...(evidence.actionResult?.postcondition ? { postcondition: evidence.actionResult.postcondition } : {}),
              },
              targeting,
              ...evidence,
              summary: `physical mouse click${resolvedLabel ? ` on "${resolvedLabel}"` : ''} delivered to ${target.app || `pid ${target.pid}`}; fresh screen attached`,
            };
          }
          // Ask BEFORE attempting. The tree reports the actions each control publishes, so a control
          // that cannot be pressed is knowable in advance rather than only from the -25206 that comes
          // back after the attempt. This is what stops the refusal from firing "on discovery": the
          // answer is read from the same observation the caller planned against.
          //
          // Evidence only. A missing list means the tree said nothing about this control, and silence
          // is not a "no" — the attempt still goes through and the reactive catch below still stands.
          if (delivery === 'background' && expectedElement?.axActions?.length
            && !expectedElement.axActions.includes('press')) {
            throw new Error(noAxPressRefusal(
              resolvedLabel || cmd.query || 'this element',
              `it publishes only ${expectedElement.axActions.map(action => `\`${action}\``).join(', ')}`,
            ));
          }
          // Do not pre-position with move_cursor here. Click coordinates are window-local pixels,
          // while move_cursor consumes screen-space overlay coordinates; forwarding x/y directly
          // visibly pointed far away from the actual control. The click RPC owns the window-to-screen
          // conversion and updates the session cursor in the same coordinate frame as delivery.
          const data = await this.call('click', args).catch((error: unknown) => {
            // Background delivery activates an element through its published AX action. Plenty of
            // ordinary controls do not publish one: a Notes note row advertises `actions=[showmenu]`
            // and nothing else, so AXPress comes back -25206 (kAXErrorActionUnsupported) and the row
            // cannot be activated this way AT ALL. Measured on the same row that a foreground click
            // opens correctly in ~1.0s.
            //
            // The raw driver string is a dead end — it names an AX constant and offers no next step,
            // so the model retries the identical call. Name the cause and the one delivery that can
            // work instead. Deliberately a REFUSAL rather than an automatic downgrade to a physical
            // click: foreground delivery moves the real cursor and takes focus, which is precisely
            // what the caller asked to avoid, and silently swapping it is the same dishonesty the
            // off-Space background guard above refuses.
            if (!/\b-?25206\b|ActionUnsupported/i.test(String((error as Error)?.message || error))) throw error;
            throw new Error(noAxPressRefusal(
              resolvedLabel || cmd.query || 'this element',
              'the app answered AXPress with -25206, action unsupported',
            ));
          });
          const evidence = await this.postActionEvidence(target, cwd, session);
          return {
            ok: true, action: cmd.action, driver, app: target.app, pid: target.pid, windowId: target.windowId,
            details: data, ...evidence,
            targeting,
            summary: `click${resolvedLabel ? ` on "${resolvedLabel}"` : ''}${coordinateSource ? ` via ${coordinateSource}` : ''} delivered to ${target.app || `pid ${target.pid}`}; fresh screen attached`,
          };
        }
        case 'type': {
          if (!target) return this.fallback.run(cmd, ctx);
          const hasExplicitTypingTarget = !!cmd.query?.trim()
            || !!cmd.elementToken
            || cmd.elementIndex != null
            || (cmd.x != null && cmd.y != null);
          if (!hasExplicitTypingTarget) {
            const refusal = unnamedTypingRefusal(this.observedElements);
            if (refusal) throw new Error(refusal);
          }
          if (delivery === 'foreground') {
            await this.ensurePhysicalTargetFrontmost(target);
            const focusedTarget = await this.focusRequestedTextTarget(target, cmd, ctx);
            if (!focusedTarget.element) await this.ensureCursorInTargetWindow(target, ctx);
            const beforeFocus = await this.keyboardPreflight(target, focusedTarget.element, ctx);
            if (cmd.replaceExisting) {
              const selected = await this.fallback.run({ action: 'key', combo: 'cmd+a', app: target.app }, ctx);
              if (!selected.ok) throw new Error(selected.error || selected.summary);
              await new Promise(resolve => setTimeout(resolve, 20));
            }
            const native = await this.fallback.run({ action: 'type', text: cmd.text || '', app: target.app }, ctx);
            if (!native.ok) throw new Error(native.error || native.summary);
            const afterProbe = await this.probeKeyboardFocus(ctx);
            const keyboardReceipt: KeyboardReceipt = compareKeyboardFocus(
              target.pid, beforeFocus.element, afterProbe?.element,
            );
            if (afterProbe?.pid && afterProbe.pid !== target.pid) {
              keyboardReceipt.recipientMatched = false;
              keyboardReceipt.inputObserved = false;
              keyboardReceipt.reason = `focus moved to ${afterProbe.app || `pid ${afterProbe.pid}`} during text delivery`;
            }
            const evidence = await this.postActionEvidence(target, cwd, session);
            if (!this.activeExpectation && keyboardReceipt.inputObserved && evidence.progressCheck) {
              evidence.actionResult = toActionResult(evidence.progressCheck, {
                query: 'literal text changed the same focused editable element', matched: true,
              });
            } else if (!keyboardReceipt.recipientMatched) {
              evidence.actionResult = {
                delivered: true, observed: 'wrong-window', confidence: 'unknown',
                failureReason: keyboardReceipt.reason,
              };
            }
            return {
              ok: true, action: cmd.action, driver, app: target.app, pid: target.pid, windowId: target.windowId,
              details: { path: 'native-global-cgevent', keyboardReceipt },
              actionReceipt: {
                kind: 'keyboard',
                target: {
                  app: target.app, pid: target.pid, windowId: target.windowId,
                  element: focusedTarget.element?.label || focusedTarget.element?.value,
                  role: focusedTarget.element?.role,
                },
                preflight: {
                  recipientPid: beforeFocus.probe?.pid,
                  recipientApp: beforeFocus.probe?.app,
                  windowMatched: focusedTarget.preflight?.windowMatched
                    ?? (!beforeFocus.probe?.pid || beforeFocus.probe.pid === target.pid),
                  elementMatched: focusedTarget.preflight?.elementMatch?.matched,
                  elementConfidence: focusedTarget.preflight?.elementMatch?.confidence,
                  stable: focusedTarget.preflight?.stable,
                  editable: beforeFocus.element?.editable ?? null,
                  reason: beforeFocus.reason,
                },
                commit: { delivered: true, ...(native.app ? { recipientApp: native.app } : {}) },
                ...(evidence.actionResult?.postcondition ? { postcondition: evidence.actionResult.postcondition } : {}),
              },
              ...evidence,
              summary: `typed ${(cmd.text || '').length} characters with native keyboard into ${target.app || `pid ${target.pid}`}; fresh screen attached`,
            };
          }
          const args: any = { pid: target.pid, text: cmd.text || '', session, delivery_mode: delivery };
          if (target.windowId) args.window_id = target.windowId;
          if (cmd.query?.trim()) {
            const resolved = this.resolveObservedElement(cmd.query, target);
            const role = String(resolved.role || '');
            if (isEditableElement(resolved) && resolved.elementToken) args.element_token = resolved.elementToken;
            else if (isEditableElement(resolved) && resolved.elementIndex != null) args.element_index = resolved.elementIndex;
            else {
              // Hidden Chromium/Electron windows often keep perfectly good pixels while macOS
              // collapses the AX tree to OCR/static placeholder text. Passing that static handle to
              // type_text fails because it is not editable, so fall back to the exact placeholder's
              // window-local centre: the sidecar focuses that point and types in one PID/window-scoped
              // operation, with no foreground switch and no guessed coordinate.
              //
              // The condition for allowing that is a property of the OBSERVATION, not of the words in
              // the query: this window exposes no editable element at all. An earlier draft keyed on
              // English input-ish words in `cmd.query` ("message", "search", …), which both admitted
              // the fallback when a perfectly good editable field existed and refused it for a field
              // named in any other vocabulary. If an editable field IS present, the right answer is
              // always to name it rather than to type at pixels.
              const noEditableFieldObserved = !this.observedElements.some(isEditableElement);
              const placeholderRole = role === 'AXStaticText' || role === 'VisualText';
              const point = placeholderRole && noEditableFieldObserved
                ? this.elementCenterInScreenshot(resolved.frame)
                : null;
              if (!point) {
                const editableLabels = this.observedElements.filter(isEditableElement)
                  .map(element => element.label || element.value).filter(Boolean).slice(0, 6).join(', ');
                throw new Error(`literal typing target "${resolved.label || resolved.value || cmd.query}" is ${role || 'not an editable field'}; ${editableLabels ? `name an editable field instead (visible: ${editableLabels})` : 'choose an editable field/composer or its visible placeholder'}`);
              }
              args.x = point.x;
              args.y = point.y;
            }
          } else if (cmd.elementToken) args.element_token = cmd.elementToken;
          else if (cmd.elementIndex != null) args.element_index = Math.floor(cmd.elementIndex);
          else if (cmd.x != null && cmd.y != null) { args.x = cmd.x; args.y = cmd.y; }
          if (cmd.replaceExisting) {
            const selectionTarget: any = { pid: target.pid, session, delivery_mode: delivery };
            if (target.windowId) selectionTarget.window_id = target.windowId;
            if (args.element_token) selectionTarget.element_token = args.element_token;
            else if (args.element_index != null) selectionTarget.element_index = args.element_index;
            const selected = await this.call('hotkey', { ...selectionTarget, keys: ['cmd', 'a'] });
            if (selected?.ok === false) throw new Error(selected.error || selected.summary || 'failed to select existing editable contents');
          }
          const data = await this.call('type_text', args);
          const evidence = await this.postActionEvidence(target, cwd, session);
          return { ok: true, action: cmd.action, driver, app: target.app, pid: target.pid, windowId: target.windowId, details: data, ...evidence, summary: `typed ${(cmd.text || '').length} characters into ${target.app || `pid ${target.pid}`}; fresh screen attached` };
        }
        case 'key': {
          if (!target) return this.fallback.run(cmd, ctx);
          const keys = (cmd.combo || '').split('+').map(k => k.trim().toLowerCase()).filter(Boolean);
          if (!keys.length) throw new Error('key needs combo');
          // Space/Mission-Control shortcuts change which windows exist on screen, so they cannot go
          // down the ordinary "press it, then screenshot the target window" path — that window may
          // no longer be visible to capture.
          const spaceCombo = process.platform === 'darwin' ? classifySpaceCombo(cmd.combo || '') : null;
          if (spaceCombo) return await this.runSpaceCombo(cmd, target, spaceCombo, cwd, session, driver, ctx);
          if (delivery === 'foreground') {
            await this.ensurePhysicalTargetFrontmost(target);
            await this.ensureCursorInTargetWindow(target, ctx);
            const focusProbe = await this.keyboardAppPreflight(target, ctx);
            const native = await this.fallback.run({ action: 'key', combo: cmd.combo, app: target.app }, ctx);
            if (!native.ok) throw new Error(native.error || native.summary);
            // Cmd+N creates a different native window. Keeping the pre-action window id makes the
            // post-action capture follow the old/transitioning window even though the new one is
            // frontmost; TextEdit exposed exactly that as a same-sized, on-screen ghost with zero
            // capturable pixels. Drop only the window component (pid/app ownership remains fixed)
            // so refreshTargetWindow selects the new frontmost usable window generically.
            const createdWindow = keys.length === 2 && keys.includes('cmd') && keys.includes('n');
            const evidenceTarget = createdWindow ? { ...target, windowId: undefined } : target;
            const evidence = await this.postActionEvidence(evidenceTarget, cwd, session);
            // Escape is the keyboard twin of the Done/Close/Cancel click: it semantically dismisses
            // the foreground sheet, and WindowServer may keep the dead sheet enumerable for a short
            // grace period. Without this, the dialog guard kept refusing clicks on the visible page.
            if (keys.length === 1 && (keys[0] === 'escape' || keys[0] === 'esc')) {
              this.transientDialogFrame = null;
              evidence.completionGuidance = COMPUTER_COMPLETION_GUIDANCE;
            }
            return {
              ok: true, action: cmd.action, driver, app: target.app, pid: target.pid, windowId: target.windowId,
              details: { path: 'native-global-cgevent' }, ...evidence,
              actionReceipt: {
                kind: 'keyboard',
                target: { app: target.app, pid: target.pid, windowId: target.windowId },
                preflight: {
                  recipientPid: focusProbe?.pid, recipientApp: focusProbe?.app,
                  windowMatched: !focusProbe?.pid || focusProbe.pid === target.pid,
                  reason: focusProbe?.pid ? `target pid ${target.pid} owned keyboard focus` : 'native focus metadata unavailable',
                },
                commit: { delivered: true, ...(native.app ? { recipientApp: native.app } : {}) },
                ...(evidence.actionResult?.postcondition ? { postcondition: evidence.actionResult.postcondition } : {}),
              },
              summary: `pressed ${cmd.combo} with native keyboard in ${target.app || `pid ${target.pid}`}; fresh screen attached`,
            };
          }
          const common: any = { pid: target.pid, session, delivery_mode: delivery };
          if (target.windowId) common.window_id = target.windowId;
          if (cmd.elementToken) common.element_token = cmd.elementToken;
          else if (cmd.elementIndex != null) common.element_index = Math.floor(cmd.elementIndex);
          const data = keys.length > 1
            ? await this.call('hotkey', { ...common, keys })
            : await this.call('press_key', { ...common, key: keys[0] });
          const evidence = await this.postActionEvidence(target, cwd, session);
          return { ok: true, action: cmd.action, driver, app: target.app, pid: target.pid, windowId: target.windowId, details: data, ...evidence, summary: `pressed ${cmd.combo} in ${target.app || `pid ${target.pid}`}; fresh screen attached` };
        }
        case 'desktop': {
          // The desktop is deliberately NOT modelled as an app window. It has no title bar, no close
          // button and no window id the driver will hand out, so every window-scoped code path either
          // skips it or substitutes the file manager's menu-bar proxy. Its items are plain
          // accessibility elements with global frames, so they are enumerated natively and addressed
          // in the same global screen points every pointer command already speaks.
          const listed = await this.fallback.run({ action: 'desktop_icons' }, ctx);
          if (!listed.ok) {
            const reason = String(listed.error || listed.summary || '');
            // A desktop-icon surface is optional: hidden desktop items, alternate shell modes, and
            // managed machines can legitimately expose none. Listing that surface should still be a
            // successful empty observation; moving a named item remains impossible and fails below.
            if (/no desktop icon surface is present/i.test(reason) && !cmd.query?.trim()) {
              this.desktopIcons = [];
              return {
                ok: true,
                action: cmd.action,
                driver,
                icons: [],
                details: { desktopSurface: 'unavailable' },
                actionResult: { delivered: false, observed: 'confirmed', confidence: 'proven' },
                summary: 'the system exposes no desktop item surface',
              };
            }
            throw new Error(reason);
          }
          // Accessibility containers can share the desktop surface but have no addressable name.
          // They are not desktop items and cannot be resolved safely by a user query.
          const icons = (listed.icons || []).filter(icon => String(icon?.name || '').trim());
          this.desktopIcons = icons;
          if (!cmd.query?.trim()) {
            return {
              ok: true, action: cmd.action, driver, icons,
              actionResult: { delivered: false, observed: 'confirmed', confidence: 'proven' },
              summary: icons.length
                ? `${icons.length} item(s) on the desktop: ${icons.map(i => i.name).filter(Boolean).join(', ')}. Move one with action=desktop query="<name>" and either toQuery="<folder name>" to file it, or toX/toY screen points to reposition it.`
                : 'the desktop has no items on it',
            };
          }
          const from = resolveDesktopIcon(icons, cmd.query);
          const centre = (r: ScreenRect) => ({ x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) });
          const globalFrom = centre(from.frame);
          let globalTo: { x: number; y: number };
          let intent: string;
          if (cmd.toQuery?.trim()) {
            const into = resolveDesktopIcon(icons, cmd.toQuery);
            if (into.name === from.name) throw new Error(`"${from.name}" cannot be dropped onto itself`);
            globalTo = centre(into.frame);
            intent = `onto "${into.name}"`;
          } else if (cmd.toX != null && cmd.toY != null) {
            globalTo = { x: Math.round(cmd.toX), y: Math.round(cmd.toY) };
            intent = `to (${globalTo.x},${globalTo.y})`;
          } else {
            throw new Error('moving a desktop item needs a destination: toQuery="<name of a folder on the desktop>" to file it into that folder, or toX/toY screen points to reposition it');
          }
          const delivered = await this.fallback.run({
            action: 'drag', x: globalFrom.x, y: globalFrom.y, toX: globalTo.x, toY: globalTo.y,
            normalized: false, ms: CROSS_APP_DRAG_DWELL_MS,
          }, ctx);
          if (!delivered.ok) throw new Error(delivered.error || delivered.summary);
          // Re-enumerate and compare: the item's rectangle is the honest postcondition. A drop into a
          // folder removes it from the desktop entirely; a reposition moves its frame. Either way the
          // OS is the witness, not the fact that a drag was delivered.
          await new Promise(resolve => setTimeout(resolve, 450));
          const after = await this.fallback.run({ action: 'desktop_icons' }, ctx);
          const nowIcons = after.ok ? (after.icons || []) : icons;
          this.desktopIcons = nowIcons;
          const stillThere = nowIcons.find(i => i.name === from.name);
          const filedAway = !stillThere;
          const moved = !!stillThere && (stillThere.frame.x !== from.frame.x || stillThere.frame.y !== from.frame.y);
          const landed = filedAway || moved;
          return {
            ok: landed, action: cmd.action, driver, icons: nowIcons,
            details: { from: globalFrom, to: globalTo, item: from.name },
            actionResult: {
              delivered: true, observed: landed ? 'confirmed' : 'no-change',
              postcondition: { query: `"${from.name}" moved ${intent}`, matched: landed },
              confidence: 'proven',
              ...(landed ? {} : { failureReason: 'the item is still in its original position' }),
            },
            ...(landed ? {} : {
              error: `"${from.name}" did not move — the desktop may be using an automatic arrangement (sort/stacks), which snaps every item back to a computed position. Turn off Use Stacks / Sort By on the desktop before rearranging items by hand.`,
            }),
            summary: landed
              ? filedAway
                ? `moved "${from.name}" ${intent}; it is no longer on the desktop`
                : `moved "${from.name}" ${intent}; it is now at (${stillThere!.frame.x},${stillThere!.frame.y})`
              : `"${from.name}" was dragged ${intent} but is still at (${from.frame.x},${from.frame.y})`,
          };
        }
        case 'arrange': {
          // Window management through the accessibility API rather than by dragging a title bar to
          // a screen edge or hunting through the green button's hover menu: it is one call, it is
          // exact, and it behaves identically for every app because it never touches app UI.
          if (!target) throw new Error('arrange needs an active app — open or focus one first');
          const layout = cmd.layout;
          if (!layout && !cmd.bounds) throw new Error('arrange needs layout (left/right/top/bottom, quadrants, thirds, restore, maximize/center/fullscreen/unfullscreen) or explicit bounds');
          // Fullscreen only engages for the frontmost app: macOS silently refuses the attribute for
          // a background window, which read as "this app cannot go fullscreen".
          await this.ensurePhysicalTargetFrontmost(target);

          if (layout === 'fullscreen' || layout === 'unfullscreen') {
            const want = layout === 'fullscreen';
            const toggled = await this.fallback.run({ action: 'window_fullscreen', pid: target.pid, value: want ? 'true' : 'false' }, ctx);
            if (!toggled.ok) throw new Error(toggled.error || toggled.summary);
            const evidence = await this.postActionEvidence(target, cwd, session);
            const settled = !!toggled.fullscreenMatched;
            if (!settled) {
              return {
                ok: false, action: cmd.action, driver, app: target.app, pid: target.pid, windowId: target.windowId,
                fullscreen: toggled.fullscreen, fullscreenSupported: toggled.fullscreenSupported, ...evidence,
                actionResult: { delivered: true, observed: 'no-change', postcondition: { query: `window ${want ? 'entered' : 'left'} fullscreen`, matched: false }, confidence: 'proven', failureReason: 'the window did not change fullscreen state' },
                error: toggled.fullscreenSupported === false
                  ? `${target.app || `pid ${target.pid}`} has no window that supports fullscreen (panels, utility and inspector windows cannot go fullscreen) — use layout=maximize to fill the screen instead`
                  : `${target.app || `pid ${target.pid}`} did not ${want ? 'enter' : 'leave'} fullscreen. It must be the frontmost app for macOS to accept the change; bring it forward (action=focus) and try again.`,
                summary: `fullscreen ${want ? 'on' : 'off'} was refused by ${target.app || `pid ${target.pid}`}`,
              };
            }
            return {
              ok: true, action: cmd.action, driver, app: target.app, pid: target.pid, windowId: target.windowId,
              fullscreen: toggled.fullscreen, fullscreenSupported: toggled.fullscreenSupported, ...evidence,
              actionResult: { delivered: true, observed: 'confirmed', postcondition: { query: `window ${want ? 'entered' : 'left'} fullscreen`, matched: true }, confidence: 'proven' },
              summary: `${target.app || `pid ${target.pid}`} is now ${want ? 'fullscreen' : 'windowed'}; fresh screen attached`,
            };
          }

          // Resolve the target rectangle against the screen this window is actually on, so a layout
          // on a second display tiles within THAT display rather than jumping to the main one.
          // Remember where the window was BEFORE we move it, so a later arrange can put it back.
          // Read once and reuse below — window_frame is a helper round-trip, not free.
          const before = await this.fallback.run({ action: 'window_frame', pid: target.pid }, ctx);
          const priorFrame = before.ok ? before.windowFrame : undefined;

          let want = cmd.bounds;
          if (!want && layout === 'restore') {
            const saved = this.priorWindowBounds.get(target.pid);
            if (!saved) throw new Error('nothing to restore — this window has not been arranged in this session, so there is no previous rectangle to put it back to');
            want = saved;
          }
          if (!want) {
            const screensResult = await this.fallback.run({ action: 'screens' }, ctx);
            const screens = screensResult.ok && screensResult.screens?.length ? screensResult.screens : [];
            const mainScreen = screens.find(s => s.main) || screens[0];
            if (mainScreen?.scale) this.mainDisplayScale = mainScreen.scale;
            if (!screens.length) throw new Error('could not read screen geometry, so a named layout cannot be resolved — pass explicit bounds instead');
            // An explicit display index MOVES the window to that screen; without one it tiles within
            // whichever screen the window already sits on, so a layout on a second display does not
            // yank the window back to the main one.
            const screen = cmd.display
              ? screens.find(s => s.index === Number(cmd.display))
              : screenForRect(priorFrame, screens);
            if (!screen) {
              throw new Error(cmd.display
                ? `display ${cmd.display} does not exist — this Mac reports ${screens.length} screen(s) (indexes ${screens.map(s => s.index).join(', ')})`
                : 'could not determine which screen this window is on');
            }
            want = layoutRect(layout!, screen.visible);
          }
          if (priorFrame) this.priorWindowBounds.set(target.pid, priorFrame);
          const placed = await this.fallback.run({ action: 'window_set_frame', pid: target.pid, bounds: want }, ctx);
          if (!placed.ok) throw new Error(placed.error || placed.summary);
          const got = placed.windowFrame;
          const exact = frameMatches(want, got);
          const evidence = await this.postActionEvidence(target, cwd, session);
          // An app that enforces a minimum size gets the position it was asked for but not the size.
          // Saying so is the difference between "tiled" and "tiled, and still overlapping the other
          // half" — which the caller can only account for if it is told. It is told by `ok` as well
          // as by the sentence: a maximize that returned 603x505 did not maximize, and reporting
          // ok:true for it made the one honest field disagree with the summary beside it. This
          // matches how `copy` already reports "delivered, but the postcondition did not hold".
          const name = target.app || `pid ${target.pid}`;
          return {
            ok: true, action: cmd.action, driver, app: target.app, pid: target.pid, windowId: target.windowId,
            windowFrame: got, requestedFrame: want, ...evidence,
            actionResult: {
              delivered: true, observed: exact ? 'confirmed' : 'expectation-missed',
              postcondition: { query: `window placed at ${want.w}x${want.h}+${want.x}+${want.y}`, matched: exact },
              confidence: exact ? 'proven' : 'likely',
              ...(exact ? {} : { failureReason: 'the app overrode the requested geometry and will do so again' }),
            },
            // The window DID move, so this is not a delivery failure and `ok` stays true — the
            // mismatch is reported by postcondition.matched and by the sentence. What was missing is
            // the only thing a caller can act on: whether to try again. An app enforcing a minimum
            // size will enforce it every time, so say that instead of leaving a retry on the table.
            summary: exact
              ? `${name} placed at ${got!.w}x${got!.h} (${got!.x},${got!.y})${layout ? ` [${layout}]` : ''}; fresh screen attached`
              : `${name} moved, but the app adjusted the size: asked ${want.w}x${want.h} at (${want.x},${want.y}), got ${got?.w}x${got?.h} at (${got?.x},${got?.y})`
                + ' — the app enforces its own minimum size or size increments, so retrying this layout will produce the same geometry;'
                + ' plan against windowFrame, and do not treat the window as filling the requested rectangle',
          };
        }
        case 'clipboard': {
          // Explicit pasteboard access. `paths` puts FILES on it (so an app can receive them by
          // paste), `value` puts text on it, neither reads it. Nothing here is app-specific: the
          // pasteboard is an OS service, so this is the same operation for every application.
          if (cmd.paths?.length) {
            const written = await this.fallback.run({ action: 'clipboard_write_files', paths: cmd.paths }, ctx);
            if (!written.ok) throw new Error(written.error || written.summary);
            return {
              ok: true, action: cmd.action, driver, clipboard: written.clipboard,
              actionResult: { delivered: true, observed: 'confirmed', postcondition: { query: `${cmd.paths.length} file(s) on the clipboard`, matched: true }, confidence: 'proven' },
              summary: `put ${cmd.paths.length} file(s) on the clipboard: ${cmd.paths.join(', ')}`,
            };
          }
          if (cmd.value != null) {
            const written = await this.fallback.run({ action: 'clipboard_write', text: cmd.value }, ctx);
            if (!written.ok) throw new Error(written.error || written.summary);
            return {
              ok: true, action: cmd.action, driver, clipboard: written.clipboard,
              actionResult: { delivered: true, observed: 'confirmed', postcondition: { query: 'text on the clipboard', matched: true }, confidence: 'proven' },
              summary: `wrote ${cmd.value.length} chars to the clipboard`,
            };
          }
          const clip = await this.readClipboard(ctx);
          return {
            ok: true, action: cmd.action, driver, clipboard: clip,
            actionResult: { delivered: false, observed: 'confirmed', confidence: 'proven' },
            summary: describeClipboard(clip),
          };
        }
        case 'copy': {
          // Copy is the classic "delivered but did nothing" action: with no selection, Cmd+C is
          // accepted by every app and changes nothing. NSPasteboard.changeCount is the OS's own
          // monotonic write counter, so comparing it across the keystroke proves whether anything
          // was actually placed — evidence, not delivery.
          if (!target) throw new Error('copy needs an active app — open or focus one first');
          const combo = process.platform === 'darwin' ? 'cmd+c' : 'ctrl+c';
          const before = await this.readClipboard(ctx).catch(() => null);
          let focusProbe: any;
          let delivered: any;
          if (delivery === 'background') {
            // Keep the selection/focus in the PID+window-scoped sidecar. Switching to the physical
            // keyboard here used to front Safari after a background Cmd+L, dismiss its address
            // popup and lose the URL selection; it would also visibly steal WhatsApp/TextEdit from
            // the user's current app during cross-app workflows.
            const keys = combo.split('+').map(key => key.trim().toLowerCase()).filter(Boolean);
            const data = await this.call('hotkey', {
              // Deliberately PID-scoped, not parent-window-scoped: the selected editor can be an
              // app-owned transient child (Safari's address suggestions, a combo-box popup). The
              // parent remains the capture/coordinate target, while AX keyboard focus inside this
              // same PID is the authority for where Copy belongs.
              pid: target.pid, session, delivery_mode: 'background', keys,
            });
            focusProbe = { pid: target.pid, app: target.app };
            delivered = { ok: true, app: target.app, details: data };
          } else {
            await this.ensurePhysicalTargetFrontmost(target);
            await this.ensureCursorInTargetWindow(target, ctx);
            focusProbe = await this.keyboardAppPreflight(target, ctx);
            delivered = await this.fallback.run({ action: 'key', combo, app: target.app }, ctx);
            if (!delivered.ok) throw new Error(delivered.error || delivered.summary);
          }
          // Apps write the pasteboard asynchronously after the keystroke, so poll rather than
          // sampling once and declaring failure on a race.
          let after = before;
          let landed = false;
          for (const settleMs of [80, 120, 200, 300]) {
            await new Promise(resolve => setTimeout(resolve, settleMs));
            after = await this.readClipboard(ctx).catch(() => after);
            if (!before || !after) break;
            landed = clipboardAdvanced(before, after);
            if (landed) break;
          }
          const evidence = await this.postActionEvidence(target, cwd, session);
          if (before && after && !landed) {
            return {
              ok: false, action: cmd.action, driver, app: target.app, pid: target.pid, windowId: target.windowId,
              clipboard: after, ...evidence,
              actionReceipt: {
                kind: 'keyboard', target: { app: target.app, pid: target.pid, windowId: target.windowId },
                preflight: {
                  recipientPid: focusProbe?.pid, recipientApp: focusProbe?.app,
                  windowMatched: !focusProbe?.pid || focusProbe.pid === target.pid,
                  reason: focusProbe?.pid ? `target pid ${target.pid} owned keyboard focus` : 'native focus metadata unavailable',
                },
                commit: { delivered: true, recipientApp: delivered.app || target.app },
                postcondition: { query: 'clipboard received new content', matched: false },
              },
              actionResult: { delivered: true, observed: 'no-change', postcondition: { query: 'clipboard received new content', matched: false }, confidence: 'proven', failureReason: 'the clipboard did not change' },
              error: `${combo} reached ${target.app || `pid ${target.pid}`} but the clipboard did not change — nothing was selected, or this surface does not support copy. Select the content first (click into it, then drag or use select-all), then copy again.`,
              summary: `copy delivered to ${target.app || `pid ${target.pid}`} but nothing landed on the clipboard`,
            };
          }
          return {
            ok: true, action: cmd.action, driver, app: target.app, pid: target.pid, windowId: target.windowId,
            clipboard: after || undefined, ...evidence,
            ...(after ? { actionResult: { delivered: true, observed: 'confirmed' as const, postcondition: { query: 'clipboard received new content', matched: true }, confidence: 'proven' as const } } : {}),
            actionReceipt: {
              kind: 'keyboard', target: { app: target.app, pid: target.pid, windowId: target.windowId },
              preflight: {
                recipientPid: focusProbe?.pid, recipientApp: focusProbe?.app,
                windowMatched: !focusProbe?.pid || focusProbe.pid === target.pid,
                reason: focusProbe?.pid ? `target pid ${target.pid} owned keyboard focus` : 'native focus metadata unavailable',
              },
              commit: { delivered: true, recipientApp: delivered.app || target.app },
              ...(after ? { postcondition: { query: 'clipboard received new content', matched: true } } : {}),
            },
            summary: after
              ? `copied from ${target.app || `pid ${target.pid}`} — ${describeClipboard(after)}`
              : `copy delivered to ${target.app || `pid ${target.pid}`} (this driver cannot read the clipboard back, so the content is unverified)`,
          };
        }
        case 'paste': {
          if (!target) throw new Error('paste needs an active app — open or focus one first');
          const clip = await this.readClipboard(ctx).catch(() => null);
          if (clip && !clip.text && !clip.files.length) {
            throw new Error('the clipboard is empty — copy something (action=copy) or put content on it (action=clipboard with value or paths) before pasting');
          }
          const combo = process.platform === 'darwin' ? 'cmd+v' : 'ctrl+v';
          let focusProbe: any;
          let delivered: any;
          if (delivery === 'background') {
            const keys = combo.split('+').map(key => key.trim().toLowerCase()).filter(Boolean);
            const data = await this.call('hotkey', {
              pid: target.pid, session, delivery_mode: 'background', keys,
            });
            focusProbe = { pid: target.pid, app: target.app };
            delivered = { ok: true, app: target.app, details: data };
          } else {
            await this.ensurePhysicalTargetFrontmost(target);
            await this.ensureCursorInTargetWindow(target, ctx);
            focusProbe = await this.keyboardAppPreflight(target, ctx);
            delivered = await this.fallback.run({ action: 'key', combo, app: target.app }, ctx);
            if (!delivered.ok) throw new Error(delivered.error || delivered.summary);
          }
          const evidence = await this.postActionEvidence(target, cwd, session);
          // A paste leaves the clipboard untouched, so it cannot self-verify the way copy does.
          // What it CAN do is check the fresh frame for the text that was pasted — a real semantic
          // postcondition rather than "the keystroke was accepted".
          if (clip?.text && evidence.progressCheck) {
            const seen = this.observedTextIncludes(clip.text);
            evidence.actionResult = toActionResult(evidence.progressCheck, {
              query: `pasted text visible in ${target.app || 'the target'}`, matched: seen,
            });
          }
          return {
            ok: true, action: cmd.action, driver, app: target.app, pid: target.pid, windowId: target.windowId,
            clipboard: clip || undefined, ...evidence,
            actionReceipt: {
              kind: 'keyboard', target: { app: target.app, pid: target.pid, windowId: target.windowId },
              preflight: {
                recipientPid: focusProbe?.pid, recipientApp: focusProbe?.app,
                windowMatched: !focusProbe?.pid || focusProbe.pid === target.pid,
                reason: focusProbe?.pid ? `target pid ${target.pid} owned keyboard focus` : 'native focus metadata unavailable',
              },
              commit: { delivered: true, recipientApp: delivered.app || target.app },
              ...(evidence.actionResult?.postcondition ? { postcondition: evidence.actionResult.postcondition } : {}),
            },
            summary: `pasted into ${target.app || `pid ${target.pid}`}${clip ? ` — ${describeClipboard(clip)}` : ''}; fresh screen attached`,
          };
        }
        case 'set_value': {
          if (!target) throw new Error('set_value needs a target pid');
          if (cmd.value == null) throw new Error('set_value needs value');
          const resolved = cmd.query?.trim()
            ? this.resolveObservedElement(cmd.query, target)
            : this.resolveObservedHandle(target, cmd);
          const role = String(resolved.role || '');
          if (!ACTIONABLE_AX_ROLES.has(role)) {
            throw new Error(`"${resolved.label || role || 'element'}" does not support native value assignment`);
          }
          const requested = this.normalizedControlValue(role, cmd.value);
          const handle = resolved.elementToken
            ? { element_token: resolved.elementToken }
            : resolved.elementIndex != null ? { element_index: resolved.elementIndex } : null;
          if (!handle) throw new Error('set_value target has no fresh native handle; observe again');
          let data: any;
          try {
            data = await this.call('set_value', {
              pid: target.pid, window_id: target.windowId, session, value: requested.value,
              ...handle,
            });
          } catch (error) {
            // AppKit NSPopUpButton often publishes no AX children until it is physically opened,
            // so direct AX value assignment has no option node to select. Waiting a whole model
            // round after opening is unreliable: the transient menu can disappear while a hosted
            // model/provider is thinking. In foreground mode, complete the ordinary human gesture
            // synchronously from two fresh semantic frames: click the pop-up, then its exact item.
            // Background mode never silently escalates to cursor/focus stealing.
            if (role !== 'AXPopUpButton' || delivery !== 'foreground') throw error;
            const requestedLabel = String(cmd.value).trim();
            const savedExpectation = this.activeExpectation;
            this.activeExpectation = null;
            try {
              const opened = await this.runInner({
                action: 'click', session, deliveryMode: 'foreground',
                ...(resolved.elementToken ? { elementToken: resolved.elementToken }
                  : { elementIndex: resolved.elementIndex }),
              }, ctx);
              if (!opened.ok) throw new Error(
                opened.error || opened.summary || 'failed to open pop-up menu',
                { cause: error },
              );
              const item = this.observedElements.find(element => String(element.role || '') === 'AXMenuItem'
                && String(element.label || '').trim().toLocaleLowerCase() === requestedLabel.toLocaleLowerCase());
              if (!item) {
                throw new Error(
                  `pop-up opened, but no exact menu item ${JSON.stringify(requestedLabel)} was present in the fresh menu state`,
                  { cause: error },
                );
              }
              const chosen = await this.runInner({
                action: 'click', session, deliveryMode: 'foreground',
                ...(item.elementToken ? { elementToken: item.elementToken }
                  : { elementIndex: item.elementIndex }),
              }, ctx);
              if (!chosen.ok) throw new Error(
                chosen.error || chosen.summary || `failed to select ${requestedLabel}`,
                { cause: error },
              );
              // The immediate post-click frame may still contain the closing menu. Let AppKit settle,
              // then read the owning window again before declaring the exact value applied.
              await new Promise(resolve => setTimeout(resolve, 160));
            } finally {
              this.activeExpectation = savedExpectation;
              this.activeAction = 'set_value';
            }
            const evidence = await this.postActionEvidence(target, cwd, session);
            const popup = this.observedElements.find(element => String(element.role || '') === 'AXPopUpButton');
            const applied = String(popup?.value || popup?.label || '').trim().toLocaleLowerCase()
              === requestedLabel.toLocaleLowerCase();
            if (evidence.progressCheck) {
              evidence.actionResult = toActionResult(evidence.progressCheck, {
                query: `${resolved.label || 'pop-up'} exact option ${JSON.stringify(requestedLabel)}`,
                matched: applied,
              });
            }
            return {
              ok: applied, action: cmd.action, driver, app: target.app, pid: target.pid, windowId: target.windowId,
              details: {
                fallback: 'foreground-popup-menu', target: { label: resolved.label, role },
                requestedValue: cmd.value, appliedValue: popup?.value || popup?.label,
              },
              ...evidence,
              ...(applied ? {} : { error: `pop-up did not settle on ${JSON.stringify(requestedLabel)}` }),
              summary: applied
                ? `selected exact pop-up option ${JSON.stringify(requestedLabel)} through its fresh native menu; fresh screen attached`
                : `pop-up selection did not settle on ${JSON.stringify(requestedLabel)}`,
            };
          }
          const evidence = await this.postActionEvidence(target, cwd, session);
          const exactEndpoint = role === 'AXSlider' && requested.endpoint;
          if (exactEndpoint && evidence.progressCheck) {
            evidence.actionResult = toActionResult(evidence.progressCheck, {
              query: `${resolved.label || 'Slider'} native ${exactEndpoint} endpoint (${requested.value})`,
              matched: true,
            });
          }
          return {
            ok: true, action: cmd.action, driver, app: target.app, pid: target.pid, windowId: target.windowId,
            details: {
              native: data,
              target: { label: resolved.label, role },
              requestedValue: cmd.value,
              appliedValue: requested.value,
              ...(requested.endpoint ? { endpoint: requested.endpoint } : {}),
            },
            ...evidence,
            summary: exactEndpoint
              ? `${resolved.label || 'slider'} set to exact ${requested.endpoint} endpoint; fresh screen attached`
              : `value delivered to ${resolved.label || target.app || `pid ${target.pid}`}; fresh screen attached`,
          };
        }
        case 'drag': {
          if (!target) return this.fallback.run(cmd, ctx);
          // A destination in ANOTHER application cannot be expressed in the source window's
          // screenshot space — the two windows have different origins and the source's pixels stop
          // at its own edge. Resolve that case against the destination window's live frame instead.
          // `await` matters: returning the promise unawaited from inside run()'s try block means a
          // rejection escapes the error handler entirely and surfaces as an unhandled throw instead
          // of the {ok:false, error} contract every other refusal uses.
          if (cmd.toApp?.trim()) return await this.runCrossAppDrag(cmd, target, cwd, session, driver, ctx);
          // Source and destination each accept the same semantic grounding as click: an element
          // handle from the newest observation (query/elementToken/elementIndex for the source,
          // toQuery/toElementToken/toElementIndex for the destination) or a raw screenshot pixel.
          const hasSourceHandle = !!(cmd.query?.trim() || cmd.elementToken || cmd.elementIndex != null);
          const hasDestHandle = !!(cmd.toQuery?.trim() || cmd.toElementToken || cmd.toElementIndex != null);
          if (!hasSourceHandle && (cmd.x == null || cmd.y == null)) {
            throw new Error('drag needs a source: query/elementToken/elementIndex from the newest observation, or x+y screenshot pixels');
          }
          if (!hasDestHandle && (cmd.toX == null || cmd.toY == null)) {
            throw new Error('drag needs a destination: toQuery/toElementToken/toElementIndex from the newest observation, or toX+toY screenshot pixels');
          }
          if (!this.observedTarget || this.observedTarget.pid !== target.pid || this.observedTarget.windowId !== target.windowId) {
            throw new Error('drag needs a fresh image of this exact window');
          }
          const width = this.observedTarget.width;
          const height = this.observedTarget.height;
          if (!width || !height) throw new Error('latest screenshot has no usable dimensions');
          const resolveDragPoint = (
            spec: { query?: string; elementToken?: string; elementIndex?: number }, end: 'source' | 'destination',
          ): { x: number; y: number } => {
            const resolved = spec.query?.trim()
              ? this.resolveObservedElement(spec.query, target)
              : this.resolveObservedHandle(target, { elementToken: spec.elementToken, elementIndex: spec.elementIndex });
            const point = this.elementCenterInScreenshot(resolved.frame);
            if (!point) throw new Error(`drag ${end} element has no visible screenshot rectangle; observe again or use a visible screenshot pixel instead`);
            return point;
          };
          const from = hasSourceHandle
            ? resolveDragPoint(cmd, 'source')
            : {
              x: cmd.normalized ? scaleNormalizedPoint(cmd.x!, width - 1) : Math.round(cmd.x!),
              y: cmd.normalized ? scaleNormalizedPoint(cmd.y!, height - 1) : Math.round(cmd.y!),
            };
          const to = hasDestHandle
            ? resolveDragPoint({ query: cmd.toQuery, elementToken: cmd.toElementToken, elementIndex: cmd.toElementIndex }, 'destination')
            : {
              x: cmd.normalized ? scaleNormalizedPoint(cmd.toX!, width - 1) : Math.round(cmd.toX!),
              y: cmd.normalized ? scaleNormalizedPoint(cmd.toY!, height - 1) : Math.round(cmd.toY!),
            };
          if ([from.x, from.y, to.x, to.y].some(value => !Number.isFinite(value))
            || from.x < 0 || from.y < 0 || to.x < 0 || to.y < 0
            || from.x >= width || to.x >= width || from.y >= height || to.y >= height) {
            throw new Error(`drag points must stay inside the latest image (${width}x${height})`);
          }
          if (delivery === 'foreground') {
            await this.ensurePhysicalTargetFrontmost(target);
            const wf = await this.liveWindowFrame(target);
            const globalFrom = this.screenshotPixelToGlobalPoint(from, wf);
            const globalTo = this.screenshotPixelToGlobalPoint(to, wf);
            if (globalFrom && globalTo) {
              // Drive the drag through the explicit state machine: verify the SOURCE is inside the
              // window before the button ever goes down (dragging from empty space is a mistake), run
              // the atomic native drag as the down→move→up executor, then verify a fresh screen. On a
              // native failure, cancel and post a compensating mouse-up so a half-drag can't wedge the
              // pointer. The full phase trace ships in details.dragTrace for observability.
              const machine = new DragMachine(globalFrom, globalTo);
              machine.locateSource();
              const sourceInside = !wf || pointInFrame(globalFrom, wf);
              machine.verifySource(sourceInside, sourceInside ? 'source is inside the target window' : 'source point is outside the target window');
              if (!sourceInside) {
                return {
                  ok: false, action: cmd.action, driver, app: target.app, pid: target.pid, windowId: target.windowId,
                  details: { dragTrace: machine.trace }, error: 'drag source is outside the target window — re-observe and pick a point that is on the window',
                  summary: `drag refused: source is outside ${target.app || `pid ${target.pid}`}`,
                };
              }
              machine.mouseDown().startDrag().moveThrough([globalTo]).locateDestination();
              // A destination outside the source window is a LEGITIMATE cross-window drag, so this is
              // informational — the machine always completes the release rather than abandoning it.
              machine.verifyDestination(true, (!wf || pointInFrame(globalTo, wf)) ? 'destination inside the window' : 'destination outside the source window (cross-window drop)');
              const native = await this.fallback.run({
                action: 'drag', x: globalFrom.x, y: globalFrom.y,
                toX: globalTo.x, toY: globalTo.y, app: target.app, normalized: false,
              }, ctx);
              if (!native.ok) {
                machine.cancel('native drag failed');
                if (machine.releaseOwed) {
                  try { await this.fallback.run({ action: 'mouse_up', x: globalTo.x, y: globalTo.y, app: target.app, normalized: false }, ctx); }
                  catch { /* best-effort release so a failed drag never leaves the button stuck */ }
                }
                throw new Error(native.error || native.summary);
              }
              machine.mouseUp('native drag completed');
              const evidence = await this.postActionEvidence(target, cwd, session);
              machine.verifyResult(true, 'fresh post-drag screen captured');
              return {
                ok: true, action: cmd.action, driver, app: target.app, pid: target.pid, windowId: target.windowId,
                details: { path: 'native-global-cgevent', from: globalFrom, to: globalTo, dragTrace: machine.trace }, ...evidence,
                summary: `visible native cursor drag delivered to ${target.app || `pid ${target.pid}`}; fresh screen attached`,
              };
            }
          }
          const data = await this.call('drag', {
            pid: target.pid, window_id: target.windowId, session,
            from_x: from.x, from_y: from.y, to_x: to.x, to_y: to.y,
            delivery_mode: delivery, button: cmd.button || 'left',
          });
          const evidence = await this.postActionEvidence(target, cwd, session);
          return { ok: true, action: cmd.action, driver, app: target.app, pid: target.pid, windowId: target.windowId, details: data, ...evidence, summary: `drag delivered to ${target.app || `pid ${target.pid}`}; fresh screen attached` };
        }
        case 'scroll': {
          if (!target) return this.fallback.run(cmd, ctx);
          const direction = Math.abs(cmd.dx || 0) > Math.abs(cmd.dy || 0)
            ? ((cmd.dx || 0) >= 0 ? 'right' : 'left')
            : ((cmd.dy || 0) >= 0 ? 'down' : 'up');
          const args: any = { pid: target.pid, direction, amount: Math.max(1, Math.min(50, Math.round(Math.abs((cmd.dy || cmd.dx || 120) / 40)))), session, delivery_mode: delivery };
          if (target.windowId) args.window_id = target.windowId;
          if (cmd.elementToken) args.element_token = cmd.elementToken;
          else if (cmd.elementIndex != null) args.element_index = Math.floor(cmd.elementIndex);
          else if (cmd.x != null && cmd.y != null) { args.x = cmd.x; args.y = cmd.y; }
          if (delivery === 'foreground' && this.observedTarget?.width && this.observedTarget?.height) {
            const point = {
              x: cmd.x == null ? Math.round(this.observedTarget.width / 2)
                : cmd.normalized ? scaleNormalizedPoint(cmd.x, this.observedTarget.width - 1) : Math.round(cmd.x),
              y: cmd.y == null ? Math.round(this.observedTarget.height / 2)
                : cmd.normalized ? scaleNormalizedPoint(cmd.y, this.observedTarget.height - 1) : Math.round(cmd.y),
            };
            const globalPoint = await this.preparePhysicalPoint(target, point);
            if (globalPoint) {
              const native = await this.fallback.run({
                action: 'scroll', x: globalPoint.x, y: globalPoint.y,
                dx: cmd.dx || 0, dy: cmd.dy || 0, app: target.app, normalized: false,
              }, ctx);
              if (!native.ok) throw new Error(native.error || native.summary);
              const evidence = await this.postActionEvidence(target, cwd, session);
              return {
                ok: true, action: cmd.action, driver, app: target.app, pid: target.pid, windowId: target.windowId,
                details: { path: 'native-global-cgevent', at: globalPoint }, ...evidence,
                summary: `visible native cursor scrolled ${direction} in ${target.app || `pid ${target.pid}`}; fresh screen attached`,
              };
            }
          }
          const data = await this.call('scroll', args);
          const evidence = await this.postActionEvidence(target, cwd, session);
          return { ok: true, action: cmd.action, driver, app: target.app, pid: target.pid, windowId: target.windowId, details: data, ...evidence, summary: `scrolled ${direction} in ${target.app || `pid ${target.pid}`}; fresh screen attached` };
        }
        case 'hover':
        case 'hold':
        case 'mouse_down':
        case 'mouse_up': {
          if (!target) return this.fallback.run(cmd, ctx);
          // Await inside runInner's try/catch so a native timeout remains a normal {ok:false}
          // DesktopResult instead of escaping as an unhandled rejected promise.
          return await this.pointerPrimitive(cmd.action, target, cmd, cwd, session, ctx);
        }
        case 'close': {
          // close = close the SELECTED WINDOW only (Cmd+W / Ctrl+W). It must never quit the whole
          // application — that is the separate, high-impact quit_app action below.
          if (!target) return this.fallback.run(cmd, ctx);
          const closingWindowId = target.windowId;
          const combo = process.platform === 'darwin' ? 'cmd+w' : 'ctrl+w';
          await this.ensurePhysicalTargetFrontmost(target);
          const delivered = await this.fallback.run({ action: 'key', combo, app: target.app }, ctx);
          if (!delivered.ok) throw new Error(delivered.error || delivered.summary);
          // Close animations and the WindowServer's stale-enumeration grace period both outlive a
          // single fixed delay; poll before declaring the close failed (same phenomenon that kept
          // dismissed sheets enumerable for a tick).
          let remaining: any[] = [];
          let stillListed = true;
          for (const settleMs of [350, 450, 700]) {
            await new Promise(resolve => setTimeout(resolve, settleMs));
            const windows = await this.call('list_windows', { pid: target.pid });
            remaining = Array.isArray(windows?.windows) ? windows.windows : [];
            stillListed = !!closingWindowId && remaining.some((w: any) => Number(w?.window_id) === closingWindowId);
            if (!stillListed) break;
          }
          if (stillListed) {
            throw new Error(`window ${closingWindowId} of ${target.app || `pid ${target.pid}`} did not close after Cmd+W — it may have an unsaved-changes prompt open; observe to see its current state`);
          }
          // The app keeps running. Retarget to its next window when one exists; otherwise drop the target.
          const next = remaining.find((w: any) => w?.is_on_screen !== false && Number(w?.bounds?.width || 0) > 100);
          if (next && this.targets.owns(target.pid)) {
            this.targets.retargetWindow(target.pid, Number(next.window_id) || undefined);
            this.syncSurface();
          } else if (this.targets.owns(target.pid) && remaining.length === 0) {
            this.surfaces.remove(`native:${target.pid}`);
            // Forget only THIS app. A session can have several apps open at once (copy from one,
            // paste into another); closing one window must not erase the others' registrations and
            // force a re-launch. No other app is auto-activated: switching the input target without
            // being asked is exactly how coordinates end up delivered to the wrong window. The model
            // picks the next surface explicitly with focus, which returns a fresh frame.
            this.targets.forget(target.pid);
            this.pinnedWindow = null;
            this.syncLivePip();
          }
          return {
            ok: true, action: cmd.action, driver, app: target.app, pid: target.pid, windowId: closingWindowId,
            actionResult: { delivered: true, observed: 'confirmed', postcondition: { query: 'target window no longer listed', matched: true }, confidence: 'proven' },
            summary: `closed window ${closingWindowId ?? '?'} of ${target.app || `pid ${target.pid}`} (application still running${remaining.length ? `, ${remaining.length} window(s) remain` : ''})`,
          };
        }
        case 'quit_app': {
          // High impact: quits the ENTIRE application and may discard unsaved state. The tool layer
          // gates this behind an explicit approval; the runtime verifies the quit actually happened.
          if (!target) return this.fallback.run({ ...cmd, action: 'quit_app' }, ctx);
          const combo = process.platform === 'darwin' ? 'cmd+q' : 'alt+f4';
          await this.ensurePhysicalTargetFrontmost(target);
          const delivered = await this.fallback.run({ action: 'key', combo, app: target.app }, ctx);
          if (!delivered.ok) throw new Error(delivered.error || delivered.summary);
          await new Promise(resolve => setTimeout(resolve, 350));
          const windows = await this.call('list_windows', { pid: target.pid });
          if (Array.isArray(windows?.windows) && windows.windows.length > 0) {
            throw new Error(`${target.app || `pid ${target.pid}`} did not quit after the cooperative quit shortcut — it may be showing an unsaved-changes prompt; observe to see its current state`);
          }
          this.surfaces.remove(`native:${target.pid}`);
          // Drop only the quit app — other apps this session opened stay registered and focusable.
          this.targets.forget(target.pid);
          this.pinnedWindow = null;
          // A quit app must not linger as a re-acquirable identity: the next turn's observe would
          // chase a pid the OS may already have recycled onto an unrelated process.
          if (this.lastOwnedTarget?.pid === target.pid) this.lastOwnedTarget = null;
          this.syncLivePip();
          return {
            ok: true, action: cmd.action, driver, app: target.app, pid: target.pid,
            actionResult: { delivered: true, observed: 'confirmed', postcondition: { query: 'application windows no longer listed', matched: true }, confidence: 'proven' },
            summary: `quit ${target.app || `pid ${target.pid}`} and verified that its windows disappeared`,
          };
        }
        case 'move': {
          if (cmd.x == null || cmd.y == null) throw new Error('move needs x and y');
          if (delivery === 'foreground') return this.fallback.run({ ...cmd, normalized: false }, ctx);
          const data = await this.call('move_cursor', { x: cmd.x, y: cmd.y, session });
          return { ok: true, action: cmd.action, driver, x: cmd.x, y: cmd.y, details: data, summary: `moved Bimax cursor to ${cmd.x},${cmd.y}` };
        }
        case 'wait': {
          const ms = Math.max(WAIT_MIN, Math.min(WAIT_MAX, Math.floor(cmd.ms || 500)));
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, ms);
            ctx?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('computer wait aborted')); }, { once: true });
          });
          const evidence = target?.windowId ? await this.postActionEvidence(target, cwd, session) : {};
          return { ok: true, action: cmd.action, driver, app: target?.app, pid: target?.pid, windowId: target?.windowId, ...evidence, summary: `waited ${ms}ms${target?.windowId ? '; fresh screen attached' : ''}` };
        }
        default:
          return { ok: false, action: cmd.action, driver, error: `unsupported computer action: ${String(cmd.action)}`, summary: `${cmd.action} failed` };
      }
    } catch (err: any) {
      const error = bimaxBrand(String(err?.message || err)).slice(0, 1000);
      return {
        ok: false, action: cmd.action, driver, error,
        actionResult: { delivered: false, observed: 'failed', confidence: 'unknown', failureReason: error },
        summary: `${cmd.action} failed`,
      };
    }
  }
}

export const globalDesktopRuntime: DesktopRuntimePort = new BimaxComputerRuntime();
