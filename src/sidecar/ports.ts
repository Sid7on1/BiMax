/**
 * Loopback port helpers for sidecars.
 *
 * `memory/headroomProxy.ts` has its own copies of these, and they are not imported from there on
 * purpose: that module registers a process exit hook when it loads, so importing it for two pure
 * functions would attach a shutdown handler for a sidecar the caller never started. Migrating
 * headroom onto this file is a separate change with its own tests to move.
 */

import * as http from 'http';
import * as net from 'net';

/** True when nothing is listening on `port`, so it is safe to bind. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

/** An OS-assigned free ephemeral port, so two engines never race for one fixed number. */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('no ephemeral port'))));
    });
  });
}

/** GET a loopback path and report whether it answered below 400. */
export function httpGetOk(port: number, pathname: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: pathname, timeout: timeoutMs }, (response) => {
      response.resume();
      resolve((response.statusCode || 500) < 400);
    });
    request.on('error', () => resolve(false));
    request.on('timeout', () => { request.destroy(); resolve(false); });
  });
}

/** POST JSON to a loopback path and parse the reply. Rejects on transport or status failure. */
export function httpPostJson<T>(port: number, pathname: string, body: unknown, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
        timeout: timeoutMs,
        headers: { 'content-type': 'application/json', 'content-length': String(payload.length) },
      },
      (response) => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { raw += chunk; });
        response.on('end', () => {
          const status = response.statusCode || 500;
          if (status >= 400) {
            reject(new Error(`${pathname} returned ${status}: ${raw.slice(0, 300)}`));
            return;
          }
          try {
            resolve(JSON.parse(raw) as T);
          } catch {
            reject(new Error(`${pathname} returned unparseable JSON`));
          }
        });
      },
    );
    request.on('error', reject);
    request.on('timeout', () => { request.destroy(new Error(`${pathname} timed out after ${timeoutMs}ms`)); });
    request.end(payload);
  });
}

/** Poll a readiness path until it answers or the budget runs out. */
export async function waitReady(port: number, pathname: string, totalMs: number, stepMs = 500): Promise<boolean> {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    if (await httpGetOk(port, pathname, 1_000)) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}
