import { createHash, randomUUID } from 'crypto';

import { verifiedWorkspaceOperations, type NativeServiceHandshake } from './native.service.client';
import {
  computeWindowTile,
  displayForWindow,
  WINDOW_TILE_PRESETS,
  type LayoutRect,
  type WindowTilePreset,
} from './native.window.layout';
import {
  NativeBridgeTransportError,
  NativeServiceOperationClient,
} from './native.bridge.transport';
import {
  compileNativeSemanticTransaction,
  type CompiledNativeTransaction,
  type NativeElementRef,
  type NativeSemanticValue,
  type NativeTransactionAction,
  type NativeTransactionDeliveryPolicy,
  type NativeTransactionPrecondition,
} from './native.transaction.compiler';
import {
  NativeAppProfileRegistry,
  type NativeAppGuidanceReceipt,
  type NativeAppIdentity,
} from './native.app.profile.registry';
import { globalNativeInputInterlock, type NativeInputInterlock } from './native.input.interlock';
import { refreshTakeoverAuthority } from './takeover.authority';

export interface NativeAXNode {
  token: string;
  role: string;
  label?: string;
  value?: string;
  identifier?: string;
  enabled: boolean;
  elementRef?: NativeElementRef;
}

interface NativeAXDiffOperation {
  op: 'insert' | 'update' | 'remove';
  node?: NativeAXNode;
  token?: string;
}

export interface NativeAXSnapshot {
  snapshotId: string;
  sessionId: string;
  pid: number;
  windowId?: number;
  windowGeneration?: number;
  eventRevision: number;
  eventTracking: boolean;
  truncated: boolean;
  partial: boolean;
  changedDuringCapture: boolean;
  baseSnapshotId?: string;
  nodes: NativeAXNode[];
  diff?: NativeAXDiffOperation[];
  [key: string]: unknown;
}

interface RetainedCoordinatorSnapshot {
  snapshot: NativeAXSnapshot;
  nodes: Map<string, NativeAXNode>;
}

interface NativeTaskState {
  serviceSessionId: string;
  snapshots: Map<string, RetainedCoordinatorSnapshot>;
}

function isRetiredNativeSession(error: unknown): boolean {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return code === 'session_not_found';
}

export interface PreparedNativeTransaction {
  serviceSessionId: string;
  compiled: CompiledNativeTransaction;
}

export interface NativeActionToolInput {
  snapshotId: string;
  elementToken: string;
  action: string;
  value?: unknown;
  payload?: unknown;
  deliveryPolicy: string;
  evidenceTier?: number;
  postcondition?: Record<string, unknown>;
  settleTimeoutMs?: number;
}

export interface NativeTransactionToolInput {
  basedOnSnapshotId: string;
  deliveryPolicy: NativeTransactionDeliveryPolicy;
  steps: Array<{
    stepId: string;
    elementToken: string;
    action: NativeTransactionAction;
    value: unknown;
    precondition?: NativeTransactionPrecondition;
  }>;
}

export interface NativeCaptureToolInput {
  mode: 'image' | 'som' | 'zoom';
  pid?: number;
  windowId?: number;
  windowGeneration?: number;
  displayId?: number;
  basedOnSnapshotId?: string;
  region?: { x: number; y: number; width: number; height: number };
  zoomFactor?: number;
  format?: 'png' | 'jpeg';
  jpegQuality?: number;
  maxDimension?: number;
}

export interface NativeAppLookupInput {
  bundleId?: unknown;
  appName?: unknown;
  readinessTimeoutMs?: unknown;
}

export interface NativeAppLookup { kind: 'bundle_id' | 'name'; value: string }

export interface ResolvedNativeApplication {
  lookup: NativeAppLookup;
  resolved: boolean;
  bundlePath?: string;
  bundleId?: string;
  displayName?: string;
  running: Array<{ pid: number; bundleId?: string; displayName?: string }>;
}

export type NativeFileOperation = 'open_file' | 'reveal_file' | 'trash_file' | 'duplicate_file';

export type NativeWindowOperation = 'move_window' | 'resize_window' | 'set_window_frame'
  | 'minimize_window' | 'unminimize_window' | 'close_window' | 'set_window_fullscreen';

export interface PreparedNativeWindowOperation {
  serviceSessionId: string;
  operation: NativeWindowOperation;
  window: { pid: number; windowId: number; generation: number };
  frame?: LayoutRect;
  fullScreen?: boolean;
  /** Set when the geometry came from a layout preset, so the approval can name it. */
  tile?: WindowTilePreset;
  /** Closing a window may discard unsaved work. It is never routine. */
  commitAction: boolean;
}

export interface PreparedNativeFileOperation {
  serviceSessionId: string;
  operation: NativeFileOperation;
  /** The workspace-resolved absolute path. Approval names this, never the model's input string. */
  path: string;
  application?: NativeAppLookup;
  /** Reveal brings Finder forward; the caller must be told before it approves. */
  changesForeground: boolean;
}

export interface PreparedNativeUrlOpen {
  serviceSessionId: string;
  url: string;
  host: string;
  application?: NativeAppLookup;
}

export interface PreparedNativeLaunch {
  serviceSessionId: string;
  lookup: NativeAppLookup;
  /** The bundle Launch Services actually resolved. Approval names this, never the model's string. */
  resolved: ResolvedNativeApplication;
  alreadyRunning: boolean;
  readinessTimeoutMs: number;
}

export interface PreparedNativeAction {
  serviceSessionId: string;
  request: Record<string, unknown>;
  target: { pid: number; windowId: number; windowGeneration: number };
  node: NativeAXNode;
  foreground: boolean;
}

function taskNativeId(taskSessionId: string): string {
  const digest = createHash('sha256').update(taskSessionId).digest('hex').slice(0, 24);
  return `bimax-task-${digest}`;
}

function typedValue(value: unknown): NativeSemanticValue {
  if (typeof value === 'string' && value.length <= 4_096 && !value.includes('\0')) {
    return { type: 'string', value };
  }
  if (typeof value === 'boolean') return { type: 'boolean', value };
  if (typeof value === 'number' && Number.isFinite(value)) return { type: 'number', value };
  throw new NativeBridgeTransportError('invalid_semantic_value', 'native semantic value must be a finite string, number, or boolean');
}

function validElementRef(value: unknown, snapshotId: string): value is NativeElementRef {
  if (!value || typeof value !== 'object') return false;
  const ref = value as Partial<NativeElementRef>;
  return typeof ref.token === 'string' && ref.token.length > 0 && !ref.token.includes('\0')
    && ref.snapshotId === snapshotId
    && Number.isSafeInteger(ref.pid) && (ref.pid ?? 0) > 0
    && Number.isSafeInteger(ref.windowId) && (ref.windowId ?? 0) > 0
    && Number.isSafeInteger(ref.windowGeneration) && (ref.windowGeneration ?? -1) >= 0
    && Number.isSafeInteger(ref.axRevision) && (ref.axRevision ?? -1) >= 0
    && typeof ref.stablePathHash === 'string' && ref.stablePathHash.length > 0
    && !ref.stablePathHash.includes('\0');
}

