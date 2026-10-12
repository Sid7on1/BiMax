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
  const legs: { key: K; leg: HedgeLeg<T>; startedAt: number }[] = [];
  const launch = (key: K, budgetMs: number) => {
    const startedAt = now();
    const leg = options.start(key, budgetMs);
    // Settled below. A loser's rejection after its abort must never surface as an unhandled rejection.
    leg.promise.catch(() => undefined);
    legs.push({ key, leg, startedAt });
  };

  const firstStart = now();
  launch(options.first, options.budgetMs);

  if (options.hedgeAfterMs > 0 && options.hedgeAfterMs < options.budgetMs) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      legs[0].leg.promise.then(() => false, () => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), options.hedgeAfterMs); }),
    ]);
    clearTimeout(timer);
    if (timedOut) {
      const backup = await options.nextKey().catch(() => null);
      if (backup !== null && backup !== undefined) {
        options.onHedge?.(backup);
        launch(backup, Math.max(1, options.budgetMs - (now() - firstStart)));
      }
    }
  }

  // The first leg to succeed wins. A leg that fails early does not end the race while another can still
  // answer. When every leg fails, the FIRST leg's error is thrown (the caller's retry path benches that
  // key) and each other leg is reported as a loser with its own error — every leg is accounted once.
  return await new Promise<HedgeOutcome<K, T>>((resolve, reject) => {
    let settled = false;
    let failures = 0;
    const errors: unknown[] = new Array(legs.length);
    legs.forEach(({ key, leg, startedAt }, index) => {
      leg.promise.then((value) => {
        if (settled) { leg.abort(); return; }
        settled = true;
        legs.forEach((other, otherIndex) => {
          if (otherIndex === index) return;
          other.leg.abort();
          options.onLoser?.(other.key, now() - other.startedAt, errors[otherIndex]);
        });
        resolve({ key, value, startedAt });
      }, (error) => {
        if (settled) return;
        errors[index] = error ?? new Error('request failed');
        failures += 1;
        if (failures < legs.length) return;
        settled = true;
        legs.forEach((other, otherIndex) => {
          if (otherIndex > 0) options.onLoser?.(other.key, now() - other.startedAt, errors[otherIndex]);
        });
        reject(errors[0]);
      });
    });
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
