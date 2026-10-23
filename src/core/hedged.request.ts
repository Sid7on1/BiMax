/**
 * A request that sends one backup copy on a second API key when the first has not answered in time,
 * and keeps whichever answers first.
 *
 * Why: NVIDIA's hosted endpoint holds the RESPONSE HEADERS while it queues a request, and the queue is
 * per request, not per key. Measured 2026-09-29 on the owner's five keys: fired together, four held their
 * headers past 60 s while one answered at 14.7 s; minutes later the same five answered in 0.4 s. A normal
 * grant takes ~0.4 s for "hi" and ~1.1 s for a 28,587-token prompt. Waiting out a held request cost a turn
 * 45 s (the app's first-token budget) before the retry even started — "hi" took 46 s in the app.
 *
 * Cutting the header wait short instead would kill heavy models that legitimately queue for minutes, so
 * the first request is never abandoned; the backup only races it. One backup at most, so a stall costs at
 * most one extra request.
 */

export interface HedgeLeg<T> {
  promise: Promise<T>;
  /** Cancel this leg's request. Called on the loser once the other leg has answered. */
  abort(): void;
}

export interface HedgeOutcome<K, T> {
  key: K;
  value: T;
  /** When the winning leg was sent (ms epoch) — its own latency starts here, not at the first leg. */
  startedAt: number;
}

export interface HedgeOptions<K, T> {
  first: K;
  /** Caller cancellation bounds key lookup and every launched header request. */
  signal?: AbortSignal;
  /** Send the request on `key`; `budgetMs` is what is left of the overall header deadline. */
  start: (key: K, budgetMs: number) => HedgeLeg<T>;
  /** Overall header deadline for the first leg; the backup gets whatever remains of it. */
  budgetMs: number;
  /** Send the backup after this long with no answer. 0 or less disables hedging. */
  hedgeAfterMs: number;
  /** A different key usable right now, or null when there is none — then the first leg is simply awaited. */
  nextKey: () => Promise<K | null>;
  onHedge?: (backup: K) => void;
  /** The leg that did not win: aborted after the other answered (`error` undefined), or failed. */
  onLoser?: (key: K, waitedMs: number, error?: unknown) => void;
  now?: () => number;
}

export async function hedgedRequest<K, T>(options: HedgeOptions<K, T>): Promise<HedgeOutcome<K, T>> {
  const now = options.now ?? Date.now;
  const firstStart = now();
  const deadline = firstStart + options.budgetMs;
  return new Promise<HedgeOutcome<K, T>>((resolve, reject) => {
    let settled = false;
    let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
    const deadlineTimer = setTimeout(() => expire(), Math.max(0, options.budgetMs));
    const legs: { key: K; leg?: HedgeLeg<T>; startedAt: number; failed: boolean; error?: unknown; aborted: boolean }[] = [];
    // Cleanup and telemetry are advisory: neither may strand an otherwise completed request.
    const safely = (action: () => void) => { try { action(); } catch { /* preserve request outcome */ } };
    const abortLeg = (entry: typeof legs[number]) => {
      if (!entry.leg || entry.aborted) return;
      entry.aborted = true;
      safely(() => entry.leg?.abort());
    };
    const cleanup = () => {
      clearTimeout(hedgeTimer);
      clearTimeout(deadlineTimer);
      options.signal?.removeEventListener('abort', stop);
    };
    const fail = (error: unknown, accountBackups: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      legs.forEach((entry, index) => {
        abortLeg(entry);
        if (accountBackups && index > 0) safely(() => options.onLoser?.(entry.key, now() - entry.startedAt, entry.error ?? error));
      });
      reject(error);
    };
    const stop = () => fail(options.signal?.reason, false);
    const expire = () => fail(Object.assign(new Error('Request timeout waiting for response headers.'), { name: 'APIConnectionTimeoutError' }), true);
    const launch = (key: K) => {
      if (settled) return;
      if (options.signal?.aborted) { stop(); return; }
      const budgetMs = deadline - now();
      if (budgetMs <= 0) { expire(); return; }
      const entry: typeof legs[number] = { key, startedAt: now(), failed: false, aborted: false };
      legs.push(entry);
      const failed = (error: unknown) => {
        if (settled) return;
        if (options.signal?.aborted) { stop(); return; }
        if (now() >= deadline) { expire(); return; }
        entry.failed = true;
        entry.error = error ?? new Error('request failed');
        if (legs.every(candidate => candidate.failed)) fail(legs[0].error, true);
      };
      try { entry.leg = options.start(key, budgetMs); }
      catch (error) { failed(error); return; }
      if (settled) abortLeg(entry);
      entry.leg.promise.then(value => {
        if (settled) { abortLeg(entry); return; }
        if (options.signal?.aborted) { stop(); return; }
        if (now() >= deadline) { expire(); return; }
        settled = true;
        cleanup();
        legs.forEach(other => {
          if (other === entry) return;
          abortLeg(other);
          safely(() => options.onLoser?.(other.key, now() - other.startedAt, other.error));
        });
        resolve({ key, value, startedAt: entry.startedAt });
      }, failed);
    };
    options.signal?.addEventListener('abort', stop, { once: true });
    if (options.signal?.aborted) { stop(); return; }
    launch(options.first);
    if (!settled && options.hedgeAfterMs > 0 && options.hedgeAfterMs < options.budgetMs) {
      hedgeTimer = setTimeout(() => {
        // Key discovery races the primary instead of holding its response hostage. A late key
        // cannot launch after success, Stop or the original deadline.
        Promise.resolve().then(() => settled ? null : options.nextKey()).then(backup => {
          if (settled || backup === null || backup === undefined) return;
          if (options.signal?.aborted) { stop(); return; }
          if (now() >= deadline) { expire(); return; }
          safely(() => options.onHedge?.(backup));
          launch(backup);
        }).catch(() => { /* no backup available; primary remains bounded by the deadline */ });
      }, options.hedgeAfterMs);
    }
  });
}

/** True for a server on this Mac (Ollama, LM Studio, a local proxy). No base URL means a provider's hosted default. */
export function isLoopbackEndpoint(baseURL: string | null | undefined): boolean {
  if (!baseURL) return false;
  try {
    const host = new URL(baseURL).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || /^127\./.test(host);
  } catch {
    return false;
  }
}