function validNode(value: unknown, snapshotId: string): value is NativeAXNode & { elementRef: NativeElementRef } {
  if (!value || typeof value !== 'object') return false;
  const node = value as Partial<NativeAXNode>;
  return typeof node.token === 'string' && node.token.length > 0 && !node.token.includes('\0')
    && typeof node.role === 'string' && node.role.length > 0
    && typeof node.enabled === 'boolean'
    && validElementRef(node.elementRef, snapshotId)
    && node.elementRef.token === node.token;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function actionShape(input: NativeActionToolInput): void {
  const fail = (message: string): never => {
    throw new NativeBridgeTransportError('invalid_action_shape', message);
  };
  if (input.evidenceTier !== undefined && input.evidenceTier !== 1 && input.evidenceTier !== 2) {
    fail('evidenceTier must be 1 or 2');
  }
  if (input.settleTimeoutMs !== undefined && (!Number.isSafeInteger(input.settleTimeoutMs)
      || input.settleTimeoutMs < 50 || input.settleTimeoutMs > 5_000)) {
    fail('settleTimeoutMs must be between 50 and 5000');
  }
  if (input.postcondition !== undefined
      && (!input.postcondition || typeof input.postcondition !== 'object' || Array.isArray(input.postcondition))) {
    fail('postcondition must be an object');
  }
  if (input.postcondition) {
    const allowed = new Set([
      'text', 'textPresence', 'expectedValue', 'valueMustChange',
      'expectedFocused', 'expectedSelected', 'elementExists',
    ]);
    if (Object.keys(input.postcondition).some(key => !allowed.has(key))) fail('postcondition contains an unsupported field');
    if (input.postcondition.text !== undefined
        && (typeof input.postcondition.text !== 'string' || input.postcondition.text.length > 4_096)) fail('postcondition.text is invalid');
    if (input.postcondition.expectedValue !== undefined
        && (typeof input.postcondition.expectedValue !== 'string' || input.postcondition.expectedValue.length > 4_096)) fail('postcondition.expectedValue is invalid');
    if (input.postcondition.textPresence !== undefined
        && input.postcondition.textPresence !== 'present' && input.postcondition.textPresence !== 'absent') fail('postcondition.textPresence is invalid');
    for (const key of ['valueMustChange', 'expectedFocused', 'expectedSelected', 'elementExists']) {
      if (input.postcondition[key] !== undefined && typeof input.postcondition[key] !== 'boolean') {
        fail(`postcondition.${key} must be boolean`);
      }
    }
  }

  const noArgument = new Set([
    'invoke', 'increment', 'decrement', 'toggle', 'expand', 'collapse', 'select', 'scroll_to_visible',
  ]);
  if (noArgument.has(input.action)) {
    if (input.value !== undefined || input.payload !== undefined) fail(`${input.action} does not accept value or payload`);
    return;
  }
  if (input.action === 'set_value') {
    if (input.value === undefined || input.payload !== undefined) fail('set_value requires value and no payload');
    typedValue(input.value);
    return;
  }
  if (input.action === 'set_selected') {
    if (typeof input.value !== 'boolean' || input.payload !== undefined) fail('set_selected requires a boolean value and no payload');
    return;
  }
  if (input.action === 'type_text') {
    if (typeof input.value !== 'string' || input.value.length === 0 || input.payload !== undefined) {
      fail('type_text requires a non-empty string value and no payload');
    }
    typedValue(input.value);
    return;
  }
  const payloadKinds: Record<string, string> = {
    select_text_range: 'text_range', select_text: 'text_match', set_caret: 'caret',
    scroll_page: 'scroll', scroll_to_fraction: 'scroll_fraction',
  };
  const expectedKind = payloadKinds[input.action];
  if (expectedKind) {
    const payload = input.payload as Record<string, unknown> | undefined;
    if (input.value !== undefined || !payload || typeof payload !== 'object' || Array.isArray(payload)
        || payload.kind !== expectedKind) fail(`${input.action} requires a ${expectedKind} payload and no value`);
    const safePayload = payload!;
    const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => !!value
      && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).every(key => keys.includes(key));
    if (input.action === 'select_text_range') {
      const range = safePayload.range;
      if (!exact(safePayload, ['kind', 'range']) || !exact(range, ['location', 'length'])
          || !Number.isSafeInteger(range.location) || (range.location as number) < 0
          || !Number.isSafeInteger(range.length) || (range.length as number) < 0) fail('select_text_range payload is invalid');
    } else if (input.action === 'select_text') {
      const match = safePayload.match;
      if (!exact(safePayload, ['kind', 'match']) || !exact(match, ['text', 'prefix', 'suffix', 'placement'])
          || typeof match.text !== 'string' || match.text.length < 1 || match.text.length > 4_096
          || (match.prefix !== undefined && (typeof match.prefix !== 'string' || match.prefix.length > 4_096))
          || (match.suffix !== undefined && (typeof match.suffix !== 'string' || match.suffix.length > 4_096))
          || (match.placement !== undefined && !['select', 'before', 'after'].includes(String(match.placement)))) fail('select_text payload is invalid');
    } else if (input.action === 'set_caret') {
      const caret = safePayload.caret;
      if (!exact(safePayload, ['kind', 'caret']) || !exact(caret, ['anchor', 'index'])
          || !['index', 'start', 'end'].includes(String(caret.anchor))
          || (caret.index !== undefined && (!Number.isSafeInteger(caret.index) || (caret.index as number) < 0))
          || (caret.anchor === 'index') !== (caret.index !== undefined)) fail('set_caret payload is invalid');
    } else if (input.action === 'scroll_page') {
      const scroll = safePayload.scroll;
      if (!exact(safePayload, ['kind', 'scroll']) || !exact(scroll, ['direction'])
          || !['up', 'down', 'left', 'right'].includes(String(scroll.direction))) fail('scroll_page payload is invalid');
    } else if (input.action === 'scroll_to_fraction') {
      const scroll = safePayload.scrollFraction;
      if (!exact(safePayload, ['kind', 'scrollFraction']) || !exact(scroll, ['axis', 'fraction'])
          || !['horizontal', 'vertical'].includes(String(scroll.axis))
          || typeof scroll.fraction !== 'number' || !Number.isFinite(scroll.fraction)
          || scroll.fraction < 0 || scroll.fraction > 1) fail('scroll_to_fraction payload is invalid');
    }
    return;
  }
  fail(`unsupported semantic action ${input.action}`);
}

/**
 * An application is named the way Launch Services names it. A path-shaped lookup dies here as well
 * as in the service, so a coordinator bug cannot be the thing that lets a caller name a bundle
 * Launch Services never registered.
 */
