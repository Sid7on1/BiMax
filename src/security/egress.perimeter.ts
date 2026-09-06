/**
 * The process-wide egress perimeter — the guard moved BENEATH the code it governs.
 *
 * ## Why this exists
 *
 * `egress.guard.ts` is a good choke point that almost nothing went through. A census of its callers
 * found two — the LLM adapter and the network-consent path used by WebFetch and WebSearch — while
 * sixteen other modules opened sockets directly: a full Puppeteer browser, the remote embedding and
 * rerank backends, the MCP client, Octokit, self-update, three telemetry exporters. An opt-in choke
 * point is only ever as good as the discipline of the next person to add a module, and "nothing left
 * the premises" is not a claim that can rest on discipline.
 *
 * So the guard moves down a layer. Every outbound primitive Node offers is wrapped once, at boot,
 * and a module that never heard of the guard is governed anyway. Forgetting to call it is no longer
 * possible, because there is nothing left to forget.
 *
 * ## Why every layer checks, and only the outer layer records
 *
 * One `fetch()` becomes an `https.request`, which becomes a `net.connect`, which becomes a
 * `dns.lookup`. Checking all four is what makes the perimeter airtight — a caller that skips the
 * high-level API and opens a socket directly is still caught at the socket. But RECORDING all four
 * would turn one request into four ledger lines and make the headline count ("142 attempts · 0
 * external") meaningless.
 *
 * So the outermost layer to see a given host records it, and the layers underneath verify without
 * recording, using a short host-scoped window. The verdict is computed and enforced identically at
 * every layer; only the bookkeeping is deduplicated. That ordering matters: if the window ever
 * misfires the failure is a DUPLICATE LEDGER LINE, never an unguarded connection.
 *
 * ## What this deliberately does not do
 *
 * It does not stop a child process. `curl` in a subprocess has its own network stack and cannot be
 * reached from here — that is the sandbox's job, and sovereign mode turns the sandbox on with the
 * network-denying profile for exactly this reason (see `sandbox/exec.sandbox.ts`). Naming the limit
 * is the point: a perimeter that quietly claimed to cover subprocesses would be the same species of
 * overstatement this module exists to remove.
 */

import { assertEgressAllowed } from './egress.guard';
import { hostOf } from './sovereign';

/**
 * The LIVE module exports, not an `import * as` namespace.
 *
 * TypeScript compiles `import * as http` into a namespace object whose properties are getters onto
 * the real exports. Assigning to that copy throws ("Cannot set property request of #<Object> which
 * has only a getter"), and even where it did not, every other module holds its own copy. Patching
 * the object `require` returns is what every namespace view then reads through — one patch, seen
 * everywhere, which is the whole point of a perimeter.
 */
// oslint-disable-next-line @typescript-eslint/no-require-imports -- the live exports object is the patch target
const nodeRequire = require;
const dnsModule = nodeRequire('dns') as typeof import('dns');
const httpModule = nodeRequire('http') as typeof import('http');
const httpsModule = nodeRequire('https') as typeof import('https');
const netModule = nodeRequire('net') as typeof import('net');
const tlsModule = nodeRequire('tls') as typeof import('tls');

/** Marker set on a patched function so a second install is a no-op rather than a double wrap. */
const PATCHED = Symbol('bimax.egress.patched');

interface Patchable {
  [PATCHED]?: true;
}

let installed = false;
/** Every undo closure recorded at install time, applied in reverse by {@link uninstallEgressPerimeter}. */
const undo: Array<() => void> = [];

/**
 * Hosts recently recorded, with the timestamp of the record. A nested layer that sees a host still
 * in the window verifies but does not record.
 *
 * A time window rather than async-context propagation is a deliberate trade. `AsyncLocalStorage`
 * would be exact for a single request, but undici pools and reuses connections, so the socket for
 * request N is frequently opened inside the async context of request N-1 — the exactness is an
 * illusion and the failure mode is a MISSING record, which is the wrong direction for an audit. A
 * window is approximate in the safe direction: at worst it merges two genuinely separate requests to
 * one host into one line, and the ledger's own summary counts hosts as well as attempts.
 */
const recentlyRecorded = new Map<string, number>();
const DEDUPE_WINDOW_MS = 250;

/** Should this layer write a ledger entry, or has an outer layer already recorded this host? */
function shouldRecord(host: string): boolean {
  const now = Date.now();
  // Bounded: a long session must not accumulate a map entry per host contacted.
  if (recentlyRecorded.size > 512) {
    for (const [key, at] of recentlyRecorded) {
      if (now - at > DEDUPE_WINDOW_MS) recentlyRecorded.delete(key);
    }
  }
  const last = recentlyRecorded.get(host);
  recentlyRecorded.set(host, now);
  return last === undefined || now - last > DEDUPE_WINDOW_MS;
}

/**
 * The module that actually wanted this connection, read off the stack.
 *
 * Without it every ledger line would read `subsystem: "fetch"`, which answers "how did it leave?"
 * and not "who sent it?" — and the second question is the one an audit asks. The first frame under
 * `src/` that is not this file or the guard is the answer; the layer name is the fallback for a
 * connection opened entirely from inside a dependency.
 */
