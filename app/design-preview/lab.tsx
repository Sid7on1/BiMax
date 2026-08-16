import React, { useCallback, useMemo, useRef, useState } from 'react';
import { MorphSurface } from '../src/renderer/src/components/ui/morph/MorphSurface';
import { MorphDebug } from '../src/renderer/src/components/ui/morph/debug';
import { setTimeScale, type MorphFrame } from '../src/renderer/src/components/ui/morph/controller';
import { destinationFor, type DestinationKind, type MorphGeometry } from '../src/renderer/src/components/ui/morph/geometry';
import { useSeedRef } from '../src/renderer/src/components/ui/morph/use-seed';
import { MorphRegion } from '../src/renderer/src/components/ui/morph/MorphRegion';
import { SeedMenu, SeedMenuItem, SeedMenuLabel, SeedMenuReadout, SeedMenuSeparator } from '../src/renderer/src/components/ui/morph/SeedMenu';
import { ComposerPill } from '../src/renderer/src/components/Composer';
import { TitleBar } from '../src/renderer/src/components/TitleBar';
import { Cpu } from 'lucide-react';

/**
 * The Motion Lab (Prompt 1 §34, Prompt 2 §116).
 *
 * Two halves, because the two questions are different:
 *
 *   - **The stage** answers "does this look like one object transforming into another?" — nine
 *     seeds around a real frame, every destination kind, the debug overlay, and slow motion, because
 *     the brief's quality bar is explicitly a 0.25× one. At full speed a good morph and a cheap fade
 *     are hard to tell apart; every defect §117 lists is only visible slowed down.
 *   - **The matrix** answers "is the destination right at every window size?" — which is not a
 *     question about motion at all, and trying to answer it by resizing a window and watching is
 *     both slow and unreliable. `destinationFor` is pure, so the whole size × seed × kind grid can
 *     simply be *drawn*, and a clipped or mis-flipped placement is visible as a shape rather than
 *     as a moment you might have missed.
 */

const KINDS: DestinationKind[] = [
  'popover', 'palette', 'toolbarExpansion', 'floatingPanel', 'workspaceSurface', 'sidebar', 'inspector',
];

/** The nine seed positions the brief asks for. */
const SEEDS = [
  ['top-left', 'start', 'start'], ['top-center', 'center', 'start'], ['top-right', 'end', 'start'],
  ['center-left', 'start', 'center'], ['center', 'center', 'center'], ['center-right', 'end', 'center'],
  ['bottom-left', 'start', 'end'], ['bottom-center', 'center', 'end'], ['bottom-right', 'end', 'end'],
] as const;

/** Something for the glass to refract. Flat colour makes translucency unverifiable. */
const DESKTOP = 'linear-gradient(135deg, #1f3a5f 0%, #6d597a 34%, #b56576 62%, #eaac8b 100%)';

