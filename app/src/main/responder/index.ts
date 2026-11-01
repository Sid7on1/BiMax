import { Responder, createRelayAuthorizer, type Identity } from 'desktop-responder';
import { app } from 'electron';
import * as path from 'node:path';
import { RealEngineAdapter, type ThreadManagerLike } from './adapter';
import { ApprovalHook } from './approval-hook';
import { loadOrCreateIdentity } from './identity-secure';
import { setupPairingIpc, type SecureResponderHandle } from './pairing-ui';
import { DesktopHostControls } from './host-controls';

export * from './adapter';
export * from './approval-hook';
export * from './identity-secure';
export * from './pairing-ui';

export interface ResponderInitOptions {
  enabled?: boolean;
  knownWorkspaceRoots?: () => string[];
  onCloudGrant?: (grant: import('./cloud').CloudGrant) => Promise<void>;
  identity?: Identity;
  onEmergencyStop?: () => void;
  relayUrl?: string;
  lanRelayUrl?: string;
  dataDir?: string;
  broadcast?: (channel: string, ...args: unknown[]) => void;
  secureHandle?: SecureResponderHandle;
  authorizeRelayUrl?: (url: string) => Promise<string>;
  gatewayUrl?: string;
  getAccessToken?: () => Promise<string>;
}

let activeResponder: Responder | null = null;
let teardownIpc: (() => void) | null = null;

/**
 * Starts only with explicit main-owned enablement. The legacy direct-call environment opt-in is
 * retained for fixtures; normal Desktop enablement comes from Phone connection settings.
 */
export async function initResponderIfEnabled(
  threads: ThreadManagerLike,
  options: ResponderInitOptions = {},
): Promise<{ responder: Responder; adapter: RealEngineAdapter; approvalHook: ApprovalHook; hostControls: DesktopHostControls } | null> {
  if (!(options.enabled ?? (process.env.BIMAX_RESPONDER === '1'))) {
    return null;
  }
  if (activeResponder) throw new Error('Desktop responder is already running');
  if (!options.secureHandle) throw new Error('Responder requires trusted-sender IPC registration');

  const identity = options.identity ?? await loadOrCreateIdentity();
  const approvalHook = new ApprovalHook();
  const adapter = new RealEngineAdapter(threads, approvalHook, undefined, options.knownWorkspaceRoots);

  const relayUrl = options.relayUrl || process.env.BIMAX_RELAY_URL || 'ws://127.0.0.1:8787';
  const authorizeRelayUrl = options.authorizeRelayUrl ?? (options.gatewayUrl && options.getAccessToken
    ? createRelayAuthorizer(options.gatewayUrl, options.getAccessToken, identity.deviceId, identity.helloPubkeyB64)
    : undefined);
  if (relayUrl.startsWith('wss:') && !authorizeRelayUrl)
    throw new Error('Cloud remote access requires a gateway URL and signed-in account credential');

  const hostControls: DesktopHostControls = new DesktopHostControls(async () => { try { await responder.emergencyStop(); } finally { options.onEmergencyStop?.(); } });
  const responder: Responder = new Responder({
    identity,
    enginePort: adapter,
    relayUrl,
    lanRelayUrl: options.lanRelayUrl || process.env.BIMAX_LAN_RELAY_URL,
    dataDir: options.dataDir ?? path.join(app.getPath('userData'), 'responder'),
    hostControls,
    onCloudGrant:options.onCloudGrant,
    authorizeRelayUrl,
  });

  teardownIpc = setupPairingIpc(responder, options.secureHandle, () => hostControls.stop(), options.broadcast);
  try {
    await responder.start();
  } catch (error) {
    teardownIpc();
    teardownIpc = null;
    await responder.stop().catch(() => {});
    throw error;
  }
  activeResponder = responder;

  return { responder, adapter, approvalHook, hostControls };
}

/**
 * Cleanly stops the active responder and tears down IPC listeners.
 */
export async function stopResponder(): Promise<void> {
  if (teardownIpc) {
    teardownIpc();
    teardownIpc = null;
  }
  if (activeResponder) {
    await activeResponder.stop();
    activeResponder = null;
  }
}
