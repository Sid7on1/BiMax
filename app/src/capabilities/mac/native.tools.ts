import { classifyMacActionImpact as classifyDesktopActionImpact } from './action.impact';
import { randomUUID } from 'node:crypto';
import { capabilityEvents as cliEvents } from './events';
import { loadMacCapabilityConfig as loadConfig } from './config';
import type { CapabilityGovernor as IGovernor } from './provider.policy';
import { NativeServiceOperationClient } from './native.bridge.transport';
import { resolveCapabilityWorkspacePath as resolveBrowserWorkspacePath, capabilityWriteBlock as workspaceWriteBlock } from './path.policy';
import { resolveConvergedComputerRoute } from './browser.convergence.route';
import type { NativeRolloutController } from './native.rollout';
import { buildNativeOperationToolContracts } from './native.operation.contract';
import {
  NativeToolCoordinator,
  type NativeActionToolInput,
  type NativeCaptureToolInput,
  type NativeTransactionToolInput,
  type NativeWindowOperation,
} from './native.tool.coordinator';
import {
  assessNativeCutover,
  assessNativeSemanticOptIn,
  globalNativeServiceCapabilityClient,
  type NativeServiceCapabilityClient,
} from './native.service.client';
import { buildCapabilityTool as buildTool, type CapabilityTool as BuiltTool } from './provider.tool';

export interface NativeComputerToolSurface {
  tools: BuiltTool[];
  coordinator: NativeToolCoordinator;
}

export type NativeRoutingMode = 'full' | 'semantic';

function taskSession(context: unknown): string {
  const value = context && typeof context === 'object'
    ? (context as { sessionId?: unknown }).sessionId : undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('native computer tools require a Bimax task session');
  }
  return value.trim();
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function withRoute(value: unknown, route: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>), route }
    : { result: value, route };
}

function taintObservation(kind: string): void {
  cliEvents.emit('observation', kind);
}

function nativeSemanticRoute(surface: 'macos_app' | 'system_ui', pid: number) {
  return resolveConvergedComputerRoute(
    { surface, pid }, { browserCdp: false, nativeAX: true, nativeCapture: false },
  ).receipt;
}

async function approveNativeAction(
  governor: IGovernor,
  coordinator: NativeToolCoordinator,
  taskSessionId: string,
  input: NativeActionToolInput,
  prepared: Awaited<ReturnType<NativeToolCoordinator['prepareAction']>>,
  resolvedApp?: string,
): Promise<{ approvalId: string; grantedAtMs: number; expiresAtMs: number } | undefined> {
  const app = resolvedApp ?? await coordinator.appIdentity(taskSessionId, prepared.target.pid);
  const impact = classifyDesktopActionImpact(input.action, {
    label: prepared.node.label, role: prepared.node.role,
  });
  const approvals = (await loadConfig()).computerApprovals;
  const governorMode = (governor as { mode?: unknown }).mode;
  // Foreground delivery always asks: its service-side approval asserts that the coordinator made
  // a real focus-changing decision. Background routine work keeps the existing user preference.
  const routine = approvals === 'high-impact-only' && !impact.high && !prepared.foreground
    && governorMode !== 'plan' && governorMode !== 'strict';
  await governor.approveTaskExecution('COMPUTER_CONTROL', {
    tool: 'BimaxActionTool', action: input.action, app,
    highImpact: impact.high || undefined, impactReason: impact.reason,
    isDestructive: !routine,
    target: prepared.target,
  });
  if (routine) {
    const note = `Auto-approved (${approvals}): ${input.action} in ${app}`;
    cliEvents.emit('status', note);
    cliEvents.emit('log', { id: Date.now(), level: 'info', text: note, timestamp: new Date() });
  }
  return prepared.foreground ? coordinator.approvalFor(prepared) : undefined;
}

const FILE_OPERATIONS = new Set([
  'inspect_file', 'open_file', 'reveal_file', 'trash_file', 'duplicate_file',
]);

const WINDOW_OPERATIONS = new Set([
  'move_window', 'resize_window', 'set_window_frame', 'minimize_window', 'unminimize_window',
  'close_window', 'set_window_fullscreen',
]);

function appLookupArgs(args: Record<string, unknown>): { bundleId?: unknown; appName?: unknown } | undefined {
  if (args.bundleId === undefined && args.appName === undefined) return undefined;
  return {
    ...(args.bundleId !== undefined ? { bundleId: args.bundleId } : {}),
    ...(args.appName !== undefined ? { appName: args.appName } : {}),
  };
}

