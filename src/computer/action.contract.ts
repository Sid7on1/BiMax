import { DesktopCommand, DesktopResult, PUBLIC_DESKTOP_ACTIONS, PublicDesktopAction } from './desktop.runtime';

/**
 * The model-facing contract for the one ComputerTool namespace.
 *
 * Keep these entries short and operational. The runtime has much deeper diagnostics, but the
 * model only needs to know why an action exists, the legal argument shape, and what evidence comes
 * back. This table is also checked against PUBLIC_DESKTOP_ACTIONS, so a newly exposed action cannot
 * silently ship without its own description.
 */
export interface ComputerActionContract {
  purpose: string;
  input: string;
  returns: string;
  coordinateFrame: 'none' | 'target-frame' | 'global-screen';
}

export const COMPUTER_ACTION_CONTRACTS: Record<PublicDesktopAction, ComputerActionContract> = {
  status: { purpose: 'Check driver health and desktop permissions.', input: 'No target.', returns: 'Permission checks and runtime readiness.', coordinateFrame: 'none' },
  request_access: { purpose: 'Request missing Accessibility or Screen Recording permission.', input: 'No target.', returns: 'Current permission state.', coordinateFrame: 'none' },
  apps: { purpose: 'List running applications without choosing one.', input: 'No target.', returns: 'Running app names and process ids.', coordinateFrame: 'none' },
  windows: { purpose: 'List live windows, optionally for one app process.', input: 'Optional app or pid.', returns: 'Current window ids, titles, and bounds.', coordinateFrame: 'none' },
  open: { purpose: 'Launch or acquire an application and make its exact window the owned target.', input: 'app or bundleId; optional exact windowId/newInstance.', returns: 'Owned app, pid, windowId, and fresh target frame.', coordinateFrame: 'none' },
  focus: { purpose: 'Switch to an app already registered in this session without relaunching it.', input: 'app or pid; optional exact windowId.', returns: 'New owned target and fresh target frame.', coordinateFrame: 'none' },
  observe: { purpose: 'Refresh the exact owned window and its semantic element map.', input: 'Optional query, maxElements, includeScreenshot.', returns: 'Fresh frameId, target screenshot, display context, and elements.', coordinateFrame: 'none' },
  screenshot: { purpose: 'Capture the owned window, or an explicitly selected display when no window is owned.', input: 'Optional display index.', returns: 'Fresh screenshot dimensions and frame identity.', coordinateFrame: 'none' },
  click: { purpose: 'Click exactly one control or point.', input: 'One selector: query, elementToken, elementIndex, or x+y+frameId.', returns: 'Recipient receipt, verification, and fresh post-action frame.', coordinateFrame: 'target-frame' },
  type: { purpose: 'Insert literal Unicode text, optionally focusing one editable control atomically.', input: 'text; optional one selector; x+y requires frameId.', returns: 'Keyboard recipient receipt and fresh post-action frame.', coordinateFrame: 'target-frame' },
  key: { purpose: 'Send one keyboard key or shortcut to the owned target.', input: 'combo such as return or cmd+shift+t; optional expect.', returns: 'Keyboard recipient receipt and fresh post-action frame.', coordinateFrame: 'none' },
  set_value: { purpose: 'Assign an exact native value instead of approximating with pointer motion.', input: 'value plus query, elementToken, or elementIndex.', returns: 'Applied value evidence and fresh post-action frame.', coordinateFrame: 'none' },
  drag: { purpose: 'Drag from one grounded source to one grounded destination.', input: 'Source selector or x+y; destination selector or toX+toY; raw pixels require frameId. Use toApp for cross-app.', returns: 'Drag receipt and fresh post-action frame.', coordinateFrame: 'target-frame' },
  scroll: { purpose: 'Scroll the owned window at an optional grounded point.', input: 'dx or dy; optional selector or x+y+frameId.', returns: 'Direction, delivery result, and fresh post-action frame.', coordinateFrame: 'target-frame' },
  hover: { purpose: 'Move the physical cursor to a target-frame point and pause.', input: 'x+y+frameId; optional ms.', returns: 'Delivery result and fresh post-action frame.', coordinateFrame: 'target-frame' },
  hold: { purpose: 'Press and hold a mouse button at a target-frame point, then release.', input: 'x+y+frameId; optional button/ms.', returns: 'Delivery result and fresh post-action frame.', coordinateFrame: 'target-frame' },
  mouse_down: { purpose: 'Press and leave a physical mouse button held.', input: 'x+y+frameId; optional button.', returns: 'Held-button state; follow with mouse_up.', coordinateFrame: 'target-frame' },
  mouse_up: { purpose: 'Release a held physical mouse button at a grounded point.', input: 'x+y+frameId; optional button.', returns: 'Release result and fresh post-action frame.', coordinateFrame: 'target-frame' },
  cursor: { purpose: 'Read the current physical cursor location.', input: 'No target.', returns: 'Global screen x/y.', coordinateFrame: 'global-screen' },
  frontmost: { purpose: 'Read which application is actually frontmost.', input: 'No target.', returns: 'OS-reported app name.', coordinateFrame: 'none' },
  move: { purpose: 'Move the cursor without clicking.', input: 'x+y in global screen points.', returns: 'Final global cursor x/y.', coordinateFrame: 'global-screen' },
  copy: { purpose: 'Copy the current selection from the owned app.', input: 'Optional expect.', returns: 'Clipboard-change proof plus fresh post-action frame.', coordinateFrame: 'none' },
  paste: { purpose: 'Paste current clipboard content into the owned app.', input: 'Optional expect.', returns: 'Recipient receipt plus fresh post-action frame.', coordinateFrame: 'none' },
  clipboard: { purpose: 'Read the clipboard, or replace it with text or files.', input: 'No value/paths to read; value for text; paths for files.', returns: 'Clipboard types, files, text, and change counter.', coordinateFrame: 'none' },
  arrange: { purpose: 'Place the owned window using OS window geometry.', input: 'layout or exact bounds; optional display.', returns: 'Requested and achieved window rectangles plus fresh frame.', coordinateFrame: 'global-screen' },
  desktop: { purpose: 'List desktop items or move one item.', input: 'No query to list; query plus toQuery or global toX+toY to move.', returns: 'Current desktop items and verified move result.', coordinateFrame: 'global-screen' },
  close: { purpose: 'Close only the owned window, keeping the application running.', input: 'Optional exact app/pid/windowId.', returns: 'Proof that the selected window disappeared.', coordinateFrame: 'none' },
  quit_app: { purpose: 'Quit the entire owned application.', input: 'Optional exact app/pid.', returns: 'Proof that its windows disappeared.', coordinateFrame: 'none' },
  wait: { purpose: 'Wait briefly for UI animation or asynchronous state to settle.', input: 'Optional ms from 50 to 5000.', returns: 'Fresh frame when a window is owned.', coordinateFrame: 'none' },
  record_start: { purpose: 'Start explicit computer-use recording.', input: 'captureScope window (default) or display; display records the human-visible screen and requires approval.', returns: 'Truthful recording scope and output directory.', coordinateFrame: 'none' },
  record_status: { purpose: 'Read current recording state.', input: 'No target.', returns: 'Enabled state, scope, paths, and error.', coordinateFrame: 'none' },
  record_stop: { purpose: 'Stop the active recording.', input: 'No target.', returns: 'Final recording and video paths.', coordinateFrame: 'none' },
  menu_activate: { purpose: "Run a command from the app's menu bar — the exact, verifiable path when the window's accessibility tree cannot serve the request.", input: "menuPath: the dotted index path from an observation's menu list (e.g. \"5.19\"). Never a menu NAME — names repeat, carry invisible marks, and change with locale.", returns: 'The activated command, and whether its effect was confirmed by the item renaming itself.', coordinateFrame: 'none' },
  menu_search: { purpose: "Type into the app's OWN search box to reach CONTENT a menu cannot name — one song, one conversation, one file.", input: 'searchText (required); searchSubmit to press Return. The entry point is discovered from the menu bar, so no shortcut is passed.', returns: 'The search command used, and what could verify the result — never a claim that it was verified.', coordinateFrame: 'none' },
};

