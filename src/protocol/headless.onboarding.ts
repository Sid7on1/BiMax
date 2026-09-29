import { engineEvents, MessageEntry } from '../engine/events';
import { isCodebase, summarizeGraph } from '../graph/graph.summary';
import { getConfig, saveConfig } from '../engine/config';

/**
 * First-run onboarding (parity with Ink's FullScreen): inside a real project with no map yet,
 * offer to build the AST index; once it exists, offer the AI (semantic) layer. Each offer is a
 * menu the front-end renders; selecting an option dispatches the matching slash command. Both are
 * gated on config.onboardingComplete so we never nag twice. Off entirely outside a codebase, so a
 * scratch dir (~ / Desktop) never indexes hundreds of thousands of junk nodes.
 * The payload carries the SAME id as the message so both front-ends correlate a selection the
 * same way (the desktop replies with the message id, the TUI with payload.id). These onboarding
 * menus have no engine-side onSelect: every option value is a slash command the front-end's
 * menuSelect dispatches directly.
 *
 * Split out of startHeadless (flaw list C19). Returns the function that stops listening for the finished map; the listener used
 * to outlive the session.
 */
export function startIndexOnboarding(deps: { graphStore: any; codebaseIndexer: any }): () => void {
  const { graphStore, codebaseIndexer } = deps;
  const uiMenu = (title: string, options: any[]): MessageEntry => {
    const id = `ui-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    return {
      id,
      role: 'system',
      uiComponent: 'menu',
      payload: { id, title, options },
      content: '',
      timestamp: new Date(),
    };
  };
  let aiOffered = false;
  let mapOffered = false;
  const onboardingDone = () => {
    try {
      return !!getConfig().onboardingComplete;
    } catch {
      return false;
    }
  };
  const nodeCount = () => {
    try {
      return summarizeGraph(graphStore).nodeCount;
    } catch {
      return 0;
    }
  };

  // After a map is built, offer the AI graph once (the indexer emits graph_changed on completion).
  const onGraphChanged = () => {
    if (aiOffered || onboardingDone()) return;
    let s;
    try {
      s = summarizeGraph(graphStore);
    } catch {
      return;
    }
    if (s.nodeCount > 0 && !s.aiGraphBuilt) {
      aiOffered = true;
      try {
        saveConfig({ onboardingComplete: true } as any);
      } catch {
        /* best-effort */
      }
      engineEvents.emit(
        'message',
        uiMenu('Add the AI graph? (semantic layer: purpose + risk per symbol)', [
          { label: 'Build AI graph', value: '/index-ai force', desc: 'Makes API calls — richer impact analysis' },
          { label: 'Skip', value: '', desc: 'You can run /index-ai later' },
        ]),
      );
    }
  };
  engineEvents.on('graph_changed', onGraphChanged);

  // BIMAX_AUTO_INDEX=0: a supervising front-end sheds background indexing on memory-constrained
  // machines (capability `autoIndex`). Config keeps working for everyone else.
  const autoIndexEnabled = () => {
    if (process.env.BIMAX_AUTO_INDEX === '0') return false;
    try {
      return getConfig().autoIndex !== false;
    } catch {
      return true;
    }
  };

  if (isCodebase(process.cwd()) && nodeCount() === 0) {
    if (autoIndexEnabled()) {
      // autoIndex: true → build the graph in the background automatically (idempotent: autoIndex()
      // no-ops if a graph already exists on disk). THIS is what unlocks the repo map + GraphContext/
      // GraphQuery tools without the user clicking a menu or running /index. Previously "autoIndex"
      // only flipped an enabled flag and nothing ever called it, so the graph stayed empty.
      engineEvents.emit('status', 'Indexing codebase for symbol-level navigation…');
      void codebaseIndexer.autoIndex(false, false).catch(() => {
        /* best-effort; /index retries */
      });
    } else if (!onboardingDone()) {
      // autoIndex off → ask before building (the original onboarding menu).
      setTimeout(() => {
        if (mapOffered || nodeCount() !== 0 || onboardingDone()) return;
        // Record that the question was ASKED, before asking it — exactly what the AI-graph offer
        // above does. Without this the prompt had no memory at all: "Skip" carries `value: ''`,
        // which sends nothing to the engine, so declining recorded nothing and the next engine
        // process asked again. On a memory-constrained box that is every session, because
        // `resources.ts` sets BIMAX_AUTO_INDEX=0 under the `minimal` profile and this branch is
        // the one that runs. Reported live: the same repo, the same chat tab, asked over and over.
        //
        // The file comment two blocks up already states the intent — "gated on
        // config.onboardingComplete so we never nag twice" — and it was true of the AI-graph offer
        // and never of this one. `mapOffered` additionally covers repeats inside one process.
        mapOffered = true;
        try {
          saveConfig({ onboardingComplete: true } as any);
        } catch {
          /* best-effort — an unwritable project dir must not block the prompt itself */
        }
        engineEvents.emit(
          'message',
          // Labels are DATA, not presentation. These carried literal square brackets —
          // "[ Build map graph ]" — which is terminal decoration, and the desktop app renders the
          // label verbatim into a button. The result was a GUI card that looked like a TUI prompt.
          // A front-end that wants brackets can add them; one that doesn't cannot remove them.
          uiMenu('New codebase detected — build the map graph?', [
            {
              label: 'Build map graph',
              value: '/index force',
              desc: 'AST index so I navigate to the exact symbol (skips node_modules, .git, build dirs)',
            },
            { label: 'Skip', value: '', desc: 'You can run /index later' },
          ]),
        );
      }, 600);
    }
  }
  return () => { engineEvents.off('graph_changed', onGraphChanged); };
}