interface FocusBrokerCredentials { endpoint: string; token: string }

function focusBrokerCredentials(env: NodeJS.ProcessEnv = process.env): FocusBrokerCredentials | null {
  const endpoint = String(env.BIMAX_CU_FOCUS_BROKER_ENDPOINT || '').trim();
  const token = String(env.BIMAX_CU_FOCUS_BROKER_TOKEN || '').trim();
  if (!endpoint || !/^[0-9a-f]{64}$/.test(token)) return null;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
      || url.pathname !== '/v1/focus/activate' || url.username || url.password
      || url.search || url.hash) return null;
  } catch { return null; }
  return { endpoint, token };
}

async function requestFocusActivation(
  credentials: FocusBrokerCredentials,
  targetPid: number,
  targetBundleId: string,
): Promise<{ accepted: boolean; code: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_500);
  try {
    const response = await fetch(credentials.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        token: credentials.token,
        requestId: `provider-${randomUUID()}`,
        targetPid,
        targetBundleId,
        expiresAtMs: Date.now() + 4_000,
      }),
      signal: controller.signal,
    });
    const value = await response.json() as { accepted?: unknown; code?: unknown };
    return {
      accepted: response.ok && value.accepted === true,
      code: typeof value.code === 'string' ? value.code : 'invalid_response',
    };
  } catch {
    return { accepted: false, code: 'focus_broker_unreachable' };
  } finally {
    clearTimeout(timeout);
  }
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function nativeAppRecord(value: unknown, pid: number): Record<string, unknown> | null {
  const apps = value && typeof value === 'object' && Array.isArray((value as { apps?: unknown }).apps)
    ? (value as { apps: unknown[] }).apps : [];
  for (const entry of apps) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const app = (entry as { app?: unknown }).app;
    if (app && typeof app === 'object' && !Array.isArray(app)
      && (app as { pid?: unknown }).pid === pid) return app as Record<string, unknown>;
  }
  return null;
}

function createFocusTool(
  governor: IGovernor,
  coordinator: NativeToolCoordinator,
  credentials: FocusBrokerCredentials,
): BuiltTool {
  return buildTool({
    name: 'BimaxFocusTool',
    description: 'Bring one exact, already-running application PID to the foreground through the Electron-owned authenticated focus broker and verify the OS frontmost PID.',
    schema: {
      type: 'object', additionalProperties: false,
      properties: {
        pid: { type: 'integer', minimum: 1 },
        bundleId: { type: 'string', minLength: 3, maxLength: 255 },
      },
      required: ['pid', 'bundleId'],
    },
    isDestructive: true,
    approvalHandledInternally: true,
    execute: async (args, context): Promise<string> => {
      const session = taskSession(context);
      const pid = Number(args.pid);
      const bundleId = typeof args.bundleId === 'string' ? args.bundleId.trim() : '';
      if (!Number.isSafeInteger(pid) || pid <= 0 || !/^[A-Za-z0-9.-]{3,255}$/.test(bundleId)) {
        throw new Error('focus requires one exact running pid and bundleId');
      }
      const before = await coordinator.workspace(session, {}) as Record<string, unknown>;
      const app = nativeAppRecord(before, pid);
      if (!app || app.bundleId !== bundleId) {
        throw new Error('focus target no longer matches the live native application inventory');
      }
      const frontmostPidBefore = before.frontmostPid;
      if (frontmostPidBefore === pid) {
        return json({
          operation: 'focus_app', outcome: 'already_frontmost', activated: true,
          requestedActivation: false, app, frontmostPidBefore, frontmostPidAfter: pid,
        });
      }
      await governor.approveTaskExecution('COMPUTER_CONTROL', {
        tool: 'BimaxFocusTool', action: 'bring application to foreground',
        app: app.displayName || bundleId, bundleId, target: { pid, bundleId },
        highImpact: true, impactReason: 'changes the application visible in the foreground',
        isDestructive: true,
      });
      const broker = await requestFocusActivation(credentials, pid, bundleId);
      if (!broker.accepted) {
        return json({
          operation: 'focus_app', outcome: 'blocked', activated: false,
          requestedActivation: true, app, frontmostPidBefore,
          frontmostPidAfter: frontmostPidBefore, code: broker.code,
        });
      }
      let after = before;
      const deadline = Date.now() + 1_800;
      while (Date.now() < deadline) {
        after = await coordinator.workspace(session, {}) as Record<string, unknown>;
        if (after.frontmostPid === pid) break;
        await pause(60);
      }
      const frontmostPidAfter = after.frontmostPid;
      return json({
        operation: 'focus_app',
        outcome: frontmostPidAfter === pid ? 'activated' : 'activation_unverified',
        activated: frontmostPidAfter === pid,
        requestedActivation: true, app, frontmostPidBefore, frontmostPidAfter,
        brokerCode: broker.code,
      });
    },
  }, governor);
}

