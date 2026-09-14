import { cliEvents, MessageEntry } from '../cli/events';
import { AgentPersona } from '../cli/personas/base.persona';
import { routeQuery } from '../cli/agentRouter';
import { expandAtMentions, expandFileAtMentions } from '../cli/atMention';
import { globalCommandRegistry } from '../cli/commands/registry';
import { decideTier, Tier, isConversational } from '../cli/model.router';
import { getEpistemicLedger } from '../mind/epistemic.ledger';
import {
  recordTurn, beginTurnTimeline, markRouted, markAssembled, markFirstVisibleToken, endTurnTimeline,
} from '../telemetry/perf';
import { IGraphStore } from '../graph/models';
import { getSessionRecorder } from '../cli/session.recorder';

/**
 * Confidence-in-margin (turn-end form): from the epistemic-ledger delta across a turn, decide what
 * to say about its verification posture. `verified` = claims resolved by a build/test run that named
 * the touched files; `opened` = new claims (edits) still unchecked. Returns null when the turn
 * changed nothing that the ledger tracks — it speaks only to confirm verified work or nudge an
 * unverified change. Pure, so it's unit-testable without driving a whole turn.
 */
export function ledgerTurnSummary(
  before: { resolved: number; open: number } | null,
  after: { resolved: number; open: number },
): { text: string; level: 'success' | 'info' } | null {
  if (!before) return null;
  const verified = after.resolved - before.resolved;
  const opened = after.open - before.open;
  if (verified > 0) {
    return { text: `◇ ledger · verified ${verified} change${verified > 1 ? 's' : ''} this turn`, level: 'success' };
  }
  if (opened > 0) {
    return { text: `◇ ledger · ${opened} change${opened > 1 ? 's' : ''} unverified — run a build/test to confirm`, level: 'info' };
  }
  return null;
}

/**
 * Menu labels are DATA, not presentation. Commands historically wrote terminal decoration into the
 * label itself — "[ Start Indexing ]", "[ Cancel ]" — which the desktop app renders verbatim into a
 * button, so a GUI card looked like a TUI prompt. Strip the wrapper once at the protocol boundary:
 * a front-end that wants brackets can add them, one that doesn't cannot remove them. (The TUI draws
 * its own "❯ " cursor and colour, and the brackets were eating 4 of its 24-char label budget.)
 */
function undecorate(opt: any): any {
  if (!opt || typeof opt.label !== 'string') return opt;
  const label = opt.label.trim().replace(/^\[\s*(.*?)\s*\]$/, '$1').trim();
  return label === opt.label ? opt : { ...opt, label };
}

export interface HeadlessDeps {
  personas: Record<string, AgentPersona>;
  options: any;           // the same `options` bag FullScreen receives (governor, llmAdapter, toolRegistry, …)
  graphStore: IGraphStore;
  codebaseIndexer?: any;
  saveConfig?: (updates: Record<string, any>) => Promise<any>;
}

/**
 * Drives a BiMax session with no UI — the headless counterpart to FullScreen's handleSubmit.
 * Same engine entrypoints (agent router → persona.execute, globalCommandRegistry.execute,
 * @-mention expansion), but every UI effect is replaced by a `cliEvents` emit the ProtocolHost
 * forwards over the wire. Deliberately leaner than handleSubmit: it omits Ink-only concerns
 * (autocomplete, paste chips, tier-routing UI, vision) — those belong to the front-end.
 */
export class HeadlessSession {
  private busy = false;
  private turnFinished: Promise<void> = Promise.resolve();
  private finishTurn: (() => void) | null = null;
  private clearing: Promise<void> | null = null;
  // Aborts the in-flight turn when the front-end sends an interrupt. Non-null only while a turn runs.
  private turnAbort: AbortController | null = null;
  // Manual model-tier pin (the /tier command / Ctrl+T). null = automatic routing. Mirrors the
  // pinnedTierRef FullScreen keeps for the Ink path, so headless honors /tier identically.
  private pinnedTier: Tier | null = null;
  // Active interactive menus, keyed by the id sent to the front-end. Holds the option list + the
  // onSelect callback (which can't cross the wire), so a menuSelect reply can run the real handler —
  // e.g. picking a model id in /model applies it instead of dispatching the bare id as a chat turn.
  private menus = new Map<string, { options: any[]; onSelect?: (opt: any) => void }>();
  private menuSeq = 0;