function callingSubsystem(fallback: string): string {
  const previousLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = 24;
  const stack = new Error().stack ?? '';
  Error.stackTraceLimit = previousLimit;

  const frames = stack.split('\n').slice(2);

  // Preferred: a source path. Present when running from `src/` (tests, ts-node) or the compiled
  // `dist/` layout, and it names the module directly.
  for (const line of frames) {
    const match = /(?:src|dist)[/\\]((?:[\w.-]+[/\\])*[\w.-]+)\.(?:ts|js|mjs|cjs)/.exec(line);
    if (!match) continue;
    const module = match[1].replace(/[/\\]/g, '/');
    if (module.startsWith('security/egress.')) continue;
    return module;
  }

  // Fallback: the calling FUNCTION's name.
  //
  // The packaged engine is a bun single-file executable, which bundles every module into one
  // synthetic file — so no frame carries a `src/` path and the path scan above finds nothing. That
  // is not a rare edge: it is how the shipped product always runs, and it made every ledger line in
  // a real session read `subsystem: "fetch"`, which answers "how did it leave?" and not "who sent
  // it?". A function name is less precise than a module path but it is a real answer, and the
  // ledger is the artefact an audit reads.
  for (const line of frames) {
    const match = /^\s*at\s+(?:async\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s/.exec(line);
    if (!match) continue;
    const name = match[1];
    // Our own wrappers, and the anonymous/native frames that carry no information.
    if (/^(patched|guard|callingSubsystem|assertEgressAllowed|checkEgress|Object|Module|process|new Promise)$/.test(name)) continue;
    if (name.startsWith('patched')) continue;
    return name;
  }
  return fallback;
}

/**
 * Verify one destination, attributing it to its calling module and recording it once per request.
 *
 * The record-once key is the HOST, never the raw target. One logical request reaches the perimeter
 * spelled differently at each layer — `net.connect` sees `example.com:443` and the `dns.lookup`
 * underneath it sees `example.com` — and keying on the spelling would put both in the ledger and
 * defeat the deduplication entirely.
 */
function guard(target: string, layer: string): void {
  if (!target) return;
  assertEgressAllowed(
    { target, subsystem: callingSubsystem(layer), purpose: `via ${layer}` },
    { record: shouldRecord(hostOf(target) || target) },
  );
}

/**
 * The destination an `http.request`/`net.connect`-style options object names, or null when the
 * call is not network egress at all.
 *
 * Returning null for a Unix domain socket is load-bearing, not a shortcut: `dockerode` talks to
 * `/var/run/docker.sock` and MCP transports use local sockets. Those never leave the machine, and a
 * guard that treated a filesystem path as an unresolvable hostname would classify it `external` and
 * break local tooling the moment sovereign mode came on.
 */
function targetFromOptions(options: unknown): string | null {
  if (!options || typeof options !== 'object') return null;
  const o = options as Record<string, unknown>;
  if (typeof o.socketPath === 'string' && o.socketPath) return null; // IPC, not a network hop
  if (typeof o.path === 'string' && o.path.startsWith('/') && o.host === undefined && o.hostname === undefined
    && o.port === undefined) return null;                            // net.connect({ path })

  const host = typeof o.hostname === 'string' && o.hostname ? o.hostname
    : typeof o.host === 'string' && o.host ? o.host
    : undefined;
  const port = typeof o.port === 'number' || typeof o.port === 'string' ? String(o.port) : undefined;
  // Node defaults a missing host to localhost; classifying it as an empty (therefore external)
  // target would refuse every connection to a local model server.
  if (!host) return port ? `localhost:${port}` : null;
  return port ? `${host}:${port}` : host;
}

/** The destination named by the (url | options) first argument of `http.request` / `https.request`. */
function targetFromRequestArgs(args: unknown[]): string | null {
  const first = args[0];
  if (typeof first === 'string') return first;
  if (first instanceof URL) return first.href;
  // `request(url, options, cb)` — the options object may still carry the port.
  return targetFromOptions(first);
}

/** The destination named by `net.connect` / `tls.connect`, across all three overloads. */
function targetFromConnectArgs(args: unknown[]): string | null {
  const first = args[0];
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    const host = typeof args[1] === 'string' ? args[1] : 'localhost';
    return `${host}:${first}`;
  }
  if (typeof first === 'string') return null; // connect(path) — IPC
  return targetFromOptions(first);
}

/** Names of primitives this process could not wrap, for {@link unpatchableEgressSurfaces}. */
const unpatchable: string[] = [];

/**
 * Replace `owner[key]` with `make(original)`, unless it is already patched. Records the undo.
 *
 * `Object.defineProperty` rather than assignment because several Node exports are accessor
 * properties, and a plain assignment throws on those. A property that genuinely cannot be
 * redefined is RECORDED rather than swallowed — a perimeter with a silent hole is worse than one
 * that says where its hole is, and `/sovereign status` prints the list.
 */