export function MotionLab(): React.ReactElement {
  const [kind, setKind] = useState<DestinationKind>('popover');
  const [openAt, setOpenAt] = useState<string | null>(null);
  const [debug, setDebug] = useState(true);
  const [scale, setScale] = useState(1);
  const [frame, setFrame] = useState<MorphFrame | null>(null);
  const [trail, setTrail] = useState<{ x: number; y: number }[]>([]);
  const stageRef = useRef<HTMLDivElement>(null);

  const speed = useCallback((value: number) => {
    setScale(value);
    setTimeScale(value);
  }, []);

  // The stage is the surface's world: the morph places itself inside this box rather than inside the
  // browser window, so a 1440x900 destination can be watched inside a 900x560 frame on a laptop.
  const bounds = useCallback(() => {
    const rect = stageRef.current?.getBoundingClientRect();
    return rect
      ? { width: rect.width, height: rect.height, originX: rect.left, originY: rect.top }
      : { width: window.innerWidth, height: window.innerHeight, originX: 0, originY: 0 };
  }, []);

  const onFrame = useCallback((next: MorphFrame) => {
    setFrame(next);
    setTrail((points) => {
      const centre = {
        x: next.geometry.x + next.geometry.width / 2,
        y: next.geometry.y + next.geometry.height / 2,
      };
      // Reset the trail whenever a new flight begins, otherwise the path from the last one is still
      // on screen and reads as this one having gone somewhere it did not.
      if (next.progress < 0.02 && points.length > 4) return [centre];
      return [...points.slice(-160), centre];
    });
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <Toolbar
        kind={kind} setKind={setKind}
        debug={debug} setDebug={setDebug}
        scale={scale} setScale={speed}
      />

      <div
        ref={stageRef}
        style={{
          position: 'relative', height: 560, borderRadius: 16, overflow: 'hidden',
          background: DESKTOP, boxShadow: '0 24px 60px rgba(0,0,0,.35)',
          display: 'grid',
          gridTemplate: 'repeat(3, 1fr) / repeat(3, 1fr)',
          padding: 18,
        }}
      >
        {SEEDS.map(([name, justify, align]) => (
          <div key={name} style={{ display: 'grid', justifyItems: justify, alignItems: align }}>
            <Seed
              name={name}
              kind={kind}
              open={openAt === name}
              onToggle={() => setOpenAt((current) => (current === name ? null : name))}
              onClosed={() => setFrame(null)}
              bounds={bounds}
              onFrame={onFrame}
            />
          </div>
        ))}
      </div>

      <MorphDebug
        enabled={debug}
        origin={null}
        destination={null}
        frame={frame}
        trail={trail}
      />

      <Drills onSet={setOpenAt} />
      <GoldenFlow />
      <GoldenFlowTwo />
      <ToolbarTiers />
      <PlacementMatrix kind={kind} />
    </div>
  );
}

/* ---------------------------------------------------------------- one seed */

function Seed({
  name, kind, open, onToggle, onClosed, bounds, onFrame,
}: {
  name: string;
  kind: DestinationKind;
  open: boolean;
  onToggle: () => void;
  onClosed: () => void;
  bounds: () => { width: number; height: number; originX: number; originY: number };
  onFrame: (frame: MorphFrame) => void;
}): React.ReactElement {
  const seed = useSeedRef();

  return (
    <>
      <button
        ref={seed.ref}
        onClick={onToggle}
        aria-expanded={open}
        className="glass-pill pressable flex size-11 cursor-pointer items-center justify-center rounded-full text-[10px] font-semibold text-ink"
        title={name}
      >
        {open ? '×' : '+'}
      </button>

      <MorphSurface
        open={open}
        seed={seed}
        kind={kind}
        bounds={bounds}
        onClosed={onClosed}
        onFrame={onFrame}
        role="dialog"
        aria-label={`${kind} from ${name}`}
        className={kind === 'popover' || kind === 'toolbarExpansion' ? 'liquid-glass-pop' : 'liquid-glass-panel'}
      >
        <header className="flex items-center justify-between border-b border-line/60 px-3.5 py-2.5">
          <span className="text-[12px] font-semibold text-ink">{kind}</span>
          <span className="font-mono text-[10px] text-faint">{name}</span>
        </header>
        <div className="space-y-2 p-3.5 text-[11.5px] leading-relaxed text-dim">
          <p>
            This surface is the button. Its box, its corner and its glass are one set of springs
            travelling from that control&apos;s rectangle to this one.
          </p>
          <p className="text-faint">
            Nothing here is scaled — the text was laid out at this size on the first frame and the
            shell simply grew past it. Watch the corner at 0.25×.
          </p>
          <div className="flex gap-1.5 pt-1">
            {['Work', 'Quick', 'Vision'].map((label) => (
              <span key={label} className="glass-pill rounded-lg px-2 py-1 text-[10.5px]">{label}</span>
            ))}
          </div>
        </div>
      </MorphSurface>
    </>
  );
}

/* ----------------------------------------------------------------- toolbar */

function Toolbar({
  kind, setKind, debug, setDebug, scale, setScale,
}: {
  kind: DestinationKind;
  setKind: (k: DestinationKind) => void;
  debug: boolean;
  setDebug: (v: boolean) => void;
  scale: number;
  setScale: (v: number) => void;
}): React.ReactElement {
  return (
    <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center', font: '500 12px/1.4 system-ui' }}>
      <Group label="destination">
        {KINDS.map((k) => (
          <Chip key={k} on={kind === k} onClick={() => setKind(k)}>{k}</Chip>
        ))}
      </Group>
      <Group label="speed">
        {/* 0.1x is below the brief's 0.25x quality bar on purpose: at a tenth speed a single
            still frame is a reliable sample of the middle of the flight, which is where radius
            pops, opacity flashes and shadow jumps live. It is the setting to use when comparing
            two tunings, not the one to judge the motion by. */}
        {[1, 0.5, 0.25, 0.1].map((s) => (
          <Chip key={s} on={scale === s} onClick={() => setScale(s)}>{s}×</Chip>
        ))}
      </Group>
      <Group label="debug">
        <Chip on={debug} onClick={() => setDebug(!debug)}>{debug ? 'on' : 'off'}</Chip>
      </Group>
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <span style={{ font: '600 10px/1 ui-monospace, monospace', letterSpacing: '.08em', textTransform: 'uppercase', color: '#8a8a85' }}>
        {label}
      </span>
      {children}
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }): React.ReactElement {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '4px 9px', borderRadius: 7, cursor: 'pointer', font: 'inherit',
        border: `1px solid ${on ? '#ffffff55' : '#ffffff22'}`,
        background: on ? '#ffffff1a' : 'transparent',
        color: on ? '#f5f5f4' : '#9a9a95',
      }}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ drills */