/**
 * File operations are workspace-scoped before they are native operations.
 *
 * The path is resolved against the active workspace and checked through the same lexical plus
 * realpath rule the governed download destination uses, so a symlink cannot carry the operation
 * out of the workspace. Every approval names the resolved absolute path, never the model's input.
 */
async function runNativeFileOperation(
  governor: IGovernor,
  coordinator: NativeToolCoordinator,
  session: string,
  operation: string,
  args: Record<string, unknown>,
  context: unknown,
): Promise<Record<string, unknown>> {
  const cwd = (context && typeof context === 'object' && typeof (context as { cwd?: unknown }).cwd === 'string'
    ? (context as { cwd: string }).cwd : process.cwd());
  if (typeof args.path !== 'string' || !args.path.trim()) {
    throw new Error(`${operation} requires a workspace path`);
  }
  const resolved = resolveBrowserWorkspacePath(cwd, args.path);
  if (!resolved.ok) throw new Error(`${operation} refused: ${resolved.reason}`);

  if (operation === 'inspect_file') {
    return { operation, ...await coordinator.inspectFile(session, resolved.path) as Record<string, unknown> };
  }

  const mutatesFile = operation === 'trash_file' || operation === 'duplicate_file';
  if (mutatesFile) {
    const blocked = workspaceWriteBlock(resolved.path);
    if (blocked) throw new Error(`${operation} refused: ${blocked}`);
  }
  const prepared = await coordinator.prepareFileOperation(
    session, operation as 'open_file' | 'reveal_file' | 'trash_file' | 'duplicate_file',
    resolved.path, operation === 'open_file' ? appLookupArgs(args) : undefined,
  );
  if (mutatesFile) {
    // Trash is a recoverable delete and duplicate writes a new file: both cross the FILE_WRITE
    // boundary and are disclosed as destructive.
    await governor.approveTaskExecution('FILE_WRITE', {
      tool: 'BimaxWorkspaceTool', action: operation, targetPath: prepared.path, isDestructive: true,
    });
  } else {
    await governor.approveTaskExecution('COMPUTER_CONTROL', {
      tool: 'BimaxWorkspaceTool', action: operation, targetPath: prepared.path,
      // Revealing brings Finder forward. That is a visible change to what the human is looking at,
      // so it is disclosed as high-impact rather than treated as routine.
      highImpact: prepared.changesForeground || undefined,
      impactReason: prepared.changesForeground ? 'brings Finder to the foreground' : undefined,
      isDestructive: true,
    });
  }
  return { operation, ...await coordinator.performFileOperation(session, prepared) as Record<string, unknown> };
}

/**
 * Build the model-visible native surface only after both discovery and the signed bridge agree
 * that every production cutover gate is satisfied. Any refusal returns null; callers keep the
 * compatibility ComputerTool instead of exposing a half-connected native catalog.
 */
