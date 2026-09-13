import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { SavedThread } from './thread.manager';

/** Serialized atomic snapshots; streamed updates coalesce, completed history survives relaunch. */
export class ThreadStorage {
  private pending = new Map<string, SavedThread>();
  private timer?: ReturnType<typeof setTimeout>;
  private writes: Promise<void> = Promise.resolve();
  constructor(private dir: string) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  load(): SavedThread[] {
    return fs.readdirSync(this.dir).filter(n => /^[\w-]+\.json$/.test(n)).slice(0, 200).flatMap(n => {
      try {
        const file = path.join(this.dir,n);
        if (fs.statSync(file).size > 32 * 1024 * 1024) return [];
        const value = JSON.parse(fs.readFileSync(file,'utf8'));
        return value.summary && Array.isArray(value.state?.items) ? [value] : [];
      } catch { return []; }
    });
  }
  save(value: SavedThread): void {
    this.pending.set(value.summary.id, { summary: { ...value.summary }, state: value.state });
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 500);
  }
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const batch = [...this.pending.values()]; this.pending.clear();
    this.writes = this.writes.then(async () => {
      for (const value of batch) {
        const file = path.join(this.dir, `${value.summary.id}.json`);
        // Secrets entered in approval dialogs are never stored in this transcript snapshot.
        const text = JSON.stringify({ ...value, state: { ...value.state, request: null } });
        await fsp.writeFile(`${file}.tmp`, text, { mode: 0o600 });
        await fsp.rename(`${file}.tmp`, file);
      }
    });
    return this.writes;
  }
}
