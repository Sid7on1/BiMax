import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

/** One real Bimax CU process per Bimax Thread. Failed calls are never replayed. */
export class ComputerUseTransport {
  private child: ChildProcessWithoutNullStreams;
  private next = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private closed = false;
  constructor(executable: string) {
    // No provider credentials, Python paths or project configuration enter the native helper.
    this.child = spawn(executable, [], { env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME }, stdio: ['pipe', 'pipe', 'pipe'] });
    let outputBytes = 0;
    this.child.stdout.on('data', chunk => { outputBytes += chunk.length; if (outputBytes > 8 * 1024 * 1024) this.close(); });
    createInterface({ input: this.child.stdout }).on('line', line => {
      outputBytes = 0;
      if (line.length > 8 * 1024 * 1024) { this.close(); return; }
      try {
        const reply = JSON.parse(line), waiter = this.pending.get(reply.id);
        if (!waiter) return;
        this.pending.delete(reply.id); clearTimeout(waiter.timer);
        if (reply.error) waiter.reject(new Error(reply.error.message)); else waiter.resolve({ structuredContent: reply.result.data, content: [...(reply.result.image ? [{ type: 'image', mimeType: 'image/png', data: reply.result.image }] : []), { type: 'text', text: JSON.stringify(reply.result.data) }] });
      } catch { this.close(); }
    });
    this.child.stdin.on('error', () => this.close());
    this.child.stderr.on('data', () => {}); // Native screen text must never enter app logs.
    this.child.on('error', () => this.close());
    this.child.on('exit', () => this.close());
  }
  request(method: string, params: any = {}): Promise<any> {
    if (this.pending.size >= 16) return Promise.reject(new Error('Native operation queue is full.'));
    if (this.closed) return Promise.reject(new Error('Bimax CU driver disconnected; observe again.'));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(), 90_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, operation: method, arguments: params }) + '\n', error => { if (error) this.close(); });
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, waiter] of this.pending) {
      this.child.stdin.write(JSON.stringify({ cancel: id }) + '\n');
      clearTimeout(waiter.timer); waiter.reject(new Error('Bimax CU operation ended; input was not replayed.'));
    }
    this.pending.clear();
    // EOF lets the native component restore parked windows. Kill only a nonresponsive helper.
    this.child.stdin.on('error', () => {});
    this.child.stdin.end();
    const kill = setTimeout(() => { this.child.kill('SIGKILL'); }, 3000); kill.unref();
    this.child.once('exit', () => clearTimeout(kill));
  }
}
