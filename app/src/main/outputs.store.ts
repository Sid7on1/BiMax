import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { OutputInput, OutputDocument, OutputRecord, OutputFormat } from '../shared/outputs';

export const OUTPUT_FORMATS: OutputFormat[] = [
  'markdown',
  'document',
  'code',
  'html',
  'react',
  'vega-lite',
  'mermaid',
  'table',
  'form',
];
export const OUTPUT_MAX_BYTES = 192 * 1024;
/** Managed output snapshots have a disk budget, independent of engine/worker memory budgets. */
export const OUTPUT_DISK_BUDGET_BYTES = 100 * 1024 * 1024;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const validId = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);

export function outputInput(raw: unknown): OutputInput {
  const v = raw as OutputInput;
  if (
    !v ||
    typeof v !== 'object' ||
    typeof v.key !== 'string' ||
    !/^[\w.-]{1,80}$/.test(v.key) ||
    typeof v.title !== 'string' ||
    !v.title.trim() ||
    v.title.length > 120 ||
    !OUTPUT_FORMATS.includes(v.format) ||
    typeof v.content !== 'string' ||
    Buffer.byteLength(v.content) > OUTPUT_MAX_BYTES
  )
    throw new Error('Invalid output: choose a title, format, stable key and at most 192 KiB of content.');
  if (v.language !== undefined && (typeof v.language !== 'string' || !/^[\w+-]{1,30}$/.test(v.language)))
    throw new Error('Invalid code language.');
  if (v.outputId !== undefined && (!validId(v.outputId) || !validId(v.baseVersion)))
    throw new Error('Updating an output requires its exact current version.');
  if (['table', 'vega-lite', 'form'].includes(v.format)) {
    try {
      JSON.parse(v.content);
    } catch {
      throw new Error('This output format requires valid JSON.');
    }
  }
  return {
    key: v.key,
    title: v.title.trim(),
    content: v.content,
    format: v.format,
    ...(v.language ? { language: v.language } : {}),
    ...(v.outputId ? { outputId: v.outputId, baseVersion: v.baseVersion } : {}),
  };
}

