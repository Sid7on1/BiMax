import { Responder, createRelayAuthorizer } from 'desktop-responder';
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
 * Initializes and starts the desktop responder if and only if process.env.BIMAX_RESPONDER === "1".
 * When BIMAX_RESPONDER is unset or not "1", the adapter remains completely inert with zero behavior change.
 */
export async function initResponderIfEnabled(
  threads: ThreadManagerLike,
  options: ResponderInitOptions = {},
): Promise<{ responder: Responder; adapter: RealEngineAdapter; approvalHook: ApprovalHook } | null> {
  if (process.env.BIMAX_RESPONDER !== '1') {
    return null;
  }
  if (activeResponder) throw new Error('Desktop responder is already running');
  if (!options.secureHandle) throw new Error('Responder requires trusted-sender IPC registration');

  const identity = await loadOrCreateIdentity();
  const approvalHook = new ApprovalHook();
  const adapter = new RealEngineAdapter(threads, approvalHook);

  const relayUrl = options.relayUrl || process.env.BIMAX_RELAY_URL || 'ws://127.0.0.1:8787';
  const authorizeRelayUrl = options.authorizeRelayUrl ?? (options.gatewayUrl && options.getAccessToken
    ? createRelayAuthorizer(options.gatewayUrl, options.getAccessToken, identity.deviceId, identity.helloPubkeyB64)
    : undefined);
  if (relayUrl.startsWith('wss:') && !authorizeRelayUrl)
    throw new Error('Cloud remote access requires a gateway URL and signed-in account credential');

  const hostControls: DesktopHostControls = new DesktopHostControls(() => responder.emergencyStop());
  const responder: Responder = new Responder({
    identity,
    enginePort: adapter,
    relayUrl,
    lanRelayUrl: options.lanRelayUrl || process.env.BIMAX_LAN_RELAY_URL,
    dataDir: options.dataDir ?? path.join(app.getPath('userData'), 'responder'),
    hostControls,
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

  return { responder, adapter, approvalHook };
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
