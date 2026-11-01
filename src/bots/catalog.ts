import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { withMemoryWriteTransaction } from '../memory/write.transaction';
import { BotDefinition, BotDraft, BotId, type BotDraftInput } from './definition';

const Catalog = z.object({ schemaVersion: z.literal(1), definitions: z.array(BotDefinition) }).strict();

/** Trusted host-owned directory. No constructor I/O, global registration, worker or model call. */
export class BotCatalog {
  readonly directory: string;
  private readonly file: string;
  constructor(directory: string) { this.directory = path.resolve(directory); this.file = path.join(this.directory, 'definitions.json'); }

  private async read(): Promise<BotDefinition[]> {
    try {
      const rows = Catalog.parse(JSON.parse(await fs.readFile(this.file, 'utf8'))).definitions;
      if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('Duplicate bot identities in catalog.');
      return rows;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  async list(): Promise<BotDefinition[]> { return this.read(); }
  async get(id: string): Promise<BotDefinition> {
    BotId.parse(id);
    const definition = (await this.read()).find(row => row.id === id);
    if (!definition) throw new Error('Bot does not exist.');
    return definition;
  }
  private async write(rows: BotDefinition[]): Promise<void> {
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify({ schemaVersion: 1, definitions: rows }, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fs.rename(tmp, this.file);
    } finally { await fs.rm(tmp, { force: true }); }
  }
  async create(input: BotDraftInput): Promise<BotDefinition> {
    const draft = BotDraft.parse(input);
    return withMemoryWriteTransaction(this.file, async () => {
      const rows = await this.read();
      const definition: BotDefinition = { ...draft, schemaVersion: 1, id: randomUUID(), revision: 1 };
      await this.write([...rows, definition]);
      return definition;
    });
  }
  async update(id: string, expectedRevision: number, input: BotDraftInput): Promise<BotDefinition> {
    BotId.parse(id); const draft = BotDraft.parse(input);
    return withMemoryWriteTransaction(this.file, async () => {
      const rows = await this.read(); const at = rows.findIndex(row => row.id === id);
      if (at < 0 || rows[at].revision !== expectedRevision) throw new Error('Bot revision changed; reload before saving.');
      const updated: BotDefinition = { ...draft, schemaVersion: 1, id, revision: expectedRevision + 1 };
      rows[at] = updated; await this.write(rows); return updated;
    });
  }
  memoryFile(id: string): string { return path.join(this.directory, 'memory', BotId.parse(id), 'vectors.json'); }
}
