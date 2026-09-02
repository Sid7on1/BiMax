import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import '@fontsource-variable/inter';
import './styles.css';

/**
 * Single renderer entry. Bimax is a code-only agentic IDE: there is no macOS permission coach
 * window and no Computer Use surface, so this bundle mounts exactly one app root.
 */
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
