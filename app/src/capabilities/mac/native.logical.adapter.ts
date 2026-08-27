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
  type RequestedLogicalDelivery,
  type TypedLogicalPostcondition,
} from './native.logical.verification';
import {
  NativePerceptionLatency,
  NativePerceptionReadiness,
  nativeSnapshotAuthority,
  type NativePerceptionPhase,
} from './native.perception';
import type { AxReadinessObservation } from './ax.readiness';
import { authorizeTrustedBranch, verifyTrustedPlan, type TrustedBranchDecision } from './trusted.plan';

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
  eventRevision: number;
  nodes: NativeSnapshotNode[];
  readiness: AxReadinessObservation;
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
  'status', 'apps', 'windows', 'open', 'focus', 'observe', 'screenshot',
  'click', 'type', 'set_value', 'frontmost', 'arrange', 'close', 'wait',
]);

function object(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any> : {};
}

function appLabel(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  const candidate = object(value);
  for (const key of ['displayName', 'name', 'label', 'bundleId']) {
    if (typeof candidate[key] === 'string' && candidate[key].trim()) return candidate[key].trim();
  }
  return '';
}

function stableAppReceipt(value: Record<string, any>): Record<string, any> {
  const application = object(value.app);
  const resolved = object(value.resolved);
  const running = Array.isArray(resolved.running) ? object(resolved.running[0]) : {};
  const pid = application.pid ?? running.pid;
  const bundleId = application.bundleId ?? resolved.bundleId ?? running.bundleId;
  const app = appLabel(application) || appLabel(resolved) || appLabel(running);
  return {
    ...value,
    ...(Object.keys(application).length ? { application } : {}),
    ...(app ? { app } : {}),
    ...(Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}),
    ...(typeof bundleId === 'string' && bundleId.trim() ? { bundleId: bundleId.trim() } : {}),
  };
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
  const providerSession = typeof value === 'string' && value.trim() ? value.trim() : 'mac-logical-default';
  const trustedPlan = verifyTrustedPlan(context);
  return trustedPlan ? `${providerSession}:task:${trustedPlan.taskId}` : providerSession;
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

function branchStop(action: string, branch: TrustedBranchDecision): string {
  const result = JSON.parse(stop(action, branch.reason, 'untrusted_observation_authority'));
  return JSON.stringify({ ...result, observationSecurity: branch }, null, 2);
}

function requirePostcondition(
  action: 'open' | 'click' | 'type' | 'set_value' | 'arrange' | 'close',
  command: DesktopCommand,
): { postcondition: TypedLogicalPostcondition } | { error: string } {
  const result = postconditionFor(action, command);
  return result.postcondition ? { postcondition: result.postcondition }
    : { error: result.reason || `${action} needs a checkable postcondition` };
}

