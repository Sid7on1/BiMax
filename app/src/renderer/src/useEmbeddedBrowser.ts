import { useCallback, useEffect, useState } from 'react';
import type { EmbeddedBrowserState } from './global';

/**
 * State for the embedded research browser lane.
 *
 * The pages themselves live in main-process `WebContentsView`s, never in this document — so there
 * is nothing here to render and everything here is a description of what main should do. Every
 * channel returns the WHOLE lane state rather than an acknowledgement, which is what keeps the tab
 * strip in step with a navigation the page started on its own (a redirect, a link click): one
 * round-trip, one authoritative answer, no local mirror to drift.
 */
export interface EmbeddedBrowserApi {
  tabs: EmbeddedBrowserState['tabs'];
  activeTabId: string | null;
  /** True until the first state has arrived, so the lane can avoid flashing an empty tab strip. */
  loading: boolean;
  newTab: () => void;
  selectTab: (id: string) => void;
  closeTab: (id: string) => void;
  navigate: (url: string) => void;
  back: () => void;
  forward: () => void;
  reload: () => void;
}

const EMPTY: EmbeddedBrowserState = { tabs: [], activeTabId: null };

export function useEmbeddedBrowser(active: boolean): EmbeddedBrowserApi {
  const [state, setState] = useState<EmbeddedBrowserState>(EMPTY);
  const [loading, setLoading] = useState(true);

  const api = window.bimax?.embeddedBrowser;

  const apply = useCallback((next: unknown) => {
    // Main answers with the lane state, or with the channel's fallback when a sender is refused.
    // Treating a malformed answer as "no change" keeps a refused call from blanking the tab strip.
    if (next && typeof next === 'object' && Array.isArray((next as EmbeddedBrowserState).tabs)) {
      setState(next as EmbeddedBrowserState);
    }
    setLoading(false);
  }, []);

  /**
   * Show the native view only while this lane is on screen.
   *
   * A `WebContentsView` is painted ABOVE the renderer by the OS. It has no z-index and no clipping
   * relative to React's tree, so a view left visible while the user is in the chat lane would sit
   * on top of the conversation as an opaque rectangle. Visibility is therefore tied to the lane,
   * and hiding is what a lane switch does first.
   */
  useEffect(() => {
    if (!api) return;
    api.setVisible(active);
    if (!active) return;
    void api.state().then(apply);
    return () => api.setVisible(false);
  }, [active, api, apply]);

  // Opening the lane for the first time with nothing loaded should land somewhere, not on a blank
  // frame with a tab strip the user has to discover.
  useEffect(() => {
    if (!api || !active || loading) return;
    if (state.tabs.length === 0) void api.newTab().then(apply);
  }, [api, active, loading, state.tabs.length, apply]);

  const call = useCallback(
    (fn: (() => Promise<unknown>) | undefined) => { if (fn) void fn().then(apply); },
    [apply],
  );

  return {
    tabs: state.tabs,
    activeTabId: state.activeTabId,
    loading,
    newTab: () => call(api && (() => api.newTab())),
    selectTab: (id) => call(api && (() => api.selectTab(id))),
    closeTab: (id) => call(api && (() => api.closeTab(id))),
    navigate: (url) => call(api && (() => api.navigate(url))),
    back: () => call(api && (() => api.back())),
    forward: () => call(api && (() => api.forward())),
    reload: () => call(api && (() => api.reload())),
  };
}
