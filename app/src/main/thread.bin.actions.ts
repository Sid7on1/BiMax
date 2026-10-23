import fs from 'node:fs';
import type { ThreadManager, SavedThread } from './thread.manager';
import type { ThreadStorage } from './thread.storage';
import type { ThreadBinRecovery } from './thread.bin.recovery';

/** Main-process actions shared by IPC and end-state tests; the renderer supplies ids, never paths. */
export function threadBinActions(host: {
  threads: ThreadManager; storage: ThreadStorage; recovery: ThreadBinRecovery;
  changed: () => void; leftBar: (id: string) => void;
}) {
  const { threads, storage, recovery } = host;
  const refused=(error:unknown)=>({ok:false,error:(error as Error).message});
  return {
    async move(id: unknown, archived: unknown) {
      if (typeof id !== 'string' || typeof archived !== 'boolean') return {ok:false,error:'No thread was given.'};
      let saved: SavedThread | undefined; let file: string | undefined;
      try {
        if (recovery.isBusy(id)) throw new Error('This conversation is already being moved.');
        if (archived) { file=storage.archivedFile(id); }
        else {
          if (id === threads.activeId) throw new Error('This thread is open in the main window. Open another thread first.');
          // release also rejects a starting/running/draining engine.
          saved=threads.release(id); host.leftBar(id);
          file=await storage.writeFinal(saved);
        }
        await recovery.move(id,archived);
        return {ok:true};
      } catch(error) {
        if (saved && (!file || fs.existsSync(file))) {
          storage.readmit(id);
          try { threads.restore(saved); } catch { /* durable final state is read on relaunch */ }
        }
        return refused(error);
      } finally {host.changed();}
    },
    undo(id: unknown) {
      if (typeof id !== 'string') return {ok:false,error:'No thread was given.'};
      try {
        if (!recovery.isArchived(id)) threads.ensureRoom();
        const back=recovery.undo(id);
        if (!back.archived) { storage.readmit(id); threads.restore(back.value); }
        host.changed(); return {ok:true};
      } catch(error) { host.changed(); return refused(error); }
    },
  };
}
