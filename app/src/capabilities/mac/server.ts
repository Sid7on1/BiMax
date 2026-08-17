import { normalizeDesktopAction, PUBLIC_DESKTOP_ACTIONS, type DesktopCommand } from './desktop.runtime';
import {
  renderComputerActionReference,
  unwrapActionEnvelope,
  validateModelComputerCommand,
} from './action.contract';
import { globalComputerSessionManager } from './session.manager';
import { createEligibleNativeComputerTools } from './native.tools';
import { assertProviderHostArchitecture, DesktopCapabilityGovernor } from './provider.policy';
import type { CapabilityTool } from './provider.tool';
import { globalNativeInputInterlock } from './native.input.interlock';
import { refreshTakeoverAuthority } from './takeover.authority';

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

export const MAC_CONTROL_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    action: { type: 'string', enum: [...PUBLIC_DESKTOP_ACTIONS], description: 'Exactly one action per call.' },
    app: { type: 'string' }, bundleId: { type: 'string' }, query: { type: 'string' },
    elementToken: { type: 'string' }, elementIndex: { type: 'number' },
    x: { type: 'number' }, y: { type: 'number' }, toX: { type: 'number' }, toY: { type: 'number' },
    toQuery: { type: 'string' }, toElementToken: { type: 'string' }, toElementIndex: { type: 'number' },
    normalized: { type: 'boolean' }, text: { type: 'string' }, replaceExisting: { type: 'boolean' },
    combo: { type: 'string' }, modifier: { type: 'array', items: { type: 'string' } },
    button: { type: 'string' }, count: { type: 'number' }, value: { type: 'string' },
    expect: { type: 'string' }, expectMode: { type: 'string' }, frameId: { type: 'string' },
    maxElements: { type: 'number' }, includeScreenshot: { type: 'boolean' }, layout: { type: 'string' },
    direction: { type: 'string' }, amount: { type: 'number' }, deliveryMode: { type: 'string', enum: ['foreground', 'background'] },
    captureScope: { type: 'string' }, ms: { type: 'number' }, pid: { type: 'number' }, windowId: { type: 'number' },
  },
  required: ['action'],
} as const;

const READ_ONLY = new Set(['status', 'apps', 'windows', 'observe', 'screenshot', 'cursor', 'frontmost', 'desktop', 'record_status']);

/**
 * The user-takeover gate, applied to every tool before it can reach the runtime.
 *
 * Reads stay available while paused on purpose: `native.input.interlock.ts` already draws that line
 * ("Reads/capture remain available while paused"), and the Live Target inspector needs fresh
 * evidence in order to show the user what they just took control of.
 */
export async function assertUserHasNotTakenControl(mutating: boolean): Promise<void> {
  await refreshTakeoverAuthority();
  if (!mutating) return;
  const state = globalNativeInputInterlock.state();
  if (!state.paused) return;
  throw new UserTakeoverError(state.reason || 'you took control');
}

export class UserTakeoverError extends Error {
  public readonly code = 'computer_use_paused';
  constructor(public readonly userReason: string) {
    super(`computer use is paused because ${userReason}; resume in Bimax before the agent acts`);
    this.name = 'UserTakeoverError';
  }
}

/** Exported as a seam: the argument contract below is only meaningful if it is exercised through
 * the same entry point `mac_control` actually uses. */