  constructor(private deps: HeadlessDeps) {
    // /tier auto|lite|heavy emits set_tier; apply the pin and reflect it in the footer, exactly as
    // FullScreen.handleSetTier does for Ink. (set_tier is also forwarded to the front-end verbatim.)
    cliEvents.on('set_tier', (t: 'auto' | 'lite' | 'heavy') => {
      this.pinnedTier = t === 'auto' ? null : t;
      cliEvents.emit('model_tier', { tier: this.pinnedTier ?? 'lite', pinned: this.pinnedTier });
      cliEvents.emit('status', this.pinnedTier === null
        ? 'Routing → auto (lite decides, escalates as needed)'
        : `Routing pinned → ${this.pinnedTier} model`);
    });
  }

  /** Whether a turn is executing right now — the heartbeat's `activeTurn` signal. */
  get isBusy(): boolean {
    return this.busy;
  }

  /** A submitted line: a slash command or a user turn. */
  async dispatch(text: string): Promise<void> {
    const query = (text || '').trim();
    if (!query) return;
    if (/^\/clear\s+force(?:\s|$)/i.test(query)) {
      if (!this.clearing) {
        this.interrupt();
        this.clearing = this.turnFinished.then(() => this.runCommand(query));
      }
      try { await this.clearing; } finally { this.clearing = null; }
      return;
    }
    if (this.clearing) await this.clearing;
    if (query.startsWith('/')) { await this.runCommand(query); return; }
    await this.runTurn(query);
  }

  /** Engine-owned continuation turn. It uses the coordinator without fabricating user chat. */
  async dispatchAutonomous(text: string): Promise<'completed' | 'busy' | 'failed' | 'interrupted'> {
    const query = (text || '').trim();
    if (!query || query.startsWith('/')) return 'failed';
    if (this.clearing) return 'busy';
    return this.runTurn(query, { autonomous: true });
  }

  /**
   * Cancel the in-flight turn (the front-end's Ctrl-C / Esc). Cooperative: the agent loop stops at
   * its next safe boundary, then the `finally` in runTurn emits the idle spinner. A no-op when idle.
   */
  interrupt(): void {
    if (!this.busy || !this.turnAbort) return;
    this.turnAbort.abort();
    cliEvents.emit('status', 'Interrupting…');
  }

