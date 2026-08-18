import { cliEvents } from '../../cli/events';
import { loadConfig } from '../../cli/config';
import { DesktopRuntimePort, DesktopCommand, normalizeDesktopAction, PUBLIC_DESKTOP_ACTIONS } from '../../computer/desktop.runtime';
import { globalComputerSessionManager, isSessionRoutableDesktopRuntime } from '../../computer/session.manager';
import { classifyDesktopActionImpact } from '../../browser/action.impact';
import { IGovernor } from '../../core/interfaces';
import { getTaintTracker } from '../../mind/taint';
import { buildTool, BuiltTool } from '../tool.factory';
import { computerResultForModel, renderComputerActionReference, unwrapActionEnvelope, validateModelComputerCommand } from '../../computer/action.contract';
import {
  resolveConvergedComputerRoute, validateConvergedHandoff,
  type ConvergedComputerTargetRef,
} from '../../computer/browser.convergence.route';
import {
  globalNativeComputerShadowObserver,
  type NativeShadowObserverPort,
} from '../../computer/native.shadow.comparison';

/** Acting verbs face the governor; observation (screenshot/cursor/status/…) is approval-free. */
// 'clipboard' is gated alongside the acting verbs even though a bare read changes nothing: the
// pasteboard routinely holds whatever the USER last copied — a password out of a password manager,
// a card number — and reading it pulls that into the transcript.
const GATED_ACTIONS = new Set([
  'request_access', 'open', 'focus', 'click', 'drag', 'scroll', 'move', 'hover', 'hold',
  'mouse_down', 'mouse_up', 'type', 'key', 'set_value', 'copy', 'paste', 'clipboard',
  'arrange', 'desktop', 'close', 'quit_app', 'record_start',
]);

type ConvergedDesktopCommand = DesktopCommand & {
  surface?: 'browser_page' | 'browser_chrome' | 'system_ui';
  handoffRef?: string;
  pageUrl?: string;
  browserTabRef?: string;
  browserDocumentRef?: string;
  windowGeneration?: number;
};