export function compatibilityTool(cwd: string, governor: DesktopCapabilityGovernor): CapabilityTool {
  const runtime = globalComputerSessionManager.forSession(`mac-provider-${process.pid}`);
  return {
    name: 'mac_control',
    description: 'Desktop-owned macOS control ladder. Start with status or observe, act once from the freshest frame, then verify the returned end state. Prefer the separately listed semantic native tools when their schemas are available.',
    schema: MAC_CONTROL_SCHEMA,
    isDestructive: true,
    execute: async (args): Promise<string> => {
      // Accept the `{type:{...}}` envelope some models emit before sanitizing, or the payload is
      // filtered away as unknown keys and a well-formed call is refused as "Unknown macOS action".
      const unwrapped = unwrapActionEnvelope(args as Record<string, unknown>);
      const allowed = new Set(Object.keys(MAC_CONTROL_SCHEMA.properties));
      const sanitized = Object.fromEntries(Object.entries(unwrapped).filter(([key]) => allowed.has(key)));
      const action = normalizeDesktopAction(String(sanitized.action || ''));
      if (!(PUBLIC_DESKTOP_ACTIONS as readonly string[]).includes(action)) {
        return JSON.stringify({ ok: false, action, code: 'invalid_action', error: 'Unknown macOS action.' });
      }
      // Models trained on browser-computer APIs emit {action:"press", key:"return"}; this runtime
      // calls that field `combo`. normalizeDesktopAction folds the verb, so fold the payload too —
      // otherwise an explicit Return is refused with the absurd "key needs combo".
      const command = {
        ...sanitized,
        action,
        ...(action === 'key' && !sanitized.combo && (unwrapped as any).key
          ? { combo: (unwrapped as any).key }
          : {}),
      } as DesktopCommand;

      // The model-facing contract, applied HERE rather than only in the CLI's ComputerTool.
      //
      // This validation existed, was unit-tested, and had no production caller on the Desktop path:
      // `mac_control` went straight to the runtime. So an ambiguous command — measured live, a
      // `type` carrying BOTH elementToken and elementIndex — was never refused on its merits. It
      // reached element resolution, where elementToken silently wins, missed, and came back as
      // "element handle is stale or missing; observe again". That sentence describes a fix for a
      // different problem, so the model re-sent the same malformed call and burned the turn.
      //
      // Refuse before the governor is asked to approve: a malformed command should never occupy an
      // approval slot, and the model needs to hear which selectors collided, not a staleness story.
      const invalid = validateModelComputerCommand(command);
      if (invalid) {
        return JSON.stringify({
          ok: false,
          action,
          code: 'invalid_arguments',
          summary: `${action} refused: invalid action arguments`,
          error: invalid,
          expected: renderComputerActionReference().split('\n').find(line => line.startsWith(`${action}:`)),
        }, null, 2);
      }
      // Before approval, and before anything that could reach the bridge: the human's own hands
      // outrank an approval the agent already holds.
      await assertUserHasNotTakenControl(!READ_ONLY.has(action));
      if (!READ_ONLY.has(action)) {
        await governor.approveTaskExecution('MAC_ACTION', { ...command, isDestructive: true });
      }
      const result = await runtime.run(command, { cwd });
      // Status is what the Live Target inspector and the model both read to learn the current
      // control state, so it carries the latch rather than making them infer it from a refusal.
      const takeover = globalNativeInputInterlock.state();
      return JSON.stringify(
        action === 'status'
          ? { ...result, userTakeover: { paused: takeover.paused, reason: takeover.reason ?? '' } }
          : result,
        null,
        2,
      );
    },
  };
}

export async function createMacCapabilityServer(cwd = process.env.BIMAX_CWD || process.cwd()): Promise<any> {
  assertProviderHostArchitecture();
  const governor = new DesktopCapabilityGovernor();
  const tools: CapabilityTool[] = [compatibilityTool(cwd, governor)];
  const native = process.env.BIMAX_MAC_PROVIDER_DISABLE_NATIVE === '1'
    ? null : await createEligibleNativeComputerTools(governor).catch(() => null);
  if (native) tools.push(...native.tools);
  tools.sort((a, b) => a.name.localeCompare(b.name));

  const server = new Server({ name: 'bimax-mac', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.schema })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    const tool = tools.find(candidate => candidate.name === request.params.name);
    if (!tool) return { content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }], isError: true };
    try {
      // Refresh the app-owned latch once per call so the native coordinator's own synchronous
      // check (native.tool.coordinator.ts requireInputAvailable) sees the user's current decision
      // rather than whatever it last cached. `false` refreshes without enforcing here — each tool
      // decides which of its operations mutate.
      await assertUserHasNotTakenControl(false);
      const text = await tool.execute(request.params.arguments || {}, { cwd, sessionId: `mac-provider-${process.pid}` });
      let structuredContent: unknown;
      try { structuredContent = JSON.parse(text); } catch { /* text-only result */ }
      return { content: [{ type: 'text', text }], ...(structuredContent !== undefined ? { structuredContent } : {}) };
    } catch (error) {
      const takeoverCode = error instanceof UserTakeoverError
        ? 'computer_use_paused'
        : (error as { code?: unknown } | null)?.code;
      const takeoverRefusal = takeoverCode === 'computer_use_paused'
        || takeoverCode === 'computer_use_takeover_intervened';
      const text = JSON.stringify(takeoverRefusal
        ? {
          ok: false,
          code: takeoverCode,
          userTakeover: {
            paused: globalNativeInputInterlock.state().paused,
            reason: globalNativeInputInterlock.state().reason ?? '',
          },
          error: String((error as Error)?.message || error),
        }
        : { ok: false, error: String((error as Error)?.message || error) });
      return { content: [{ type: 'text', text }], isError: true };
    }
  });
  return server;
}

export async function runMacCapabilityProvider(): Promise<void> {
  console.log = console.error.bind(console);
  const server = await createMacCapabilityServer();
  await server.connect(new StdioServerTransport());
  const shutdown = async (): Promise<void> => {
    try { await globalComputerSessionManager.disposeAll(); } finally { process.exit(0); }
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
