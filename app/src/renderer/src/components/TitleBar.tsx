import React from 'react';
import { PanelLeft, PanelRight } from 'lucide-react';
import { cn } from '../lib/cn';
import { BrandMark } from './BrandMark';

/**
 * THERE IS NO TITLE BAR ANY MORE. This file holds the two clusters it dissolved into.
 *
 * It used to be one full-width `<header>` with its own material and a hairline under it, sitting
 * above both the sidebar and the content. Measured on Cursor 2026-09-19 (`front inspo/10-cursor`):
 * that app has no such strip — the canvas and the sidebar both run to `y = 0`, and the controls
 * float *on* those surfaces rather than on a lid above them. That is what makes it read as one
 * continuous thing, and it is also the edge-to-edge sidebar macOS 27 asks for.
 *
 * So the strip is gone and its contents split by which surface they belong to:
 *   `SidebarChrome` — the traffic-light gutter, the sidebar toggle, the wordmark. Lives INSIDE
 *                     `TaskSidebar`, so the glass runs unbroken from y=0 to the footer.
 *   `CanvasChrome`  — project, branch, browser, evidence, appearance. Floats over the content pane.
 *
 * Neither paints a background or draws a border. Both are `drag-region`, which is what keeps the
 * window draggable now that no bar spans the top; the controls inside them are `no-drag`.
 *
 * The task's own state moved to `TaskHeader` — `examples/CURRENT_BIMAX_UI.md` recorded the defect
 * of a verification badge living up here, far from the evidence it referred to.
 */
export function CanvasChrome({
  project, protocolMismatch, sidebarHoldsEdge, onToggleSidebar, onPeekSidebar,
  inspectorOpen, onToggleInspector,
}: {
  project: string;
  protocolMismatch: number | null;
  /**
   * Whether a sidebar surface actually occupies the window's top-left corner right now.
   *
   * NOT the same as "the sidebar is open", and conflating them was a real defect: with no project
   * loaded the sidebar is not rendered at all, yet `sidebarOpen` is still true from its default, so
   * this row skipped the traffic-light gutter and the window's own lights were drawn straight
   * through the project button. The predicate is layout, not intent — see App.tsx.
   *
   * A transient peek deliberately does not count: the panel is an overlay, and shifting this row on
   * hover is the same reflow-on-hover bug the peek contract exists to avoid.
   */
  sidebarHoldsEdge: boolean;
  onToggleSidebar: () => void;
  onPeekSidebar?: () => void;
  /** The right panel's state, and the one control that opens it. */
  inspectorOpen?: boolean;
  onToggleInspector?: () => void;
}): React.ReactElement {
  return (
    /*
      Deliberately almost empty (owner, 2026-09-19). This row used to carry the project picker, the
      browser lane, the branch and change counts, the evidence toggle and the appearance menu. All
      of it is gone from the top: the project and branch are already stated directly above the
      composer, where they describe the thing you are about to act on; evidence and appearance moved
      to the sidebar footer; the browser lane was removed from the product.

      Two things stay, and both are structural rather than decorative:
        - the pin toggle, ONLY while the sidebar is away — it is otherwise the sole way back, and a
          panel you cannot reopen is a panel you have lost;
        - the right panel's toggle, at the far right (owner, 2026-09-19). It lived in the sidebar's
          footer, which put "show the panel on the RIGHT" in the bottom-LEFT corner — as far from
          the thing it opens as the window allows, and invisible whenever the sidebar was away;
        - the protocol-mismatch badge, which is a refusal to run, not a control.

      The row itself still earns its height: it is the `drag-region` that replaces the title bar, and
      it holds the traffic lights' gutter whenever the sidebar is not there to hold it.
    */
    <div
      className={cn(
        'drag-region flex h-11 shrink-0 items-center gap-2 pr-3 select-none',
        sidebarHoldsEdge ? 'pl-3' : 'pl-[76px]',
      )}
    >
      {project && !sidebarHoldsEdge && (
        <IconBtn
          title="Pin tasks open (⌘B)"
          /*
            Hover and click are DIFFERENT actions, and conflating them was the bug: `onHover` used
            to call this same toggle, so pointing at the button latched the panel open with no way
            back — "it comes but it never goes".
              hover → peek   (transient; ends when the pointer leaves the panel)
              click → pin    (sticky; only another click releases it)
          */
          onClick={onToggleSidebar}
          onHover={onPeekSidebar}
        >
          <PanelLeft size={16} />
        </IconBtn>
      )}
      <span className="flex-1" />
      {project && onToggleInspector && (
        <IconBtn
          title="Show or hide the right panel (⌘J)"
          onClick={onToggleInspector}
          active={inspectorOpen}
        >
          <PanelRight size={16} />
        </IconBtn>
      )}
      {protocolMismatch !== null && (
        <span className="no-drag shrink-0 rounded-lg px-2 py-1 text-xs text-rust">
          Bimax needs an update
        </span>
      )}
    </div>
  );
}

export function SidebarChrome({
  sidebarOpen, onToggleSidebar,
}: {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}): React.ReactElement {
  return (
    <div className="drag-region flex h-11 shrink-0 items-center gap-1.5 pr-2 pl-[76px] select-none">
      <IconBtn
        title={sidebarOpen ? 'Unpin tasks (⌘B)' : 'Pin tasks open (⌘B)'}
        active={sidebarOpen}
        onClick={onToggleSidebar}
      >
        <PanelLeft size={16} />
      </IconBtn>
      <BrandMark className="text-[12px]" />
    </div>
  );
}

function IconBtn({
  title, active, onClick, onHover, children,
}: {
  title: string;
  active?: boolean;
  onClick: () => void;
  onHover?: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
      onMouseEnter={onHover}
      className={cn(
        'no-drag flex size-7 cursor-pointer items-center justify-center rounded-md hover:bg-hover focus-visible:outline-2 focus-visible:outline-ember',
        active ? 'text-ink' : 'text-faint',
      )}
    >
      {children}
    </button>
  );
}