  private async runTurn(query: string, opts: { autonomous?: boolean } = {}): Promise<'completed' | 'busy' | 'failed' | 'interrupted'> {
    if (this.busy) {
      if (!opts.autonomous) cliEvents.emit('status', 'Busy — finish the current turn before sending another.');
      return 'busy';
    }
    this.busy = true;
    this.turnFinished = new Promise(resolve => { this.finishTurn = resolve; });
    this.turnAbort = new AbortController();
    const turnStart = Date.now();
    // A fresh user instruction legitimizes repetition — failure-memory counters reset so the
    // system never blocks something the human explicitly re-asked for.
    if (!opts.autonomous) { try { require('../core/failure.memory').getFailureMemory().newUserTurn(); } catch { /* observer */ } }
    let firstTokenMs = 0; // set on the first streamed token (perf: time-to-first-token)
    // Lightweight conversation lane (P0-3): greetings/acks/simple meta questions bypass the full
    // harness entirely. A manual heavy pin or an engine wake keeps the full path. The decision is
    // local (no model call), so a "hi" never pays for routing, graph, memory, or verification.
    const conversational = !opts.autonomous && this.pinnedTier !== 'heavy'
      && isConversational(query);
    const model = this.deps.options.llmAdapter?.userModel || this.deps.options.llmAdapter?.defaultModel;
    beginTurnTimeline(conversational ? 'lite' : 'full', model);
    // Snapshot the epistemic ledger so we can report THIS turn's verification posture at the end:
    // claims open on edits and resolve when a build/test run names the touched files.
    const beforeLedger = (() => { try { return getEpistemicLedger().stats(); } catch { return null; } })();
    if (!opts.autonomous) cliEvents.emit('message', this.msg('user', query));
    // Show activity IMMEDIATELY — @-mention expansion below can take a moment, during which the
    // front-end would otherwise sit silent after the user's message. (Routing itself is local now.)
    cliEvents.emit('spinner_state', 'thinking', 'Thinking…');

    const active = (conversational || opts.autonomous)
      ? this.deps.personas.bimax
      : (this.deps.personas[routeQuery(query)] || this.deps.personas.bimax);
    const before = active.messages.length;
    let totalChars = 0;
    let streamed = '';
    const onToken = (token: string) => {
      if (firstTokenMs === 0) { firstTokenMs = Date.now() - turnStart; markFirstVisibleToken(); }
      totalChars += token.length; streamed += token; cliEvents.emit('stream_token', token);
    };

    let result: 'completed' | 'failed' | 'interrupted' = 'failed';
    try {
      if (conversational) {
        // The lite lane: no routing, no @-mention expansion, no tools. Fall back to the full harness
        // if the conversational completion errors (a keyless/cold provider shouldn't lose the turn).
        cliEvents.emit('model_tier', { tier: 'lite', pinned: this.pinnedTier });
        markRouted();
        markAssembled();
        try {
          await active.converse(query, onToken, { useLite: true, signal: this.turnAbort.signal });
        } catch (error) {
          if (this.turnAbort.signal.aborted) throw error;
          streamed = ''; // discard any partial lite output; the full harness re-runs the turn cleanly
          // forceHeavy: the lite lane just failed, and the router would send this same trivial query
          // straight back to the same lite model. Retrying the thing that just broke is not a
          // fallback — escalate to the work model so the retry can actually succeed.
          await this.runFullHarness(active, query, !!opts.autonomous, onToken, true);
        }
      } else {
        await this.runFullHarness(active, query, !!opts.autonomous, onToken);
      }

      // Prefer the streamed text; fall back to the message-slice only if nothing streamed.
      const content = this.cleanTurnText(streamed) || this.collectTurnText(active, before);
      if (content) cliEvents.emit('message', this.msg('assistant', content));
      // A turn that ends with NOTHING is the worst failure mode there is: the UI returns to Ready and
      // the user cannot tell whether the agent ignored them, crashed, or is still working. Every path
      // that produces no text and no error must still say something actionable.
      else if (!this.turnAbort.signal.aborted) {
        cliEvents.emit('message', this.msg('system',
          '⚠ The model returned an empty response. Check /model — the configured model may not be served by your provider — or retry.', 'error'));
      }
      cliEvents.emit('cost_update', totalChars);
      // Whatever partial work streamed before the interrupt is kept; tell the user it stopped early.
      if (this.turnAbort.signal.aborted) cliEvents.emit('message', this.msg('system', '⏹ Turn interrupted.'));
      result = this.turnAbort.signal.aborted ? 'interrupted' : 'completed';
    } catch (e: any) {
      const detail = e?.message ?? String(e);
      // A governor veto (budget cap, denied permission, plan mode) otherwise looked like a silent
      // "no response" — only a dim log line. Surface it as a visible system message with the fix.
      if (e?.name === 'GovernorVetoError' || /budget|veto|plan mode/i.test(detail)) {
        cliEvents.emit('message', this.msg('system', `⚠ ${detail}`, 'error'));
      } else if (/No API keys configured/i.test(detail)) {
        // First-run / dismissed onboarding: a keyless turn must say so in the transcript, not die
        // into the hidden log view. Name the exact next step.
        const strictKimiK3 = /kimi-k3/i.test(String(process.env.BIMAX_DESKTOP_STRICT_MODEL || ''));
        cliEvents.emit('message', this.msg('system', strictKimiK3
          ? '⚠ Kimi K3 needs an NVIDIA provider key. Open Bimax Settings → Models → Providers and add or select NVIDIA.'
          : '⚠ No API key configured — run /keys to add one for the selected provider.', 'error'));
      } else if (/rejected the API key|unauthorized/i.test(detail)) {
        // Auth-dead pool (expired key): the adapter fails fast now; make the failure actionable.
        cliEvents.emit('message', this.msg('system', `⚠ ${detail}`, 'error'));
      } else if (/is not served by provider|model.{0,20}(not found|not available|does not exist)/i.test(detail)) {
        // A stale model pin. The adapter already writes the actionable form of this ("run /model to
        // pick an id <provider> serves"), but it only reached the hidden log view, so the turn looked
        // like an unexplained silence. This is THE failure the user actually hits after a provider
        // rotates its catalog — it belongs in the transcript.
        cliEvents.emit('message', this.msg('system', `⚠ ${detail}`, 'error'));
        // Startup healing trusts /models, which can list an id the provider then 404s. THIS is the
        // moment we learn the truth, so re-heal now that the adapter has marked the id unservable.
        // The turn is not replayed: it may already have run tools, and re-running those to recover
        // from a model error is not a trade the user agreed to. Repair, then say it's safe to retry.
        void this.healAfterModelFailure();
      } else {
        // Anything else still ends the turn with no reply. Surface a short form rather than leaving
        // the transcript blank; the full text stays in the log line emitted below.
        cliEvents.emit('message', this.msg('system', `⚠ Turn failed: ${detail}`, 'error'));
      }
      cliEvents.emit('log', { id: Date.now(), level: 'error', text: `Agent error: ${detail}`, timestamp: new Date() });
    } finally {
      this.busy = false;
      this.turnAbort = null;
      recordTurn({ firstTokenMs, totalMs: Date.now() - turnStart, streamedChars: totalChars });
      endTurnTimeline(); // close the phase timeline (persists the secret-free record for /perf)
      cliEvents.emit('thinking_clear');
      // Confidence-in-margin (turn-end form): report whether this turn's edits were checked. The
      // ledger delta tells us how many claims opened (edits) vs resolved (a build/test run named the
      // touched files) during the turn. Silent when the turn changed nothing — it only speaks to
      // confirm verified work or nudge that a change went unchecked.
      if (beforeLedger) {
        try {
          const sum = ledgerTurnSummary(beforeLedger, getEpistemicLedger().stats());
          if (sum) cliEvents.emit('message', this.msg('system', sum.text, sum.level));
        } catch { /* ledger best-effort */ }
      }
      cliEvents.emit('spinner_state', 'idle', 'Ready');
      this.finishTurn?.();
      this.finishTurn = null;
    }
    return result;
  }