function appLookup(input: NativeAppLookupInput): NativeAppLookup {
  const fail = (message: string): never => {
    throw new NativeBridgeTransportError('invalid_app_lookup', message);
  };
  const named = [input.bundleId, input.appName].filter(value => value !== undefined);
  if (named.length !== 1) fail('name an application by exactly one of bundleId or appName');
  const kind: 'bundle_id' | 'name' = input.bundleId !== undefined ? 'bundle_id' : 'name';
  const value = named[0];
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) {
    fail('an application lookup must be 1-256 characters');
  }
  const text = value as string;
  if (text.includes('/') || text.includes('\\') || text.startsWith('.') || text.includes('..')) {
    fail('an application lookup must not be a filesystem path');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(text)) fail('an application lookup contains control characters');
  if (kind === 'bundle_id' && !/^[A-Za-z0-9.-]+$/.test(text)) {
    fail('bundle identifiers accept only letters, digits, dots, and hyphens');
  }
  return { kind, value: text };
}

/**
 * Paths reaching the native service are already workspace-scoped by the tool layer. This is the
 * shape check beneath that: absolute, normalized, and never re-normalized here — normalizing would
 * mean the tool validated one path and the service acted on another.
 */
function absolutePath(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4_096) {
    throw new NativeBridgeTransportError('invalid_file_path', 'a path must be 1-4096 characters');
  }
  if (!value.startsWith('/') || value.includes('\0')) {
    throw new NativeBridgeTransportError('invalid_file_path', 'a path must be absolute and contain no NUL');
  }
  if (value.split('/').includes('..')) {
    throw new NativeBridgeTransportError('invalid_file_path', 'a path must be already-normalized');
  }
  return value;
}

function windowTarget(input: { pid?: unknown; windowId?: unknown; windowGeneration?: unknown }): {
  pid: number; windowId: number; generation: number;
} {
  const ok = (value: unknown, min: number): value is number => Number.isSafeInteger(value)
    && (value as number) >= min;
  if (!ok(input.pid, 1) || !ok(input.windowId, 1) || !ok(input.windowGeneration, 0)) {
    throw new NativeBridgeTransportError(
      'invalid_window_target',
      'a window operation requires an exact pid, windowId, and windowGeneration from a workspace observation',
    );
  }
  return { pid: input.pid, windowId: input.windowId, generation: input.windowGeneration };
}

function layoutRect(value: unknown): LayoutRect {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new NativeBridgeTransportError('invalid_window_frame', 'a window frame must be an object');
  }
  const rect = value as Record<string, unknown>;
  const keys = Object.keys(rect);
  if (keys.some(key => !['x', 'y', 'width', 'height'].includes(key))) {
    throw new NativeBridgeTransportError('invalid_window_frame', 'a window frame accepts only x, y, width, and height');
  }
  const numbers = ['x', 'y', 'width', 'height'].map(key => rect[key]);
  if (!numbers.every(entry => typeof entry === 'number' && Number.isFinite(entry))) {
    throw new NativeBridgeTransportError('invalid_window_frame', 'a window frame must be finite numbers');
  }
  const [x, y, width, height] = numbers as number[];
  if (Math.abs(x) > 20_000 || Math.abs(y) > 20_000 || width < 0 || height < 0
      || width > 20_000 || height > 20_000) {
    throw new NativeBridgeTransportError('invalid_window_frame', 'a window frame must be bounded');
  }
  return { x, y, width, height };
}

function validResolvedApplication(value: unknown, lookup: NativeAppLookup): ResolvedNativeApplication {
  if (!value || typeof value !== 'object') {
    throw new NativeBridgeTransportError('malformed_app_resolution', 'native service returned a malformed application resolution');
  }
  const record = value as Record<string, unknown>;
  const wire = record.lookup as { kind?: unknown; value?: unknown } | undefined;
  if (wire?.kind !== lookup.kind || wire?.value !== lookup.value) {
    throw new NativeBridgeTransportError('app_resolution_mismatch', 'native resolution answered a different lookup');
  }
  if (typeof record.resolved !== 'boolean') {
    throw new NativeBridgeTransportError('malformed_app_resolution', 'native resolution omitted its outcome');
  }
  const running = Array.isArray(record.running) ? record.running : [];
  return {
    lookup,
    resolved: record.resolved,
    ...(typeof record.bundlePath === 'string' ? { bundlePath: record.bundlePath } : {}),
    ...(typeof record.bundleId === 'string' ? { bundleId: record.bundleId } : {}),
    ...(typeof record.displayName === 'string' ? { displayName: record.displayName } : {}),
    running: running.flatMap(entry => {
      const app = entry as { pid?: unknown; bundleId?: unknown; displayName?: unknown };
      if (!Number.isSafeInteger(app.pid) || (app.pid as number) <= 0) return [];
      return [{
        pid: app.pid as number,
        ...(typeof app.bundleId === 'string' ? { bundleId: app.bundleId } : {}),
        ...(typeof app.displayName === 'string' ? { displayName: app.displayName } : {}),
      }];
    }),
  };
}

function validSnapshot(value: unknown, serviceSessionId: string): value is NativeAXSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<NativeAXSnapshot>;
  return typeof snapshot.snapshotId === 'string' && snapshot.snapshotId.length > 0
    && snapshot.sessionId === serviceSessionId
    && Number.isSafeInteger(snapshot.pid) && (snapshot.pid ?? 0) > 0
    && Number.isSafeInteger(snapshot.eventRevision)
    && typeof snapshot.eventTracking === 'boolean'
    && typeof snapshot.truncated === 'boolean'
    && typeof snapshot.partial === 'boolean'
    && typeof snapshot.changedDuringCapture === 'boolean'
    && Array.isArray(snapshot.nodes);
}

/**
 * Session-owned authority cache between model-facing operation tools and the native service.
 * Only complete, event-tracked, capture-stable snapshots become action/transaction authorities.
 */
export class NativeToolCoordinator {
  private readonly tasks = new Map<string, NativeTaskState>();
  private readonly creating = new Map<string, Promise<NativeTaskState>>();
  private readonly preparedActions = new WeakSet<object>();
  private readonly preparedTransactions = new WeakSet<object>();
  private readonly preparedLaunches = new WeakSet<object>();
  private readonly preparedFileOperations = new WeakSet<object>();
  private readonly preparedUrlOpens = new WeakSet<object>();
  private readonly preparedWindowOperations = new WeakSet<object>();

  public constructor(
    private readonly handshake: NativeServiceHandshake,
    private readonly client: NativeServiceOperationClient = new NativeServiceOperationClient(),
    private readonly appProfiles: NativeAppProfileRegistry = new NativeAppProfileRegistry(),
    private readonly parallelClientFactory: () => NativeServiceOperationClient = () =>
      new NativeServiceOperationClient(),
    private readonly inputInterlock: NativeInputInterlock = globalNativeInputInterlock,
    /**
     * Re-read the app-owned takeover authority. Injected so the concurrency tests can pause at an
     * exact moment; the default is the real loopback read, which is inert when no host configured
     * one and fails closed when a host declared one and it cannot be reached.
     */
    private readonly refreshAuthority: () => Promise<unknown> =
      () => refreshTakeoverAuthority(undefined, inputInterlock),
  ) {}

