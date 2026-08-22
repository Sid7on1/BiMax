import {
  normalizeDesktopAction,
  PUBLIC_DESKTOP_ACTIONS,
  type DesktopCommand,
  type PublicDesktopAction,
} from './desktop.runtime';
import {
  canonicalizeRedundantSelectors,
  unwrapActionEnvelope,
  validateModelComputerCommand,
} from './action.contract';
import type { NativeComputerToolSurface } from './native.tools';
import type { CapabilityTool } from './provider.tool';
import {
  gradeSemanticMutation,
  gradeWorkspaceMutation,
  postconditionFor,
  type MutationGrade,
  type TypedLogicalPostcondition,
} from './native.logical.verification';

interface NativeSnapshotNode {
  token?: unknown;
  role?: unknown;
  label?: unknown;
  value?: unknown;
  identifier?: unknown;
  enabled?: unknown;
}

interface NativeSnapshotRecord {
  snapshotId: string;
  pid: number;
  windowId?: number;
  windowGeneration?: number;
  nodes: NativeSnapshotNode[];
}

interface LogicalSessionState {
  pid?: number;
  latestSnapshotId?: string;
  snapshots: Map<string, NativeSnapshotRecord>;
}

const TILE_BY_LAYOUT: Record<string, string> = {
  left: 'left_half',
  right: 'right_half',
  top: 'top_half',
  bottom: 'bottom_half',
  'top-left': 'top_left',
  'top-right': 'top_right',
  'bottom-left': 'bottom_left',
  'bottom-right': 'bottom_right',
  'left-third': 'left_third',
  'center-third': 'center_third',
  'right-third': 'right_third',
  'left-two-thirds': 'left_two_thirds',
  'right-two-thirds': 'right_two_thirds',
  center: 'center',
  maximize: 'maximize',
};

const ADAPTER_ACTIONS = new Set<PublicDesktopAction>([
  'status', 'apps', 'windows', 'open', 'observe', 'screenshot',
  'click', 'type', 'set_value', 'frontmost', 'arrange', 'close', 'wait',
]);

function object(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any> : {};
}

function enumValues(tool: CapabilityTool | undefined, property: string): string[] {
  const schema = object(tool?.schema);
  const properties = object(schema.properties);
  const values = object(properties[property]).enum;
  return Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string') : [];
}

function parseNativeResult(text: string, tool: string): Record<string, any> {
  try {
    const value = JSON.parse(text);
    return object(value);
  } catch {
    throw new Error(`${tool} returned a non-JSON result`);
  }
}

function sessionId(context: unknown): string {
  const value = object(context).sessionId;
  return typeof value === 'string' && value.trim() ? value.trim() : 'mac-logical-default';
}

function logicalResult(
  action: string,
  nativeTool: string,
  value: Record<string, any>,
  executor: 'semantic' | 'visual',
): string {
  return JSON.stringify({
    ...value,
    ok: value.ok !== false,
    action,
    driver: 'bimax-native',
    executor,
    nativeTool,
  }, null, 2);
}

function mutationResult(
  action: string,
  nativeTool: string,
  value: Record<string, any>,
  grade: MutationGrade,
): string {
  return JSON.stringify({
    ...value,
    ok: grade.ok,
    action,
    driver: 'bimax-native',
    executor: 'semantic',
    nativeTool,
    verified: grade.ok,
    verification: grade.verification,
    ...(!grade.ok ? {
      code: 'postcondition_unverified',
      error: grade.verification.reason,
      actionAttempted: true,
      visible: true,
    } : {}),
  }, null, 2);
}

function stop(action: string, reason: string, code = 'native_logical_action_unavailable'): string {
  return JSON.stringify({
    ok: false,
    action,
    driver: 'bimax-native',
    executor: 'stop',
    blocked: true,
    visible: true,
    code,
    reason,
    error: reason,
    verification: { status: 'not_attempted', freshObservation: false, reason },
  }, null, 2);
}

function requirePostcondition(
  action: 'open' | 'click' | 'type' | 'set_value' | 'arrange' | 'close',
  command: DesktopCommand,
): { postcondition: TypedLogicalPostcondition } | { error: string } {
  const result = postconditionFor(action, command);
  return result.postcondition ? { postcondition: result.postcondition }
    : { error: result.reason || `${action} needs a checkable postcondition` };
}

