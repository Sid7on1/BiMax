import { useCallback, useEffect, useRef, useState } from 'react';
import type { GitStatusResult, StampedGitStatus } from './global';
import { SingleFlightRefresh } from './refresh.controller';

/**
 * One git-status poller for the whole shell: the TitleBar changes-pill and the Review panel both
 * read from here. Refresh cadence = 4s poll + the main-process fs watcher's fast path (the
 * watcher ignores .git, so commits made in the embedded terminal surface via the poll).
 *
 * The poll and the watcher used to call `git.status()` directly, so a burst of file changes started
 * a burst of overlapping reads and any of them could land on a project the user had already left.
 * Both are now handled by `SingleFlightRefresh`, which keeps one read in flight, folds everything
 * that arrives during it into a single follow-up, and drops replies stamped with a retired project
 * or generation. The 4s interval stays as the slow reconciliation path.
 */
export function useGit(project: string): { status: GitStatusResult | null; refresh: () => void } {
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const controller = useRef<SingleFlightRefresh<StampedGitStatus> | null>(null);

  useEffect(() => {
    setStatus(null);
    // Every branch returns a cleanup, so the effect's contract does not depend on which one ran.
    if (!project) { controller.current = null; return () => { /* nothing was wired up */ }; }

    const refresher = new SingleFlightRefresh<StampedGitStatus>({
      expectedProject: project,
      fetch: () => window.bimax.git.status(),
      stampOf: (value) =>
        typeof value?.project === 'string' && typeof value?.generation === 'number'
          ? { project: value.project, generation: value.generation }
          : null,
      onResult: setStatus,
    });
    controller.current = refresher;
    refresher.request();

    const id = setInterval(() => refresher.request(), 4000);
    // Both broadcasts carry the live generation, so the fence learns a project switch from whichever
    // one arrives first rather than from a reply it has already accepted.
    const offFiles = window.bimax.files.onChanged((generation) => {
      refresher.setGeneration(generation);
      refresher.request();
    });
    const offProject = window.bimax.onProject((_dir, generation) => refresher.setGeneration(generation));

    return () => {
      clearInterval(id);
      offFiles();
      offProject();
      refresher.dispose();
      controller.current = null;
    };
  }, [project]);

  const refresh = useCallback(() => { controller.current?.request(); }, []);

  return { status, refresh };
}
