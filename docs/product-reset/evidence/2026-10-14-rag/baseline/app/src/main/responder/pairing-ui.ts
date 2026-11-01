import { ipcMain } from 'electron';
import type { Responder } from 'desktop-responder';

/**
 * Exposes responder pairing and trust management to the Electron renderer via IPC.
 * Follows Bimax main-process IPC naming conventions.
 */
export function setupPairingIpc(
  responder: Responder,
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

  const handleConfirmPairing = async (_event: unknown, code: string, phoneHelloPubkeyB64?: string) => {
    if (typeof code !== 'string' || !code.trim()) {
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
      const prevId = await responder.pairingManager.revokeTrustedPhone();
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

  ipcMain.handle('responder:get-advertisement', handleGetAd);
  ipcMain.handle('responder:get-verification-code', handleGetVerificationCode);
  ipcMain.handle('responder:confirm-pairing', handleConfirmPairing);
  ipcMain.handle('responder:revoke-pairing', handleRevokePairing);
  ipcMain.handle('responder:get-status', handleGetStatus);

  return () => {
    ipcMain.removeHandler('responder:get-advertisement');
    ipcMain.removeHandler('responder:get-verification-code');
    ipcMain.removeHandler('responder:confirm-pairing');
    ipcMain.removeHandler('responder:revoke-pairing');
    ipcMain.removeHandler('responder:get-status');
  };
}
