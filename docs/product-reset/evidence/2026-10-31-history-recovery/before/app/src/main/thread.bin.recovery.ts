import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SavedThread } from './thread.manager';
import type { BinOps } from './thread.undo';
import type { ThreadBinUndo } from '../shared/threads';

/** A bounded private safety copy for Bimax Thread Bin undo, including the system API's unknown-trash-path fallback. */
export const BIN_UNDO_MS = 5 * 60_000;
const MAX_BIN_UNDO = 5;
interface Recovery { value: SavedThread; archived: boolean; at: number }
export class ThreadBinRecovery {
  private busy = new Set<string>();
  private dir: string;
  constructor(private root: string, private bin: Pick<BinOps, 'moveToBin'>, private now = Date.now) {
    this.dir = path.join(root, '.bin-recovery');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.prune();
  }
  private id(id: string): void { if (!/^[\w-]{1,80}$/.test(id)) throw new Error('Thread not found.'); }
  isBusy(id: string): boolean { return this.busy.has(id); }
  isArchived(id: string): boolean {
    if (this.busy.has(id)) throw new Error('This conversation is still being moved.');
    const r=this.read(id);
    if (this.now()-r.at >= BIN_UNDO_MS) { this.prune(); throw new Error('Undo expired. The conversation is still in the Bin.'); }
    if (fs.existsSync(this.target(id,r.archived))) throw new Error('This conversation already exists. Nothing was overwritten.');
    return r.archived;
  }
  private backup(id: string): string { this.id(id); return path.join(this.dir, `${id}.json`); }
  private target(id: string, archived: boolean): string { this.id(id); return path.join(this.root, ...(archived ? ['archive'] : []), `${id}.json`); }
  private read(id: string): Recovery {
    const file = this.backup(id);
    if (fs.statSync(file).size > 32 * 1024 * 1024) throw new Error('Recovery is too large.');
    const r: Recovery = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (r.value?.summary?.id !== id || !Array.isArray(r.value.state?.items) || typeof r.archived !== 'boolean' || !Number.isFinite(r.at)) throw new Error('Recovery cannot be read.');
    return r;
  }
  private records(): Recovery[] {
    return fs.readdirSync(this.dir).filter(n => /^[\w-]{1,80}\.json$/.test(n)).flatMap(n => {
      const id=n.slice(0,-5);
      try { return [this.read(id)]; } catch { fs.rmSync(this.backup(id), { force: true }); return []; }
    }).sort((a,b)=>b.at-a.at);
  }
  prune(): void {
    for (const r of this.records()) if (!this.busy.has(r.value.summary.id) && this.now()-r.at >= BIN_UNDO_MS) fs.rmSync(this.backup(r.value.summary.id), { force: true });
  }
  latest(): ThreadBinUndo | undefined {
    this.prune();
    const r=this.records().find(r=>!this.busy.has(r.value.summary.id) && !fs.existsSync(this.target(r.value.summary.id,r.archived)));
    return r ? { id:r.value.summary.id, title:r.value.summary.title, expiresAt:r.at+BIN_UNDO_MS } : undefined;
  }
  async move(id: string, archived: boolean): Promise<void> {
    this.id(id);
    if (this.busy.has(id)) throw new Error('This conversation is already being moved.');
    this.prune();
    const records=this.records();
    if (records.length >= MAX_BIN_UNDO) {
      const oldest=[...records].reverse().find(r=>!this.busy.has(r.value.summary.id));
      if (!oldest) throw new Error('Other conversations are still being moved. Try again.');
      fs.rmSync(this.backup(oldest.value.summary.id), { force: true });
    }
    this.busy.add(id);
    const target=this.target(id,archived);
    try {
      if (fs.statSync(target).size > 32 * 1024 * 1024) throw new Error('Conversation is too large.');
      const value: SavedThread=JSON.parse(fs.readFileSync(target,'utf8'));
      if (value.summary?.id !== id || !Array.isArray(value.state?.items)) throw new Error('Conversation cannot be read.');
      const r: Recovery={ value:{...value,state:{...value.state,request:null}},archived,at:this.now() };
      const temporary=`${this.backup(id)}.tmp`;
      try { fs.writeFileSync(temporary,JSON.stringify(r),{mode:0o600}); fs.renameSync(temporary,this.backup(id)); }
      finally { fs.rmSync(temporary,{force:true}); }
      await this.bin.moveToBin(target);
      if (fs.existsSync(target)) throw new Error('The conversation did not move to the Bin.');
    } catch(error) {
      // A failed move leaves the original intact. If it disappeared despite an error, retain recovery.
      if (fs.existsSync(target)) fs.rmSync(this.backup(id),{force:true});
      throw error;
    } finally { this.busy.delete(id); }
  }
  /** Restore only the conversation, at its original list/archive location; never overwrite an existing file. */
  undo(id: string): { value: SavedThread; archived: boolean } {
    this.id(id);
    if (this.busy.has(id)) throw new Error('This conversation is still being moved.');
    const r=this.read(id);
    if (this.now()-r.at >= BIN_UNDO_MS) { this.prune(); throw new Error('Undo expired. The conversation is still in the Bin.'); }
    const target=this.target(id,r.archived);
    if (fs.existsSync(target)) throw new Error('This conversation already exists. Nothing was overwritten.');
    fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
    const temporary=`${target}.undo.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary,JSON.stringify(r.value),{mode:0o600,flag:'wx'});
    try { fs.linkSync(temporary,target); } finally { fs.rmSync(temporary,{force:true}); }
    fs.rmSync(this.backup(id),{force:true});
    return {value:r.value,archived:r.archived};
  }
}
