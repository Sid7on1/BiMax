import { Logger } from '../utils/logger';
import { engineEvents } from '../engine/events';
import { waitWithSignal, withRequestDeadline } from '../utils/request.deadline';

/**
 * MCP Tasks extension support (spec 2025-11-25, carried into the 2026-07-28 RC): a server may
 * answer tools/call with a TASK reference instead of an inline result — long-running work
 * (builds, deploys, big queries) then runs server-side while the client polls. Without this,
 * a task-shaped response would surface as a useless JSON blob and the actual result would be
 * lost. With it, BiMax polls `tasks/get` (backing off 500ms → 5s), streams status lines to the
 * footer, and fetches `tasks/result` when the task completes — inside the tool call's normal
 * timeout budget, so the agent loop and governor see an ordinary (just slower) tool call.
 *
 * Defensive by design: servers in the wild disagree on the envelope, so the task reference is
 * accepted both as `result.task.taskId` (spec shape) and the `_meta` fallback some SDKs emit.
 */

// zod ships with the MCP SDK; a passthrough schema lets us use client.request() without
// re-declaring the (still-evolving) task result shapes.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { z } = require('zod');
const PASSTHROUGH = z.object({}).passthrough();

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export interface TaskRef {
  taskId: string;
  status?: string;
}

/** Pull a task reference out of a tools/call result, or null for ordinary inline results. */
export function extractTaskRef(res: any): TaskRef | null {
  const t = res?.task;
  if (t && typeof t.taskId === 'string' && t.taskId) {
    return { taskId: t.taskId, status: typeof t.status === 'string' ? t.status : undefined };
  }
  const meta = res?._meta?.['io.modelcontextprotocol/task'];
  if (meta && typeof meta.taskId === 'string' && meta.taskId) {
    return { taskId: meta.taskId, status: typeof meta.status === 'string' ? meta.status : undefined };
  }
  return null;
}

/**
 * Poll a task to a terminal state and return its result payload (the same shape a synchronous
 * tools/call would have returned). Throws on failure/cancellation/timeout — the caller's normal
 * error path then applies.
 */
export async function awaitTaskResult(
  client: any,
  serverName: string,
  toolName: string,
  ref: TaskRef,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<any> {
  let delay = 500;
  let status = ref.status || 'working';
  let statusMessage = '';
  const timeoutError = () =>
    new Error(
      `MCP task ${ref.taskId} (${serverName}/${toolName}) did not finish within ${Math.round(timeoutMs / 1000)}s (last status: ${status}).`,
    );
  // Stop is also sent to the server, once and without waiting for an acknowledgement.
  // A cancelled local wait cannot establish that a remote side effect was undone.
  const cancelRemote = () => {
    try {
      Promise.resolve(
        client.request({ method: 'tasks/cancel', params: { taskId: ref.taskId } }, PASSTHROUGH, { timeout: 1000 }),
      ).catch(() => {
        /* cancellation is best-effort */
      });
    } catch {
      /* a closed transport cannot acknowledge cancellation */
    }
  };
  signal?.addEventListener('abort', cancelRemote, { once: true });
  if (signal?.aborted) cancelRemote();
  try {
    return await withRequestDeadline(timeoutMs, signal, timeoutError, async (requestSignal, remainingMs) => {
      const request = (method: string) =>
        client.request({ method, params: { taskId: ref.taskId } }, PASSTHROUGH, {
          signal: requestSignal,
          timeout: remainingMs(),
        });
      while (!TERMINAL.has(status)) {
        if (status === 'input_required') {
          // Server-side elicitation mid-task — nothing an autonomous poll can answer.
          throw new Error(
            `MCP task ${ref.taskId} (${serverName}/${toolName}) needs additional input (status: input_required)` +
              `${statusMessage ? ` — ${statusMessage}` : ''}. Re-run the tool with the missing information supplied up front.`,
          );
        }
        await waitWithSignal(Math.min(delay, remainingMs()), requestSignal);
        remainingMs();
        delay = Math.min(delay * 1.5, 5000);

        const got = await request('tasks/get');
        remainingMs();
        const t = got?.task ?? got ?? {};
        status = String(t.status || 'working');
        statusMessage = typeof t.statusMessage === 'string' ? t.statusMessage : '';
        try {
          engineEvents.emit(
            'status',
            `MCP task ${serverName}/${toolName}: ${status}${statusMessage ? ` — ${statusMessage.slice(0, 80)}` : ''}`,
          );
        } catch {
          /* UI is best-effort */
        }
      }

      if (status !== 'completed') {
        throw new Error(
          `MCP task ${ref.taskId} (${serverName}/${toolName}) ended ${status}${statusMessage ? `: ${statusMessage}` : ''}.`,
        );
      }

      Logger.info(`[MCP] Task ${ref.taskId} (${serverName}/${toolName}) completed; fetching result.`);
      const result = await request('tasks/result');
      remainingMs();
      // Some servers nest the tool result under `result`, some return it directly.
      return result?.result ?? result;
    });
  } finally {
    signal?.removeEventListener('abort', cancelRemote);
  }
}