export async function createEligibleNativeComputerTools(
  governor: IGovernor,
  capabilityClient: NativeServiceCapabilityClient = globalNativeServiceCapabilityClient,
  operationClient: NativeServiceOperationClient = new NativeServiceOperationClient(),
  routingMode: NativeRoutingMode = process.env.BIMAX_CU_NATIVE_SEMANTIC_ROUTING_ENABLED === '1'
    ? 'semantic' : 'full',
  rolloutController?: NativeRolloutController,
): Promise<NativeComputerToolSurface | null> {
  if (rolloutController && !rolloutController.status().selected) return null;
  const probe = await capabilityClient.probe();
  if (!probe.handshake || !operationClient.available()) return null;
  // The same approval record the probe was assessed against. Re-reading the store here could pick
  // up a different answer than the probe used and register a native surface the status line calls
  // unsigned (or the reverse), so the probe's record is carried forward rather than fetched again.
  const approval = probe.adHocApproval;
  const discovered = routingMode === 'semantic'
    ? assessNativeSemanticOptIn(probe.handshake, true, approval)
    : { eligible: probe.routingEligible, blockers: probe.cutoverBlockers };
  if (!discovered.eligible) return null;

  let handshake;
  try { handshake = await operationClient.handshake(); }
  catch { return null; }
  // The bridge handshake is the live XPC endpoint used below and is therefore the final authority.
  // `true` represents the already-proven environment gate from the eligible discovery result. The
  // approval is re-applied here too: the bridge reports its OWN signing state, so a discovery that
  // cleared on an approved sidecar must not be assumed to carry over to a different binary.
  const liveAssessment = routingMode === 'semantic'
    ? assessNativeSemanticOptIn(handshake, true, approval)
    : assessNativeCutover(handshake, true, approval);
  if (!liveAssessment.eligible) return null;

  const coordinator = new NativeToolCoordinator(handshake, operationClient);
  const contracts = buildNativeOperationToolContracts(handshake);
  const tools = contracts.map(contract => buildTool({
    name: contract.name,
    description: contract.description,
    schema: contract.schema,
    isDestructive: false,
    isConcurrencySafe: false,
    approvalHandledInternally: contract.name === 'BimaxActionTool'
      || contract.name === 'BimaxTransactionTool'
      // The workspace tool decides per operation: inventory and resolution are read-only, and a
      // launch takes its own approval naming the resolved bundle.
      || contract.name === 'BimaxWorkspaceTool',
    execute: async (args: Record<string, unknown>, context?: unknown): Promise<string> => {
      // A trip refuses before creating a session or crossing XPC. We never replay a failed native
      // mutation through ComputerTool because the original delivery may be ambiguous; only future
      // model work is directed to the still-registered compatibility surface.
      rolloutController?.assertAllowed();
      try {
        const session = taskSession(context);
        const result = await (async (): Promise<string> => { switch (contract.name) {
        case 'BimaxWorkspaceTool': {
          const operation = args.operation;
          if (operation === 'resolve_app') {
            // Read-only Launch Services lookup: no process starts, so no approval is taken.
            return json({ operation, ...await coordinator.resolveApp(session, args) });
          }
          if (typeof operation === 'string' && FILE_OPERATIONS.has(operation)) {
            return json(await runNativeFileOperation(governor, coordinator, session, operation, args, context));
          }
          if (typeof operation === 'string' && WINDOW_OPERATIONS.has(operation)) {
            const prepared = await coordinator.prepareWindowOperation(
              session, operation as NativeWindowOperation, args,
            );
            const app = await coordinator.appIdentity(session, prepared.window.pid);
            await governor.approveTaskExecution('COMPUTER_CONTROL', {
              tool: 'BimaxWorkspaceTool',
              action: prepared.tile ? `${operation} (${prepared.tile})` : operation,
              app,
              // Closing a window can discard unsaved work; geometry changes cannot. Only the
              // commit action is marked high-impact.
              highImpact: prepared.commitAction || undefined,
              impactReason: prepared.commitAction ? 'may discard unsaved work' : undefined,
              isDestructive: true,
              target: prepared.window,
            });
            return json({
              operation,
              ...await coordinator.performWindowOperation(session, prepared) as Record<string, unknown>,
              ...(prepared.tile ? { tile: prepared.tile, requestedFrame: prepared.frame } : {}),
            });
          }
          if (operation === 'open_url') {
            const prepared = await coordinator.prepareUrlOpen(session, args.url, appLookupArgs(args));
            // Opening a URL reaches the network through whichever browser Launch Services picks.
            // It is outward-facing, so it is always high-impact and names the host it will reach.
            await governor.approveTaskExecution('COMPUTER_CONTROL', {
              tool: 'BimaxWorkspaceTool', action: 'open a URL in the default browser',
              host: prepared.host, url: prepared.url,
              highImpact: true, impactReason: 'opens an outward-facing request from this machine',
              isDestructive: true,
            });
            return json({ operation, ...await coordinator.performUrlOpen(session, prepared) as Record<string, unknown> });
          }
          if (operation === 'launch_app') {
            const prepared = await coordinator.prepareLaunch(session, args);
            const target = [prepared.resolved.displayName, prepared.resolved.bundleId]
              .filter(Boolean).join(' / ') || prepared.lookup.value;
            // Starting a process is not routine work, and the approval names the bundle Launch
            // Services resolved rather than the string the model typed.
            await governor.approveTaskExecution('COMPUTER_CONTROL', {
              tool: 'BimaxWorkspaceTool',
              action: prepared.alreadyRunning
                ? 'launch application (already running; nothing will start)'
                : 'launch application in the background',
              app: target,
              isDestructive: true,
              highImpact: !prepared.alreadyRunning || undefined,
              impactReason: prepared.alreadyRunning ? undefined : 'starts a new process',
              target: { bundlePath: prepared.resolved.bundlePath, bundleId: prepared.resolved.bundleId },
            });
            const receipt = await coordinator.performLaunch(session, prepared) as Record<string, unknown>;
            return json({ operation, ...receipt, resolved: prepared.resolved });
          }
          const snapshot = await coordinator.workspace(session, {
            ...(args.pid !== undefined ? { pid: args.pid } : {}),
            includeOffscreenWindows: args.includeOffscreenWindows === true,
          }) as Record<string, unknown>;
          if (operation === 'windows') taintObservation('window inventory');
          return json({
            operation,
            ...(operation === 'apps' ? { apps: snapshot.apps, frontmostPid: snapshot.frontmostPid } : {}),
            ...(operation === 'windows' ? { windows: snapshot.windows } : {}),
            ...(operation === 'displays' ? { displays: snapshot.displays } : {}),
          });
        }
        case 'BimaxObserveTool': {
          const { relatedObservations, ...primaryRequest } = args;
          const related = Array.isArray(relatedObservations)
            ? relatedObservations as Record<string, unknown>[] : [];
          const snapshots = related.length
            ? await coordinator.observeParallel(session, [primaryRequest, ...related])
            : [await coordinator.observe(session, primaryRequest)];
          const [snapshot, ...relatedSnapshots] = snapshots;
          const appGuidance = args.scope === 'system_ui'
            ? null : await coordinator.appGuidance(session, snapshot.pid);
          taintObservation('AX observation');
          cliEvents.emit('browser_evidence', {
            action: 'native_ax_observe', ok: true, trusted: false,
            source: `native snapshot ${snapshot.snapshotId}`,
            summary: `Observed ${snapshot.nodes.length} native accessibility nodes`,
          });
          return json({
            ...snapshot,
            ...(relatedSnapshots.length ? { relatedSnapshots } : {}),
            ...(appGuidance ? { appGuidance } : {}),
            route: nativeSemanticRoute(args.scope === 'system_ui' ? 'system_ui' : 'macos_app', snapshot.pid),
          });
        }
        case 'BimaxActionTool': {
          const input = args as unknown as NativeActionToolInput;
          const prepared = await coordinator.prepareAction(session, input);
          const app = await coordinator.appIdentity(session, prepared.target.pid);
          const approval = await approveNativeAction(governor, coordinator, session, input, prepared, app);
          return json({
            ...await coordinator.performAction(session, prepared, approval),
            target: { app, ...prepared.target },
            route: nativeSemanticRoute('macos_app', prepared.target.pid),
          });
        }
        case 'BimaxTransactionTool': {
          const input = args as unknown as NativeTransactionToolInput;
          const prepared = await coordinator.compileTransaction(session, input);
          const manifest = prepared.compiled.approvalManifest;
          const app = await coordinator.appIdentity(session, manifest.target.pid);
          const approvals = (await loadConfig()).computerApprovals;
          const governorMode = (governor as { mode?: unknown }).mode;
          const routine = approvals === 'high-impact-only'
            && governorMode !== 'plan' && governorMode !== 'strict';
          await governor.approveTaskExecution('COMPUTER_CONTROL', {
            tool: 'BimaxTransactionTool', action: `transaction (${manifest.steps.length} routine steps)`,
            app, isDestructive: !routine, approvalManifest: manifest,
          });
          if (routine) {
            const note = `Auto-approved (${approvals}): ${manifest.steps.length}-step native transaction in ${app}`;
            cliEvents.emit('status', note);
            cliEvents.emit('log', { id: Date.now(), level: 'info', text: note, timestamp: new Date() });
          }
          return json(withRoute(
            await coordinator.performTransaction(session, prepared),
            nativeSemanticRoute('macos_app', manifest.target.pid),
          ));
        }
        case 'BimaxCaptureTool': {
          const result = await coordinator.capture(session, args as unknown as NativeCaptureToolInput);
          const route = resolveConvergedComputerRoute(
            { surface: 'visual_only' },
            { browserCdp: false, nativeAX: false, nativeCapture: true },
          ).receipt;
          return json(withRoute(result, route));
        }
      }
      throw new Error(`unsupported native computer tool ${String(contract.name)}`);
        })();
        rolloutController?.recordSuccess(contract.name);
        return result;
      } catch (error) {
        rolloutController?.recordError(contract.name, error);
        throw error;
      }
    },
  }, governor));

  const focusCredentials = focusBrokerCredentials();
  if (focusCredentials) tools.push(createFocusTool(governor, coordinator, focusCredentials));

  if (tools.length === 0) {
    await coordinator.dispose();
    return null;
  }
  return { tools, coordinator };
}
