import { isMainThread, workerData, type MessagePort } from 'node:worker_threads';
import type { EngineWorkerData, EmbeddedToolSpec } from '../engine/api';
import type { IGovernor } from '../core/interfaces';
import { buildTool } from './tool.factory';
import type { ToolRegistry } from './tool.registry';

/** Generic internal host client. Terminal, project config and MCP cannot create this transferred port. */
export function registerEmbeddedHostTools(registry: ToolRegistry, governor: IGovernor, data?: EngineWorkerData): void {
  const actual: EngineWorkerData | undefined = data || (!isMainThread ? workerData : undefined);
  const port = actual?.bimaxEmbeddedToolsPort as MessagePort | undefined;
  const tools = actual?.bimaxEmbeddedTools;
  if (!port || !Array.isArray(tools)) return;
  const execute = embeddedClient(port);
  for (const spec of tools as EmbeddedToolSpec[]) {
    registry.register(buildTool({ ...spec, isDestructive: true, approvalHandledInternally: true,
      execute: (args, context) => execute(spec.name, args, context?.signal),
    }, governor));
    registry.discover(spec.name);
  }
}

export function embeddedClient(port: MessagePort) {
  let next = 0, closed = false;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void }>();
  const close = () => {
    if (closed) return;
    closed = true;
    for (const call of pending.values()) { call.cleanup(); call.reject(new Error('Embedded host ended; input was not replayed.')); }
    pending.clear(); port.close();
  };
  port.on('close', close); port.unref();
  port.on('message', reply => {
    const call = pending.get(reply?.id);
    if (!call) return;
    pending.delete(reply.id); call.cleanup();
    if (reply.error) call.reject(new Error(reply.error)); else call.resolve(reply.result);
  });
  return (name: string, args: unknown, signal?: AbortSignal): Promise<unknown> => {
    if (closed || signal?.aborted) return Promise.reject(new Error('Embedded operation stopped.'));
    if (pending.size >= 16 || JSON.stringify(args).length > 256_000) return Promise.reject(new Error('Embedded request exceeds its bounded capacity.'));
    const id = ++next;
    return new Promise((resolve, reject) => {
      const cancel = () => {
        if (!pending.delete(id)) return;
        cleanup(); port.postMessage({ cancel: id }); reject(new Error('Embedded operation stopped; input was not replayed.'));
      };
      // Human approvals may take time; cancellation remains immediate. No reconnect or retry.
      const timer = setTimeout(cancel, 600_000); timer.unref();
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
      pending.set(id, { resolve, reject, cleanup }); signal?.addEventListener('abort', cancel, { once: true });
      try { port.postMessage({ id, name, args }); } catch { close(); }
    });
  };
}
