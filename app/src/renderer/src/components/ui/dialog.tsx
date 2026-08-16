import React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cn } from '../../lib/cn';
import { destinationFor, type DestinationKind } from './morph/geometry';
import { useMorphDriver } from './morph/use-morph';
import { useIntentSeed } from './morph/use-seed';

/**
 * shadcn-pattern Dialog on Radix primitives — real focus trap, aria-modal, focus restore.
 * `locked` disables Esc/overlay dismissal: the engine's prompt round-trips (governor veto, diff
 * approval) block the agent loop until answered, so the modal must not silently close.
 *
 * ## Which dialogs morph, and why most of them do not
 *
 * The first version of this file put the seeded flight in the component, so **every** dialog in the
 * app grew out of whatever control the user had last pressed and a dialog added later got it without
 * opting in. That was defended here as "the only version of 'every component has the same animation'
 * that stays true", and it is a straight violation of Prompt 2 §42:
 *
 *   > Use Seed Morph selectively. It is the signature, not a mandate. […] Keep standard system
 *   > behaviour for context menus, menus, alerts, file choosers, permissions and native sheets.
 *
 * A signature that fires on every surface is not a signature, it is a default — and the specific
 * cost is that the surfaces where the spatial claim is *false* make it anyway. The Trust Center is
 * not the button that opened it. An engine-raised approval prompt did not come out of anything the
 * user pressed. So the default here is `standard`, and morphing is something a call site asks for:
 *
 * | Dialog | Motion | Why |
 * |---|---|---|
 * | Models | `seeded` | §42 names `model button→picker` as the case the morph exists for |
 * | Command palette | `materialize` | §45: no spatial seed from ⌘K, and none invented from a click |
 * | Settings | `standard` | §67 — settings does not need the strongest morph |
 * | Trust Center | `standard` | §42 — permissions |
 * | Machine health, engine request | `standard` | §42 — alerts |
 * | Workspace sheet | `standard` | §42 — native sheets |
 *
 * `standard` is not "no animation": it is the app's own dialog entrance (`anim-dialog-in`, a spring
 * compiled to `linear()` by `./motion`), which is composited on the GPU and keeps playing through a
 * main-thread stall. Prompt 1 §36 asks for no duplicate animation systems, and this is not one —
 * it is the *same* spring system, used where the destination is known at launch and never moves.
 *
 * ## Why the standard path lets Radix own mounting and the morph path does not
 *
 * Radix's `Presence` keeps a closing element mounted by watching for a CSS *animation* to end. That
 * is exactly what `standard` is, so Radix handles it and this file adds nothing. The morph is a
 * spring over a geometry only known at runtime, which `Presence` cannot see — a plain
 * `<DialogContent>` would be torn out of the DOM on the first frame of its own exit. Hence
 * `forceMount` on that path only, where `open` is the caller's intent and the gap between
 * `open === false` and the driver going inactive is exactly the collapse.
 */

/** Lets `DialogContent` see the open state that `Dialog` was given, so it can own the exit. */
const OpenContext = React.createContext<boolean>(false);

export function Dialog({
  open = false, children, ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Root>): React.ReactElement {
  return (
    <OpenContext.Provider value={open}>
      <DialogPrimitive.Root open={open} {...props}>{children}</DialogPrimitive.Root>
    </OpenContext.Provider>
  );
}

export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;

/**
 * How this dialog arrives.
 *
 * - `standard` — a Mac sheet. Centred, scales up a little, fades. The default.
 * - `seeded` — grows out of the control the user pressed and folds back into it.
 * - `materialize` — driven by the morph so it can be *placed* by `destinationFor` and resize live,
 *   but with no origin: it appears where it lands (Prompt 2 §45).
 */
export type DialogMotion = 'standard' | 'seeded' | 'materialize';

type BaseProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
  locked?: boolean;
  /**
   * What this surface is, semantically (Prompt 2 §43).
   *
   * Decides where a driven surface lands and how it is dressed. Read only by the `seeded` and
   * `materialize` paths — a standard dialog is placed by CSS, because its box never moves and a
   * layout model for a static centred sheet is a second thing to keep in agreement with the
   * stylesheet.
   */
  kind?: Extract<DestinationKind, 'floatingPanel' | 'palette' | 'workspaceSurface'>;
  motion?: DialogMotion;
};

export const DialogContent = React.forwardRef<HTMLDivElement, BaseProps>(
  ({ motion = 'standard', ...rest }, ref) => (
    motion === 'standard'
      ? <StandardDialogContent ref={ref} {...rest} />
      : <MorphDialogContent ref={ref} seeded={motion === 'seeded'} {...rest} />
  ),
);
DialogContent.displayName = 'DialogContent';

