import type { MessagePort } from 'node:worker_threads';
import type { EmbeddedToolSpec } from '../../../src/engine/api';

export interface EmbeddedToolsBinding {
  tools: EmbeddedToolSpec[];
  execute(name: string, args: unknown, signal: AbortSignal): Promise<unknown>;
  close(): void;
}

/** Birth-bound to one engine generation. There is no socket, token, config entry or reconnect path. */
export function bindEmbeddedTools(port: MessagePort, binding: EmbeddedToolsBinding): () => void {
  let closed = false;
  const calls = new Map<number, AbortController>();
  const names = new Set(binding.tools.map(t => t.name));
  const close = () => {
    if (closed) return;
    closed = true;
    for (const controller of calls.values()) controller.abort();
    calls.clear(); binding.close(); port.close();
  };
  port.on('close', close);
  port.on('message', async message => {
    if (closed) return;
    if (Number.isSafeInteger(message?.cancel)) { calls.get(message.cancel)?.abort(); return; }
    const id = message?.id;
    if (!Number.isSafeInteger(id) || id <= 0 || calls.has(id) || calls.size >= 16) { close(); return; }
    const controller = new AbortController(); calls.set(id, controller);
    try {
      if (!names.has(message.name) || JSON.stringify(message.args).length > 256_000) throw new Error('Invalid embedded tool request');
      const result = await binding.execute(message.name, message.args, controller.signal);
      if (!closed && !controller.signal.aborted) {
        if (JSON.stringify(result).length > 8 * 1024 * 1024) throw new Error('Embedded tool response exceeds 8 MiB');
        port.postMessage({ id, result });
      }
    } catch (error) {
      if (!closed && !controller.signal.aborted) port.postMessage({ id, error: (error as Error).message });
    } finally { calls.delete(id); }
  });
  return close;
}
