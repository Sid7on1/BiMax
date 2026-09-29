import OpenAI from 'openai';
import { RetryPolicy } from './circuit-breaker';

/**
 * What went wrong with a provider request, as types rather than message text (flaw list E41).
 *
 * The adapter used to recognise its OWN errors by matching their wording: a stalled stream was an `Error` whose
 * message said "sent no first token", and the key pool benched the key only when a regex found that phrase. Reword
 * the message and the key stops being benched, with no test or type to notice. Errors the adapter raises are now
 * classes carrying the facts as fields; their messages are unchanged, word for word, because people and logs read them.
 *
 * Errors raised by others (the OpenAI SDK, Node's network stack, providers' bodies) are classified by their types and
 * codes first. Text is read only where the source offers nothing else, and each such place says so.
 */

/** Which part of a response never arrived. */
export type StallPhase = 'response headers' | 'first token' | 'mid-stream';

/**
 * A provider stopped answering: no response headers, no first token, or a gap mid-stream longer than the budget.
 * Raised by the adapter's own watchdogs, never by the SDK.
 */
export class ProviderStallError extends Error {
  override readonly name = 'ProviderStallError';

  constructor(
    readonly model: string,
    readonly phase: StallPhase,
    readonly waitedMs: number,
    options?: { cause?: unknown },
  ) {
    const secs = Math.round(waitedMs / 1000);
    super(phase === 'response headers'
      ? `LLM stream timeout: model '${model}' sent no response headers for ${secs}s — benching this key and rotating (run /perf for network-path evidence)`
      : `LLM stream timeout: model '${model}' sent no ${phase} for ${secs}s — not a tool error (run /perf for network-path evidence)`,
    options);
  }

  /**
   * True when the provider is holding THIS KEY's request in its queue (nothing at all came back), so the key should be
   * benched and the retry rotated. A gap after the answer had started is the stream's fault, not the key's.
   */
  get keyIsHeld(): boolean {
    return this.phase !== 'mid-stream';
  }
}

/** The SDK gave up waiting for a connection or for headers within the `timeout` the adapter passed it. */
export function isRequestTimeout(e: unknown): boolean {
  const err = e as { name?: unknown; code?: unknown } | null;
  return e instanceof OpenAI.APIConnectionTimeoutError
    || err?.name === 'APIConnectionTimeoutError'
    || err?.name === 'TimeoutError' // AbortSignal.timeout()
    || err?.code === 'ECONNABORTED';
}

/** The person stopped the turn (Esc, a new task): no provider did anything wrong. */
export function isUserAbort(e: unknown, signal?: { aborted?: boolean } | null): boolean {
  if (signal?.aborted) return true;
  const err = e as { name?: unknown } | null;
  return err?.name === 'AbortError' || e instanceof OpenAI.APIUserAbortError;
}

const LOCAL_NETWORK_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
]);

/**
 * A failure that happened on THIS machine's network path — DNS refused to resolve, the socket never connected, or it
 * reset before the provider said anything. The provider never saw the request, so the API key must not be blamed:
 * cooling/benching the key for a local blip is how one DNS hiccup snowballed into "all keys cooling down" minutes
 * (observed live on a 1-key pool, and this Mac's DNS genuinely drops out intermittently). These report as status 0,
 * which the key manager treats as neutral.
 *
 * Codes first. The message is read only for the few failures undici and Node report without a code (a resolver's
 * "getaddrinfo …" wrapped by a library, "socket hang up", "other side closed").
 */
export function isLocalNetworkError(e: any): boolean {
  for (let err = e; err; err = err.cause) {
    if (err?.code && LOCAL_NETWORK_CODES.has(String(err.code))) return true;
    if (/getaddrinfo|nodename nor servname|socket hang up|other side closed/i.test(String(err?.message || ''))) return true;
  }
  // OpenAI SDK connection errors with no HTTP status = the request never reached the API.
  return e instanceof OpenAI.APIConnectionError && !(e instanceof OpenAI.APIConnectionTimeoutError) && e?.status == null;
}

/**
 * The status a failed request counts as for the key pool: a local network failure → 0 (neutral — never bills the key),
 * a timeout or stall → 408, otherwise the API-reported status, else 500.
 */
export function errorStatus(e: any): number {
  if (isLocalNetworkError(e)) return 0;
  if (e instanceof ProviderStallError || isRequestTimeout(e)) return 408;
  // Text only as the last resort: some OpenAI-compatible servers answer a timeout with a body and no status.
  if (/timeout/i.test(String(e?.message || ''))) return 408;
  return e?.status || 500;
}

/** The provider's Retry-After in seconds, when it sent one. */
export function retryAfterSecs(e: any): number | null {
  const raw = e?.headers?.['retry-after'];
  if (raw == null) return null;
  const secs = parseFloat(String(raw));
  return Number.isFinite(secs) ? secs : null;
}

// Provider-fault classification for the LLM circuit breaker. The per-key ApiKeyManager already
// rotates and cools individual keys; the breaker sits ABOVE that to catch a whole-provider outage,
// where every rotated key fails and the agent loop would otherwise hot-retry chat() with no pause.
const LLM_RETRY_POLICY = RetryPolicy.server(); // 429 + any 5xx are transient provider faults
export function isProviderFault(status: number | null | undefined): boolean {
  // No status = a timeout / dropped stream (a provider fault for outage purposes); 408 likewise.
  if (status == null || status === 0 || status === 408) return true;
  return LLM_RETRY_POLICY.shouldRetry(status);
}