  /**
   * The full agent harness: model-tier routing, @-mention expansion, then the agent loop with tools,
   * memory, graph, outcome, and the self-critic/adversarial passes. Extracted so runTurn can pick
   * between this and the lightweight `converse` lane. Streams tokens through `onToken` (which also
   * feeds the perf timeline and the wire) and marks the routing/assembly phase boundaries.
   */
  /**
   * Re-run model healing after a live call proved a configured model unservable, and tell the user
   * what changed. Startup healing can only ask the provider what it CLAIMS to serve; a real 404 is
   * the only proof that a listed id is a lie. Best-effort and never throws — this runs while the
   * turn is already failing, and a failure to self-repair must not replace the original error.
   */
  private async healAfterModelFailure(): Promise<void> {
    try {
      const adapter: any = this.deps.options.llmAdapter;
      if (typeof adapter?.healModels !== 'function') return;
      const healed = await adapter.healModels() as Array<{ slot: string; from: string; to: string }>;
      if (!healed.length) return;
      // Session-scoped, like the boot healer: recover the turn without rewriting the model the
      // user chose. See the note in headless.entry.ts — persisting this is what made an explicit
      // pick silently revert to the top-ranked candidate on every later launch.
      const lines = healed.map(h => `  • ${h.slot}: "${h.from}" → "${h.to}"`);
      cliEvents.emit('message', this.msg('system',
        `Switched to a model your provider actually serves — send that again:\n${lines.join('\n')}`, 'info'));
      cliEvents.emit('config_changed');
    } catch { /* self-repair is best-effort */ }
  }