export function renderComputerActionReference(): string {
  return PUBLIC_DESKTOP_ACTIONS.map(action => {
    const spec = COMPUTER_ACTION_CONTRACTS[action];
    return `${action}: ${spec.purpose} Input: ${spec.input} Returns: ${spec.returns}`;
  }).join('\n');
}

function hasSelector(cmd: DesktopCommand): boolean {
  return !!(cmd.query?.trim() || cmd.elementToken || cmd.elementIndex != null);
}

function selectorCount(cmd: DesktopCommand): number {
  return Number(!!cmd.query?.trim()) + Number(!!cmd.elementToken)
    + Number(cmd.elementIndex != null) + Number(cmd.x != null);
}

/**
 * Which selectors the caller actually supplied. "accepts exactly one selector" tells a model the
 * rule but not what it did wrong, and a model that cannot see its own mistake repeats it — the
 * baseline caught exactly that loop. Naming the conflict costs nothing and makes the refusal
 * actionable. It never says which one to keep: that is intent, and guessing it lands a click
 * somewhere nobody asked for.
 */
function suppliedSelectors(cmd: DesktopCommand): string {
  const names = [
    cmd.query?.trim() ? 'query' : '',
    cmd.elementToken ? 'elementToken' : '',
    cmd.elementIndex != null ? 'elementIndex' : '',
    cmd.x != null ? 'x+y' : '',
  ].filter(Boolean);
  return names.join(' + ');
}

