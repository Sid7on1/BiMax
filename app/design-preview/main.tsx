import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TaskSidebar } from '../src/renderer/src/components/TaskSidebar';
import { ChatPreview } from './chat';
import { ModelsPreview } from './models';
import { TranscriptPreview } from './transcript';
import { MotionPreview } from './motion';
import { MotionLab } from './lab';
import type { UiSnapshot, UiSnapshotSession } from '../src/renderer/src/protocol';
import '@fontsource-variable/inter';
import '../src/renderer/src/styles.css';

/**
 * Browser harness for the app shell. Only the IPC surface the previewed components actually touch
 * is stubbed; anything else must fail loudly rather than be quietly faked.
 */
(window as unknown as { bimax: unknown }).bimax = {
  pickFolder: async () => null,
  // The sidebar lists Bimax Threads. The preview has no main process, so there are never any threads,
  // Finder context or pending approvals to show — the list renders empty instead of throwing.
  threads: {
    list: async () => ({ activeId: null, threads: [], shortcutAvailable: true }),
    onList: () => () => {},
    onSelected: () => () => {},
    context: async () => ({ root: null, source: 'Choose a folder' }),
    onContext: () => () => {},
    approvals: async () => [],
    onApprovals: () => () => {},
    quickCurrent: async () => null,
    onQuickThread: () => () => {},
    onQuickMsg: () => () => {},
    onQuickActivity: () => () => {},
    search: async () => [],
    archived: async () => [],
  },
  // Only what the previewed components touch. The coach's IPC is stubbed so the overlay can be
  // looked at; anything it calls that is NOT stubbed must throw rather than be silently faked.
  permissionCoach: {
    bundlePath: async () => '/Applications/Bimax.app',
    setInteractive: () => {},
    dragBundle: () => {},
    stop: async () => true,
    relaunch: async () => true,
  },
};

const session = (id: string, title: string, minutesAgo: number, current = false): UiSnapshotSession => ({
  id,
  title,
  startedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  messageCount: 12,
  cwd: '/Users/you/Desktop/Bimax',
  current,
});

const SNAPSHOT = {
  sessions: [
    session('a', 'Redesign the left panel', 2, true),
    session('b', 'Flash exact-state controller', 48),
    session('c', 'Why do clicks land on window chrome?', 190),
    session('d', 'Package the sidecar for release', 1500),
  ],
} as unknown as UiSnapshot;

const EMPTY = { sessions: [] } as unknown as UiSnapshot;

const noop = (): void => {};