function patch<T extends object, K extends keyof T & string>(owner: T, key: K, make: (original: T[K]) => T[K]): void {
  const original = owner[key];
  if (typeof original !== 'function') return;
  if ((original as Patchable)[PATCHED]) return;
  const replacement = make(original) as T[K] & Patchable;
  replacement[PATCHED] = true;
  try {
    Object.defineProperty(owner, key, {
      value: replacement, writable: true, configurable: true, enumerable: true,
    });
  } catch {
    unpatchable.push(key);
    return;
  }
  undo.push(() => {
    Object.defineProperty(owner, key, {
      value: original, writable: true, configurable: true, enumerable: true,
    });
  });
}

/**
 * Primitives the perimeter could not wrap in this process. Empty is the expected answer; a
 * non-empty list is a hole an operator must be told about rather than left to discover.
 */
export function unpatchableEgressSurfaces(): readonly string[] {
  return unpatchable;
}

/**
 * Install the perimeter. Idempotent, and safe to call from every entrypoint.
 *
 * Refusals throw synchronously. For `fetch` that surfaces as a rejected promise; for the lower-level
 * primitives it is a synchronous throw where the caller would normally get an async `error` event.
 * That asymmetry is intentional: a refusal is a policy decision, not a network failure, and it
 * should be loud and immediate rather than indistinguishable from a timeout. It can only happen in
 * sovereign mode, to an external host.
 */
export function installEgressPerimeter(): void {
  if (installed) return;
  installed = true;

  // `async` so a refusal REJECTS rather than throwing synchronously. Every caller of `fetch` awaits
  // it or attaches `.catch`; a synchronous throw would escape those handlers and unwind the turn.
  // The lower-level primitives keep the synchronous throw, because there the caller's alternative
  // is an async `error` event that is indistinguishable from a timeout.
  patch(globalThis as typeof globalThis & { fetch: typeof fetch }, 'fetch', original =>
    async function patchedFetch(this: unknown, input: unknown, init?: unknown) {
      const target = typeof input === 'string' ? input
        : input instanceof URL ? input.href
        : typeof (input as { url?: unknown })?.url === 'string' ? (input as { url: string }).url
        : '';
      guard(target, 'fetch');
      return (original as typeof fetch).call(this as never, input as never, init as never);
    } as typeof fetch);

  for (const [mod, layer] of [[httpModule, 'http.request'], [httpsModule, 'https.request']] as const) {
    for (const key of ['request', 'get'] as const) {
      patch(mod as unknown as Record<string, unknown>, key, original =>
        function patchedRequest(this: unknown, ...args: unknown[]) {
          const target = targetFromRequestArgs(args);
          if (target) guard(target, layer);
          return (original as (...a: unknown[]) => unknown).apply(this, args);
        });
    }
  }

  for (const key of ['connect', 'createConnection'] as const) {
    patch(netModule as unknown as Record<string, unknown>, key, original =>
      function patchedConnect(this: unknown, ...args: unknown[]) {
        const target = targetFromConnectArgs(args);
        if (target) guard(target, 'net.connect');
        return (original as (...a: unknown[]) => unknown).apply(this, args);
      });
  }

  patch(tlsModule as unknown as Record<string, unknown>, 'connect', original =>
    function patchedTlsConnect(this: unknown, ...args: unknown[]) {
      const target = targetFromConnectArgs(args);
      if (target) guard(target, 'tls.connect');
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    });

  // A name lookup is itself egress — it hands the hostname to whoever runs the resolver, which on an
  // air-gapped site is the exact leak sovereign mode exists to prevent. `telemetry/netprobe.ts` did
  // precisely this to the provider origin on every stalled turn.
  const dnsMethods = ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname',
    'resolveMx', 'resolveNs', 'resolveTxt', 'resolveSrv'] as const;
  for (const key of dnsMethods) {
    patch(dnsModule as unknown as Record<string, unknown>, key, original =>
      function patchedDns(this: unknown, ...args: unknown[]) {
        if (typeof args[0] === 'string') guard(args[0], `dns.${key}`);
        return (original as (...a: unknown[]) => unknown).apply(this, args);
      });
    patch(dnsModule.promises as unknown as Record<string, unknown>, key, original =>
      function patchedDnsPromise(this: unknown, ...args: unknown[]) {
        if (typeof args[0] === 'string') guard(args[0], `dns.promises.${key}`);
        return (original as (...a: unknown[]) => unknown).apply(this, args);
      });
  }
}

/** Test seam and `/sovereign` diagnostics: is the perimeter live in this process? */
export function isEgressPerimeterInstalled(): boolean {
  return installed;
}

/** Test seam. Restores every primitive in reverse install order. */
export function uninstallEgressPerimeter(): void {
  while (undo.length > 0) undo.pop()!();
  recentlyRecorded.clear();
  unpatchable.length = 0;
  installed = false;
}

/** Test seam: forget the record-once window without uninstalling. */
export function _resetPerimeterDedupeForTests(): void {
  recentlyRecorded.clear();
}
