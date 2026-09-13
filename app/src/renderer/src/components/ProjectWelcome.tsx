import React, { useEffect, useMemo, useState } from 'react';
import { ArrowRight, FolderOpen, History } from 'lucide-react';
import { BrandMark } from './BrandMark';

function projectName(project: string): string {
  return project.split('/').filter(Boolean).pop() || project;
}

function parentPath(project: string): string {
  const parts = project.split('/').filter(Boolean);
  return parts.length > 1 ? `/${parts.slice(0, -1).join('/')}` : project;
}

/**
 * First-run / no-project experience. Bimax used to silently boot against $HOME, which looked
 * superficially usable but broke Git, graph, genome, and project-scoped memory. This gate makes
 * workspace selection an explicit product decision and provides a fast path back to recent work.
 */
export function ProjectWelcome(): React.ReactElement {
  const [recents, setRecents] = useState<string[]>([]);
  const [opening, setOpening] = useState<string | 'picker' | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    void window.bimax.recentProjects()
      .then((projects) => { if (live) setRecents(projects); })
      .catch(() => { if (live) setRecents([]); });
    return () => { live = false; };
  }, []);

  const visibleRecents = useMemo(() => recents.slice(0, 6), [recents]);

  const chooseFolder = async (): Promise<void> => {
    setOpening('picker');
    setError('');
    try {
      await window.bimax.pickFolder();
    } catch {
      setError('Bimax could not open the project picker. Try again.');
    } finally {
      setOpening(null);
    }
  };

  const openRecent = async (project: string): Promise<void> => {
    setOpening(project);
    setError('');
    try {
      const opened = await window.bimax.openProject(project);
      if (!opened) {
        setRecents((items) => items.filter((item) => item !== project));
        setError('That project is no longer available. Choose its new location.');
      }
    } catch {
      setError('Bimax could not open that project.');
    } finally {
      setOpening(null);
    }
  };

  return (
    <main className="project-welcome home-canvas relative flex min-h-0 flex-1 overflow-y-auto">
      <div className="workspace-home-content">
        <div className="anim-fade-up flex items-center gap-3">
          <BrandMark className="text-[13px]" />
          <span className="text-xs font-medium tracking-[0.12em] text-faint uppercase">Welcome to BiMAX</span>
        </div>
        <h1 className="anim-fade-up font-display mt-4 max-w-[650px] text-[40px] leading-[1.06] font-semibold tracking-[-0.04em] text-ink" style={{ animationDelay: '50ms' }}>
          Great work starts here.
        </h1>
        <p className="anim-fade-up mt-4 max-w-[620px] text-[14px] leading-relaxed text-dim" style={{ animationDelay: '90ms' }}>
          Bring a project. Make it yours. A focused workspace for your ideas, code, and everything that comes next.
        </p>

        <div className="anim-fade-up mt-8 flex flex-wrap gap-2.5" style={{ animationDelay: '130ms' }}>
          <button
            onClick={() => void chooseFolder()}
            disabled={opening !== null}
            className="flex cursor-pointer items-center gap-2 rounded-xl bg-ember px-4 py-2.5 text-[13px] font-semibold text-bg shadow-[0_10px_28px_rgba(0,0,0,0.16)] transition hover:-translate-y-0.5 hover:bg-ember-bright disabled:cursor-wait disabled:opacity-60"
          >
            <FolderOpen size={16} />
            {opening === 'picker' ? 'Opening…' : 'Open project'}
          </button>
          <span className="flex items-center px-1 text-xs text-faint">or press ⌘O anywhere</span>
        </div>

        {error && (
          <div className="anim-fade-up mt-4 max-w-[620px] rounded-lg border border-rust/30 bg-rust/10 px-3 py-2 text-xs text-rust">
            {error}
          </div>
        )}

        <section className="anim-fade-up mt-12" style={{ animationDelay: '180ms' }}>
          <div className="mb-3 flex items-center gap-2 text-[11px] font-medium tracking-[0.1em] text-faint uppercase">
            <History size={13} /> Recent projects
          </div>
          {visibleRecents.length > 0 ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {visibleRecents.map((project, index) => (
                <button
                  key={project}
                  onClick={() => void openRecent(project)}
                  disabled={opening !== null}
                  className="anim-fade-up group flex min-w-0 cursor-pointer items-center gap-3 rounded-xl border border-line bg-raise/55 px-4 py-3 text-left transition hover:border-ember/35 hover:bg-hover disabled:cursor-wait disabled:opacity-60"
                  style={{ animationDelay: `${210 + index * 35}ms` }}
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-ember/15 bg-ember/10 text-ember">
                    <FolderOpen size={16} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-ink">{projectName(project)}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-faint">{parentPath(project)}</span>
                  </span>
                  <ArrowRight size={14} className="shrink-0 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-ember" />
                </button>
              ))}
            </div>
          ) : (
            <div className="max-w-[620px] rounded-xl border border-dashed border-line bg-raise/30 px-4 py-4 text-xs leading-relaxed text-faint">
              Your recent projects will appear here after you open the first one.
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
