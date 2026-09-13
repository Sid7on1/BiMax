import * as net from 'net';

export interface BinResult {
  /** Items now in the Bin, with where each one landed (null when the app could not tell). */
  moved: Array<{ path: string; trashPath: string | null }>;
  /** Set when the app stopped part-way; `moved` still lists what already went. */
  error: string | null;
}

/**
 * Move items to the macOS Bin through the Bimax app, over the thread's private socket.
 *
 * The engine cannot do this well itself: it has no access to ~/.Trash, so it could neither learn where an item
 * landed nor put it back. The app drives Finder, which it is already allowed to control, so "Put Back" keeps
 * working and the thread's undo knows the item's place in the Bin.
 */
export async function moveToBin(paths: string[], signal?: AbortSignal): Promise<BinResult> {
  const socketPath = process.env.BIMAX_THREAD_SOCKET;
  const token = process.env.BIMAX_THREAD_TOKEN;
  if (!socketPath || !token) throw new Error('Moving items to the Bin needs the Bimax app, and this thread is not connected to it.');
  const text = await new Promise<string>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let raw = '';
    const abort = () => socket.destroy(new Error('Cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
    socket.on('close', () => signal?.removeEventListener('abort', abort));
    socket.setTimeout(120_000, () => socket.destroy(new Error('The Bimax app did not answer in time')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify({ action: 'trash', paths, token }) + '\n'));
    socket.on('data', (data) => { raw += data.toString('utf8'); if (raw.length > 512_000) socket.destroy(new Error('The response was too large')); });
    socket.on('end', () => resolve(raw));
  });
  const reply = JSON.parse(text || '{}');
  if (!reply.ok) throw new Error(reply.error || 'The Bimax app could not move the items to the Bin');
  return { moved: Array.isArray(reply.result?.moved) ? reply.result.moved : [], error: reply.result?.error ?? null };
}