/** Desktop-owned immutable snapshots. A manifest commit is the acknowledgement boundary. */
export class OutputsStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly root: string) {}
  private async directory(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    if (!(await fs.lstat(dir)).isDirectory() || (await fs.lstat(dir)).isSymbolicLink())
      throw new Error('Output storage directory is unsafe.');
  }
  private async readFile(file: string): Promise<string> {
    const h = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await h.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 2 * 1024 * 1024)
        throw new Error('Output storage file is unsafe or too large.');
      return await h.readFile('utf8');
    } finally {
      await h.close();
    }
  }
  private async atomic(file: string, text: string): Promise<void> {
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const h = await fs.open(temp, 'wx', 0o600);
      try {
        await h.writeFile(text);
        await h.sync();
      } finally {
        await h.close();
      }
      await fs.rename(temp, file);
      const d = await fs.open(path.dirname(file), 'r');
      try {
        await d.sync();
      } finally {
        await d.close();
      }
    } finally {
      await fs.rm(temp, { force: true });
    }
  }
  async list(owner?: string): Promise<OutputRecord[]> {
    await this.directory(this.root);
    const records: OutputRecord[] = [];
    for (const entry of await fs.readdir(this.root, { withFileTypes: true })) {
      if (!validId(entry.name) || !entry.isDirectory()) continue;
      let record: OutputRecord;
      try {
        record = await this.record(entry.name);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw e;
      }
      if (!owner || record.ownerThreadId === owner) records.push(record);
    }
    return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async record(id: string): Promise<OutputRecord> {
    if (!validId(id)) throw new Error('Invalid output handle.');
    await this.directory(this.root);
    const dir = path.join(this.root, id);
    if ((await fs.lstat(dir)).isSymbolicLink()) throw new Error('Unsafe output directory.');
    const r = JSON.parse(await this.readFile(path.join(dir, 'record.json'))) as OutputRecord;
    if (
      r.id !== id ||
      !OUTPUT_FORMATS.includes(r.format) ||
      typeof r.ownerThreadId !== 'string' ||
      typeof r.title !== 'string' ||
      !Array.isArray(r.versions) ||
      !r.versions.length ||
      r.versions.length > 1000 ||
      r.versions.some(
        (v) =>
          !validId(v.id) ||
          !validId(v.sha256) ||
          !Number.isSafeInteger(v.byteLength) ||
          v.byteLength < 0 ||
          v.byteLength > OUTPUT_MAX_BYTES,
      )
    )
      throw new Error('Output catalog is corrupt; no replacement was substituted.');
    return r;
  }
  async read(id: string, versionId?: string): Promise<OutputDocument> {
    const record = await this.record(id);
    const version = record.versions.find((v) => v.id === (versionId || record.versions.at(-1)!.id));
    if (!version) throw new Error('Output version not found.');
    let content: string;
    try {
      content = await this.readFile(path.join(this.root, id, `${version.id}.content`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { record, version, content: '', state: 'missing' };
      throw error;
    }
    return {
      record,
      version,
      content,
      state:
        hash(content) === version.sha256 && Buffer.byteLength(content) === version.byteLength
          ? 'available'
          : 'changed',
    };
  }
  publish(
    owner: string,
    run: string,
    raw: unknown,
    admitted: () => boolean = () => true,
  ): Promise<OutputDocument> {
    const job = this.queue.then(() => this.write(owner, run, outputInput(raw), admitted));
    this.queue = job.catch(() => undefined);
    return job;
  }
  private async write(
    owner: string,
    run: string,
    input: OutputInput,
    admitted: () => boolean,
  ): Promise<OutputDocument> {
    if (!admitted()) throw new Error('Output producer stopped before publication.');
    if (!owner || !run) throw new Error('An output requires a host-owned conversation and run.');
    await this.directory(this.root);
    const id = input.outputId || hash(`${owner}\0${run}\0${input.key}`);
    let record: OutputRecord | undefined;
    try {
      record = await this.record(id);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (record) {
      if (record.ownerThreadId !== owner || record.format !== input.format)
        throw new Error('Output ownership or format mismatch.');
      if (input.outputId && record.versions.at(-1)!.id !== input.baseVersion)
        throw new Error('This output changed. Reload before saving your revision.');
      if (!input.outputId) {
        const old = await this.read(id);
        if (old.state === 'available' && old.content === input.content && record.title === input.title)
          return old;
        throw new Error(
          'This run already published different bytes under this key. Use its current output/version to revise it.',
        );
      }
      if (record.versions.length >= 1000)
        throw new Error('This output has reached its retained-version limit. Export a copy.');
    }
    // Count actual retained files, including interrupted orphans and temporary manifests.
    // Catalog-only accounting would let failed/aborted publications grow outside the disk budget.
    let used = 0,
      entries = 0;
    for (const directory of await fs.readdir(this.root, { withFileTypes: true })) {
      if (!validId(directory.name) || !directory.isDirectory()) continue;
      for (const file of await fs.readdir(path.join(this.root, directory.name))) {
        if (++entries > 100_000) throw new Error('Output storage has too many retained files.');
        const info = await fs.lstat(path.join(this.root, directory.name, file));
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
          throw new Error('Output storage contains an unsafe file.');
        used += info.size;
      }
    }
    const manifestReserve = 2048 + (record?.versions.length || 0) * 256;
    if (used + Buffer.byteLength(input.content) + manifestReserve > OUTPUT_DISK_BUDGET_BYTES)
      throw new Error('The 100 MiB Outputs storage budget is full. Export your work before adding more.');
    const now = new Date().toISOString();
    const version = {
      id: hash(`${record?.versions.at(-1)?.id || ''}\0${input.format}\0${input.content}`),
      sha256: hash(input.content),
      byteLength: Buffer.byteLength(input.content),
      createdAt: now,
    };
    if (record?.versions.at(-1)?.sha256 === version.sha256) return this.read(id);
    const dir = path.join(this.root, id);
    await this.directory(dir);
    // Write bytes before publishing their manifest. An interrupted orphan is never listed as saved.
    const file = path.join(dir, `${version.id}.content`);
    try {
      await fs.access(file);
      if ((await this.readFile(file)) !== input.content) throw new Error('Retained output bytes changed.');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      await this.atomic(file, input.content);
    }
    const next: OutputRecord = record
      ? { ...record, title: input.title, updatedAt: now, versions: [...record.versions, version] }
      : {
          id,
          ownerThreadId: owner,
          producerRunId: run,
          title: input.title,
          format: input.format,
          language: input.language,
          createdAt: now,
          updatedAt: now,
          versions: [version],
        };
    if (!admitted()) throw new Error('Output producer stopped before publication.');
    await this.atomic(path.join(dir, 'record.json'), JSON.stringify(next));
    const actual = await this.read(id, version.id);
    if (actual.state !== 'available') throw new Error('The saved output could not be verified.');
    return actual;
  }
}
