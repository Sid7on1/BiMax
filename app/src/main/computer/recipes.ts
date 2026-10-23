import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Saved instructions have no PID, snapshot, read grant or input authority. */
export class ComputerRecipes {
  constructor(private directory: string) {}
  async save(name: string, text: string): Promise<string> {
    if (!name.trim() || name.length > 80 || !text.startsWith('@CU ') || text.length > 32_000) throw new Error('Workflow exceeds the saved instruction limit.');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, `${Date.now()}-${randomUUID()}.json`);
    await writeFile(file, JSON.stringify({ name, text }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    return name;
  }
  async list(): Promise<Array<{ name: string; text: string }>> {
    const files = await readdir(this.directory).catch(() => [] as string[]);
    const result: Array<{ name: string; text: string }> = [];
    for (const file of files.filter(f => /^\d+-[a-f\d-]{36}\.json$/.test(f)).sort().reverse().slice(0, 100)) {
      try {
        const data = await readFile(path.join(this.directory, file), 'utf8'); if (data.length > 33_000) continue;
        const entry = JSON.parse(data);
        if (typeof entry.name === 'string' && entry.name.length <= 80 && typeof entry.text === 'string' && entry.text.startsWith('@CU ') && entry.text.length <= 32_000) result.push({ name: entry.name, text: entry.text });
      } catch { /* A damaged note cannot prevent the rest from loading. */ }
    }
    return result;
  }
}