export function createComputerTool(
  governor: IGovernor,
  runtime: DesktopRuntimePort = globalComputerSessionManager,
  shadowObserver: NativeShadowObserverPort = globalNativeComputerShadowObserver,
): BuiltTool {
  // Keyboard approval is shown in the terminal, so the approval UI itself can steal focus from
  // the app the model just opened. Remember that intended app and pass it all the way to the
  // runtime; the runtime re-activates and verifies it immediately before each keyboard action.
  const targetAppBySession = new Map<string, string>();
  const rememberTargetApp = (sessionId: string, app: string): void => {
    targetAppBySession.delete(sessionId);
    if (app) targetAppBySession.set(sessionId, app);
    while (targetAppBySession.size > 32) {
      const oldest = targetAppBySession.keys().next().value as string | undefined;
      if (!oldest) break;
      targetAppBySession.delete(oldest);
    }
  };
  return buildTool({
    name: 'ComputerTool',
    description: `Operate the user's real desktop through native screenshots, accessibility targets, and the physical mouse/keyboard. A request to inspect or operate the user's own computer, app, or screen authorizes the routine interaction it asks for — use this tool rather than claiming you have no access, and never improvise desktop control through shell commands.

MANDATORY LOOP
1. open or observe the intended window and inspect the attached fresh frame.
2. Choose exactly ONE smallest safe action from that frame.
3. Call ComputerTool once. Never emit a second ComputerTool call in the same assistant turn.
4. When the intended next state has native text, pass expect + expectMode so this same call proves it.
5. Inspect the returned post-action frame and progressCheck/actionResult.
6. Repeat until the newest frame proves the requested end state, or report the blocker.

Every state-changing action requires a fresh frame of the exact target; if capture fails, re-observe before any more input. Use only handles from the newest result: query or elementToken first, then elementIndex, then raw screenshot x/y — never copy an element frame into x/y. coordinateSpace describes the returned image; normalized=true maps 0-1000 into that image. Every observation returns a frameId: pass it back on the action you planned from it, so a stale frame is refused instead of mis-clicked.

Success requires visible or semantic evidence from the newest frame, not the driver reporting delivery. Detailed guidance for multi-app work, window arrangement, drag-and-drop, Spaces, the clipboard and message composers is supplied with the task when it involves the desktop.

ACTIONS (one call = one action)
${renderComputerActionReference()}`,
    isDestructive: false,
    isConcurrencySafe: false,
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...PUBLIC_DESKTOP_ACTIONS], description: 'Choose exactly one action. Every action has its own Input and Returns contract in the tool description.' },
        x: { type: 'number', description: 'click/type/drag/scroll/hover/hold/mouse*: pixel in Image 1; move: global screen point. Never use Image 2 display-context pixels.' },
        y: { type: 'number', description: 'click/type/drag/scroll/hover/hold/mouse*: pixel in Image 1; move: global screen point. Never use Image 2 display-context pixels.' },
        toX: { type: 'number', description: 'drag: destination x pixel in the newest screenshot. Prefer toQuery/toElementToken/toElementIndex.' },
        toY: { type: 'number', description: 'drag: destination y pixel in the newest screenshot. Prefer toQuery/toElementToken/toElementIndex.' },
        toApp: { type: 'string', description: 'drag: destination APPLICATION for a cross-app drop (must already be open via open/focus). toX/toY are then read in THAT window, and omitting them drops on its centre. Both windows must be visible at once — arrange them side by side first.' },
        toQuery: { type: 'string', description: 'drag: destination element by native label from the newest observation (e.g. a sidebar folder). Preferred over toX/toY.' },
        toElementToken: { type: 'string', description: 'drag: destination semantic handle from the newest observation. Preferred over toX/toY.' },
        toElementIndex: { type: 'number', description: 'drag: destination element index from the newest observation. Preferred over toX/toY.' },
        dx: { type: 'number', description: 'scroll: horizontal pixels (positive = right).' },
        dy: { type: 'number', description: 'scroll: vertical pixels (positive = down).' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        modifier: { type: 'array', items: { type: 'string', enum: ['cmd', 'shift', 'alt', 'ctrl', 'fn'] }, description: 'click: optional held modifier keys, e.g. ["cmd"] for multi-selection.' },
        count: { type: 'number', description: 'click: 1 (default), 2 = double, 3 = triple.' },
        text: { type: 'string', description: 'type: literal text, full unicode. Pair with query/elementToken when a visible editable field should be focused atomically before typing.' },
        replaceExisting: { type: 'boolean', description: 'type: select the targeted editable field contents before entering text. Use when the requested value must replace a search query, draft, or existing field exactly.' },
        combo: { type: 'string', description: 'key/press: e.g. "cmd+shift+t", "return", "escape", "ctrl+c".' },
        key: { type: 'string', description: 'Compatibility alias for combo when action is key/press. Prefer combo.' },
        app: { type: 'string', description: 'Exact application name, preferably as returned by apps/open. Actions default to the most recently opened app.' },
        bundleId: { type: 'string', description: 'open: exact macOS bundle id; preferred when known.' },
        pid: { type: 'number', description: 'Target process id returned by open/apps/windows.' },
        windowId: { type: 'number', description: 'Target window id returned by open/windows.' },
        elementIndex: { type: 'number', description: 'Fresh semantic handle from the latest observe. Preferred over guessing x/y; the runtime physically clicks its visible center.' },
        elementToken: { type: 'string', description: 'Opaque fresh semantic handle from observe; preferred over elementIndex and raw x/y. The runtime physically clicks its visible center.' },
        menuPath: { type: 'string', description: "menu_activate: the dotted index path copied verbatim from an observation's menu list (e.g. \"5.19\"). Menus are offered when the window's accessibility tree cannot serve the request — they are the app's own COMMANDS (play, save, find), not its content. Never pass a menu name: names repeat within one menu, carry invisible direction marks in some apps, and change with locale." },
        query: { type: 'string', description: 'observe: filter/verify native text. click/drag/set_value: resolve a native label from the newest observation. type: resolve, preflight, and focus an editable field before sending text (drag: the SOURCE element).' },
        expect: { type: 'string', description: 'Acting verbs: native text whose presence/absence in the automatic post-action observation proves the intended result. Separate from query, which names what to act on.' },
        expectMode: { type: 'string', enum: ['present', 'absent'], description: 'How to verify expect after the action. present is default; absent performs an exhaustive accessibility scan before proving disappearance.' },
        maxElements: { type: 'number', description: 'observe: compact model-visible element budget, 1–2000 (the runtime scans deeper internally).' },
        includeScreenshot: { type: 'boolean', description: 'observe: false for a cheap tree-only verification refresh.' },
        value: { type: 'string', description: 'set_value: exact native control value. Sliders accept 0..1, 0%..100%, maximum/full, or minimum/mute. clipboard: text to place on the clipboard.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'clipboard: absolute file paths to place on the clipboard, so the next paste hands the app the FILES themselves (e.g. attaching a photo). Without this, a path would paste as literal text.' },
        layout: { type: 'string', enum: ['left', 'right', 'top', 'bottom', 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'left-third', 'center-third', 'right-third', 'left-two-thirds', 'right-two-thirds', 'restore', 'maximize', 'center', 'fullscreen', 'unfullscreen'], description: 'arrange: where to put the active window. Halves/quadrants/thirds tile within the screen\'s usable area (thirds are for three-app layouts); maximize fills it; restore puts it back where it was before the last arrange; fullscreen is the native macOS fullscreen Space (unfullscreen leaves it). Pass display to move the window to another screen.' },
        bounds: { type: 'object', description: 'arrange: exact rectangle in screen points, e.g. {"x":0,"y":33,"w":735,"h":864}. Use layout instead unless you need a precise size.', properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } }, required: ['x', 'y', 'w', 'h'] },
        session: { type: 'string', description: 'Optional stable Bimax cursor/session identity.' },
        newInstance: { type: 'boolean', description: 'open: request an isolated app instance only when the user explicitly asks for a separate copy. The runtime checks the live process state instead of assuming which apps permit duplication.' },
        display: { type: 'number', description: 'screenshot: display index, 1 = main. arrange: move the window to that display and tile it within that screen\'s usable area.' },
        ms: { type: 'number', description: 'wait: 50-5000 ms. hover/hold: how long to hover or hold the button (default 400/800 ms).' },
        normalized: { type: 'boolean', description: 'Interpret target-frame x/y in a 0–1000 space scaled to Image 1. Not valid for move or desktop global coordinates.' },
        frameId: { type: 'string', description: 'Exact frameId that produced Image 1. Required with raw target-frame coordinates so stale pixels are refused.' },
        recordVideo: { type: 'boolean', description: 'record_start: include an MP4 screen recording (default true).' },
        captureScope: { type: 'string', enum: ['window', 'display'], description: 'record_start: window (default) captures only the owned app window; display captures the whole human-visible display, including overlapping windows, and requires explicit approval.' },
        outputDir: { type: 'string', description: 'record_start: optional output directory; defaults under .bimax/computer/recordings.' },
        surface: { type: 'string', enum: ['browser_page', 'browser_chrome', 'system_ui'], description: 'Exact BrowserTool handoff surface. browser_page is read-only AX scrape fallback.' },
        handoffRef: { type: 'string', minLength: 1, maxLength: 128, description: 'Short-lived authority returned by BrowserTool handoff.' },
        pageUrl: { type: 'string', description: 'BrowserTool handoff page URL; checked against handoffRef.' },
        browserTabRef: { type: 'string', description: 'BrowserTool handoff tab ref; checked against handoffRef.' },
        browserDocumentRef: { type: 'string', description: 'BrowserTool handoff document ref; checked against handoffRef.' },
        windowGeneration: { type: 'integer', minimum: 0, description: 'BrowserTool handoff exact native window generation.' },
      },
      required: ['action'],
    },
    execute: async (rawArgs: ConvergedDesktopCommand & { key?: string }, context?: any) => {
      // Some models wrap the arguments in the action name — {"click":{...}} — instead of naming it
      // in `action`. Left alone that reads as action=undefined, and the refusal then names the
      // symptom rather than the mistake, which a model cannot act on: the Phase 10 baseline caught
      // one repeating the identical malformed call six times before giving up. Unwrapped here,
      // before anything reads args, so the branches below and the governor all see one shape.
      let args = unwrapActionEnvelope(rawArgs as unknown as Record<string, unknown>) as unknown as typeof rawArgs;
      // The Bimax task owns the computer session. A model-supplied `session` must never select or
      // observe another task's handles, target, history or recording state.
      const taskSessionId = typeof context?.sessionId === 'string' && context.sessionId.trim()
        ? context.sessionId.trim()
        : '';
      const taskSessionKey = taskSessionId || 'default';
      let convergedTarget: ConvergedComputerTargetRef | undefined;
      if (args.surface || args.handoffRef) {
        if (!args.surface || !args.handoffRef) {
          return JSON.stringify({
            ok: false, action: args.action,
            summary: 'Browser convergence handoff requires both surface and handoffRef.',
          });
        }
        const authority = validateConvergedHandoff(args.handoffRef, taskSessionKey);
        if (!authority.ok) {
          return JSON.stringify({ ok: false, action: args.action, summary: authority.error });
        }
        convergedTarget = authority.target;
        if (convergedTarget.surface !== args.surface) {
          return JSON.stringify({ ok: false, action: args.action, summary: 'surface does not match handoffRef authority.' });
        }
        if (convergedTarget.surface === 'browser_page' && args.action !== 'observe') {
          return JSON.stringify({
            ok: false, action: args.action,
            summary: 'browser_page AX fallback is read-only; page mutations must return to BrowserTool CDP.',
          });
        }
        const mismatch = (provided: unknown, retained: unknown): boolean => provided !== undefined && provided !== retained;
        if (mismatch(args.pid, convergedTarget.pid)
            || mismatch(args.windowId, convergedTarget.windowId)
            || mismatch(args.windowGeneration, convergedTarget.windowGeneration)
            || (convergedTarget.surface === 'browser_page' && (
              mismatch(args.pageUrl, convergedTarget.url)
              || mismatch(args.browserTabRef, convergedTarget.tabRef)
              || mismatch(args.browserDocumentRef, convergedTarget.documentRef)))) {
          return JSON.stringify({ ok: false, action: args.action, summary: 'handoff target fields do not match handoffRef authority.' });
        }
      }
      const targetApp = targetAppBySession.get(taskSessionKey) || '';
      const activeRuntime = taskSessionId && isSessionRoutableDesktopRuntime(runtime)
        ? runtime.forSession(taskSessionId)
        : runtime;
      // Fold verb synonyms onto real actions FIRST — before the gating decision below — so an
      // aliased high-impact verb (press→key, launch→open) still faces the governor. Doing this any
      // later would turn the alias into an approval bypass.
      const normalizedAction = normalizeDesktopAction(args.action) as DesktopCommand['action'];
      // Models trained on browser-computer APIs often emit {action:"press", key:"return"} while
      // this native runtime calls that field `combo`. The verb was normalized but the payload was
      // not, producing the absurd "key needs combo" refusal for a perfectly explicit Return. Fold
      // both halves of the compatibility form together before approval and execution.
      args = {
        ...args,
        action: normalizedAction,
        ...(normalizedAction === 'key' && !args.combo && args.key ? { combo: args.key } : {}),
      };
      const invalid = validateModelComputerCommand(args);
      if (invalid) {
        return JSON.stringify({
          ok: false,
          action: args.action,
          summary: `${args.action} refused: invalid action arguments`,
          error: invalid,
          expected: renderComputerActionReference().split('\n').find(line => line.startsWith(`${args.action}:`)),
        });
      }
      const intendedApp = args.app?.trim() || ([
        'click', 'drag', 'scroll', 'type', 'key', 'set_value', 'copy', 'paste', 'arrange',
        'close', 'quit_app', 'hover', 'hold', 'mouse_down', 'mouse_up',
      ].includes(args.action) ? targetApp : '');
      // Strip every field the model must NEVER control:
      //   - deliveryMode: a user-owned /computer preference (a hallucinated arg could silently
      //     switch to the sidecar's synthetic overlay path);
      //   - fullDisplayToken / approveFullDisplay(legacy): whole-display recording approval is a
      //     governor decision — a model-supplied token or boolean can never authorize it.
      const modelArgs = { ...args } as DesktopCommand & { approveFullDisplay?: unknown };
      delete modelArgs.deliveryMode;
      delete modelArgs.fullDisplayToken;
      delete modelArgs.session;
      delete modelArgs.approveFullDisplay;
      const modelRecord = modelArgs as unknown as Record<string, unknown>;
      delete modelRecord.surface;
      delete modelRecord.handoffRef;
      delete modelRecord.pageUrl;
      delete modelRecord.browserTabRef;
      delete modelRecord.browserDocumentRef;
      delete modelRecord.windowGeneration;
      const effectiveArgs: DesktopCommand = {
        ...modelArgs,
        ...(convergedTarget && 'pid' in convergedTarget ? { pid: convergedTarget.pid } : {}),
        ...(convergedTarget && 'windowId' in convergedTarget && convergedTarget.windowId !== undefined
          ? { windowId: convergedTarget.windowId } : {}),
        ...(intendedApp ? { app: intendedApp } : {}),
        ...(taskSessionId ? { session: taskSessionId } : {}),
      };
      // Whole-display recording detection BEFORE the approval prompt, so the user approves the
      // TRUE scope. Only a governor-approved prompt mints the single-use runtime token below.
      const wantsVideo = effectiveArgs.action === 'record_start' && effectiveArgs.recordVideo !== false;
      const scopePreview = wantsVideo ? activeRuntime.recordingScopePreview?.(effectiveArgs.captureScope) : undefined;
      const wholeDisplay = effectiveArgs.captureScope === 'display'
        || (!!scopePreview && !scopePreview.captureSafe);
      if (GATED_ACTIONS.has(effectiveArgs.action)) {
        // Scope the approval to the app that will RECEIVE the input so the governor can offer
        // (and honor) a session grant for exactly that app — and hard-deny sensitive targets.
        // 'open' is the odd one out: it targets an app that is NOT yet frontmost (that's the whole
        // point), so falling back to frontmostApp() for it showed the WRONG app in the prompt —
        // e.g. "Allow? open in ComputerTool @ <terminal>" when the model opened by bundleId only,
        // confusingly naming whatever happened to still be focused instead of what's being opened.
        // 'open' and 'focus' both target an app that is NOT yet frontmost (that's the whole point),
        // so falling back to frontmostApp() for them showed the WRONG app in the prompt — e.g.
        // "Allow? open in ComputerTool @ <terminal>", naming whatever happened to still be focused
        // instead of what is being switched to.
        const app = effectiveArgs.action === 'open' || effectiveArgs.action === 'focus'
          ? (effectiveArgs.app?.trim() || effectiveArgs.bundleId?.trim() || 'application')
          : intendedApp || await activeRuntime.frontmostApp();
        const semanticTarget = activeRuntime.describeTarget?.(effectiveArgs) || undefined;
        const impact = effectiveArgs.action === 'record_start'
          ? {
            high: true,
            reason: wholeDisplay
              ? 'starting a WHOLE-DISPLAY screen recording — captures EVERYTHING visible, including unrelated windows'
              : `starting screen recording captures visible desktop content${scopePreview ? ` (scope: ${scopePreview.scope})` : ''}`,
          }
          : effectiveArgs.action === 'quit_app'
            ? { high: true, reason: 'quits the entire application and may discard unsaved state' }
            : classifyDesktopActionImpact(effectiveArgs.action, {
          text: effectiveArgs.text, combo: effectiveArgs.combo, app: effectiveArgs.app,
          label: semanticTarget?.label, role: semanticTarget?.role, value: semanticTarget?.value,
          });
        // The sidecar's first-use spawn/handshake can take real wall-clock time; kick it off now
        // so it overlaps with the human reading/deciding on the approval prompt instead of starting
        // only after Enter, where it would otherwise sit behind an undifferentiated spinner.
        activeRuntime.warm?.();
        // 'high-impact-only' approvals: routine interaction (click/type/press/open) flows without a
        // prompt so long runs aren't interrupted every step; high-impact actions (delete/send/
        // purchase/submit/permissions) still face the human each time, and the governor's
        // sensitive-target hard floor runs regardless of what we pass here. plan/strict sessions
        // keep the every-action prompt — those modes exist to slow things down.
        const approvals = (await loadConfig()).computerApprovals;
        const governorMode = (governor as any).mode;
        const routine = approvals === 'high-impact-only' && !impact.high
          && governorMode !== 'plan' && governorMode !== 'strict';
        await governor.approveTaskExecution('COMPUTER_CONTROL', {
          tool: 'ComputerTool', action: effectiveArgs.action, app: app || undefined,
          highImpact: impact.high || undefined, impactReason: impact.reason,
          isDestructive: !routine,
        });
        if (routine) {
          const note = `Auto-approved (${approvals}): ${effectiveArgs.action}${app ? ` in ${app}` : ''}`;
          cliEvents.emit('status', note);
          // Auditability: auto-approvals must be findable after the fact (Ctrl+O log panel), not
          // just a status flash that the next event overwrites.
          cliEvents.emit('log', { id: Date.now(), level: 'info', text: note, timestamp: new Date() });
        }
        // The governor prompt above resolved (or threw on deny). Only NOW — with the user having
        // approved the explicitly-stated whole-display scope — mint the runtime's single-use token.
        if (wholeDisplay) {
          const token = activeRuntime.authorizeFullDisplayRecording?.();
          if (token) effectiveArgs.fullDisplayToken = token;
        }
      }
      const result = await activeRuntime.run(effectiveArgs, { cwd: context?.cwd || process.cwd(), signal: context?.signal });
      // Both verbs establish which app subsequent input belongs to, so both must update the
      // remembered target — otherwise a focus switch would leave later acting verbs defaulting to
      // the app the session opened BEFORE the switch.
      if (result.ok && (effectiveArgs.action === 'open' || effectiveArgs.action === 'focus')) {
        rememberTargetApp(taskSessionKey, result.app || effectiveArgs.app?.trim() || '');
      }
      if (result.ok && effectiveArgs.action === 'quit_app' && (!intendedApp || intendedApp === targetApp)) {
        rememberTargetApp(taskSessionKey, '');
      }
      // Whatever is on screen is untrusted input (prompt injection): a screenshot pulls it into
      // the conversation, exactly like a WebFetch of an arbitrary page. Clipboard content is the
      // same kind of import — text of unknown origin crossing into the transcript — so the verbs
      // that surface it are tainted on the identical footing.
      // Ground truth about the live preview, attached to observations. The preview is
      // presentation-only — there is no verb that can see it — so asked what it is showing, a model
      // with nothing to read answers from imagination. That happened twice in real sessions: it
      // named an app after every switch without ever querying anything. Cheap (a state read), and
      // only on the verbs that already return a picture.
      if (result.ok && ['observe', 'screenshot', 'status'].includes(effectiveArgs.action)) {
        try {
          const pip = await activeRuntime.pipStatus?.();
          if (pip) {
            result.preview = pip.running
              ? `live preview is showing ${pip.surface || 'the active window'}`
              : pip.enabled
                ? 'live preview is enabled but not currently running'
                : 'live preview is off';
          }
        } catch { /* the preview is presentation-only; never fail an observation over it */ }
      }
      const importsUntrustedContent = ['observe', 'screenshot'].includes(effectiveArgs.action)
        || (['copy', 'paste', 'clipboard'].includes(effectiveArgs.action) && !!result.clipboard);
      if (result.ok && importsUntrustedContent) {
        const kind = ['observe', 'screenshot'].includes(effectiveArgs.action) ? 'screenshot' : 'clipboard';
        try { getTaintTracker().mark('web', `ComputerTool ${kind}${result.app ? ` (${result.app})` : ''}`); } catch { /* taint is best-effort */ }
        cliEvents.emit('browser_evidence', {
          action: kind === 'clipboard' ? 'clipboard' : 'screenshot', ok: result.ok, trusted: false,
          source: result.screenshot || 'ComputerTool', summary: result.summary,
        });
      }
      // Phase 9 shadowing is observation-only and strictly fail-open. It starts after the
      // compatibility result exists, is not awaited, and receives no action authority. Its
      // count/digest receipt never enters the model-visible result.
      if (result.ok && effectiveArgs.action === 'observe' && result.pid) {
        void shadowObserver.compare(taskSessionKey, result, {
          query: effectiveArgs.query,
          maxElements: effectiveArgs.maxElements,
        }).catch(() => {});
      }
      const compact = computerResultForModel(result);
      if (convergedTarget) {
        const receipt = resolveConvergedComputerRoute(convergedTarget, {
          browserCdp: false, nativeAX: false, nativeCapture: false, compatibilityAX: true,
        }).receipt!;
        return JSON.stringify({
          ...compact,
          route: { ...receipt, target: convergedTarget, handoffRef: args.handoffRef },
        });
      }
      return JSON.stringify(compact);
    },
  }, governor);
}