/* ----------------------------------------------------------------- standard */

/**
 * A Mac sheet: centred, entered on the house spring, and mounted entirely by Radix.
 *
 * Nothing here is driven per frame, which is the point — the whole entrance is one compositor
 * animation, so it does not care that the renderer is busy streaming markdown into the transcript.
 */
const StandardDialogContent = React.forwardRef<HTMLDivElement, Omit<BaseProps, 'motion'>>(
  ({ className, style, locked, kind: _kind, children, ...props }, forwardedRef) => {
    const block = locked ? (event: { preventDefault: () => void }) => event.preventDefault() : undefined;

    return (
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            'fixed inset-0 z-50 bg-[#0a0807]/45 backdrop-blur-[3px]',
            'anim-fade-in data-[state=closed]:anim-fade-out',
          )}
        />
        <DialogPrimitive.Content
          ref={forwardedRef}
          onEscapeKeyDown={block}
          onPointerDownOutside={block}
          onInteractOutside={block}
          className={cn(
            'fixed top-1/2 left-1/2 z-50',
            // Tailwind v4 writes these to the native `translate` property, which composes with
            // `transform` rather than overwriting it — so the centring survives a keyframe that
            // scales, and neither has to know about the other.
            '-translate-x-1/2 -translate-y-1/2',
            'anim-dialog-in data-[state=closed]:anim-dialog-out',
            'liquid-glass liquid-glass-panel overflow-hidden rounded-[22px] focus:outline-none',
          )}
          {...props}
        >
          {/*
            The caller's box: its className, its style, its children as direct descendants. Kept as
            a separate element even though nothing is driven here, so that `className` lands in the
            same place on both paths — a dialog that laid out differently depending on how it
            animated would be a trap for whoever writes the next one.
          */}
          <div
            className={cn('max-h-[80vh] w-[min(680px,calc(100vw-min(64px,40vw)))] overflow-y-auto p-5', className)}
            style={style}
          >
            {children}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    );
  },
);
StandardDialogContent.displayName = 'StandardDialogContent';

/* -------------------------------------------------------------------- morph */

/**
 * ## Why Radix still owns the node
 *
 * The alternative — rendering the dialog *inside* a `MorphSurface` — would put our portal between
 * Radix's Content and its Portal, and Radix's focus trap, `aria-modal`, outside-press detection and
 * focus restore are all things this app relies on and none of them are worth reimplementing for an
 * animation. So the morph drives the node Radix already made: `useMorphDriver` writes the geometry
 * onto `Content` and reveals the box inside it. Radix keeps every guarantee; the motion is ours.
 *
 * ## Why there are two boxes
 *
 * The shell carries the geometry — position, size, radius, material — and the inner box carries the
 * caller's layout. They cannot be one element: dialogs put their layout on `DialogContent`
 * (`flex-row` for Settings' nav-plus-page, `flex-col` for Models) and address their children
 * directly, so a wrapper *inside* would collapse those layouts to a single item.
 *
 * The inner box is also what makes the reveal honest: it is laid out once at the destination's size
 * and then *clipped* by the growing shell (Prompt 1 §13), so no text is ever scaled.
 */