  /**
   * The final pre-delivery gate. Every `this.client.<mutation>` in this class is preceded by it.
   *
   * A single refresh near MCP-call entry is NOT enough: admission, approval, targeting, fallback
   * selection and execution preparation all happen before delivery, and the user can press Take
   * Control at any point in that window. So this does two things immediately before the bridge:
   *
   *  1. **re-reads the app-owned authority.** `refreshAuthority` is the same loopback read the
   *     server-level gate uses (`takeover.authority.ts`), and it fails closed — an authority that
   *     cannot be reached pauses rather than assuming consent. This closes the ordinary race.
   *  2. **checks the latch generation against admission.** If the user paused and resumed while
   *     this action was being prepared, the action's own preparation predates a takeover: its
   *     target, approval and frame were all chosen for a machine the human has since touched.
   *     Delivering it would be the queued-mutation leak. A new action after resume is fine — this
   *     governs THIS action, which is why the generation is captured per prepared object.
   */
  private async requireInputAvailable(prepared?: object): Promise<void> {
    await this.refreshAuthority();
    const state = this.inputInterlock.state();
    if (state.paused) {
      throw new NativeBridgeTransportError(
        'computer_use_paused',
        `computer use is paused for user takeover${state.reason ? `: ${state.reason}` : ''}; explicit resume is required`,
      );
    }
    if (!prepared) return;
    const admitted = this.admissionGeneration.get(prepared);
    if (admitted !== undefined && admitted !== state.generation) {
      throw new NativeBridgeTransportError(
        'computer_use_takeover_intervened',
        'you took control while this action was being prepared; it was discarded — re-observe and act again',
      );
    }
  }

  /**
   * The takeover generation each prepared mutation was admitted under. A WeakMap so a prepared
   * object that is never delivered cannot keep the entry alive, matching the existing
   * `preparedActions`/`preparedTransactions` WeakSets.
   */
  private readonly admissionGeneration = new WeakMap<object, number>();

  /** Bind a prepared mutation to the takeover generation it was prepared under. */
  private admit<T extends object>(prepared: T): T {
    this.admissionGeneration.set(prepared, this.inputInterlock.state().generation);
    return prepared;
  }

  public async workspace(taskSessionId: string, request: Record<string, unknown>): Promise<unknown> {
    return (await this.readWithSession(taskSessionId,
      state => this.client.workspace(state.serviceSessionId, request))).value;
  }

  public async appIdentity(taskSessionId: string, pid: number): Promise<string> {
    const found = await this.appIdentityDetails(taskSessionId, pid);
    return [found.displayName, found.bundleId].filter(Boolean).join(' / ') || `pid ${pid}`;
  }

  public async appGuidance(taskSessionId: string, pid: number): Promise<NativeAppGuidanceReceipt | null> {
    return this.appProfiles.takeGuidance(taskSessionId, await this.appIdentityDetails(taskSessionId, pid));
  }

  private async appIdentityDetails(taskSessionId: string, pid: number): Promise<NativeAppIdentity> {
    const state = await this.state(taskSessionId);
    const value = await this.client.workspace(state.serviceSessionId, { pid, includeOffscreenWindows: true });
    const apps = value && typeof value === 'object' && Array.isArray((value as { apps?: unknown }).apps)
      ? (value as { apps: unknown[] }).apps : [];
    const found = apps.find(candidate => {
      const app = candidate && typeof candidate === 'object'
        ? (candidate as { app?: { pid?: unknown } }).app : undefined;
      return app?.pid === pid;
    }) as { app?: { displayName?: unknown; bundleId?: unknown } } | undefined;
    const displayName = typeof found?.app?.displayName === 'string' ? found.app.displayName : '';
    const bundleId = typeof found?.app?.bundleId === 'string' ? found.app.bundleId : '';
    return { pid, ...(displayName ? { displayName } : {}), ...(bundleId ? { bundleId } : {}) };
  }

  /** Read-only Launch Services lookup. It starts nothing, so it needs no approval. */
  public async resolveApp(
    taskSessionId: string,
    input: NativeAppLookupInput,
  ): Promise<ResolvedNativeApplication> {
    this.requireWorkspaceOperation('resolve_app');
    const lookup = appLookup(input);
    const result = await this.readWithSession(taskSessionId,
      state => this.client.resolveApp(state.serviceSessionId, { ...lookup }));
    return validResolvedApplication(
      result.value, lookup,
    );
  }

  /**
   * Resolve before approving. The Governor is shown the bundle Launch Services actually chose and
   * whether the application is already running, so an approval cannot be obtained for one name and
   * spent on whatever that name happens to resolve to later.
   */
  public async prepareLaunch(
    taskSessionId: string,
    input: NativeAppLookupInput,
  ): Promise<PreparedNativeLaunch> {
    this.requireWorkspaceOperation('launch_app');
    const timeout = input.readinessTimeoutMs ?? 3_000;
    if (!Number.isSafeInteger(timeout) || (timeout as number) < 0 || (timeout as number) > 10_000) {
      throw new NativeBridgeTransportError('invalid_launch_timeout', 'readinessTimeoutMs must be between 0 and 10000');
    }
    const resolved = await this.resolveApp(taskSessionId, {
      ...(input.bundleId !== undefined ? { bundleId: input.bundleId } : {}),
      ...(input.appName !== undefined ? { appName: input.appName } : {}),
    });
    if (!resolved.resolved) {
      throw new NativeBridgeTransportError('app_not_found', 'no registered application matched the lookup');
    }
    const state = await this.state(taskSessionId);
    const prepared: PreparedNativeLaunch = {
      serviceSessionId: state.serviceSessionId,
      lookup: resolved.lookup,
      resolved,
      alreadyRunning: resolved.running.length > 0,
      readinessTimeoutMs: timeout as number,
    };
    this.preparedLaunches.add(prepared);
    this.admit(prepared);
    return deepFreeze(prepared);
  }

  public async performLaunch(
    taskSessionId: string,
    prepared: PreparedNativeLaunch,
  ): Promise<unknown> {
    if (!prepared || typeof prepared !== 'object' || !this.preparedLaunches.has(prepared)) {
      throw new NativeBridgeTransportError('unsigned_launch', 'native launches must come from the task coordinator');
    }
    const state = this.tasks.get(taskSessionId);
    if (!state || state.serviceSessionId !== prepared.serviceSessionId) {
      throw new NativeBridgeTransportError('launch_session_mismatch', 'prepared launch belongs to a different task session');
    }
    await this.requireInputAvailable(prepared);
    return this.client.launchApp(prepared.serviceSessionId, {
      lookup: prepared.lookup,
      readinessTimeoutMs: prepared.readinessTimeoutMs,
    });
  }

