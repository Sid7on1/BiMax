import * as fs from 'fs/promises';
import { constants, Dirent, Stats } from 'fs';
import { createHash } from 'crypto';

export type InputEvidence = { path: string; kind: 'file' | 'directory' | 'stat'; digest: string };
export interface EvidenceSnapshot {
  inputs: InputEvidence[];
  complete: boolean;
  reasons: string[];
}
const MAX_INPUTS = 2048;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_READ_BYTES = 16 * 1024 * 1024;
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const directoryDigest = (entries: Dirent[]) => hash(JSON.stringify(entries.map(e =>
  [e.name, e.isDirectory() ? 'directory' : e.isFile() ? 'file' : 'other'],
).sort((a, b) => a[0].localeCompare(b[0]))));
const statDigest = (stat: Stats) => hash(JSON.stringify([stat.size, stat.mtimeMs, stat.mode, stat.isFile()]));

/** Bounded actual-byte reads. No mtime cache and no file-sized allocation before the size limit. */
export async function readEvidenceFile(file: string, signal?: AbortSignal, maxBytes = MAX_FILE_BYTES): Promise<Buffer> {
  signal?.throwIfAborted();
  // A FIFO must not hang in open() before we can reject its non-file stat.
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Evidence input is not a regular file');
    if (stat.size > maxBytes) throw new Error('Evidence read byte limit exceeded');
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      signal?.throwIfAborted();
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes - total + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error('Evidence read byte limit exceeded');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally { await handle.close(); }
}

/** Evidence comes from the bytes/listings actually used by the tool, never a later guessed read. */
export class WorkflowEvidence {
  private inputs = new Map<string, InputEvidence>();
  private reasons = new Set<string>();
  private readBytes = 0;
  constructor(readonly signal?: AbortSignal) {}
  incomplete(reason: string): void { if (this.reasons.size < 16) this.reasons.add(reason); }
  gaps(): string[] { return [...this.reasons]; }
  private add(input: InputEvidence): void {
    const key = `${input.kind}:${input.path}`;
    if (this.inputs.has(key) && this.inputs.get(key)!.digest !== input.digest) this.incomplete('Input changed during observation');
    if (this.inputs.size >= MAX_INPUTS && !this.inputs.has(key)) { this.incomplete('Evidence input limit reached'); return; }
    this.inputs.set(key, input);
  }
  directory(file: string, entries: Dirent[]): void { this.add({ path: file, kind: 'directory', digest: directoryDigest(entries) }); }
  stat(file: string, stat: Stats): void { this.add({ path: file, kind: 'stat', digest: statDigest(stat) }); }
  async readFile(file: string): Promise<string> {
    this.signal?.throwIfAborted();
    const remaining = MAX_READ_BYTES - this.readBytes;
    if (remaining <= 0) { this.incomplete('Evidence read budget exhausted'); throw new Error('Evidence read budget exhausted'); }
    try {
      const data = await readEvidenceFile(file, this.signal, Math.min(MAX_FILE_BYTES, remaining));
      this.readBytes += data.length;
      this.add({ path: file, kind: 'file', digest: hash(data) });
      return data.toString('utf8');
    } catch (error) { this.incomplete('Input could not be read completely'); throw error; }
  }
  snapshot(): EvidenceSnapshot {
    if (!this.inputs.size) this.incomplete('No input evidence recorded');
    return { inputs: [...this.inputs.values()], complete: this.reasons.size === 0 && this.inputs.size > 0, reasons: [...this.reasons] };
  }
}

export async function evidenceIsCurrent(snapshot: EvidenceSnapshot, signal?: AbortSignal): Promise<boolean> {
  if (!snapshot.complete || !snapshot.inputs.length || snapshot.inputs.length > MAX_INPUTS) return false;
  let bytes = 0;
  for (const input of snapshot.inputs) {
    signal?.throwIfAborted();
    try {
      let digest: string;
      if (input.kind === 'file') {
        const data = await readEvidenceFile(input.path, signal, Math.min(MAX_FILE_BYTES, MAX_READ_BYTES - bytes));
        bytes += data.length;
        digest = hash(data);
      } else if (input.kind === 'directory') {
        digest = directoryDigest(await fs.readdir(input.path, { withFileTypes: true }));
      } else {
        digest = statDigest(await fs.stat(input.path));
      }
      if (digest !== input.digest) return false;
    } catch { signal?.throwIfAborted(); return false; }
  }
  return true;
}