function Stage({
  theme, chrome, snapshot, label,
}: {
  theme: 'moonlight' | 'starlight';
  chrome: 'windowed' | 'expanded';
  snapshot: UiSnapshot;
  label: string;
}): React.ReactElement {
  return (
    <figure style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <figcaption style={{ font: '600 11px/1 ui-monospace, monospace', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#8a8a85' }}>
        {label}
      </figcaption>
      {/* The desktop the glass samples. Without something behind it, translucency is unverifiable. */}
      <div
        className={`theme-${theme} text-ink`}
        data-chrome={chrome}
        style={{
          width: 268,
          height: 620,
          overflow: 'hidden',
          borderRadius: 14,
          background:
            'linear-gradient(140deg, #2f4858 0%, #6d597a 38%, #b56576 66%, #e8a598 100%)',
          boxShadow: '0 24px 60px rgba(0,0,0,0.35)',
        }}
      >
        <TaskSidebar
          snapshot={snapshot}
          onNewTask={noop}
          onOpenPalette={noop}
          onResume={noop}
          onOpenTrust={noop}
          onOpenInspector={noop}
          onOpenSettings={noop}
          onOpenMachineHealth={noop}
          computerUseBlocked={false}
        />
      </div>
    </figure>
  );
}

type Page = 'lab' | 'motion' | 'shell' | 'models' | 'transcript';
const PAGES: Page[] = ['lab', 'motion', 'shell', 'models', 'transcript'];

function Preview(): React.ReactElement {
  const [dark, setDark] = useState(true);
  // Addressable by hash (#transcript, #shell, …) so a view can be opened, linked and screenshotted
  // without editing this file — which is what the previous default-only switch forced.
  const [page, setPage] = useState<Page>(() => {
    const h = window.location.hash.slice(1) as Page;
    return PAGES.includes(h) ? h : 'lab';
  });
  useEffect(() => { window.location.hash = page; }, [page]);
  // The real app puts the theme class on <html>; portalled surfaces (the brand dropdown) inherit
  // from there, so the page root has to carry it too or they would render unthemed.
  useEffect(() => {
    document.documentElement.classList.remove('theme-moonlight', 'theme-starlight');
    document.documentElement.classList.add(dark ? 'theme-moonlight' : 'theme-starlight');
  }, [dark]);

  return (
    <div style={{ minHeight: '100vh', padding: 32, background: dark ? '#141416' : '#e9e9e6' }}>
      <button
        onClick={() => setDark((v) => !v)}
        style={{
          marginBottom: 24, padding: '6px 14px', borderRadius: 8, cursor: 'pointer',
          border: '1px solid #8884', background: 'transparent', color: dark ? '#f5f5f4' : '#111',
          font: '500 12px/1.4 system-ui',
        }}
      >
        page: {dark ? 'moonlight' : 'starlight'}
      </button>
      <button
        onClick={() => setPage(PAGES[(PAGES.indexOf(page) + 1) % PAGES.length])}
        style={{
          marginBottom: 24, marginLeft: 8, padding: '6px 14px', borderRadius: 8, cursor: 'pointer',
          border: '1px solid #8884', background: 'transparent', color: dark ? '#f5f5f4' : '#111',
          font: '500 12px/1.4 system-ui',
        }}
      >
        view: {page}
      </button>
      {page === 'lab' ? (
        <div className={dark ? 'theme-moonlight' : 'theme-starlight'} data-chrome="windowed">
          <MotionLab />
        </div>
      ) : page === 'motion' ? (
        <div className={dark ? 'theme-moonlight' : 'theme-starlight'} data-chrome="windowed">
          <MotionPreview />
        </div>
      ) : page === 'transcript' ? (
        <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          {/* `text-ink` is load-bearing: body resolves --color-ink under whatever theme <html>
              carries, and descendants inherit the COMPUTED colour — so a themed subtree that does
              not re-assert it renders the other theme's ink. Markdown has no colour class of its
              own, so it is the surface that exposes this. */}
          <div className="theme-moonlight text-ink" data-chrome="expanded"><TranscriptPreview /></div>
          <div className="theme-starlight text-ink" data-chrome="expanded"><TranscriptPreview /></div>
        </div>
      ) : page === 'models' ? (
        <div className={dark ? 'theme-moonlight' : 'theme-starlight'} data-chrome="expanded">
          <ModelsPreview />
        </div>
      ) : (
      <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <Stage theme="moonlight" chrome="windowed" snapshot={SNAPSHOT} label="moonlight · windowed (glass)" />
        <Stage theme="moonlight" chrome="expanded" snapshot={SNAPSHOT} label="moonlight · expanded (solid)" />
        <Stage theme="starlight" chrome="windowed" snapshot={SNAPSHOT} label="starlight · windowed (glass)" />
        <Stage theme="starlight" chrome="expanded" snapshot={SNAPSHOT} label="starlight · expanded (solid)" />
        <Stage theme="moonlight" chrome="windowed" snapshot={EMPTY} label="moonlight · no history" />
        <figure style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <figcaption style={{ font: '600 11px/1 ui-monospace, monospace', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#8a8a85' }}>
            chat · @shadcn/helpers/ai-sdk
          </figcaption>
          <div className={dark ? 'theme-moonlight' : 'theme-starlight'} data-chrome="expanded">
            <ChatPreview />
          </div>
        </figure>
      </div>
      )}
    </div>
  );
}

// Reuse the root across hot reloads; a second createRoot on the same container warns and detaches.
const container = document.getElementById('root')! as HTMLElement & { _root?: ReturnType<typeof createRoot> };
(container._root ??= createRoot(container)).render(<Preview />);
