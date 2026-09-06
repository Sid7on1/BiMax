/**
 * Model-order-preserving, bounded scheduling for one assistant turn's tool calls.
 *
 * The previous scheduler partitioned a turn's calls into "concurrency-safe" and "everything else",
 * ran the safe ones with an unbounded `Promise.all`, and only then ran the rest in order. That has
 * two defects deepseek-harness's scheduler does not
 * (`packages/core/agent-loop/src/tool-calls.ts`):
 *
 * 1. It reorders the model's calls. `[EditFileTool(x), ReadFileTool(x)]` ran the READ first, because
 *    reads are the concurrency-safe half — so the model read the pre-edit file and "verified" a
 *    change that had not happened yet. Any write-then-observe pair in one turn was silently
 *    evaluated backwards.
 * 2. It is unbounded. Twelve greps in one turn spawn twelve concurrent subprocesses; on a
 *    memory-constrained machine that is where the turn dies, not where it goes fast.
 *
 * dsh's model instead: walk the calls in model order, let each maximal run of concurrency-safe calls
 * overlap inside a bounded pool, and treat every exclusive call as a barrier that runs alone. Order
 * between groups is exactly the order the model asked for, so a write is never overtaken by a
 * later read.
 */

/** How a batch runs: `parallel` calls may overlap; an `exclusive` batch holds exactly one call. */
export interface ToolBatch<T> {
  kind: 'parallel' | 'exclusive';
  calls: T[];
}

/**
 * Default overlap cap. dsh defaults to 10 for a server-class host; Bimax runs on the user's laptop
 * beside an editor and a browser, and each safe call here can be a real subprocess (grep, glob,
 * a read-only bash), so the default is deliberately lower. `BIMAX_MAX_PARALLEL_TOOLS` overrides it.
 */
export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 4;

/** The configured overlap cap, floored at 1 (which restores strictly serial dispatch). */
export function maxParallelToolCalls(): number {
  const raw = Number(process.env.BIMAX_MAX_PARALLEL_TOOLS);
  if (Number.isFinite(raw) && raw >= 1) return Math.floor(raw);
  return DEFAULT_MAX_PARALLEL_TOOL_CALLS;
}

/**
 * Group calls into model-ordered batches: maximal runs of concurrency-safe calls become one
 * `parallel` batch, and every other call becomes its own `exclusive` batch (a barrier).
 *
 * @param calls the turn's tool calls, in the order the model emitted them.
 * @param isSafe whether a given call may overlap with its neighbours. Per-CALL, not per-tool: the
 *   same tool can be safe for one argument set and exclusive for another (`git status` vs `git push`).
 */
export function planToolBatches<T>(calls: T[], isSafe: (call: T) => boolean): ToolBatch<T>[] {
  const batches: ToolBatch<T>[] = [];
  for (const call of calls) {
    if (!isSafe(call)) {
      batches.push({ kind: 'exclusive', calls: [call] });
      continue;
    }
    const last = batches[batches.length - 1];
    if (last && last.kind === 'parallel') last.calls.push(call);
    else batches.push({ kind: 'parallel', calls: [call] });
  }
  return batches;
}

/**
 * Run `items` through `fn` with at most `limit` in flight, returning results in INPUT order
 * regardless of completion order. `shouldStop` is consulted before each start, so an interrupt
 * halts replenishment without abandoning the calls already running — those are drained, exactly as
 * dsh drains started dispatches on abort. Entries never started are left `undefined`, and the caller
 * answers them with an explicit stub so no tool call goes unanswered.
 */
export async function runWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  shouldStop?: () => boolean,
): Promise<Array<R | undefined>> {
  const results: Array<R | undefined> = new Array(items.length).fill(undefined);
  const bound = Math.max(1, Math.min(limit, items.length));
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (shouldStop?.()) return;
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  };

  await Promise.all(Array.from({ length: bound }, () => worker()));
  return results;
}