function pairError(a: unknown, b: unknown, names: string): string | null {
  return (a == null) === (b == null) ? null : `${names} must be supplied together`;
}

/**
 * Unwrap the action-as-envelope shape some models emit: `{"click": {...}}` instead of
 * `{"action": "click", ...}`.
 *
 * Measured on the Phase 10 baseline fixture (2026-08-08, nvidia/nemotron-nano-12b-v2-vl): the model
 * sent `{"click":{"button":"right","elementIndex":2,"query":"pop-up button","x":450,"y":300}}`, the
 * runtime answered `unknown public action: undefined`, and the model then repeated the IDENTICAL
 * call six times before giving up — the whole turn budget spent on a refusal that named the symptom
 * (`undefined`) rather than the mistake. It never learned that its envelope was the problem, because
 * nothing in the reply mentioned the envelope.
 *
 * The rewrite is deliberately narrow, so it cannot fire on a well-formed command:
 *   - there must be NO `action` key already (a real command always carries one);
 *   - there must be exactly ONE key, and it must name a public action;
 *   - its value must be a plain object (the arguments).
 * Anything else is left exactly as it arrived for validation to reject on the merits.
 *
 * This normalizes SHAPE only. It never invents, drops, or chooses between selectors — a command
 * that arrives with four conflicting selectors still gets refused, because guessing which one the
 * model meant is how a click lands somewhere nobody asked for.
 */
export function unwrapActionEnvelope(args: Record<string, unknown>): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  if (args.action !== undefined) return args;
  const keys = Object.keys(args);
  if (keys.length !== 1) return args;
  const action = keys[0];
  if (!(PUBLIC_DESKTOP_ACTIONS as readonly string[]).includes(action)) return args;
  const payload = args[action];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return args;
  return { action, ...(payload as Record<string, unknown>) };
}

/** Reject malformed model calls before approval or runtime delivery. Runtime validation remains the
 * final authority; this layer exists to turn ambiguous argument soup into one precise action. */