  private async runFullHarness(active: AgentPersona, query: string, autonomous: boolean, onToken: (t: string) => void, forceHeavy = false): Promise<void> {
    // Routing is local and deterministic (no model call) — it resolves in ~0ms. Kicked off before
    // @-mention expansion purely so the decision is ready the moment expansion completes.
    const tierPromise = decideTier(this.deps.options.llmAdapter, query, this.pinnedTier)
      .catch(() => ({ tier: 'lite' as const, via: 'fallback' as const }));

    let agentQuery = query;
    try { agentQuery = (await expandFileAtMentions(agentQuery, process.cwd())).text; } catch { /* best-effort */ }
    try { agentQuery = (await expandAtMentions(agentQuery, this.deps.graphStore, process.cwd())).text; } catch { /* best-effort */ }

    let useLite = !forceHeavy;
    try {
      const decision = await tierPromise;
      const tier = forceHeavy ? 'heavy' as const : decision.tier;
      useLite = tier === 'lite';
      cliEvents.emit('model_tier', { tier, pinned: this.pinnedTier });
    } catch { /* routing is best-effort; fall back to lite (or heavy when forced) */ }
    markRouted();

    cliEvents.emit('spinner_state', 'thinking', 'Thinking…');
    markAssembled();
    await active.execute(agentQuery, onToken, {
      maxIterations: this.deps.options.maxToolIterations,
      planMode: this.deps.options.governor?.mode === 'plan',
      useLite,
      internalTurn: autonomous,
      signal: this.turnAbort?.signal,
      sessionId: getSessionRecorder()?.currentId() || undefined,
    });
  }

  private async runCommand(query: string): Promise<void> {
    const context: any = {
      cwd: process.cwd(),
      sessionId: getSessionRecorder()?.currentId() || undefined,
      options: this.deps.options,
      codebaseIndexer: this.deps.codebaseIndexer,
      graphStore: this.deps.graphStore,
      saveConfig: this.deps.saveConfig ?? (() => {}),
      addSystemMessage: (level: string, msg: string) =>
        cliEvents.emit('message', this.msg('system', msg, level)),
      // Menus / prompts are forwarded as messages carrying a uiComponent + payload; the front-end
      // renders them and replies via the protocol's menuSelect / reply channel.
      setActiveMenu: (menu: any) => this.emitMenu(menu),
      // Free-form prompts go through the request/reply channel (the old uiComponent-'prompt'
      // message was unrenderable out-of-process: its onResolve callback can't cross the wire, so
      // flows like /keys dead-ended with no visible prompt). isMasked rides along so secrets are
      // masked by contract. setActivePrompt(null) is the Ink "dismiss" — a no-op over the wire.
      setActivePrompt: (prompt: any) => {
        if (!prompt || !prompt.title) return;
        cliEvents.emit('input_prompt', prompt.title, (val: string) => prompt.onResolve?.(val), { masked: !!prompt.isMasked });
      },
      executeCommand: (cmd: string) => { void this.dispatch(cmd); },
      // Contract: receives LLM-ready Message[] (already through messageEntriesToLLM — raw UI
      // entries poisoned provider payloads). Returns false when refused so callers can stop.
      restoreMessages: (msgs: any[]): boolean => {
        // Refuse to swap the history array while a turn is running — the agent loop is mutating it,
        // and replacing it mid-flight corrupts the conversation. Same guard as runTurn().
        if (this.busy) { cliEvents.emit('status', 'Busy — finish the current turn before loading a session.'); return false; }
        const active = this.deps.personas.bimax;
        if (Array.isArray(msgs)) {
          for (const persona of new Set(Object.values(this.deps.personas))) {
            persona.messages = [];
            try { persona.resetContextSession?.(); } catch { /* best-effort */ }
          }
        }
        if (active && Array.isArray(msgs)) {
          active.messages = msgs.slice() as any;
          // Explicit session boundary (/clear, session load/resume): the session-scoped
          // ContextManager (calibration, warning latch, compaction epochs) resets WITH the history.
          try { (active as any).resetContextSession?.(); } catch { /* best-effort */ }
        }
        return true;
      },
      // Return the live conversation so /cost, /save, /sessions et al. work (was stubbed to [], which
      // made those commands silently show nothing).
      getMessages: () => {
        const active = this.deps.personas.bimax;
        return active && Array.isArray(active.messages) ? active.messages : [];
      },
    };

    try {
      const result = await globalCommandRegistry.execute(query, context);
      if (!result) return;
      if (result.type === 'message') cliEvents.emit('message', this.msg('system', result.content, result.level));
      else if (result.type === 'menu') this.emitMenu(result);
      else if (result.type === 'prompt') {
        // Free-form text prompt: bridge its onResolve callback through the request/reply channel.
        const r: any = result;
        cliEvents.emit('input_prompt', r.title, (val: string) => r.onResolve?.(val), { masked: !!r.isMasked });
      } else if (result.type === 'redirect') void this.dispatch(result.command);
      else if (result.type === 'dashboard') cliEvents.emit('message', this.uiMsg(result.uiComponent, result.payload));
    } catch (err: any) {
      if (!String(err?.message).includes('Unknown command')) {
        cliEvents.emit('message', this.msg('system', err?.message ?? String(err), 'error'));
      }
    }
  }

