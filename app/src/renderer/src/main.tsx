import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ThreadQuickBar, ThreadApprovals } from './components/ThreadSurfaces';
import { OrganizePreview } from './components/OrganizePreview';
import { ErrorBoundary } from './components/ErrorBoundary';
import { startRenderMode } from './render.mode';
import { savedMotionPreference } from './motion.preference';
import '@fontsource-variable/inter';
import './styles.css';

// WP-2 (record 57). Started here rather than inside a component so all three surfaces this entry
// mounts — the main window, the ⌘2 bar and the approval popup — follow the same decision.
startRenderMode(window.bimax.phase9, document.documentElement);
// Settings → Reduce motion, before the first frame of any surface (motion.preference.ts).
document.documentElement.toggleAttribute('data-reduce-motion', savedMotionPreference());

/**
 * Single renderer entry. Bimax is a code-only agentic IDE: there is no macOS permission coach
 * window and no Computer Use surface, so this bundle mounts exactly one app root.
 */
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      {new URLSearchParams(location.search).get('surface') === 'quick' ? <ThreadQuickBar />
        : new URLSearchParams(location.search).get('surface') === 'approval' ? <ThreadApprovals />
          : new URLSearchParams(location.search).get('surface') === 'organize' ? <OrganizePreview /> : <App />}
    </ErrorBoundary>
  </React.StrictMode>,
);