/**
 * The interruption matrix, played back at human speed (Prompt 2 §112).
 *
 * The controller tests already prove these are geometrically continuous. What they cannot answer is
 * whether a *reversal* reads as one object changing its mind or as two animations fighting, which is
 * a judgement and needs eyes. Set the speed to 0.25× first.
 */
function Drills({ onSet }: { onSet: (name: string | null) => void }): React.ReactElement {
  const run = useCallback(async (steps: [string | null, number][]) => {
    for (const [target, wait] of steps) {
      onSet(target);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }, [onSet]);

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', font: '500 12px/1.4 system-ui' }}>
      <Group label="drills">
        <Chip on={false} onClick={() => run([['center', 40], [null, 0]])}>close at ~10%</Chip>
        <Chip on={false} onClick={() => run([['center', 110], [null, 0]])}>close at ~30%</Chip>
        <Chip on={false} onClick={() => run([['center', 240], [null, 0]])}>close at ~70%</Chip>
        <Chip on={false} onClick={() => run([['center', 120], [null, 90], ['center', 0]])}>reopen mid-close</Chip>
        <Chip on={false} onClick={() => run([['top-left', 140], ['bottom-right', 0]])}>seed A → seed B</Chip>
        <Chip
          on={false}
          onClick={() => run([['center-left', 900], [null, 0]])}
        >
          open · resize me · close
        </Chip>
      </Group>
    </div>
  );
}

/* ------------------------------------------------------------ golden flow */

/**
 * Golden flow 1 — the model selector (Prompt 2 §72, Phase F).
 *
 * The real `SeedMenu` and the real `ComposerPill`, in the place they actually live: a strip at the
 * bottom of the window, where every popover has to open upward and the seed is 24px tall. That
 * geometry is the whole test. A morph tuned in the middle of a page looks fine and then flips the
 * wrong way, or clips, the first time it is asked to grow out of a control sitting two pixels off
 * the bottom edge.
 */
