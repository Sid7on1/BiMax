import React, { useCallback, useState } from 'react';
import { Inspector } from '../src/renderer/src/components/Inspector';
import { inspectorTabs, resolveWorkbenchTab, type WorkbenchTab } from '../src/renderer/src/inspector.model';

/**
 * The right panel, as one tabbed workbench (`front inspo/12-right-panel-plan.md`).
 *
 * This renders the REAL `Inspector` — its tab strip, its contextual toolbar and every lane it can
 * show — because the thing worth checking is exactly the thing that is easy to fake: that the
 * three rows measure up, that an active chip reads as the title, and that both themes and both
 * window states survive the merge. Launching Electron shows one of those eight combinations at a
 * time, and only after a project is open and a file has been clicked.
 *
 * Only the IPC these panels actually touch is stubbed, and each stub returns a shape from
 * `global.d.ts` rather than a convenient one. The stubs are deliberately tiny: a preview that
 * simulates the file system would be verifying itself.
 */

const FILES: Record<string, string> = {
  'docs/ARCHITECTURE.md': [
    '# Architecture',
    '',
    'The engine runs inside Electron as a `utilityProcess`, built from this repository by `bun build`.',
    '',
    '- **Main** owns the window, the panels and every file read.',
    '- **Renderer** owns the workbench you are looking at.',
    '',
    '> Preview renders the LIVE document, so an unsaved edit shows up here.',
    '',
    '```ts',
    'const engine = utilityProcess.fork(enginePath);',
    '```',
  ].join('\n'),
  'src/api/client.ts': [
    "import { z } from 'zod';",
    '',
    'export async function fetchJson<T>(url: string, schema: z.ZodType<T>): Promise<T> {',
    '  const response = await fetch(url, { headers: { accept: \'application/json\' } });',
    '  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);',
    '  return schema.parse(await response.json());',
    '}',
  ].join('\n'),
};

const TREE: Record<string, { name: string; dir: boolean }[]> = {
  '': [{ name: 'docs', dir: true }, { name: 'src', dir: true }, { name: 'README.md', dir: false }],
  docs: [{ name: 'ARCHITECTURE.md', dir: false }, { name: 'PRIVACY.md', dir: false }],
  src: [{ name: 'api', dir: true }, { name: 'index.ts', dir: false }],
  'src/api': [{ name: 'client.ts', dir: false }],
};

const stubs = {
  files: {
    list: async (rel: string) => TREE[rel] ?? [],
    read: async (rel: string) => ({
      content: FILES[rel] ?? `// ${rel} is not part of the preview's two-file corpus.\n`,
      truncated: false,
      size: (FILES[rel] ?? '').length,
      binary: false,
    }),
    reveal: async () => {},
    search: async (query: string) => ({
      hits: Object.keys(FILES)
        .filter((rel) => rel.toLowerCase().includes(query.toLowerCase()))
        .map((rel) => ({ rel, name: rel.split('/').pop() ?? rel, dir: false })),
      truncated: false,
    }),
    write: async () => {},
    onChanged: () => () => {},
  },
  git: {
    status: async () => null,
    diff: async () => '',
    branches: async () => ({ current: 'feat/right-panel', all: ['main', 'feat/right-panel'] }),
    log: async () => [],
    remote: async () => ({ isRepo: true, branch: 'feat/right-panel', upstream: 'origin/feat/right-panel', ahead: 2, behind: 0, dirty: 3 }),
    fetch: async () => ({ ok: true, message: 'up to date' }),
    pull: async () => ({ ok: true, message: 'up to date' }),
    push: async () => ({ ok: true, message: 'pushed' }),
  },
  // The shell is a real xterm with nothing behind it: enough to see the lane's chrome, and it
  // cannot pretend to run a command, which is the point.
  pty: {
    create: async () => 1,
    input: () => {},
    resize: () => {},
    kill: () => {},
    onData: () => () => {},
    onExit: () => () => {},
  },
};

/**
 * Installed at RENDER time, not at import time.
 *
 * `main.tsx` assigns `window.bimax` in its own module body, which runs AFTER every import it
 * pulls in — so stubs merged here at module scope were silently replaced by that object literal,
 * and the whole page went blank on the first `files.read`. Rendering happens later than both.
 */
let installed = false;
function installStubs(): void {
  if (installed) return;
  const bimax = (window as unknown as { bimax?: Record<string, unknown> }).bimax ?? {};
  Object.assign(bimax, stubs);
  (window as unknown as { bimax: unknown }).bimax = bimax;
  installed = true;
}

/** Enough of a `GitStatusResult` for the Review lane to have something to show. */
const GIT_STATUS = {
  branch: 'feat/right-panel',
  ahead: 2,
  behind: 0,
  files: [
    { path: 'app/src/renderer/src/components/Inspector.tsx', status: 'M', insertions: 148, deletions: 96 },
    { path: 'app/src/renderer/src/styles.css', status: 'M', insertions: 84, deletions: 21 },
    { path: 'app/design-preview/workbench.tsx', status: '?', insertions: 0, deletions: 0 },
  ],
};