  /**
   * Read-only file description. The path must already be workspace-resolved by the caller: this
   * coordinator refuses anything that is not an absolute, normalized path, and the service refuses
   * it again.
   */
  public async inspectFile(taskSessionId: string, path: unknown): Promise<unknown> {
    this.requireWorkspaceOperation('inspect_file');
    return (await this.readWithSession(taskSessionId,
      state => this.client.inspectFile(state.serviceSessionId, { path: absolutePath(path) }))).value;
  }

  public async prepareFileOperation(
    taskSessionId: string,
    operation: NativeFileOperation,
    path: unknown,
    application?: NativeAppLookupInput,
  ): Promise<PreparedNativeFileOperation> {
    this.requireWorkspaceOperation(operation);
    if (application && operation !== 'open_file') {
      throw new NativeBridgeTransportError('invalid_file_operation', 'only open_file names an application');
    }
    const state = await this.state(taskSessionId);
    const prepared: PreparedNativeFileOperation = {
      serviceSessionId: state.serviceSessionId,
      operation,
      path: absolutePath(path),
      ...(application ? { application: appLookup(application) } : {}),
      // Revealing a file is defined as bringing Finder forward. It is disclosed here rather than
      // discovered from the receipt afterwards.
      changesForeground: operation === 'reveal_file',
    };
    this.preparedFileOperations.add(prepared);
    this.admit(prepared);
    return deepFreeze(prepared);
  }

  public async performFileOperation(
    taskSessionId: string,
    prepared: PreparedNativeFileOperation,
  ): Promise<unknown> {
    if (!prepared || typeof prepared !== 'object' || !this.preparedFileOperations.has(prepared)) {
      throw new NativeBridgeTransportError('unsigned_file_operation', 'native file operations must come from the task coordinator');
    }
    const state = this.tasks.get(taskSessionId);
    if (!state || state.serviceSessionId !== prepared.serviceSessionId) {
      throw new NativeBridgeTransportError('file_operation_session_mismatch', 'prepared file operation belongs to a different task session');
    }
    await this.requireInputAvailable(prepared);
    return this.client.fileOperation(prepared.serviceSessionId, {
      operation: prepared.operation,
      path: prepared.path,
      ...(prepared.application ? { application: { ...prepared.application } } : {}),
    });
  }

