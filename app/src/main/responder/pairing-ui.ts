import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { Responder } from 'desktop-responder';

export type SecureResponderHandle = (channel: string, fallback: unknown,
  fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>) => void;

/**
 * Exposes responder pairing and trust management to the Electron renderer via IPC.
 * Follows Bimax main-process IPC naming conventions.
 */
export function setupPairingIpc(
  responder: Responder,
  handle: SecureResponderHandle,
  localStop: () => Promise<void>,
  broadcast?: (channel: string, ...args: unknown[]) => void,
): () => void {
  const handleGetAd = async () => {
    try {
      return responder.pairingManager.getAdvertisement();
    } catch (e: unknown) {
      console.warn('[pairing-ui] Could not obtain pairing advertisement:', e);
      return null;
    }
  };

  const handleGetVerificationCode = async () => {
    const candidate = responder.pairingManager.getCandidatePairing();
    return candidate?.verificationCode ?? null;
  };

  const handleConfirmPairing = async (_event: unknown, code: unknown, phoneHelloPubkeyB64?: unknown) => {
    if (typeof code !== 'string' || !code.trim() || code.length > 32 ||
      (phoneHelloPubkeyB64 !== undefined && (typeof phoneHelloPubkeyB64 !== 'string' || phoneHelloPubkeyB64.length > 128))) {
      return { ok: false, error: 'Invalid verification code' };
    }
    try {
      const record = await responder.confirmTrustedPhone(code.trim(), phoneHelloPubkeyB64);
      broadcast?.('responder:state-changed', { paired: true, phoneDeviceId: record.phoneDeviceId });
      return { ok: true, phoneDeviceId: record.phoneDeviceId };
    } catch (err: unknown) {
      const msg = (err as Error)?.message || 'Failed to confirm pairing';
      return { ok: false, error: msg };
    }
  };

  const handleRevokePairing = async () => {
    try {
      const prevId = await responder.revokeTrustedPhone();
      broadcast?.('responder:state-changed', { paired: false, prevPhoneDeviceId: prevId });
      return { ok: true };
    } catch (err: unknown) {
      return { ok: false, error: (err as Error)?.message || 'Revocation failed' };
    }
  };

  const handleGetStatus = async () => {
    const trusted = responder.pairingManager.getTrustedPhone();
    const candidate = responder.pairingManager.getCandidatePairing();
    return {
      paired: !!trusted,
      trustedPhoneDeviceId: trusted?.phoneDeviceId,
      hasPendingPairing: !!candidate,
      verificationCode: candidate?.verificationCode,
    };
  };

  handle('responder:get-advertisement', null, handleGetAd);
  handle('responder:get-verification-code', null, handleGetVerificationCode);
  handle('responder:confirm-pairing', { ok: false }, handleConfirmPairing);
  handle('responder:revoke-pairing', { ok: false }, handleRevokePairing);
  handle('responder:get-status', null, handleGetStatus);
  handle('responder:stop', { ok: false }, async () => {
    await localStop();
    return { ok: true };
  });

  return () => {
    ipcMain.removeHandler('responder:get-advertisement');
    ipcMain.removeHandler('responder:get-verification-code');
    ipcMain.removeHandler('responder:confirm-pairing');
    ipcMain.removeHandler('responder:revoke-pairing');
    ipcMain.removeHandler('responder:get-status');
    ipcMain.removeHandler('responder:stop');
  };
}
