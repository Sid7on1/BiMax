import React from '../../../../app/node_modules/react';
import { createRoot } from '../../../../app/node_modules/react-dom/client';
import { ThreadsList } from '../../../../app/src/renderer/src/components/ThreadsList';

const host = window as any;
const listeners = new Set<(data: unknown) => void>();
host.bimax = { threads: {
  list: async () => ({ activeId: null, threads: [], shortcutAvailable: true, recovery: await host.auditEntries() }),
  onList: (cb: (data: unknown) => void) => { listeners.add(cb); return () => listeners.delete(cb); },
  exportRecovery: (id: string, archived: boolean, backup: boolean) => host.auditExport(id, archived, backup),
} };
host.auditPush = (entries: unknown[], savingError: string | null = null) => { for (const cb of listeners) cb({ activeId: null, threads: [], shortcutAvailable: true, recovery: entries, savingError }); };
createRoot(document.getElementById('root')!).render(<ThreadsList />);
