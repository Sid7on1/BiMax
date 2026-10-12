/** Backoff that releases both its timer and abort listener on every exit. */
export function waitWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** One deadline and cancellation signal across an operation's requests and backoff. */
export async function withRequestDeadline<T>(
  timeoutMs: number,
  parent: AbortSignal | undefined,
  timeoutError: () => Error,
  operation: (signal: AbortSignal, remainingMs: () => number) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  const stop = () => controller.abort(parent?.reason ?? new Error('Operation cancelled.'));
  const timer = setTimeout(() => controller.abort(timeoutError()), Math.max(0, timeoutMs));
  parent?.addEventListener('abort', stop, { once: true });
  if (parent?.aborted) stop();
  let rejectAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
    if (controller.signal.aborted) rejectAbort();
  });
  const remainingMs = () => {
    controller.signal.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      controller.abort(timeoutError());
      controller.signal.throwIfAborted();
    }
    return remaining;
  };
  try {
    // Defer invocation so a synchronous exception follows the same cleanup path.
    return await Promise.race([
      Promise.resolve().then(() => {
        remainingMs();
        return operation(controller.signal, remainingMs);
      }),
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', stop);
    controller.signal.removeEventListener('abort', rejectAbort);
  }
}