function snapshotFrom(value: Record<string, any>): NativeSnapshotRecord | null {
  if (typeof value.snapshotId !== 'string' || !Number.isSafeInteger(value.pid) || value.pid <= 0) return null;
  return {
    snapshotId: value.snapshotId,
    pid: value.pid,
    ...(Number.isSafeInteger(value.windowId) && value.windowId > 0 ? { windowId: value.windowId } : {}),
    ...(Number.isSafeInteger(value.windowGeneration) && value.windowGeneration >= 0
      ? { windowGeneration: value.windowGeneration } : {}),
    nodes: Array.isArray(value.nodes) ? value.nodes.map(object) : [],
  };
}

function searchable(node: NativeSnapshotNode): string {
  return [node.label, node.value, node.identifier, node.role]
    .filter(value => typeof value === 'string').join('\n').toLocaleLowerCase();
}

/**
 * Collapse the capability-filtered native tool set behind the product's one logical authority.
 *
 * This adapter never invents a native capability. A verb is enabled only when its required native
 * tool and live handshake-derived enum member exist. Unsupported physical/menu/recording verbs
 * descend to the fourth rung (stop) instead of falling through to compatibility.
 */
export function createNativeLogicalMacControl(
  surface: NativeComputerToolSurface,
  schema: Record<string, unknown>,
): CapabilityTool {
  const nativeTools = new Map(surface.tools.map(tool => [tool.name, tool]));
  const sessions = new Map<string, LogicalSessionState>();

  const stateFor = (context: unknown) => {
    const key = sessionId(context);
    let state = sessions.get(key);
    if (!state) {
      state = { snapshots: new Map() };
      sessions.set(key, state);
    }
    return state;
  };

  const invoke = async (
    name: string,
    args: Record<string, unknown>,
    context: unknown,
  ): Promise<Record<string, any> | null> => {
    const tool = nativeTools.get(name);
    if (!tool) return null;
    return parseNativeResult(await tool.execute(args, context), name);
  };

  const snapshotFor = (state: LogicalSessionState, command: DesktopCommand) => {
    const id = command.frameId || state.latestSnapshotId;
    return id ? state.snapshots.get(id) : undefined;
  };

  const selectToken = (
    state: LogicalSessionState,
    command: DesktopCommand,
  ): { snapshot: NativeSnapshotRecord; token: string } | { error: string } => {
    const snapshot = snapshotFor(state, command);
    if (!snapshot) return { error: 'observe first; this action needs a retained native snapshot' };
    if (command.elementToken) {
      const found = snapshot.nodes.find(node => node.token === command.elementToken);
      return found ? { snapshot, token: command.elementToken }
        : { error: 'elementToken is not present in the retained native snapshot; observe again' };
    }
    if (command.elementIndex !== undefined) {
      const node = snapshot.nodes[Math.floor(command.elementIndex)];
      return typeof node?.token === 'string' ? { snapshot, token: node.token }
        : { error: 'elementIndex is outside the retained native snapshot; observe again' };
    }
    if (command.query?.trim()) {
      const query = command.query.trim().toLocaleLowerCase();
      const matches = snapshot.nodes.filter(node => searchable(node).includes(query));
      if (matches.length !== 1 || typeof matches[0]?.token !== 'string') {
        return { error: matches.length > 1
          ? `query is ambiguous in the retained native snapshot (${matches.length} matches)`
          : 'query did not match a retained native element; observe again' };
      }
      return { snapshot, token: matches[0].token };
    }
    return { error: 'this native semantic action needs query, elementToken, or elementIndex' };
  };

  return {
    name: 'mac_control',
    description: 'Desktop-owned native macOS control. One logical authority routes only to live-verified native workspace, semantic, and capture operations; unsupported verbs stop visibly and never activate compatibility.',
    schema,
    isDestructive: true,
    approvalHandledInternally: true,
    execute: async (args, context): Promise<string> => {
      const unwrapped = unwrapActionEnvelope(args);
      const allowed = new Set(Object.keys(object(schema).properties || {}));
      const sanitized = Object.fromEntries(Object.entries(unwrapped).filter(([key]) => allowed.has(key)));
      const action = normalizeDesktopAction(String(sanitized.action || ''));
      if (!(PUBLIC_DESKTOP_ACTIONS as readonly string[]).includes(action)) {
        return stop(action, 'Unknown macOS action.', 'invalid_action');
      }
      const command = canonicalizeRedundantSelectors({ ...sanitized, action } as DesktopCommand);
      const invalid = validateModelComputerCommand(command);
      if (invalid) return stop(action, invalid, 'invalid_arguments');

      const state = stateFor(context);
      const workspace = nativeTools.get('BimaxWorkspaceTool');
      const observe = nativeTools.get('BimaxObserveTool');
      const semantic = nativeTools.get('BimaxActionTool');
      const capture = nativeTools.get('BimaxCaptureTool');

      if (action === 'status') {
        return JSON.stringify({
          ok: true,
          action,
          driver: 'bimax-native',
          executor: 'semantic',
          route: 'native_logical_adapter',
          nativeTools: [...nativeTools.keys()].sort(),
          supportedActions: [...ADAPTER_ACTIONS].filter(candidate => {
            if (['apps', 'windows', 'open', 'frontmost', 'arrange', 'close'].includes(candidate)) return !!workspace;
            if (candidate === 'observe') return !!observe;
            if (candidate === 'screenshot') return !!capture;
            if (['click', 'type', 'set_value'].includes(candidate)) return !!semantic;
            return true;
          }),
        }, null, 2);
      }

      if (action === 'apps' || action === 'windows' || action === 'frontmost') {
        if (!workspace) return stop(action, 'the verified native workspace inventory is unavailable');
        const operation = action === 'frontmost' ? 'apps' : action;
        const value = await invoke('BimaxWorkspaceTool', {
          operation,
          ...(command.pid ? { pid: command.pid } : {}),
        }, context) as Record<string, any>;
        if (action === 'frontmost') {
          return logicalResult(action, 'BimaxWorkspaceTool', {
            frontmostPid: value.frontmostPid,
            app: Array.isArray(value.apps)
              ? value.apps.find((entry: any) => entry?.app?.pid === value.frontmostPid)?.app : undefined,
          }, 'semantic');
        }
        return logicalResult(action, 'BimaxWorkspaceTool', value, 'semantic');
      }

      if (action === 'open') {
        if (!workspace || !enumValues(workspace, 'operation').includes('launch_app')) {
          return stop(action, 'the verified native service cannot launch applications');
        }
        const required = requirePostcondition(action, command);
        if ('error' in required) return stop(action, required.error, 'postcondition_required');
        const value = await invoke('BimaxWorkspaceTool', {
          operation: 'launch_app',
          ...(command.bundleId ? { bundleId: command.bundleId } : { appName: command.app }),
        }, context) as Record<string, any>;
        const pid = value.app?.pid ?? value.resolved?.running?.[0]?.pid;
        if (Number.isSafeInteger(pid) && pid > 0) state.pid = pid;
        state.latestSnapshotId = undefined;
        state.snapshots.clear();
        return mutationResult(
          action, 'BimaxWorkspaceTool', value,
          gradeWorkspaceMutation(action, value, required.postcondition),
        );
      }

      if (action === 'observe') {
        if (!observe) return stop(action, 'the verified native accessibility observer is unavailable');
        const pid = command.pid ?? state.pid;
        if (!pid) return stop(action, 'observe needs pid until this logical session has opened a native application', 'native_target_required');
        const profiles = enumValues(observe, 'profile');
        const scopes = enumValues(observe, 'scope');
        const value = await invoke('BimaxObserveTool', {
          pid,
          scope: scopes.includes('window') ? 'window' : scopes[0],
          profile: profiles.includes('balanced') ? 'balanced' : profiles[0],
          ...(command.windowId ? { windowId: command.windowId } : {}),
          ...(command.maxElements ? { maxElements: command.maxElements } : {}),
          ...(command.query ? { query: command.query } : {}),
        }, context) as Record<string, any>;
        const snapshot = snapshotFrom(value);
        if (!snapshot) return stop(action, 'native observe returned no retainable full snapshot', 'native_snapshot_unavailable');
        state.pid = snapshot.pid;
        state.latestSnapshotId = snapshot.snapshotId;
        state.snapshots.set(snapshot.snapshotId, snapshot);
        const nodes = snapshot.nodes.map((node, elementIndex) => ({ ...node, elementIndex }));
        return logicalResult(action, 'BimaxObserveTool', {
          ...value,
          nodes,
          elements: nodes,
          frameId: snapshot.snapshotId,
        }, 'semantic');
      }

      if (action === 'screenshot') {
        if (!capture || !enumValues(capture, 'mode').includes('image')) {
          return stop(action, 'the verified native image capture mode is unavailable');
        }
        const snapshot = snapshotFor(state, command);
        if (!snapshot?.windowId || snapshot.windowGeneration === undefined) {
          return stop(action, 'screenshot needs a retained exact-window observation; observe first', 'native_snapshot_required');
        }
        const value = await invoke('BimaxCaptureTool', {
          mode: 'image', pid: snapshot.pid, windowId: snapshot.windowId,
          windowGeneration: snapshot.windowGeneration,
        }, context) as Record<string, any>;
        return logicalResult(action, 'BimaxCaptureTool', { ...value, frameId: snapshot.snapshotId }, 'visual');
      }

      if (action === 'click' || action === 'type' || action === 'set_value') {
        if (!semantic) return stop(action, 'the verified native semantic action surface is unavailable');
        if (command.x !== undefined) {
          return stop(action, 'pixel delivery is not yet represented by the native logical adapter; use a semantic selector');
        }
        const selected = selectToken(state, command);
        if ('error' in selected) return stop(action, selected.error, 'native_selector_unresolved');
        const required = requirePostcondition(action, command);
        if ('error' in required) return stop(action, required.error, 'postcondition_required');
        const nativeAction = action === 'click' ? 'invoke' : action === 'type' ? 'type_text' : 'set_value';
        const actions = enumValues(semantic, 'action');
        if (!actions.includes(nativeAction)) {
          return stop(action, `the native handshake has not verified ${nativeAction}`);
        }
        const policies = enumValues(semantic, 'deliveryPolicy');
        const deliveryPolicy = policies.includes('background_only') ? 'background_only'
          : policies.includes('background_native') ? 'background_native' : policies[0];
        if (!deliveryPolicy) return stop(action, 'the native handshake has no verified delivery policy');
        const value = await invoke('BimaxActionTool', {
          snapshotId: selected.snapshot.snapshotId,
          elementToken: selected.token,
          action: nativeAction,
          deliveryPolicy,
          ...(action === 'type' ? { value: command.text } : {}),
          ...(action === 'set_value' ? { value: command.value } : {}),
          evidenceTier: 1,
          postcondition: required.postcondition.predicate,
          settleTimeoutMs: 750,
        }, context) as Record<string, any>;
        state.latestSnapshotId = undefined;
        state.snapshots.clear();
        const output = {
          ...value,
          frameId: selected.snapshot.snapshotId,
          elementToken: selected.token,
        };
        return mutationResult(
          action, 'BimaxActionTool', output,
          gradeSemanticMutation(value, required.postcondition, {
            snapshotId: selected.snapshot.snapshotId,
            elementToken: selected.token,
            pid: selected.snapshot.pid,
            windowId: selected.snapshot.windowId,
            windowGeneration: selected.snapshot.windowGeneration,
          }),
        );
      }

      if (action === 'arrange' || action === 'close') {
        if (!workspace) return stop(action, 'the verified native window-operation surface is unavailable');
        const snapshot = snapshotFor(state, command);
        if (!snapshot?.windowId || snapshot.windowGeneration === undefined) {
          return stop(action, `${action} needs a retained exact-window observation; observe first`, 'native_snapshot_required');
        }
        const operation = action === 'close' ? 'close_window' : 'set_window_frame';
        if (!enumValues(workspace, 'operation').includes(operation)) {
          return stop(action, `the native handshake has not verified ${operation}`);
        }
        const tile = command.layout ? TILE_BY_LAYOUT[String(command.layout)] : undefined;
        if (action === 'arrange' && !tile) {
          return stop(action, `native arrange does not support layout ${String(command.layout || '')}`);
        }
        const required = requirePostcondition(action, {
          ...command, pid: snapshot.pid, windowId: snapshot.windowId,
        });
        if ('error' in required) return stop(action, required.error, 'postcondition_required');
        const postcondition = {
          ...required.postcondition,
          predicate: {
            ...required.postcondition.predicate,
            pid: snapshot.pid,
            windowId: snapshot.windowId,
            windowGeneration: snapshot.windowGeneration,
          },
        };
        const value = await invoke('BimaxWorkspaceTool', {
          operation,
          pid: snapshot.pid,
          windowId: snapshot.windowId,
          windowGeneration: snapshot.windowGeneration,
          ...(tile ? { tile } : {}),
        }, context) as Record<string, any>;
        state.latestSnapshotId = undefined;
        state.snapshots.clear();
        return mutationResult(
          action, 'BimaxWorkspaceTool', value,
          gradeWorkspaceMutation(action, value, postcondition),
        );
      }

      if (action === 'wait') {
        const ms = Number.isFinite(command.ms) ? Math.max(50, Math.min(5_000, Number(command.ms))) : 250;
        await new Promise(resolve => setTimeout(resolve, ms));
        return JSON.stringify({ ok: true, action, driver: 'bimax-native', executor: 'semantic', waitedMs: ms }, null, 2);
      }

      return stop(action, `${action} is not yet available through the verified native logical adapter`);
    },
  };
}
