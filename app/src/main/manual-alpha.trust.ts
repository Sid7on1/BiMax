import { execFile } from 'node:child_process';
import {
  currentAdHocServiceApproval,
  recordAdHocServiceApproval,
  revokeAdHocServiceApproval,
} from '../capabilities/mac/adhoc.approval.store';

/**
 * The user-visible half of Bimax's existing exact-hash development trust gate.
 *
 * A Developer ID proves provenance. An ad-hoc signature cannot do that, but it can still prove
 * that the bytes have not changed since the user approved one exact seal. The native capability
 * layer already enforces that rule; this module makes the approval inspectable and reachable from
 * the Trust Center without exposing an environment-variable escape hatch to the renderer.
 */

export interface ManualAlphaServiceStatus {
  state: 'developer-id' | 'approved-ad-hoc' | 'approval-required' | 'invalid' | 'unavailable';
  ready: boolean;
  canApprove: boolean;
  serviceVersion?: string;
  binary?: string;
  codeDirectoryHash?: string;
  signingIdentifier?: string;
  approvedHash?: string;
  approvedAt?: string;
  permissions?: { accessibility: string; screenRecording: string };
  detail: string;
}

interface HandshakeShape {
  serviceVersion?: unknown;
  permissions?: {
    serviceSigned?: unknown;
    adHocSigned?: unknown;
    signatureIntact?: unknown;
    codeDirectoryHash?: unknown;
    signingIdentifier?: unknown;
    accessibility?: unknown;
    screenRecording?: unknown;
  };
}

function runHandshake(binary: string): Promise<HandshakeShape> {
  return new Promise((resolve, reject) => {
    execFile(binary, ['--self-test-handshake'], { timeout: 3_000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || error.message || 'native service probe failed').trim()));
          return;
        }
        try { resolve(JSON.parse(stdout) as HandshakeShape); }
        catch { reject(new Error('native service returned a malformed handshake')); }
      });
  });
}

const HASH = /^[0-9a-f]{40,64}$/;

/** Read-only and non-prompting. This starts the service only in its handshake/self-test mode. */
export async function inspectManualAlphaService(binary?: string): Promise<ManualAlphaServiceStatus> {
  if (process.platform !== 'darwin' || !binary) {
    return {
      state: 'unavailable', ready: false, canApprove: false,
      detail: process.platform === 'darwin'
        ? 'The Computer Use service is not present in this build.'
        : 'Computer Use service trust is available on macOS only.',
    };
  }

  try {
    const handshake = await runHandshake(binary);
    const permissions = handshake.permissions ?? {};
    const serviceVersion = typeof handshake.serviceVersion === 'string' ? handshake.serviceVersion : undefined;
    const servicePermissions = {
      accessibility: String(permissions.accessibility || 'unknown'),
      screenRecording: String(permissions.screenRecording || 'unknown'),
    };
    const signingIdentifier = typeof permissions.signingIdentifier === 'string'
      ? permissions.signingIdentifier : undefined;
    if (permissions.serviceSigned === true && permissions.signatureIntact === true) {
      return {
        state: 'developer-id', ready: true, canApprove: false, serviceVersion, binary,
        signingIdentifier, permissions: servicePermissions,
        detail: 'The Computer Use service has an intact non-ad-hoc signing identity.',
      };
    }

    const codeDirectoryHash = typeof permissions.codeDirectoryHash === 'string'
      ? permissions.codeDirectoryHash.trim().toLowerCase()
      : '';
    const approval = currentAdHocServiceApproval();
    const base = {
      serviceVersion,
      binary,
      ...(signingIdentifier ? { signingIdentifier } : {}),
      permissions: servicePermissions,
      ...(HASH.test(codeDirectoryHash) ? { codeDirectoryHash } : {}),
      ...(approval ? {
        approvedHash: approval.codeDirectoryHash,
        approvedAt: approval.approvedAt,
      } : {}),
    };

    if (permissions.adHocSigned !== true || !HASH.test(codeDirectoryHash)) {
      return {
        ...base, state: 'invalid', ready: false, canApprove: false,
        detail: 'The service has no verifiable ad-hoc seal, so Bimax will not run it.',
      };
    }
    if (permissions.signatureIntact !== true) {
      return {
        ...base, state: 'invalid', ready: false, canApprove: false,
        detail: 'The service changed after it was sealed. Rebuild it before approving anything.',
      };
    }
    if (approval?.codeDirectoryHash.toLowerCase() === codeDirectoryHash) {
      return {
        ...base, state: 'approved-ad-hoc', ready: true, canApprove: false,
        detail: 'This exact ad-hoc-signed service is approved for local development.',
      };
    }
    return {
      ...base, state: 'approval-required', ready: false, canApprove: true,
      detail: approval
        ? 'The service changed since the last approval. Review and approve the new exact hash.'
        : 'Developer ID is unavailable. Approve this exact local build to use Computer Use.',
    };
  } catch (error) {
    return {
      state: 'unavailable', ready: false, canApprove: false, binary,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Approve only the hash the user was shown. Main probes again immediately before writing, so a
 * renderer cannot approve a different binary by racing the dialog or supplying an arbitrary hash.
 */
export async function approveManualAlphaService(
  binary: string | undefined,
  expectedHash: string,
): Promise<ManualAlphaServiceStatus> {
  const before = await inspectManualAlphaService(binary);
  const expected = expectedHash.trim().toLowerCase();
  if (!before.canApprove || !before.codeDirectoryHash || before.codeDirectoryHash !== expected) {
    return {
      ...before,
      ready: false,
      detail: 'The running service no longer matches the hash shown for approval. Refresh and review it again.',
    };
  }
  const written = recordAdHocServiceApproval({
    codeDirectoryHash: before.codeDirectoryHash,
    serviceVersion: before.serviceVersion,
    binary: before.binary,
  });
  if (!written.ok) return { ...before, detail: written.error || 'Could not record the approval.' };
  return inspectManualAlphaService(binary);
}

export async function revokeManualAlphaService(binary?: string): Promise<ManualAlphaServiceStatus> {
  const removed = revokeAdHocServiceApproval();
  if (!removed.ok) {
    const status = await inspectManualAlphaService(binary);
    return { ...status, detail: removed.error || 'Could not revoke the approval.' };
  }
  return inspectManualAlphaService(binary);
}