  public async prepareUrlOpen(
    taskSessionId: string,
    url: unknown,
    application?: NativeAppLookupInput,
  ): Promise<PreparedNativeUrlOpen> {
    this.requireWorkspaceOperation('open_url');
    if (typeof url !== 'string' || url.length < 1 || url.length > 2_048) {
      throw new NativeBridgeTransportError('invalid_url', 'a URL must be 1-2048 characters');
    }
    let parsed: URL;
    try { parsed = new URL(url); }
    catch { throw new NativeBridgeTransportError('invalid_url', 'the URL could not be parsed'); }
    // A custom scheme asks macOS to run whichever local application claims it. Only the two web
    // schemes are expressible, and the service refuses the rest again.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new NativeBridgeTransportError('url_scheme_refused', 'only http and https URLs may be opened');
    }
    if (!parsed.hostname) throw new NativeBridgeTransportError('invalid_url', 'an http(s) URL must name a host');
    const state = await this.state(taskSessionId);
    const prepared: PreparedNativeUrlOpen = {
      serviceSessionId: state.serviceSessionId,
      url,
      host: parsed.hostname.toLowerCase(),
      ...(application ? { application: appLookup(application) } : {}),
    };
    this.preparedUrlOpens.add(prepared);
    this.admit(prepared);
    return deepFreeze(prepared);
  }

  public async performUrlOpen(
    taskSessionId: string,
    prepared: PreparedNativeUrlOpen,
  ): Promise<unknown> {
    if (!prepared || typeof prepared !== 'object' || !this.preparedUrlOpens.has(prepared)) {
      throw new NativeBridgeTransportError('unsigned_url_open', 'native URL opens must come from the task coordinator');
    }
    const state = this.tasks.get(taskSessionId);
    if (!state || state.serviceSessionId !== prepared.serviceSessionId) {
      throw new NativeBridgeTransportError('url_open_session_mismatch', 'prepared URL open belongs to a different task session');
    }
    await this.requireInputAvailable(prepared);
    return this.client.openUrl(prepared.serviceSessionId, {
      url: prepared.url,
      ...(prepared.application ? { application: { ...prepared.application } } : {}),
    });
  }

  /**
   * Window mutation binds to an exact PID, WindowServer id, and service-issued generation. A
   * layout preset is resolved here into ordinary geometry, against the *live* usable bounds of the
   * display the window is actually on — so a preset can never be computed from a display the
   * caller merely named.
   */
  public async prepareWindowOperation(
    taskSessionId: string,
    operation: NativeWindowOperation,
    input: {
      pid?: unknown; windowId?: unknown; windowGeneration?: unknown;
      frame?: unknown; fullScreen?: unknown; tile?: unknown;
    },
  ): Promise<PreparedNativeWindowOperation> {
    this.requireWorkspaceOperation(operation);
    const window = windowTarget(input);
    const needsFrame = operation === 'move_window' || operation === 'resize_window'
      || operation === 'set_window_frame';
    if (!needsFrame && (input.frame !== undefined || input.tile !== undefined)) {
      throw new NativeBridgeTransportError('invalid_window_operation', `${operation} does not accept geometry`);
    }
    if (operation === 'set_window_fullscreen') {
      if (typeof input.fullScreen !== 'boolean') {
        throw new NativeBridgeTransportError('invalid_window_operation', 'set_window_fullscreen requires a boolean fullScreen');
      }
    } else if (input.fullScreen !== undefined) {
      throw new NativeBridgeTransportError('invalid_window_operation', `${operation} does not accept fullScreen`);
    }

    const state = await this.state(taskSessionId);
    let frame: LayoutRect | undefined;
    let tile: WindowTilePreset | undefined;
    if (needsFrame) {
      if ((input.frame === undefined) === (input.tile === undefined)) {
        throw new NativeBridgeTransportError('invalid_window_operation', 'name exactly one of frame or tile');
      }
      if (input.tile !== undefined) {
        if (typeof input.tile !== 'string' || !WINDOW_TILE_PRESETS.includes(input.tile as WindowTilePreset)) {
          throw new NativeBridgeTransportError('invalid_window_tile', 'unknown window layout preset');
        }
        if (operation !== 'set_window_frame') {
          throw new NativeBridgeTransportError('invalid_window_operation', 'a layout preset sets both origin and size; use set_window_frame');
        }
        tile = input.tile as WindowTilePreset;
        frame = await this.tileFrame(state.serviceSessionId, window, tile);
      } else {
        frame = layoutRect(input.frame);
      }
    }

    const prepared: PreparedNativeWindowOperation = {
      serviceSessionId: state.serviceSessionId,
      operation,
      window,
      ...(frame ? { frame } : {}),
      ...(typeof input.fullScreen === 'boolean' ? { fullScreen: input.fullScreen } : {}),
      ...(tile ? { tile } : {}),
      commitAction: operation === 'close_window',
    };
    this.preparedWindowOperations.add(prepared);
    this.admit(prepared);
    return deepFreeze(prepared);
  }

  public async performWindowOperation(
    taskSessionId: string,
    prepared: PreparedNativeWindowOperation,
  ): Promise<unknown> {
    if (!prepared || typeof prepared !== 'object' || !this.preparedWindowOperations.has(prepared)) {
      throw new NativeBridgeTransportError('unsigned_window_operation', 'native window operations must come from the task coordinator');
    }
    const state = this.tasks.get(taskSessionId);
    if (!state || state.serviceSessionId !== prepared.serviceSessionId) {
      throw new NativeBridgeTransportError('window_operation_session_mismatch', 'prepared window operation belongs to a different task session');
    }
    await this.requireInputAvailable(prepared);
    return this.client.windowOperation(prepared.serviceSessionId, {
      operation: prepared.operation,
      window: {
        pid: prepared.window.pid,
        windowId: prepared.window.windowId,
        generation: prepared.window.generation,
      },
      ...(prepared.frame ? { frame: { ...prepared.frame } } : {}),
      ...(typeof prepared.fullScreen === 'boolean' ? { fullScreen: prepared.fullScreen } : {}),
    });
  }

  private async tileFrame(
    serviceSessionId: string,
    window: { pid: number; windowId: number; generation: number },
    tile: WindowTilePreset,
  ): Promise<LayoutRect> {
    const snapshot = await this.client.workspace(serviceSessionId, {
      pid: window.pid, includeOffscreenWindows: true,
    }) as { windows?: unknown; displays?: unknown };
    const windows = Array.isArray(snapshot.windows) ? snapshot.windows : [];
    const live = windows.find(entry => {
      const ref = (entry as { window?: { pid?: unknown; windowId?: unknown; generation?: unknown } }).window;
      return ref?.pid === window.pid && ref?.windowId === window.windowId
        && ref?.generation === window.generation;
    }) as { bounds?: LayoutRect } | undefined;
    if (!live?.bounds) {
      throw new NativeBridgeTransportError('window_generation_stale', 'the window is gone or its id was reissued; observe the workspace again');
    }
    const displays = (Array.isArray(snapshot.displays) ? snapshot.displays : []) as Array<{
      displayId: number; bounds: LayoutRect; usableBounds?: LayoutRect;
    }>;
    const display = displayForWindow(live.bounds, displays);
    const frame = computeWindowTile(tile, display?.usableBounds);
    if (!frame) {
      // A display that reported no usable area produces no layout. Substituting the full display
      // rectangle would tile the window under the menu bar and call it success.
      throw new NativeBridgeTransportError('window_layout_unavailable', 'the window\'s display reported no usable bounds');
    }
    return frame;
  }

  private requireWorkspaceOperation(operation: string): void {
    if (!verifiedWorkspaceOperations(this.handshake).includes(operation)) {
      throw new NativeBridgeTransportError('workspace_operation_unverified', `native workspace operation ${operation} is not live-verified`);
    }
  }

  public async capture(taskSessionId: string, input: NativeCaptureToolInput): Promise<unknown> {
    const state = await this.state(taskSessionId);
    const enabled = input.mode === 'image' ? this.handshake.capabilities.observe.regionCapture
      : input.mode === 'som' ? this.handshake.capabilities.observe.som
        : input.mode === 'zoom' ? this.handshake.capabilities.observe.zoom : false;
    if (!enabled) throw new NativeBridgeTransportError('capture_mode_unverified', 'native capture mode is not live-verified');
    const hasWindow = Number.isSafeInteger(input.pid) && (input.pid ?? 0) > 0
      && Number.isSafeInteger(input.windowId) && (input.windowId ?? 0) > 0
      && Number.isSafeInteger(input.windowGeneration) && (input.windowGeneration ?? -1) >= 0;
    const hasDisplay = Number.isSafeInteger(input.displayId) && (input.displayId ?? 0) > 0;
    if (hasWindow === hasDisplay) {
      throw new NativeBridgeTransportError('invalid_capture_target', 'capture requires exactly one complete window or display target');
    }
    if ((input.mode === 'som' || input.mode === 'zoom') && !hasWindow) {
      throw new NativeBridgeTransportError('invalid_capture_target', `${input.mode} requires an exact window target`);
    }
    if (input.mode === 'som') {
      if (!input.basedOnSnapshotId || input.region || input.zoomFactor !== undefined) {
        throw new NativeBridgeTransportError('invalid_capture_shape', 'SOM requires one retained snapshot and no region or zoom factor');
      }
      const authority = state.snapshots.get(input.basedOnSnapshotId);
      if (!authority || authority.snapshot.pid !== input.pid
          || authority.snapshot.windowId !== input.windowId
          || authority.snapshot.windowGeneration !== input.windowGeneration) {
        throw new NativeBridgeTransportError('snapshot_target_mismatch', 'SOM snapshot does not authorize the exact target window');
      }
    } else if (input.basedOnSnapshotId !== undefined) {
      throw new NativeBridgeTransportError('invalid_capture_shape', 'only SOM accepts basedOnSnapshotId');
    }
    if (input.mode === 'zoom' && !input.region) {
      throw new NativeBridgeTransportError('invalid_capture_shape', 'zoom requires a source pixel region');
    }
    if (input.mode !== 'zoom' && input.zoomFactor !== undefined) {
      throw new NativeBridgeTransportError('invalid_capture_shape', 'zoomFactor is valid only for zoom');
    }
    if (input.region && (![input.region.x, input.region.y, input.region.width, input.region.height]
      .every(Number.isFinite) || input.region.x < 0 || input.region.y < 0
      || input.region.width <= 0 || input.region.height <= 0)) {
      throw new NativeBridgeTransportError('invalid_capture_region', 'capture region must be a positive top-left pixel rectangle');
    }
    const maxDimension = input.maxDimension ?? Math.min(1_456, this.handshake.limits.maxImageDimension);
    if (!Number.isSafeInteger(maxDimension) || maxDimension < 1
        || maxDimension > Math.min(4_096, this.handshake.limits.maxImageDimension)) {
      throw new NativeBridgeTransportError('invalid_image_limit', 'maxDimension exceeds the measured native limit');
    }
    const jpegQuality = input.jpegQuality ?? 0.85;
    if (!Number.isFinite(jpegQuality) || jpegQuality < 0 || jpegQuality > 1) {
      throw new NativeBridgeTransportError('invalid_jpeg_quality', 'jpegQuality must be between 0 and 1');
    }
    const zoomFactor = input.zoomFactor ?? 1;
    if (!Number.isFinite(zoomFactor) || zoomFactor <= 0 || zoomFactor > 8) {
      throw new NativeBridgeTransportError('invalid_zoom_factor', 'zoomFactor must be greater than 0 and at most 8');
    }
    return this.client.capture(state.serviceSessionId, {
      target: hasWindow
        ? { type: 'window', window: { pid: input.pid, windowId: input.windowId, generation: input.windowGeneration } }
        : { type: 'display', displayId: input.displayId },
      mode: input.mode,
      format: input.format ?? 'jpeg',
      maxDimension,
      jpegQuality,
      ...(input.region ? { region: input.region } : {}),
      ...(input.basedOnSnapshotId ? { basedOnSnapshotId: input.basedOnSnapshotId } : {}),
      zoomFactor,
    });
  }

  public async observe(taskSessionId: string, request: Record<string, unknown>): Promise<NativeAXSnapshot> {
    const result = await this.readWithSession(taskSessionId,
      state => this.client.observe(state.serviceSessionId, request));
    const { state, value } = result;
    if (!validSnapshot(value, state.serviceSessionId)) {
      throw new NativeBridgeTransportError('malformed_ax_snapshot', 'native service returned a malformed AX snapshot');
    }
    const snapshot = value as NativeAXSnapshot;
    if (snapshot.eventTracking && !snapshot.truncated && !snapshot.partial && !snapshot.changedDuringCapture) {
      const nodes = this.materializeNodes(snapshot);
      if (nodes) {
        state.snapshots.set(snapshot.snapshotId, { snapshot, nodes });
        while (state.snapshots.size > 4) state.snapshots.delete(state.snapshots.keys().next().value!);
      }
    }
    return snapshot;
  }

  /**
   * Observe one target plus up to three related application/system-UI processes concurrently.
   *
   * The long-lived bridge intentionally serializes ordinary requests. Parallel graph reads use a
   * bounded set of independent signed bridges against the same service session, then retain each
   * complete snapshot under the same task authority. Results preserve request order and one failed
   * branch rejects the batch; there are no hidden retries of a timed-out AX tree.
   */
  public async observeParallel(
    taskSessionId: string,
    requests: readonly Record<string, unknown>[],
  ): Promise<NativeAXSnapshot[]> {
    if (!Array.isArray(requests) || requests.length < 1 || requests.length > 4) {
      throw new NativeBridgeTransportError(
        'invalid_parallel_observation', 'parallel observation requires 1-4 requests',
      );
    }
    const state = await this.state(taskSessionId);
    const extraClients = requests.slice(1).map(() => this.parallelClientFactory());
    const clients = [this.client, ...extraClients];
    try {
      const values = await Promise.all(requests.map((request, index) =>
        clients[index].observe(state.serviceSessionId, request)));
      return values.map(value => {
        if (!validSnapshot(value, state.serviceSessionId)) {
          throw new NativeBridgeTransportError(
            'malformed_ax_snapshot', 'native service returned a malformed parallel AX snapshot',
          );
        }
        const snapshot = value as NativeAXSnapshot;
        if (snapshot.eventTracking && !snapshot.truncated && !snapshot.partial
            && !snapshot.changedDuringCapture) {
          const nodes = this.materializeNodes(snapshot);
          if (nodes) {
            state.snapshots.set(snapshot.snapshotId, { snapshot, nodes });
            while (state.snapshots.size > 4) state.snapshots.delete(state.snapshots.keys().next().value!);
          }
        }
        return snapshot;
      });
    } finally {
      await Promise.all(extraClients.map(client => client.dispose().catch(() => {})));
    }
  }

  public prepareAction(taskSessionId: string, input: NativeActionToolInput): Promise<PreparedNativeAction> {
    return this.state(taskSessionId).then(state => {
      actionShape(input);
      const authority = this.authority(state, input.snapshotId, input.elementToken);
      const accepted = new Set(this.handshake.capabilities.delivery.semanticActions);
      const verified = new Set(this.handshake.capabilities.delivery.verifiedSemanticActions
        .filter(action => accepted.has(action)));
      if (!verified.has(input.action)) {
        throw new NativeBridgeTransportError('semantic_action_unverified', 'native semantic action is not live-verified');
      }
      const acceptedPolicies = new Set(this.handshake.capabilities.delivery.policies);
      const verifiedPolicies = new Set(this.handshake.capabilities.delivery.verifiedDeliveryPolicies
        .filter(policy => acceptedPolicies.has(policy)));
      if (!verifiedPolicies.has(input.deliveryPolicy)) {
        throw new NativeBridgeTransportError('delivery_policy_unverified', 'native delivery policy is not live-verified');
      }
      const foreground = input.deliveryPolicy === 'foreground_once'
        || input.deliveryPolicy === 'foreground_persistent';
      const request: Record<string, unknown> = {
        element: authority.node.elementRef!,
        action: input.action,
        expectedEventRevision: authority.entry.snapshot.eventRevision,
        deliveryPolicy: input.deliveryPolicy,
      };
      if (input.value !== undefined) request.value = typedValue(input.value);
      if (input.payload !== undefined) request.payload = input.payload;
      if (input.evidenceTier !== undefined || input.postcondition !== undefined
          || input.settleTimeoutMs !== undefined) {
        request.evidence = {
          tier: input.evidenceTier ?? 1,
          ...(input.postcondition ? { postcondition: input.postcondition } : {}),
          settleTimeoutMs: input.settleTimeoutMs ?? 750,
        };
      }
      const ref = authority.node.elementRef!;
      const prepared: PreparedNativeAction = {
        serviceSessionId: state.serviceSessionId,
        request,
        target: { pid: ref.pid, windowId: ref.windowId, windowGeneration: ref.windowGeneration },
        node: authority.node,
        foreground,
      };
      this.preparedActions.add(prepared);
    this.admit(prepared);
      return deepFreeze(prepared);
    });
  }

  public async performAction(
    taskSessionId: string,
    prepared: PreparedNativeAction,
    approval?: { approvalId: string; grantedAtMs: number; expiresAtMs: number },
  ): Promise<{ op: string; payload: unknown }> {
    if (!prepared || typeof prepared !== 'object' || !this.preparedActions.has(prepared)) {
      throw new NativeBridgeTransportError('unsigned_action', 'native actions must come from the task coordinator');
    }
    const state = this.tasks.get(taskSessionId);
    if (!state || state.serviceSessionId !== prepared.serviceSessionId) {
      throw new NativeBridgeTransportError('action_session_mismatch', 'prepared action belongs to a different task session');
    }
    const request: Record<string, unknown> = { ...prepared.request };
    if (prepared.foreground) {
      if (!approval) throw new NativeBridgeTransportError('foreground_approval_required', 'foreground action requires coordinator approval');
      request.approval = {
        ...approval,
        policy: request.deliveryPolicy,
        targetPid: prepared.target.pid,
        targetWindowId: prepared.target.windowId,
      };
      request.focusLease = { ttlMs: 5_000, activationTimeoutMs: 1_500 };
    } else if (approval) {
      throw new NativeBridgeTransportError('unexpected_foreground_approval', 'background action cannot carry foreground approval');
    }
    await this.requireInputAvailable(prepared);
    const result = await this.client.action(prepared.serviceSessionId, request);
    if (result.op === 'semantic.action.receipt') this.invalidateTaskSnapshots(taskSessionId);
    return result;
  }

  public async compileTransaction(
    taskSessionId: string,
    input: NativeTransactionToolInput,
  ): Promise<PreparedNativeTransaction> {
    const state = await this.state(taskSessionId);
    const entry = state.snapshots.get(input.basedOnSnapshotId);
    if (!entry) throw new NativeBridgeTransportError('snapshot_not_retained', 'transaction snapshot is not retained by this task');
    const compiled = compileNativeSemanticTransaction({
      basedOnSnapshotId: input.basedOnSnapshotId,
      deliveryPolicy: input.deliveryPolicy,
      steps: input.steps.map(step => {
        const node = entry.nodes.get(step.elementToken);
        if (!node?.elementRef) throw new NativeBridgeTransportError('element_token_not_found', `transaction element token ${step.elementToken} is not authoritative`);
        return {
          stepId: step.stepId,
          element: node.elementRef,
          action: step.action,
          value: typedValue(step.value),
          ...(step.precondition ? { precondition: step.precondition } : {}),
        };
      }),
    }, this.handshake);
    const prepared = { serviceSessionId: state.serviceSessionId, compiled };
    this.preparedTransactions.add(prepared);
    this.admit(prepared);
    return deepFreeze(prepared);
  }

  public async performTransaction(
    taskSessionId: string,
    prepared: PreparedNativeTransaction,
  ): Promise<unknown> {
    if (!prepared || typeof prepared !== 'object' || !this.preparedTransactions.has(prepared)) {
      throw new NativeBridgeTransportError('unsigned_transaction', 'native transactions must come from the task coordinator');
    }
    const state = this.tasks.get(taskSessionId);
    if (!state || state.serviceSessionId !== prepared.serviceSessionId) {
      throw new NativeBridgeTransportError('transaction_session_mismatch', 'prepared transaction belongs to a different task session');
    }
    await this.requireInputAvailable(prepared);
    const receipt = await this.client.transaction(prepared.serviceSessionId, prepared.compiled);
    this.invalidateTaskSnapshots(taskSessionId);
    return receipt;
  }

  public async closeTask(taskSessionId: string): Promise<void> {
    let state = this.tasks.get(taskSessionId);
    const creating = this.creating.get(taskSessionId);
    if (!state && creating) {
      try { state = await creating; } catch { /* creation already failed closed */ }
    }
    this.tasks.delete(taskSessionId);
    this.appProfiles.resetTask(taskSessionId);
    if (state) await this.client.closeSession(state.serviceSessionId);
  }

  public async dispose(): Promise<void> {
    const taskIds = [...this.tasks.keys()];
    for (const taskId of taskIds) {
      try { await this.closeTask(taskId); } catch { /* continue closing neighboring tasks */ }
    }
    await this.client.dispose();
  }

  public approvalFor(prepared: PreparedNativeAction): { approvalId: string; grantedAtMs: number; expiresAtMs: number } {
    const grantedAtMs = Date.now();
    return { approvalId: randomUUID(), grantedAtMs, expiresAtMs: grantedAtMs + 10_000 };
  }

  private async state(taskSessionId: string): Promise<NativeTaskState> {
    if (!taskSessionId || taskSessionId.length > 256 || taskSessionId.includes('\0')) {
      throw new NativeBridgeTransportError('invalid_task_session', 'native operation requires a valid Bimax task session');
    }
    const existing = this.tasks.get(taskSessionId);
    if (existing) return existing;
    const inFlight = this.creating.get(taskSessionId);
    if (inFlight) return inFlight;
    const creation = (async (): Promise<NativeTaskState> => {
      const session = await this.client.createSession(taskNativeId(taskSessionId));
      const serviceSessionId = session.sessionId;
      if (typeof serviceSessionId !== 'string' || !serviceSessionId || serviceSessionId.length > 128) {
        throw new NativeBridgeTransportError('malformed_native_session', 'native service returned an invalid session');
      }
      const state = { serviceSessionId, snapshots: new Map<string, RetainedCoordinatorSnapshot>() };
      this.tasks.set(taskSessionId, state);
      return state;
    })();
    this.creating.set(taskSessionId, creation);
    try { return await creation; }
    finally { if (this.creating.get(taskSessionId) === creation) this.creating.delete(taskSessionId); }
  }

  /**
   * A native-service restart retires its session table while the provider and bridge may remain
   * healthy. Read operations are safe to retry once: discard every snapshot authority from the
   * retired session, create a fresh task session, and repeat the read. Mutations deliberately do
   * not use this helper because delivery may be ambiguous and must never be replayed.
   */
  private async readWithSession<T>(
    taskSessionId: string,
    read: (state: NativeTaskState) => Promise<T>,
  ): Promise<{ state: NativeTaskState; value: T; restarted: boolean }> {
    let state = await this.state(taskSessionId);
    try {
      return { state, value: await read(state), restarted: false };
    } catch (error) {
      if (!isRetiredNativeSession(error)) throw error;
      if (this.tasks.get(taskSessionId) === state) this.tasks.delete(taskSessionId);
      state = await this.state(taskSessionId);
      return { state, value: await read(state), restarted: true };
    }
  }

  private materializeNodes(snapshot: NativeAXSnapshot): Map<string, NativeAXNode> | null {
    if (!snapshot.baseSnapshotId) {
      const nodes = new Map<string, NativeAXNode>();
      for (const node of snapshot.nodes) if (validNode(node, snapshot.snapshotId)) nodes.set(node.token, node);
      return nodes;
    }
    // A diff proves what changed but does not reissue refs for unchanged nodes under the new
    // snapshot id. It is model-visible evidence, never a fresh action authority.
    return null;
  }

  private authority(state: NativeTaskState, snapshotId: string, token: string) {
    const entry = state.snapshots.get(snapshotId);
    if (!entry) throw new NativeBridgeTransportError('snapshot_not_retained', 'action snapshot is not retained by this task');
    const node = entry.nodes.get(token);
    if (!node?.elementRef || node.elementRef.snapshotId !== snapshotId) {
      throw new NativeBridgeTransportError('element_token_not_found', 'element token is not authoritative for this snapshot');
    }
    return { entry, node };
  }

  private invalidateTaskSnapshots(taskSessionId: string): void {
    this.tasks.get(taskSessionId)?.snapshots.clear();
  }
}
