import React from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsDialog } from '../../src/renderer/src/components/SettingsDialog';
createRoot(document.getElementById('root')!).render(
  <SettingsDialog
    open
    onClose={() => {}}
    onOpenHealth={() => {}}
    onOpenModels={() => {}}
    onOpenInspector={() => {}}
    phase9={{} as never}
    configGet={async () => ({})}
    configSet={async (patch) => patch}
  />,
);