const MorphDialogContent = React.forwardRef<HTMLDivElement, Omit<BaseProps, 'motion'> & { seeded: boolean }>(
  ({ className, style, locked, kind = 'floatingPanel', seeded, children, ...props }, forwardedRef) => {
    const open = React.useContext(OpenContext);
    /*
      The nodes live in state, not in refs, and that is load-bearing.

      Radix's `Portal` returns `null` on its own first render — it sets a `mounted` flag in a layout
      effect so that server rendering has no `document.body` to reach for. So on the commit where
      this component first renders its tree, the content element does NOT exist yet, and a layout
      effect reading `ref.current` here sees null. A ref would then never be revisited: the effect's
      dependencies have not changed by the time the portal actually mounts, so the flight is simply
      never started and every dialog silently falls back to appearing. (Measured exactly that.)

      A callback ref that writes to state turns "the node arrived" into a render, which is a
      dependency the effect can wait on.
    */
    const [shell, setShell] = React.useState<HTMLDivElement | null>(null);
    const [box, setBox] = React.useState<HTMLDivElement | null>(null);
    const boxNode = React.useRef<HTMLDivElement | null>(null);
    const setBoxNode = React.useCallback((node: HTMLDivElement | null) => {
      boxNode.current = node;
      setBox(node);
    }, []);

    const seed = useIntentSeed();
    /**
     * The width the caller's box wants, measured once from its own CSS.
     *
     * Every dialog states its size in classes — `w-[min(760px,calc(100vw-40px))]` — and the morph
     * needs that as a number, because a spring cannot animate toward `min()`. Measuring beats
     * duplicating it as a prop: a second declaration is a second thing to keep in agreement, and
     * when they disagree the surface flies smoothly to the wrong size, which reads as deliberate.
     *
     * Taken on the opening commit, while the box is still laid out by its own class — after that
     * the width is pinned, and re-reading would only measure the pin.
     */
    const naturalWidth = React.useRef<number | null>(null);
    const [width, setWidth] = React.useState<number | null>(null);

    const resolve = React.useCallback(() => {
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const origin = seed.measure();
      const node = boxNode.current;
      if (node && naturalWidth.current === null) {
        const rect = node.getBoundingClientRect();
        if (rect.width > 1) naturalWidth.current = rect.width;
      }
      // Height is measured *live*, every time. The command palette is the reason: its list shrinks
      // as the query filters, and a sheet pinned to the height it opened at would leave a growing
      // block of empty glass under the results. Because this is a spring and not a timeline, a new
      // height is simply a new target — the surface resizes as you type instead of at the end of it.
      const height = node?.getBoundingClientRect().height;
      // `destinationFor` re-clamps against the *current* window every time it is asked, so a window
      // dragged smaller mid-flight shrinks the target rather than leaving the sheet hanging off the
      // edge — the natural size is a preference, not a promise.
      return {
        // The origin is still resolved when it is only wanted for *placement*: `destinationFor`
        // anchors some kinds to their seed, and withholding it from the flight must not silently
        // move the surface. Only the launch is denied one (Prompt 2 §45).
        seed: seeded ? origin : null,
        destination: destinationFor(
          { kind, width: naturalWidth.current ?? 560, height: height && height > 1 ? height : undefined },
          viewport,
          origin,
        ),
      };
    }, [kind, seed, seeded]);

    const elements = React.useMemo(() => (shell ? { surface: shell, content: box } : null), [shell, box]);

    const { active, controller } = useMorphDriver({
      open,
      kind: () => kind,
      resolve,
      // The box's own height is the target, so a change in it has to reach the spring. Nothing else
      // reports it: filtering a list fires no resize event and moves no window.
      observe: box,
      elements,
    });

    // The box's width as a layout value, set at the edges of a flight rather than per frame — it is
    // laid out once and then merely clipped by the shell growing over it (Prompt 1 §13).
    React.useLayoutEffect(() => {
      if (!active) {
        naturalWidth.current = null;
        setWidth(null);
        return;
      }
      // Nothing to measure yet — the portal above renders null on its first commit. Pinning a
      // fallback width here would be worse than doing nothing: the box would arrive already wearing
      // it, and the "natural" width measured a moment later would be the pin reading itself back.
      if (!box) return;
      setWidth(resolve().destination.width);
    }, [active, box, resolve]);

    React.useEffect(() => {
      if (!active) return;
      const onResize = (): void => {
        setWidth(resolve().destination.width);
        controller()?.remeasure();
      };
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }, [active, resolve, controller]);

    if (!active) return null;

    const block = locked ? (event: { preventDefault: () => void }) => event.preventDefault() : undefined;

    return (
      <DialogPrimitive.Portal forceMount>
        <DialogPrimitive.Overlay
          forceMount
          className={cn(
            'fixed inset-0 z-50 bg-[#0a0807]/45 backdrop-blur-[3px]',
            open ? 'anim-fade-in' : 'anim-fade-out',
          )}
        />
        <DialogPrimitive.Content
          forceMount
          ref={mergeRefs(setShell, forwardedRef)}
          onEscapeKeyDown={block}
          onPointerDownOutside={block}
          onInteractOutside={block}
          className={cn(
            // No positioning classes: `armSurface` pins this to `fixed; left: 0; top: 0` and the
            // driver writes the real geometry. A `-translate-x-1/2` here would be a second writer of
            // the same property, and whoever writes last silently wins.
            'morph-surface z-50 overflow-hidden',
            'liquid-glass liquid-glass-panel focus:outline-none',
          )}
          {...props}
        >
          <div
            ref={setBoxNode}
            className={cn('absolute top-0 left-0 max-h-[80vh] w-[min(680px,calc(100vw-min(64px,40vw)))] overflow-y-auto p-5', className)}
            style={width !== null ? { width: `${Math.round(width)}px`, ...style } : style}
          >
            {children}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    );
  },
);
MorphDialogContent.displayName = 'MorphDialogContent';

/** Radix hands callers a ref to the content node; the flight needs the same node. */
function mergeRefs<T>(...refs: (React.Ref<T> | undefined)[]): React.RefCallback<T> {
  return (value) => {
    for (const ref of refs) {
      if (typeof ref === 'function') ref(value);
      else if (ref) (ref as React.MutableRefObject<T | null>).current = value;
    }
  };
}
