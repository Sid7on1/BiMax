import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const MAX_REPLY_BYTES = 2 * 1024 * 1024;

export interface NativeControlRouteStatus {
  connected: boolean;
  bridge?: string;
  serviceVersion?: string;
  signingIdentifier?: string;
  codeDirectoryHash?: string;
  signatureIntact?: boolean;
  permissions?: { accessibility: string; screenRecording: string };
  detail: string;
}

/** Probe the same bridge -> XPC route that the packaged provider uses. */
export function inspectNativeControlRoute(
  bridge?: string,
  timeoutMs = 3_000,
): Promise<NativeControlRouteStatus> {
  if (process.platform !== 'darwin' || !bridge || !existsSync(bridge)) {
    return Promise.resolve({
      connected: false,
      ...(bridge ? { bridge } : {}),
      detail: process.platform === 'darwin'
        ? 'The packaged Computer Use bridge is unavailable.'
        : 'The native Computer Use route is available on macOS only.',
    });
  }

  return new Promise((resolve) => {
    const requestId = randomUUID();
    const request = JSON.stringify({
      protocol: 'bimax.cu.v1',
      requestId,
      sessionId: 'trust-center-probe',
      deadlineMs: Math.min(2_000, timeoutMs),
      body: {
        op: 'handshake',
        payload: { clientVersion: 'bimax-desktop-trust-center', supportedProtocols: ['bimax.cu.v1'] },
      },
    });
    const child = spawn(bridge, ['--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH || '',
        HOME: process.env.HOME || '',
        TMPDIR: process.env.TMPDIR || '',
      },
    });
    let settled = false;
    let stdout = Buffer.alloc(0);
    let stderr = '';
    const finish = (status: NativeControlRouteStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null) child.kill();
      resolve(status);
    };
    const timer = setTimeout(() => finish({
      connected: false,
      bridge,
      detail: 'The bridge could not complete its XPC handshake before the readiness deadline.',
    }), timeoutMs);

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-2_048); });
    child.once('error', (error) => finish({ connected: false, bridge, detail: error.message }));
    child.once('exit', (code) => {
      if (!settled) finish({
        connected: false,
        bridge,
        detail: stderr.trim() || `The Computer Use bridge exited before its XPC handshake (code ${code}).`,
      });
    });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length > MAX_REPLY_BYTES) {
        finish({ connected: false, bridge, detail: 'The Computer Use bridge returned an oversized handshake.' });
        return;
      }
      const newline = stdout.indexOf(0x0a);
      if (newline < 0) return;
      try {
        const frame = JSON.parse(stdout.subarray(0, newline).toString('utf8')) as any;
        if (frame?.requestId !== requestId) throw new Error('bridge handshake correlation failed');
        if (frame?.error) throw new Error(String(frame.error.message || frame.error.code || 'bridge failed'));
        const response = frame?.response;
        const handshake = response?.body?.op === 'handshake' ? response.body.payload : undefined;
        if (response?.protocol !== 'bimax.cu.v1'
          || response?.requestId !== requestId
          || response?.sessionId !== 'trust-center-probe'
          || handshake?.selectedProtocol !== 'bimax.cu.v1') {
          throw new Error('the bridge did not return a valid XPC service handshake');
        }
        const permissions = handshake.permissions || {};
        finish({
          connected: true,
          bridge,
          serviceVersion: typeof handshake.serviceVersion === 'string' ? handshake.serviceVersion : undefined,
          signingIdentifier: typeof permissions.signingIdentifier === 'string'
            ? permissions.signingIdentifier : undefined,
          codeDirectoryHash: typeof permissions.codeDirectoryHash === 'string'
            ? permissions.codeDirectoryHash.toLowerCase() : undefined,
          signatureIntact: permissions.signatureIntact === true,
          permissions: {
            accessibility: String(permissions.accessibility || 'unknown'),
            screenRecording: String(permissions.screenRecording || 'unknown'),
          },
          detail: 'The packaged bridge reached the Bimax XPC Computer Use service.',
        });
      } catch (error) {
        finish({
          connected: false,
          bridge,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    });
    child.stdin.end(`${request}\n`, 'utf8');
  });
}

export function assessNativeControlRoute(
  service: {
    ready: boolean;
    detail: string;
    codeDirectoryHash?: string;
    permissions?: { accessibility: string; screenRecording: string };
  },
  route: NativeControlRouteStatus,
): { ready: boolean; detail: string } {
  if (!route.connected) return { ready: false, detail: route.detail };
  if (!service.ready) return { ready: false, detail: service.detail };
  if (route.signatureIntact !== true) {
    return { ready: false, detail: 'The XPC service reached through the bridge has an invalid code signature.' };
  }
  if (route.signingIdentifier !== 'ai.bimax.cu.service') {
    return { ready: false, detail: 'The bridge reached a native process with the wrong signing identity.' };
  }
  if (service.codeDirectoryHash && route.codeDirectoryHash !== service.codeDirectoryHash.toLowerCase()) {
    return { ready: false, detail: 'The bridge reached a different XPC service than the one shown for approval.' };
  }
  const permissions = route.permissions || service.permissions;
  if (permissions?.accessibility !== 'granted' || permissions?.screenRecording !== 'granted') {
    return {
      ready: false,
      detail: 'The XPC Computer Use service still needs its own Accessibility and Screen Recording grants.',
    };
  }
  return { ready: true, detail: route.detail };
}
