import { closeSync, constants, openSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { InvalidPayloadError, resolveWithinRoot } from './security';

const MAX_FILE_RESPONSE_BYTES = 1024 * 1024;
const MAX_FILE_WRITE_BYTES = 8 * 1024 * 1024;
/** Native process concurrency is an I/O budget, not the engine or sub-agent worker budget. */
const MAX_FILE_PROCESSES = 8;
let fileProcesses = 0;
let helperPath = path.resolve(__dirname, '../../project-files/bimax-project-files');
/** Called only by main with the app-bundled path, before serving file IPC. */
export function configureProjectFileHelper(value: string): void {
  helperPath = value;
}

/** A directory descriptor, opened at project selection, is this object's filesystem authority. */
export class ProjectFiles {
  readonly root: string;
  private readonly fd: number;
  private closing = false;
  private active = 0;
  private retired?: () => void;
  private retirement?: Promise<void>;

  constructor(
    root: string,
    private readonly helper = helperPath,
  ) {
    resolveWithinRoot(root, '.');
    this.root = realpathSync(root);
    this.fd = openSync(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  }
  close(): Promise<void> {
    if (!this.retirement) {
      this.closing = true;
      this.retirement = new Promise((resolve) => {
        this.retired = resolve;
      });
      this.drain();
    }
    return this.retirement;
  }
  private drain(): void {
    if (this.closing && this.active === 0 && this.retired) {
      closeSync(this.fd);
      const done = this.retired;
      this.retired = undefined;
      done();
    }
  }
  private async call(operation: 'list' | 'read' | 'tail' | 'write', rel: unknown, input = ''): Promise<Buffer> {
    if (this.closing) throw new Error('This project file authority was retired.');
    if (fileProcesses >= MAX_FILE_PROCESSES)
      throw new Error('Project file I/O is busy. Retry after pending operations finish.');
    const absolute = resolveWithinRoot(this.root, rel);
    const relative = path.relative(this.root, absolute) || '.';
    if (typeof input !== 'string' || Buffer.byteLength(input) > MAX_FILE_WRITE_BYTES)
      throw new InvalidPayloadError('File content exceeds the write byte budget.');
    this.active++;
    fileProcesses++;
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        const child = spawn(this.helper, [operation, relative], {
          stdio: ['pipe', 'pipe', 'pipe', this.fd],
          env: { PATH: '/usr/bin:/bin' },
        });
        const chunks: Buffer[] = [];
        let length = 0,
          stderr = '',
          failure: Error | undefined;
        const fail = (error: Error) => {
          failure ??= error;
          child.kill('SIGKILL');
        };
        const timer = setTimeout(() => fail(new Error('Project file operation timed out.')), 10_000);
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.stdout!.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > MAX_FILE_RESPONSE_BYTES) fail(new Error('Project file response exceeds its byte budget.'));
          else chunks.push(chunk);
        });
        child.stderr!.on('data', (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(0, 2000);
        });
        child.stdin!.on('error', fail);
        child.once('close', (code) => {
          clearTimeout(timer);
          if (failure || code !== 0) reject(failure || new Error(stderr || 'Project file operation refused.'));
          else resolve(Buffer.concat(chunks, length));
        });
        child.stdin!.end(input, 'utf8');
      });
    } finally {
      this.active--;
      fileProcesses--;
      this.drain();
    }
  }
  async readFilePreview(
    rel: unknown,
    tail = false,
  ): Promise<{ content: string; truncated: boolean; size: number; binary: boolean }> {
    const data = await this.call(tail ? 'tail' : 'read', rel);
    if (data.length < 8) throw new Error('Invalid file response.');
    const n = data.readBigUInt64BE();
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('File size exceeds the supported range.');
    const size = Number(n),
      bytes = data.subarray(8),
      binary = bytes.includes(0);
    return { content: binary ? '' : bytes.toString('utf8'), binary, size, truncated: size > bytes.length };
  }
  async writeFileContent(rel: unknown, content: string): Promise<void> {
    await this.call('write', rel, content);
  }
  async listDir(rel: unknown): Promise<Array<{ name: string; dir: boolean }>> {
    const data = await this.call('list', rel),
      entries: Array<{ name: string; dir: boolean }> = [];
    for (let at = 0; at < data.length; ) {
      const dir = data[at++] === 1,
        end = data.indexOf(0, at);
      if (end < at) throw new Error('Invalid directory response.');
      const name = data.subarray(at, end).toString('utf8');
      at = end + 1;
      if (!['node_modules', '.git', '.DS_Store'].includes(name)) entries.push({ name, dir });
    }
    return entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  }
}

/** Compatibility for pure file APIs/tests; live IPC supplies its already pinned project object. */
export async function withProjectFiles<T>(
  root: string | ProjectFiles,
  operation: (files: ProjectFiles) => Promise<T>,
): Promise<T> {
  if (root instanceof ProjectFiles) return operation(root);
  const files = new ProjectFiles(root);
  try {
    return await operation(files);
  } finally {
    await files.close();
  }
}