  /**
   * Emit an interactive menu to the front-end, remembering its onSelect so a later menuSelect can run
   * the real handler. The id correlates the two. Options with full-command values still work for
   * menus that have no onSelect (selectMenu falls back to dispatching the value).
   */
  private emitMenu(menu: any): void {
    const id = `menu-${++this.menuSeq}`;
    this.menus.set(id, { options: menu.options || [], onSelect: menu.onSelect });
    // Cap the registry — only the most recent few menus can realistically be selected.
    if (this.menus.size > 16) {
      const oldest = this.menus.keys().next().value;
      if (oldest) this.menus.delete(oldest);
    }
    // The MessageEntry carries the SAME id as the registry key. A front-end that replies with the
    // message's id (the desktop app does; the TUI reads payload.id) then hits the real entry — with
    // two different ids, every `onSelect` menu fell through to `dispatch(value)` and options whose
    // value is not a command (a model id, a rule index, `__custom__`) silently did nothing.
    cliEvents.emit('message', {
      ...this.uiMsg('menu', {
        id,
        title: menu.title,
        subtitle: menu.subtitle,
        options: (menu.options || []).map(undecorate),
        initialIndex: menu.initialIndex,
      }),
      id,
    });
  }

  /** Run a menu option's onSelect (or dispatch its value as a command if the menu had none). */
  selectMenu(id: string, value: string): void {
    const entry = this.menus.get(id);
    if (entry?.onSelect) {
      const opt = entry.options.find((o: any) => o?.value === value) ?? { value, label: value };
      this.menus.delete(id);
      try { entry.onSelect(opt); } catch (e: any) {
        cliEvents.emit('message', this.msg('system', `Menu action failed: ${e?.message ?? e}`, 'error'));
      }
      return;
    }
    this.menus.delete(id);
    // No onSelect (or unknown menu): the value is a command/redirect — dispatch it as the user would.
    if (value) void this.dispatch(value);
  }

  /** Concatenate this turn's assistant text, stripping reasoning/tool-call scaffolding. */
  private collectTurnText(active: AgentPersona, before: number): string {
    const joined = active.messages
      .slice(before)
      .filter((m: any) => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim())
      .map((m: any) => m.content.trim())
      .join('\n\n');
    return this.cleanTurnText(joined);
  }

  /** Strip reasoning / tool-call scaffolding from a chunk of assistant text. */
  private cleanTurnText(text: string): string {
    return (text || '')
      .replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
      // A still-open <tool_call> is a streaming cutoff — strip it to the end, but ONLY when a JSON
      // payload actually follows. Otherwise a literal "<tool_call>" mentioned in prose would nuke
      // the rest of a real answer (the audit's display-eating bug).
      .replace(/<tool_call>\s*[[{][\s\S]*$/, '')
      .trim();
  }

  private msg(role: 'user' | 'assistant' | 'system', content: string, level?: string): MessageEntry {
    return { id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, role, level: level as any, content, timestamp: new Date() };
  }

  private uiMsg(uiComponent: string, payload: any): MessageEntry {
    return { id: `ui-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, role: 'system', uiComponent, payload, content: '', timestamp: new Date() };
  }
}