export function validateModelComputerCommand(cmd: DesktopCommand): string | null {
  if (!(PUBLIC_DESKTOP_ACTIONS as readonly string[]).includes(cmd.action)) return `unknown public action: ${String(cmd.action)}`;
  const xy = pairError(cmd.x, cmd.y, 'x and y');
  const to = pairError(cmd.toX, cmd.toY, 'toX and toY');
  if (xy) return xy;
  if (to) return to;

  switch (cmd.action) {
    case 'open': return cmd.app?.trim() || cmd.bundleId?.trim() ? null : 'open needs app or bundleId';
    case 'focus': return cmd.app?.trim() || cmd.pid ? null : 'focus needs app or pid';
    case 'click':
      if (!hasSelector(cmd) && cmd.x == null) return 'click needs query, elementToken, elementIndex, or x+y';
      if (selectorCount(cmd) > 1) return `click accepts exactly one selector, but received ${suppliedSelectors(cmd)}; send only the one you mean (query, elementToken, elementIndex, or x+y)`;
      if (cmd.x != null && !cmd.frameId) return 'raw click coordinates require frameId from the exact screenshot';
      return null;
    case 'type':
      if (cmd.text == null) return 'type needs text';
      if (selectorCount(cmd) > 1) return `type accepts at most one focus selector, but received ${suppliedSelectors(cmd)}; send only the one you mean (query, elementToken, elementIndex, or x+y)`;
      if (cmd.x != null && !cmd.frameId) return 'raw type coordinates require frameId from the exact screenshot';
      return null;
    case 'key': return cmd.combo?.trim() ? null : 'key needs combo';
    case 'menu_search':
      return cmd.searchText?.trim() ? null : 'menu_search needs searchText';
    case 'menu_activate': {
      const raw = cmd.menuPath?.trim();
      if (!raw) return "menu_activate needs menuPath — the dotted index path from an observation's menu list (e.g. \"5.19\")";
      // A NAME is the one thing this must never accept: names repeat within a single menu, carry
      // invisible direction marks in some apps, and change with locale. Refusing here gives the
      // model the correction, instead of letting a plausible-looking name reach AppleScript.
      if (!/^\d+(\.\d+)*$/.test(raw)) {
        return `menu_activate needs a dotted index path such as "5.19", not a menu name (received ${JSON.stringify(cmd.menuPath)})`;
      }
      return null;
    }
    case 'set_value':
      if (cmd.value == null) return 'set_value needs value';
      if (selectorCount(cmd) !== 1 || cmd.x != null) return `set_value needs exactly one semantic selector (query, elementToken, or elementIndex)${suppliedSelectors(cmd) ? `, but received ${suppliedSelectors(cmd)}` : ''}`;
      return hasSelector(cmd) ? null : 'set_value needs query, elementToken, or elementIndex';
    case 'drag': {
      if (selectorCount(cmd) > 1) return 'drag source accepts exactly one selector or x+y';
      const destinationSelectorCount = Number(!!cmd.toQuery?.trim()) + Number(!!cmd.toElementToken)
        + Number(cmd.toElementIndex != null) + Number(cmd.toX != null);
      if (destinationSelectorCount > 1) return 'drag destination accepts exactly one selector: toQuery, toElementToken, toElementIndex, or toX+toY';
      const source = hasSelector(cmd) || cmd.x != null;
      const destination = !!(cmd.toApp?.trim() || cmd.toQuery?.trim() || cmd.toElementToken || cmd.toElementIndex != null || cmd.toX != null);
      if (!source) return 'drag needs a source selector or x+y';
      if (!destination) return 'drag needs a destination selector, toApp, or toX+toY';
      if ((cmd.x != null || cmd.toX != null) && !cmd.frameId) return 'raw drag coordinates require frameId from the exact source screenshot';
      return null;
    }
    case 'scroll':
      if (cmd.dx == null && cmd.dy == null) return 'scroll needs dx or dy';
      if (selectorCount(cmd) > 1) return `scroll accepts at most one position selector, but received ${suppliedSelectors(cmd)}; send only the one you mean (query, elementToken, elementIndex, or x+y)`;
      if (cmd.x != null && !cmd.frameId) return 'positioned scroll coordinates require frameId from the exact screenshot';
      return null;
    case 'hover': case 'hold': case 'mouse_down': case 'mouse_up':
      if (cmd.x == null) return `${cmd.action} needs x+y from the exact screenshot`;
      return cmd.frameId ? null : `${cmd.action} requires frameId from that screenshot`;
    case 'move':
      if (cmd.x == null) return 'move needs global screen x+y';
      return cmd.normalized ? 'move uses global screen points; normalized coordinates are not valid' : null;
    case 'arrange': return cmd.layout || cmd.bounds ? null : 'arrange needs layout or bounds';
    case 'desktop':
      if (!cmd.query?.trim()) return null;
      if (cmd.normalized) return 'desktop destinations use global screen points; normalized coordinates are not valid';
      return cmd.toQuery?.trim() || cmd.toX != null ? null : 'moving a desktop item needs toQuery or global toX+toY';
    case 'clipboard': return cmd.value != null && !!cmd.paths?.length ? 'clipboard accepts value or paths, not both' : null;
    default: return null;
  }
}

const MODEL_RESULT_KEYS: Array<keyof DesktopResult> = [
  'ok', 'action', 'summary', 'error', 'driver',
  'app', 'pid', 'windowId', 'bundleId', 'running', 'frontmostWarning',
  'screenshot', 'width', 'height', 'displayScreenshot', 'displayWidth', 'displayHeight',
  'frameId', 'frameHash', 'coordinateSpace', 'modalFrame',
  'elements', 'degraded', 'visualEvidenceError', 'verification', 'targeting',
  'progressCheck', 'actionResult', 'actionReceipt', 'recoveryDecision', 'recoveryHint',
  'preview', 'clipboard', 'icons', 'windowFrame', 'requestedFrame',
  'recording', 'accessibility', 'screenRecording', 'displays', 'screens',
  'x', 'y', 'fullscreen', 'fullscreenSupported', 'fullscreenMatched', 'applied',
];

/**
 * Convert the deep runtime result into the only object placed in model history. Heavy native
 * diagnostics, duplicate completion prose, full AX trees, and transport responses stay available
 * to runtime tests/logging but do not compete with the current frame for model attention.
 */
export function computerResultForModel(result: DesktopResult): Record<string, unknown> {
  const compact: Record<string, unknown> = {};
  for (const key of MODEL_RESULT_KEYS) {
    const value = result[key];
    if (value !== undefined) compact[key] = value;
  }
  if (['status', 'request_access', 'apps', 'windows'].includes(result.action) && result.details != null) {
    compact.data = result.details;
  } else if (result.action === 'set_value' && result.details && typeof result.details === 'object') {
    const details = result.details as Record<string, unknown>;
    compact.data = {
      target: details.target,
      requestedValue: details.requestedValue,
      appliedValue: details.appliedValue,
      endpoint: details.endpoint,
    };
  } else if ((!result.elements || result.elements.length === 0) && result.tree) {
    // Text-only/degraded drivers still get a bounded structural fallback. A normal observation's
    // compact elements already contains the same labels, so sending both only duplicates state.
    compact.tree = result.tree.slice(0, 12_000);
  }
  return compact;
}