function GoldenFlow(): React.ReactElement {
  const [chosen, setChosen] = useState('nemotron-nano-12b');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span style={{ font: '600 10px/1 ui-monospace, monospace', letterSpacing: '.08em', textTransform: 'uppercase', color: '#8a8a85' }}>
        golden flow · model selector · seeded from the composer strip
      </span>
      <div
        style={{
          position: 'relative', height: 190, borderRadius: 14, overflow: 'hidden',
          background: DESKTOP, display: 'flex', alignItems: 'flex-end', padding: 10,
        }}
      >
        <div className="liquid-glass liquid-glass-bar flex w-full items-center gap-2 rounded-[14px] px-2.5 py-1.5">
          <span className="flex-1 text-[11.5px] text-faint">Ask Bimax to build something…</span>
          <SeedMenu
            label="Model"
            width={280}
            trigger={(open) => <ComposerPill open={open} icon={<Cpu size={13} />} label={chosen} mono />}
          >
            {(close) => (
              <>
                <SeedMenuLabel>Loaded</SeedMenuLabel>
                <SeedMenuReadout label="Work" value="nvidia/nemotron-nano-12b-v2" />
                <SeedMenuReadout label="Quick" value="nvidia/nemotron-3-nano-omni" />
                <SeedMenuSeparator />
                <SeedMenuItem
                  label="Change model…"
                  desc="Slots, reasoning effort and what the engine actually kept"
                  onClick={() => { setChosen('nemotron-nano-12b'); close(); }}
                />
              </>
            )}
          </SeedMenu>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------- golden flow two */

/**
 * Golden flow 2 — the right inspector opening as a structural region (Prompt 2 §16, §47, §73, §75).
 *
 * The thing under test is not the flight, it is the **handoff**. A structural region has to grow
 * from its own window edge, and then stop being an animation: after it settles it is a column in the
 * layout, resizable by its splitter, with nothing left driving it and nothing left on the overlay.
 * The two failure modes are only visible here, in a layout that has a neighbour and a divider —
 *
 *   - the region never leaves the overlay, so it floats over the workspace and the splitter does
 *     nothing (a card that happens to be docked, which is §47's complaint exactly), or
 *   - the handoff pops, because the shell settles at a corner radius the region does not have.
 *
 * So the mock is deliberately a real two-column arrangement rather than a stage: content on the
 * left that must not swim (§77), a divider, and a region whose width is a live CSS value the drill
 * can change *while the flight is in the air* — which is the retarget the brief asks for in §78.
 */
function GoldenFlowTwo(): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [width, setWidth] = useState(300);
  /*
    One phase, not an `open` flag plus a `settled` flag. Two booleans cannot express this state
    machine: `settled` is only ever cleared on collapse, so a region being *closed* still reports
    itself as settled for the whole flight home — which is the readout confidently disagreeing with
    the screen, in the one place built to tell you what the screen is doing.
  */
  const [phase, setPhase] = useState<'closed' | 'flying' | 'settled'>('closed');

  React.useEffect(() => { if (open) setMounted(true); }, [open]);

  const toggle = useCallback(() => {
    setPhase('flying');
    setOpen((v) => !v);
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span style={{ font: '600 10px/1 ui-monospace, monospace', letterSpacing: '.08em', textTransform: 'uppercase', color: '#8a8a85' }}>
        golden flow 2 · right inspector grows from its own edge · overlay hands off to layout
      </span>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Chip on={width === 260} onClick={() => setWidth(260)}>260</Chip>
        <Chip on={width === 300} onClick={() => setWidth(300)}>300</Chip>
        <Chip on={width === 420} onClick={() => setWidth(420)}>420</Chip>
        <span data-region-phase={phase} style={{ font: '400 10.5px/1.4 ui-monospace, monospace', color: phase === 'settled' ? '#7fd1a3' : '#8a8a85' }}>
          {phase === 'settled' ? 'settled · layout owns it' : phase === 'flying' ? 'in flight · overlay' : 'closed'}
        </span>
        {/*
          The handoff, as a number you can see.

          A settled region with an overlay still on screen is the defect Prompt 2 §47 describes, and
          it is invisible: the shell sits exactly on top of the column it handed off to, so the app
          looks correct and the splitter silently does nothing. It regressed once already — the
          shared driver's `active` means "mounted", which is right for a popover and wrong here —
          so the count is on screen rather than in a comment.
        */}
        <OverlayCount expected={phase === 'settled' ? 0 : undefined} />
      </div>

      <div
        style={{
          position: 'relative', height: 300, borderRadius: 14, overflow: 'hidden',
          background: DESKTOP, display: 'flex',
        }}
      >
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', padding: 12, gap: 8 }}>
          <div className="liquid-glass liquid-glass-bar flex items-center gap-2 rounded-[12px] px-2.5 py-1.5">
            <span className="flex-1 text-[11.5px] text-faint">workspace</span>
            {/* A real button, so the intent tracker sees it exactly as it sees the composer's. */}
            <button
              type="button"
              onClick={toggle}
              aria-expanded={open}
              className="cursor-pointer rounded-lg border border-line/70 px-2 py-1 text-[11px] text-dim hover:text-ink"
            >
              + Context
            </button>
          </div>
          {/* Fixed text: if this moves while the region opens, content is swimming (§77). */}
          <div className="rounded-[10px] bg-black/25 p-3 font-mono text-[10.5px] leading-relaxed text-dim">
            export function place(seed: Rect): Rect &#123;<br />
            &nbsp;&nbsp;return anchoredBox(seed, viewport);<br />
            &#125;
          </div>
        </div>

        {mounted && (
          <>
            <div style={{ width: 1, background: 'rgba(255,255,255,.14)' }} />
            <div style={{ width, flexShrink: 0 }}>
              {/* No `seed`, exactly as `App.tsx` mounts it: the drill has to exercise the shipped
                  configuration or it is a harness verifying a code path nobody reaches. The button
                  on the left is still a real one, so the intent tracker still sees the press — and
                  the point of the drill is that it now makes no difference to the flight. */}
              <MorphRegion
                open={open}
                kind="inspector"
                onSettled={() => setPhase('settled')}
                onCollapsed={() => { setMounted(false); setPhase('closed'); }}
              >
                <div className="app-surface flex h-full flex-col gap-2 p-3">
                  <span className="text-[11px] font-semibold text-ink">Inspector</span>
                  <span className="text-[10.5px] text-faint">Tool invocation detail, context and run metadata.</span>
                  <div className="mt-1 flex flex-col gap-1.5">
                    {['readFile · src/main/index.ts', 'edit · styles.css', 'bash · npm run build'].map((row) => (
                      <div key={row} className="rounded-lg border border-line/60 px-2 py-1.5 font-mono text-[10px] text-dim">{row}</div>
                    ))}
                  </div>
                </div>
              </MorphRegion>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- toolbar tiers */

/**
 * The real `TitleBar`, at four widths at once (Prompt 2 §22, §23, §106).
 *
 * Toolbar overflow is a *measurement*, so the only honest way to check it is to give the same
 * toolbar different amounts of room and look at what it decided. Dragging a window and watching is
 * both slower and worse: the interesting states are the two frames either side of a threshold, and
 * they go past faster than you can read them.
 *
 * The widths are deliberately awkward — 1180 is comfortable, 300 cannot fit even the identity — so
 * the column on the right shows every tier the component has, including the degenerate one.
 */
const TOOLBAR_WIDTHS = [1180, 900, 720];

/**
 * The crowding that is actually reachable.
 *
 * `minWidth: 720` on the BrowserWindow means the window itself can never be narrower than the last
 * row above, so a toolbar tested only by shrinking the window would look permanently roomy. The
 * pressure in the shipped app comes from the other side: a deep project path and a long branch name
 * eating the row from the left at a perfectly ordinary window size.
 */
const CROWDED_BRANCH = 'feature/liquid-glass-seed-morph-v2-inspector-handoff';

function ToolbarTiers(): React.ReactElement {
  const gitStatus = {
    branch: 'recover/2026-08-15',
    files: [{ path: 'app/src/renderer/src/styles.css', insertions: 96, deletions: 4, status: 'M' }],
    ahead: 2,
    behind: 0,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span style={{ font: '600 10px/1 ui-monospace, monospace', letterSpacing: '.08em', textTransform: 'uppercase', color: '#8a8a85' }}>
        toolbar priority tiers · same controls, four widths
      </span>
      {TOOLBAR_WIDTHS.map((width) => (
        <div key={width} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 42, font: '400 10px/1 ui-monospace, monospace', color: '#8a8a85' }}>{width}</span>
          <div style={{ width, overflow: 'hidden', borderRadius: 10, border: '1px solid rgba(255,255,255,.10)' }}>
            <TitleBar
              project="/Users/you/Desktop/Bimax"
              protocolMismatch={null}
              gitStatus={gitStatus as never}
              sidebarOpen
              inspectorOpen={false}
              onToggleSidebar={() => {}}
              onToggleInspector={() => {}}
              onOpenChanges={() => {}}
              onOpenTrust={() => {}}
              appearance="moonlight"
              onAppearance={() => {}}
            />
          </div>
        </div>
      ))}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ width: 42, font: '400 10px/1 ui-monospace, monospace', color: '#8a8a85' }}>720†</span>
        <div data-crowded style={{ width: 720, overflow: 'hidden', borderRadius: 10, border: '1px solid rgba(255,255,255,.10)' }}>
          <TitleBar
            project="/Users/you/Developer/clients/acme/platform/services/ingest-worker"
            protocolMismatch={null}
            gitStatus={{ ...gitStatus, branch: CROWDED_BRANCH } as never}
            sidebarOpen
            inspectorOpen={false}
            onToggleSidebar={() => {}}
            onToggleInspector={() => {}}
            onOpenChanges={() => {}}
            onOpenTrust={() => {}}
            appearance="moonlight"
            onAppearance={() => {}}
          />
        </div>
      </div>
      <span style={{ font: '400 10px/1.5 ui-monospace, monospace', color: '#8a8a85' }}>
        † the minimum window width, with a deep path and a long branch — the crowding that actually ships
      </span>
    </div>
  );
}

/**
 * How many morph shells are on the overlay layer right now.
 *
 * Polled rather than pushed, because the point is to observe the DOM independently of the component
 * that is supposed to be managing it — a readout fed by the same state that decides the mounting
 * would agree with it even when both are wrong.
 */
function OverlayCount({ expected }: { expected?: number }): React.ReactElement {
  const [count, setCount] = useState(0);
  /*
    Two consecutive disagreements, not one.

    A 120ms poll and a settle that lands between two of them will always read the pre-handoff count
    once, so a single-sample check flashes red after every correct flight. A readout that cries wolf
    on every open is one that gets ignored, which costs more than not having it.
  */
  const [confirmed, setConfirmed] = useState(true);
  const previous = useRef<number | null>(null);
  React.useEffect(() => {
    const id = window.setInterval(() => {
      const next = document.querySelectorAll('body > .morph-surface').length;
      setConfirmed(previous.current === next);
      previous.current = next;
      setCount(next);
    }, 120);
    return () => window.clearInterval(id);
  }, []);
  const wrong = expected !== undefined && confirmed && count !== expected;
  return (
    <span
      data-overlay-count={count}
      style={{ font: '400 10.5px/1.4 ui-monospace, monospace', color: wrong ? '#e0806f' : '#8a8a85' }}
    >
      {count} overlay{count === 1 ? '' : 's'}{wrong ? ` (expected ${expected})` : ''}
    </span>
  );
}

/* ----------------------------------------------------------------- matrix */

const WINDOW_SIZES: [number, number][] = [
  [720, 500], [800, 600], [1024, 640], [1280, 800], [1440, 900],
  [1728, 1117], [2560, 1440], [1440, 320], [380, 900],
];

const MATRIX_SEEDS: { label: string; at: (w: number, h: number) => MorphGeometry }[] = [
  { label: 'TL', at: () => box(12, 12) },
  { label: 'TR', at: (w) => box(w - 56, 12) },
  { label: 'C', at: (w, h) => box(w / 2 - 22, h / 2 - 14) },
  { label: 'BL', at: (_w, h) => box(12, h - 40) },
  { label: 'BR', at: (w, h) => box(w - 56, h - 40) },
];

function box(x: number, y: number): MorphGeometry {
  return { x, y, width: 44, height: 28, radius: 14 };
}

/**
 * Every window size × every seed corner, drawn to scale.
 *
 * This is the half of Prompt 1 §21/§23 that has nothing to do with motion: a destination that
 * clips at 720×500, or a popover that fails to flip away from the bottom edge, is a *placement*
 * defect and shows up as a shape. The unit tests assert these boxes stay inside their window; this
 * shows what "inside" looks like, which is how you notice a box that is technically inside and
 * visually wrong.
 */
function PlacementMatrix({ kind }: { kind: DestinationKind }): React.ReactElement {
  const rows = useMemo(() => WINDOW_SIZES.map(([w, h]) => ({
    w, h,
    cells: MATRIX_SEEDS.map(({ label, at }) => {
      const seed = at(w, h);
      return { label, seed, destination: destinationFor({ kind }, { width: w, height: h }, seed) };
    }),
  })), [kind]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span style={{ font: '600 10px/1 ui-monospace, monospace', letterSpacing: '.08em', textTransform: 'uppercase', color: '#8a8a85' }}>
        placement · {kind} · every window in the test matrix
      </span>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        {rows.map(({ w, h, cells }) => {
          const scale = 132 / Math.max(w, h);
          return (
            <figure key={`${w}x${h}`} style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
              <figcaption style={{ font: '500 10px/1 ui-monospace, monospace', color: '#8a8a85' }}>
                {w}×{h}
              </figcaption>
              <div style={{ display: 'flex', gap: 5 }}>
                {cells.map(({ label, seed, destination }) => (
                  <div
                    key={label}
                    style={{
                      position: 'relative', width: w * scale, height: h * scale,
                      background: '#00000055', border: '1px solid #ffffff20', borderRadius: 3,
                    }}
                    title={`${label}: ${Math.round(destination.x)},${Math.round(destination.y)} ${Math.round(destination.width)}×${Math.round(destination.height)}`}
                  >
                    <Mark box={destination} scale={scale} colour="#60a5fa" fill />
                    <Mark box={seed} scale={scale} colour="#4ade80" />
                  </div>
                ))}
              </div>
            </figure>
          );
        })}
      </div>
    </div>
  );
}

function Mark({ box: b, scale, colour, fill }: { box: MorphGeometry; scale: number; colour: string; fill?: boolean }): React.ReactElement {
  return (
    <div
      style={{
        position: 'absolute',
        left: b.x * scale, top: b.y * scale,
        width: Math.max(1, b.width * scale), height: Math.max(1, b.height * scale),
        borderRadius: Math.max(1, b.radius * scale),
        border: `1px solid ${colour}`,
        background: fill ? `${colour}22` : colour,
      }}
    />
  );
}
