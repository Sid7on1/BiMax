import net from 'node:net';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ThreadManager } from './thread.manager';

/** Private local socket. An engine token identifies the sender; arguments cannot impersonate it. */
export async function createThreadBroker(manager: ThreadManager, authorizeLink: (from:string,to:string) => Promise<boolean> = async () => false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bimax-threads-'));
  await fs.chmod(dir, 0o700);
  const socketPath = path.join(dir, 'broker.sock');
  const tokens = new Map<string,string>();
  const server = net.createServer(socket => {
    let raw = ''; let handled = false;
    socket.setTimeout(5000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', async data => {
      if (handled) return;
      raw += data.toString('utf8');
      if (raw.length > 16000) return socket.destroy();
      if (!raw.includes('\n')) return;
      handled = true;
      try {
        const request = JSON.parse(raw.slice(0,raw.indexOf('\n')));
        const sender = tokens.get(request.token);
        if (!sender) throw new Error('Thread capability expired');
        if (request.action === 'link') {
          manager.get(request.to);
          socket.setTimeout(120_000,() => socket.destroy());
          const allowed = await authorizeLink(sender,request.to);
          if (!allowed || socket.destroyed || tokens.get(request.token) !== sender) throw new Error('Collaboration was not approved.');
          manager.link(sender,request.to,true);
          socket.end(JSON.stringify({ ok:true,result:'The user linked these threads. You may now exchange relevant task messages.' })+'\n');
          return;
        }
        const result = request.action === 'list'
          ? manager.list().filter(t => t.id !== sender).map(t => ({ id:t.id, title:t.title, status:t.status, linked:manager.get(sender).summary.peers.includes(t.id) }))
          : request.action === 'send' ? manager.peerMessage(sender, request.to, request.message)
          : (() => { throw new Error('Unknown thread action'); })();
        socket.end(JSON.stringify({ ok:true, result })+'\n');
      } catch (error) { socket.end(JSON.stringify({ ok:false, error:String((error as Error).message) })+'\n'); }
    });
  });
  await new Promise<void>((resolve,reject) => { server.once('error',reject); server.listen(socketPath,resolve); });
  await fs.chmod(socketPath,0o600);
  return {
    environment(id: string): Record<string,string> {
      // Revoke old generations before exposing a replacement process capability.
      for (const [token,owner] of tokens) if (owner === id) tokens.delete(token);
      const token = randomBytes(32).toString('hex'); tokens.set(token,id);
      return { BIMAX_THREAD_SOCKET:socketPath, BIMAX_THREAD_TOKEN:token, BIMAX_THREAD_ID:id };
    },
    close(): void { tokens.clear(); server.close(); void fs.rm(dir,{ recursive:true, force:true }); },
  };
}