const REVIEW = {
  sessionId: 's1',
  state: 'verification_failed',
  nextAction: 'One check is still failing.',
  approvals: [],
  changes: [
    { file: 'app/src/renderer/src/components/Inspector.tsx', tools: ['EditFileTool'], edits: 3, lastAt: Date.now() - 90_000 },
    { file: 'app/src/renderer/src/styles.css', tools: ['EditFileTool'], edits: 1, lastAt: Date.now() - 40_000 },
  ],
  verifications: [{ command: 'npm run check:design-preview', ok: false, settled: 0, coveredFiles: [], repoWide: false, at: Date.now() - 20_000 }],
  checkpoints: [],
  lastCheckpoint: null,
  todos: [],
  interrupted: false,
};

function Workbench({ openFiles: initial, tab }: { openFiles: string[]; tab: WorkbenchTab | null }): React.ReactElement {
  const [openFiles, setOpenFiles] = useState(initial);
  const [requested, setRequested] = useState<WorkbenchTab | null>(tab);
  const [dirtyFiles, setDirtyFiles] = useState<ReadonlySet<string>>(() => new Set(['src/api/client.ts']));
  const [wide, setWide] = useState(false);
  const [lastFile, setLastFile] = useState<string | null>(
    tab?.kind === 'file' ? tab.path : null,
  );

  const tabs = inspectorTabs({
    review: REVIEW as never, gitStatus: GIT_STATUS as never, hasProject: true, isRepo: true, ahead: 2, behind: 0,
  });
  const active = resolveWorkbenchTab(tabs, requested, openFiles);

  const onDirty = useCallback((rel: string, dirty: boolean) => {
    setDirtyFiles((set) => {
      if (set.has(rel) === dirty) return set;
      const next = new Set(set);
      if (dirty) next.add(rel); else next.delete(rel);
      return next;
    });
  }, []);

  return (
    <Inspector
      tabs={tabs}
      active={active}
      onTab={(next) => { setRequested(next); if (next.kind === 'file') setLastFile(next.path); }}
      onClose={() => {}}
      review={REVIEW as never}
      gitStatus={GIT_STATUS as never}
      checkpoints={[]}
      onRefreshGit={() => {}}
      onCommand={() => {}}
      project="/Users/you/Bimax"
      onOpenFile={(rel) => {
        setOpenFiles((files) => (files.includes(rel) ? files : [...files, rel]));
        setLastFile(rel);
        setRequested({ kind: 'file', path: rel });
      }}
      lastFile={lastFile}
      openFiles={openFiles}
      dirtyFiles={dirtyFiles}
      onCloseFile={(rel) => setOpenFiles((files) => files.filter((path) => path !== rel))}
      onDirty={onDirty}
      wide={wide}
      onToggleWide={() => setWide((value) => !value)}
    />
  );
}

function Stage({
  theme, chrome, label, openFiles, tab, width = 430,
}: {
  theme: 'moonlight' | 'starlight';
  chrome: 'windowed' | 'expanded';
  label: string;
  openFiles: string[];
  tab: WorkbenchTab | null;
  /** The panel is resizable, and the strip's container query measures the PANEL. */
  width?: number;
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
          width,
          height: 540,
          overflow: 'hidden',
          borderRadius: 14,
          background: 'linear-gradient(140deg, #2f4858 0%, #6d597a 38%, #b56576 66%, #e8a598 100%)',
          boxShadow: '0 24px 60px rgba(0,0,0,0.35)',
        }}
      >
        <Workbench openFiles={openFiles} tab={tab} />
      </div>
    </figure>
  );
}

export function WorkbenchPreview(): React.ReactElement {
  installStubs();
  const files = ['docs/ARCHITECTURE.md', 'src/api/client.ts'];
  return (
    <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <Stage theme="moonlight" chrome="windowed" label="file tab · glass" openFiles={files} tab={{ kind: 'file', path: 'src/api/client.ts' }} />
      <Stage theme="moonlight" chrome="windowed" label="lane · files" openFiles={files} tab={{ kind: 'lane', id: 'files' }} />
      <Stage theme="moonlight" chrome="expanded" label="lane · review (solid)" openFiles={files} tab={{ kind: 'lane', id: 'review' }} />
      <Stage theme="starlight" chrome="windowed" label="starlight · file tab" openFiles={files} tab={{ kind: 'file', path: 'docs/ARCHITECTURE.md' }} />
      <Stage theme="starlight" chrome="expanded" label="starlight · github (solid)" openFiles={files} tab={{ kind: 'lane', id: 'github' }} />
      <Stage theme="moonlight" chrome="windowed" label="no files open" openFiles={[]} tab={{ kind: 'lane', id: 'files' }} />
      {/* Widened: above the container query's 640pt the lane names come back, which is the whole
          reason the rule measures the panel rather than the window. */}
      <Stage theme="moonlight" chrome="windowed" label="widened · 900pt" openFiles={files} tab={{ kind: 'file', path: 'src/api/client.ts' }} width={900} />
    </div>
  );
}