function snapshotFrom(
  value: Record<string, any>,
  readinessTracker: NativePerceptionReadiness,
): NativeSnapshotRecord | null {
  if (!nativeSnapshotAuthority(value).usable) return null;
  return {
    snapshotId: value.snapshotId,
    pid: value.pid,
    ...(Number.isSafeInteger(value.windowId) && value.windowId > 0 ? { windowId: value.windowId } : {}),
    ...(Number.isSafeInteger(value.windowGeneration) && value.windowGeneration >= 0
      ? { windowGeneration: value.windowGeneration } : {}),
    eventRevision: value.eventRevision,
    nodes: Array.isArray(value.nodes) ? value.nodes.map(object) : [],
    readiness: readinessTracker.observe(value),
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
  const readiness = new NativePerceptionReadiness();
  const latency = new NativePerceptionLatency();

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
    phase: NativePerceptionPhase,
  ): Promise<Record<string, any> | null> => {
    const tool = nativeTools.get(name);
    if (!tool) return null;
    const measured = await latency.measure(phase, async () => parseNativeResult(
      await tool.execute(args, context), name,
    ));
    return { ...measured.value, adapterTiming: measured.timing };
  };

  const snapshotFor = (state: LogicalSessionState, command: DesktopCommand) => {
    const id = command.frameId || state.latestSnapshotId;
    return id ? state.snapshots.get(id) : undefined;
  };

  const observeTarget = async (
    state: LogicalSessionState,
    pid: number,
    command: DesktopCommand,
    context: unknown,
  ): Promise<{ value?: Record<string, any>; error?: string }> => {
    const observeTool = nativeTools.get('BimaxObserveTool');
    if (!observeTool) return { error: 'the verified native accessibility observer is unavailable' };
    let windowId = command.windowId;
    let windowGeneration: number | undefined;
    const workspaceTool = nativeTools.get('BimaxWorkspaceTool');
    if (!windowId && workspaceTool && enumValues(workspaceTool, 'operation').includes('windows')) {
      const inventory = await invoke('BimaxWorkspaceTool', {
        operation: 'windows', pid, includeOffscreenWindows: true,
      }, context, 'workspace') as Record<string, any>;
      const candidates = Array.isArray(inventory.windows) ? inventory.windows : [];
      const exact = candidates.map((entry: unknown) => object(object(entry).window))
        .find((entry: Record<string, any>) => entry.pid === pid
          && Number.isSafeInteger(entry.windowId) && entry.windowId > 0);
      if (exact) {
        windowId = exact.windowId;
        if (Number.isSafeInteger(exact.generation) && exact.generation >= 0) {
          windowGeneration = exact.generation;
        }
      }
    }
    const profiles = enumValues(observeTool, 'profile');
    const scopes = enumValues(observeTool, 'scope');
    const value = await invoke('BimaxObserveTool', {
      pid,
      scope: scopes.includes('window') && windowId ? 'window'
        : scopes.includes('application') ? 'application' : scopes[0],
      profile: profiles.includes('balanced') ? 'balanced' : profiles[0],
      ...(windowId ? { windowId } : {}),
      ...(windowGeneration !== undefined ? { windowGeneration } : {}),
      ...(command.maxElements ? { maxElements: command.maxElements } : {}),
    }, context, 'observe') as Record<string, any>;
    const authority = nativeSnapshotAuthority(value);
    const snapshot = snapshotFrom(value, readiness);
    if (!snapshot) return { error: 'native observe returned no retainable full snapshot' };
    state.pid = snapshot.pid;
    state.latestSnapshotId = snapshot.snapshotId;
    state.snapshots.set(snapshot.snapshotId, snapshot);
    const nodes = snapshot.nodes.map((node, elementIndex) => ({ ...node, elementIndex }));
    return { value: {
      ...value,
      nodes,
      elements: nodes,
      frameId: snapshot.snapshotId,
      perception: snapshot.readiness,
      snapshotAuthority: authority,
      observationTrust: {
        classification: 'untrusted_observation',
        sources: ['accessibility'],
        mayInform: 'selection_within_authenticated_branch',
        mayNotGrant: ['actions', 'recipients', 'destinations', 'destructive_scope'],
      },
    } };
  };

  const selectToken = (
    state: LogicalSessionState,
    command: DesktopCommand,
  ): { snapshot: NativeSnapshotRecord; token: string; node: NativeSnapshotNode } | { error: string } => {
    const snapshot = snapshotFor(state, command);
    if (!snapshot) return { error: 'observe first; this action needs a retained native snapshot' };
    if (command.elementToken) {
      const found = snapshot.nodes.find(node => node.token === command.elementToken);
      return found ? { snapshot, token: command.elementToken, node: found }
        : { error: 'elementToken is not present in the retained native snapshot; observe again' };
    }
    if (command.elementIndex !== undefined) {
      const node = snapshot.nodes[Math.floor(command.elementIndex)];
      return typeof node?.token === 'string' ? { snapshot, token: node.token, node }
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
      return { snapshot, token: matches[0].token, node: matches[0] };
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

      if (['open', 'focus', 'click', 'type', 'set_value', 'arrange', 'close'].includes(action)) {
        const admission = authorizeTrustedBranch(
          action, command as unknown as Record<string, unknown>, undefined, context,
        );
        if (admission.decision === 'blocked') return branchStop(action, admission);
      }

      const state = stateFor(context);
      const workspace = nativeTools.get('BimaxWorkspaceTool');
      const observe = nativeTools.get('BimaxObserveTool');
      const semantic = nativeTools.get('BimaxActionTool');
      const capture = nativeTools.get('BimaxCaptureTool');
      const focus = nativeTools.get('BimaxFocusTool');

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
            if (candidate === 'focus') return !!focus && !!workspace;
            if (candidate === 'observe') return !!observe;
            if (candidate === 'screenshot') return !!capture;
            if (['click', 'type', 'set_value'].includes(candidate)) return !!semantic;
            return true;
          }),
          perception: {
            authorityCache: 'disabled_pending_mutation_proof',
            readinessScope: 'pid_window_generation_observation',
          },
          latency: latency.summary(),
        }, null, 2);
      }

      if (action === 'apps' || action === 'windows' || action === 'frontmost') {
        if (!workspace) return stop(action, 'the verified native workspace inventory is unavailable');
        const operation = action === 'frontmost' ? 'apps' : action;
        const value = await invoke('BimaxWorkspaceTool', {
          operation,
          ...(command.pid ? { pid: command.pid } : {}),
        }, context, 'workspace') as Record<string, any>;
        if (action === 'frontmost') {
          const application = Array.isArray(value.apps)
            ? value.apps.find((entry: any) => entry?.app?.pid === value.frontmostPid)?.app : undefined;
          return logicalResult(action, 'BimaxWorkspaceTool', {
            frontmostPid: value.frontmostPid,
            app: appLabel(application),
            ...(application ? { application } : {}),
          }, 'semantic');
        }
        return logicalResult(action, 'BimaxWorkspaceTool', value, 'semantic');
      }

      if (action === 'open') {
        if (!workspace || !enumValues(workspace, 'operation').includes('launch_app')) {
          return stop(action, 'the verified native service cannot launch applications');
        }
        const branch = authorizeTrustedBranch(action, command as unknown as Record<string, unknown>, undefined, context);
        if (branch.decision === 'blocked') return branchStop(action, branch);
        const required = requirePostcondition(action, command);
        if ('error' in required) return stop(action, required.error, 'postcondition_required');
        const value = await invoke('BimaxWorkspaceTool', {
          operation: 'launch_app',
          ...(command.bundleId ? { bundleId: command.bundleId } : { appName: command.app }),
        }, context, 'workspace') as Record<string, any>;
        const pid = value.app?.pid ?? value.resolved?.running?.[0]?.pid;
        if (Number.isSafeInteger(pid) && pid > 0) state.pid = pid;
        state.latestSnapshotId = undefined;
        state.snapshots.clear();
        const normalized: Record<string, any> = {
          ...stableAppReceipt(value), observationSecurity: branch,
        };
        const launchGrade = gradeWorkspaceMutation(action, value, required.postcondition);
        if (!launchGrade.ok || sanitized.delivery !== 'foreground_lease') {
          return mutationResult(action, 'BimaxWorkspaceTool', normalized, launchGrade);
        }
        if (!focus || !Number.isSafeInteger(pid) || pid <= 0 || !normalized.bundleId) {
          return stop(action, 'foreground open needs the authenticated Desktop focus broker and one exact running app identity', 'foreground_focus_unavailable');
        }
        const focused = await invoke('BimaxFocusTool', {
          pid, bundleId: normalized.bundleId,
        }, context, 'verification') as Record<string, any>;
        if (focused.activated !== true || focused.frontmostPidAfter !== pid) {
          return JSON.stringify({
            ...normalized,
            ok: false, action, driver: 'bimax-native', executor: 'stop', blocked: true,
            visible: true, actionAttempted: true, code: 'foreground_activation_unverified',
            reason: `the Desktop focus broker did not verify pid ${pid} as frontmost`,
            error: `the Desktop focus broker did not verify pid ${pid} as frontmost`,
            verification: { status: 'unverified', freshObservation: false, evidence: { launch: value, focus: focused } },
          }, null, 2);
        }
        const observed = await observeTarget(state, pid, command, context);
        if (!observed.value) {
          return JSON.stringify({
            ...normalized,
            ok: false, action, driver: 'bimax-native', executor: 'stop', blocked: true,
            visible: true, actionAttempted: true, code: 'native_post_focus_observation_unavailable',
            reason: observed.error, error: observed.error,
            verification: { status: 'unverified', freshObservation: false, evidence: { launch: value, focus: focused } },
          }, null, 2);
        }
        return logicalResult(action, 'BimaxWorkspaceTool+BimaxFocusTool+BimaxObserveTool', {
          ...normalized,
          ...observed.value,
          verified: true,
          verification: {
            status: 'verified', freshObservation: true,
            postcondition: required.postcondition,
            delivery: { requested: 'foreground', actual: 'foreground', focusChanged: true },
            evidence: { launch: value, focus: focused },
          },
        }, 'semantic');
      }

      if (action === 'focus') {
        if (!focus || !workspace) return stop(action, 'the authenticated Desktop focus route is unavailable');
        const inventory = await invoke('BimaxWorkspaceTool', { operation: 'apps' }, context, 'workspace') as Record<string, any>;
        const apps = (Array.isArray(inventory.apps) ? inventory.apps : [])
          .map((entry: unknown) => object(object(entry).app));
        const wanted = command.app?.trim().toLocaleLowerCase();
        const matches = apps.filter((candidate: Record<string, any>) => command.pid
          ? candidate.pid === command.pid
          : wanted && [candidate.displayName, candidate.name, candidate.bundleId]
            .some(value => typeof value === 'string' && value.trim().toLocaleLowerCase() === wanted));
        if (matches.length !== 1) {
          return stop(action, matches.length > 1
            ? 'focus target is ambiguous in the live native application inventory'
            : 'focus target is not running in the live native application inventory', 'native_target_required');
        }
        const application = matches[0];
        if (!Number.isSafeInteger(application.pid) || typeof application.bundleId !== 'string') {
          return stop(action, 'focus target lacks an exact pid and bundleId', 'native_target_required');
        }
        const value = await invoke('BimaxFocusTool', {
          pid: application.pid, bundleId: application.bundleId,
        }, context, 'verification') as Record<string, any>;
        if (value.activated !== true || value.frontmostPidAfter !== application.pid) {
          return stop(action, 'the Desktop focus broker did not verify the requested app as frontmost', 'foreground_activation_unverified');
        }
        state.pid = application.pid;
        state.latestSnapshotId = undefined;
        state.snapshots.clear();
        const observed = await observeTarget(state, application.pid, command, context);
        if (!observed.value) return stop(action, observed.error!, 'native_post_focus_observation_unavailable');
        return logicalResult(action, 'BimaxFocusTool+BimaxObserveTool', {
          ...observed.value,
          app: appLabel(application), application,
          pid: application.pid, bundleId: application.bundleId,
          verified: true,
          verification: {
            status: 'verified', freshObservation: true,
            delivery: { requested: 'foreground', actual: 'foreground', focusChanged: value.requestedActivation === true },
            evidence: value,
          },
        }, 'semantic');
      }

      if (action === 'observe') {
        const pid = command.pid ?? state.pid;
        if (!pid) return stop(action, 'observe needs pid until this logical session has opened a native application', 'native_target_required');
        const observed = await observeTarget(state, pid, command, context);
        if (!observed.value) return stop(action, observed.error!, 'native_snapshot_unavailable');
        return logicalResult(action, 'BimaxObserveTool', observed.value, 'semantic');
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
        }, context, 'capture') as Record<string, any>;
        return logicalResult(action, 'BimaxCaptureTool', {
          ...value,
          frameId: snapshot.snapshotId,
          observationTrust: {
            classification: 'untrusted_observation', sources: ['screen_capture'],
            mayInform: 'selection_within_authenticated_branch',
            mayNotGrant: ['actions', 'recipients', 'destinations', 'destructive_scope'],
          },
        }, 'visual');
      }

      if (action === 'click' || action === 'type' || action === 'set_value') {
        if (!semantic) return stop(action, 'the verified native semantic action surface is unavailable');
        if (command.x !== undefined) {
          return stop(action, 'pixel delivery is not yet represented by the native logical adapter; use a semantic selector');
        }
        const selected = selectToken(state, command);
        if ('error' in selected) return stop(action, selected.error, 'native_selector_unresolved');
        if (selected.snapshot.readiness.state !== 'ready') {
          return stop(
            action,
            `native perception is ${selected.snapshot.readiness.state}; observe again before acting`,
            'native_perception_not_ready',
          );
        }
        const branch = authorizeTrustedBranch(
          action,
          command as unknown as Record<string, unknown>,
          selected.node as Record<string, unknown>,
          context,
        );
        if (branch.decision === 'blocked') return branchStop(action, branch);
        const required = requirePostcondition(action, command);
        if ('error' in required) return stop(action, required.error, 'postcondition_required');
        const nativeAction = action === 'click' ? 'invoke' : action === 'type' ? 'type_text' : 'set_value';
        const actions = enumValues(semantic, 'action');
        if (!actions.includes(nativeAction)) {
          return stop(action, `the native handshake has not verified ${nativeAction}`);
        }
        // Foreground delivery is an explicit caller decision, never a runtime fallback: it is only
        // attempted when the live handshake itself verified a lease-backed policy, and the receipt
        // grader then holds the result to the inverse of the background rules.
        const requestedDelivery: RequestedLogicalDelivery =
          sanitized.delivery === 'foreground_lease' ? 'foreground_lease' : 'background';
        const policies = enumValues(semantic, 'deliveryPolicy');
        let deliveryPolicy: string | undefined;
        if (requestedDelivery === 'foreground_lease') {
          if (!policies.includes('foreground_once') && !policies.includes('foreground_persistent')) {
            return stop(
              action,
              'the native handshake has not verified a foreground lease policy',
              'foreground_policy_unverified',
            );
          }
          deliveryPolicy = policies.includes('foreground_once') ? 'foreground_once' : 'foreground_persistent';
        } else {
          deliveryPolicy = policies.includes('background_only') ? 'background_only'
            : policies.includes('background_native') ? 'background_native' : policies[0];
        }
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
        }, context, 'verification') as Record<string, any>;
        state.latestSnapshotId = undefined;
        state.snapshots.clear();
        const output = {
          ...value,
          frameId: selected.snapshot.snapshotId,
          elementToken: selected.token,
          observationSecurity: branch,
        };
        return mutationResult(
          action, 'BimaxActionTool', output,
          gradeSemanticMutation(value, required.postcondition, {
            snapshotId: selected.snapshot.snapshotId,
            elementToken: selected.token,
            pid: selected.snapshot.pid,
            windowId: selected.snapshot.windowId,
            windowGeneration: selected.snapshot.windowGeneration,
          }, requestedDelivery),
        );
      }

      if (action === 'arrange' || action === 'close') {
        if (!workspace) return stop(action, 'the verified native window-operation surface is unavailable');
        const snapshot = snapshotFor(state, command);
        if (!snapshot?.windowId || snapshot.windowGeneration === undefined) {
          return stop(action, `${action} needs a retained exact-window observation; observe first`, 'native_snapshot_required');
        }
        const branch = authorizeTrustedBranch(action, command as unknown as Record<string, unknown>, undefined, context);
        if (branch.decision === 'blocked') return branchStop(action, branch);
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
        }, context, 'verification') as Record<string, any>;
        state.latestSnapshotId = undefined;
        state.snapshots.clear();
        return mutationResult(
          action, 'BimaxWorkspaceTool', { ...value, observationSecurity: branch },
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
