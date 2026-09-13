import { capabilitySnapshot, capabilityMessage } from '../core/capability.status';
import { EventEmitter } from 'events';
import {
  Outbound, Inbound, ReplyMsg, MenuSelectMsg, CompletionItem, CatalogResultMsg,
  FORWARDED_EVENTS, PROMPT_EVENT, DIFF_PROMPT_EVENT, INPUT_PROMPT_EVENT,
  PROTOCOL_FEATURES, PROTOCOL_MAX_COMPATIBLE_MAJOR, PROTOCOL_MIN_COMPATIBLE_MAJOR,
  PROTOCOL_SEMVER, PROTOCOL_VERSION, sanitizeArgs,
} from './protocol';
import { markReady, loadPersistedTimelines } from '../telemetry/perf';

export interface HostHandlers {
  /** A submitted prompt line (user turn or slash command) arrived from the front-end. */
  onInput?: (text: string) => void;
  /** The front-end asked to cancel the in-flight turn. */
  onInterrupt?: () => void;
  /** The front-end asked for autocomplete candidates for the current input. */
  onQuery?: (text: string) => CompletionItem[] | Promise<CompletionItem[]>;
  /** The front-end picked an option in a menu the engine emitted — run that menu's onSelect. */
  onMenuSelect?: (id: string, value: string) => void;
  /** Settings page read — return the allowlisted config subset (v3). */
  onConfigGet?: () => Record<string, any>;
  /** Settings page write — merge the allowlisted patch, return the post-write subset (v3). */
  onConfigSet?: (patch: Record<string, any>) => Record<string, any> | Promise<Record<string, any>>;
  /** Provider + model catalogue read (v3 additive) — answered with a `catalogResult`. */
  onCatalogGet?: (refresh: boolean) => Promise<Omit<CatalogResultMsg, 't' | 'id'>>;
  /**
   * Switch the active provider, optionally saving a key for it first (v3 additive). The key is
   * write-only: it is handed straight to the engine's secrets path and is never echoed back.
   */
  onProviderSet?: (input: { name: string; baseURL?: string; apiKey?: string }) => Promise<Omit<CatalogResultMsg, 't' | 'id'>>;
  /** Typed session resume (recovery flows) — restore the saved thread with this id. */
  onResume?: (id: string) => void;
  /** Atomically apply mode/tier/autonomy controls; the session serializes the underlying actions. */
  onControls?: (controls: { mode?: string; tier?: string; autonomy?: string }) => void | Promise<void>;
}

/**
 * Engine-side endpoint of the UI protocol. It bridges the in-process `cliEvents` emitter +
 * GlobalPrompter approval round-trip to an out-of-process front-end, transport-agnostically:
 * you give it a `write` sink (stdout, a socket, a test buffer) and feed it inbound lines.
 *
 *   • Forwarded events  → serialized as `event` messages.
 *   • `veto_prompt`      → translated to a `request`; its in-process resolve callback is held in
 *                          a pending map and fired when the matching `reply` returns.
 *   • inbound `input`    → routed to handlers.onInput (the engine's existing dispatch).
 *
 * Nothing here touches Ink: attaching the host adds listeners; the in-process appStore bridge in
 * events.ts keeps working untouched, so the two front-ends are interchangeable, not exclusive.
 */
export class ProtocolHost {
  private emitter: EventEmitter | null = null;
  private listeners: Array<{ event: string; fn: (...a: any[]) => void }> = [];
  private pending = new Map<number, (answer: string) => void>();
  // Request kind per pending id — resolution announcements skip kind 'input' (may carry secrets).
  private pendingKind = new Map<number, string>();
  private nextRequestId = 1;

  /** Announce a request's resolution to in-process observers (ReviewManager). Never for inputs. */
  private announceResolved(id: number, value: string, interrupted?: boolean): void {
    const kind = this.pendingKind.get(id);
    this.pendingKind.delete(id);
    if (!kind || kind === 'input' || !this.emitter) return;
    try {
      this.emitter.emit('request_resolved', { id, value, ...(interrupted ? { interrupted: true } : {}) });
    } catch { /* observers must never break the wire */ }
  }

  constructor(
    private write: (line: Outbound) => void,
    private handlers: HostHandlers = {},
  ) {}

  /** Subscribe to the engine's event seam and emit the handshake. */
  attach(emitter: EventEmitter): void {
    if (this.emitter) throw new Error('[ProtocolHost] already attached');
    this.emitter = emitter;

    for (const name of FORWARDED_EVENTS) {
      const fn = (...args: any[]) => this.write({ t: 'event', name, args: sanitizeArgs(args) });
      emitter.on(name, fn);
      this.listeners.push({ event: name, fn });
    }

    // Review-domain meta-events: the host is the one choke point every approval round-trip passes
    // through (veto, diff, ask, input — with the wire-visible ids and duplicate-reply dropping),
    // so it announces request lifecycle on the engine emitter for in-process observers
    // (ReviewManager). These are internal — deliberately NOT in FORWARDED_EVENTS.
    const announcePending = (id: number, kind: string, question: string, isAsk?: boolean) => {
      this.pendingKind.set(id, kind);
      try { emitter.emit('request_pending', { id, kind, question, isAsk: !!isAsk }); } catch { /* observers must never break the wire */ }
    };

    // veto_prompt(question, options, resolve, isAsk?) — the one event carrying a callback.
    const promptFn = (question: string, options: string[], resolve: (a: string) => void, isAsk?: boolean, isMultiSelect?: boolean) => {
      const id = this.nextRequestId++;
      this.pending.set(id, resolve);
      announcePending(id, 'prompt', question, isAsk);
      this.write({ t: 'request', id, kind: 'prompt', question, options: options || [], isAsk: !!isAsk, isMulti: !!isMultiSelect });
    };
    emitter.on(PROMPT_EVENT, promptFn);
    this.listeners.push({ event: PROMPT_EVENT, fn: promptFn });

    // diff_prompt(summary, diff, resolve) — the inline diff-approval gate. Same request/reply
    // mechanism as veto_prompt, but carries the diff body for the front-end to render.
    const diffFn = (summary: string, diff: string, resolve: (a: string) => void) => {
      const id = this.nextRequestId++;
      this.pending.set(id, resolve);
      announcePending(id, 'diff', summary);
      this.write({ t: 'request', id, kind: 'diff', question: summary, options: ['Approve', 'Reject'], body: diff });
    };
    emitter.on(DIFF_PROMPT_EVENT, diffFn);
    this.listeners.push({ event: DIFF_PROMPT_EVENT, fn: diffFn });

    // input_prompt(title, resolve, opts?) — a free-form text prompt (e.g. /keys asking for an API
    // key). `opts.masked` rides the wire so the front-end masks secrets BY CONTRACT — not by
    // guessing from the question's wording. Announced with kind 'input' so review observers can
    // ignore it; input replies are never re-announced (they can carry secrets).
    const inputFn = (title: string, resolve: (a: string) => void, opts?: { masked?: boolean }) => {
      const id = this.nextRequestId++;
      this.pending.set(id, resolve);
      announcePending(id, 'input', title);
      this.write({ t: 'request', id, kind: 'input', question: title, options: [], masked: !!opts?.masked });
    };
    emitter.on(INPUT_PROMPT_EVENT, inputFn);
    this.listeners.push({ event: INPUT_PROMPT_EVENT, fn: inputFn });

    markReady(); // engine wired + handshake sent — the cold-start clock stops here (/perf)
    loadPersistedTimelines(); // seed /perf so it can explain prior turns after a restart/crash
    this.write({
      t: 'hello',
      engine: {
        version: process.env.BIMAX_ENGINE_VERSION?.trim() || 'dev',
        buildCommit: process.env.BIMAX_ENGINE_COMMIT?.trim() || 'unknown',
      },
      protocolVersion: PROTOCOL_SEMVER,
      protocolMajor: PROTOCOL_VERSION,
      minCompatibleMajor: PROTOCOL_MIN_COMPATIBLE_MAJOR,
      maxCompatibleMajor: PROTOCOL_MAX_COMPATIBLE_MAJOR,
      features: [...PROTOCOL_FEATURES],
    });
    this.write({ t: 'ready', protocol: PROTOCOL_VERSION });
    for (const status of capabilitySnapshot().filter(s => s.state !== 'ready')) {
      this.write({ t: 'event', name: 'message', args: sanitizeArgs([capabilityMessage(status)]) });
    }
  }

  /** Route one decoded inbound message. Unknown / stale messages are ignored, never thrown. */
  ingest(msg: Inbound): void {
    switch (msg.t) {
      case 'reply': {
        const { id, value } = msg as ReplyMsg;
        const resolve = this.pending.get(id);
        if (resolve) { this.pending.delete(id); this.announceResolved(id, value); resolve(value); }
        return; // a reply with no pending id is a late/duplicate answer — drop it
      }
      case 'input':
        this.handlers.onInput?.(msg.text);
        return;
      case 'menuSelect': {
        const { id, value } = msg as MenuSelectMsg;
        this.handlers.onMenuSelect?.(id, value);
        return;
      }
      case 'interrupt':
        this.handlers.onInterrupt?.();
        return;
      case 'ping':
        // Answered synchronously from the ingest path — no engine work is awaited, so a pong only
        // fails to return when the process/event loop is genuinely wedged (which is the signal).
        this.write({ t: 'pong', id: msg.id });
        return;
      case 'query': {
        const { id, text } = msg;
        Promise.resolve(this.handlers.onQuery?.(text) ?? [])
          .then(items => this.write({ t: 'queryResult', id, items }))
          .catch(() => this.write({ t: 'queryResult', id, items: [] }));
        return;
      }
      case 'configGet': {
        let config: Record<string, any> = {};
        try { config = this.handlers.onConfigGet?.() ?? {}; } catch { /* answer empty, never hang */ }
        this.write({ t: 'configResult', id: msg.id, config });
        return;
      }
      case 'resume': {
        // Ids come from ui_snapshot session lists, but validate anyway: a session id is a short
        // slug, never something with newlines/quotes that could smell like command injection.
        const id = String(msg.id ?? '').trim();
        if (id && /^[\w.:-]{1,128}$/.test(id)) this.handlers.onResume?.(id);
        return;
      }
      case 'controls': {
        const mode = ['general', 'explore', 'sketch', 'code', 'beast'].includes(String(msg.mode)) ? msg.mode : undefined;
        const tier = ['auto', 'lite', 'heavy'].includes(String(msg.tier)) ? msg.tier : undefined;
        const autonomy = ['ask', 'auto', 'plan', 'full'].includes(String(msg.autonomy)) ? msg.autonomy : undefined;
        if (mode || tier || autonomy) void this.handlers.onControls?.({ mode, tier, autonomy });
        return;
      }
      case 'configSet': {
        const { id, patch } = msg;
        Promise.resolve(this.handlers.onConfigSet?.(patch ?? {}) ?? {})
          .then(config => this.write({ t: 'configResult', id, config }))
          .catch(() => this.write({ t: 'configResult', id, config: {} }));
        return;
      }
      case 'catalogGet': {
        const { id } = msg;
        this.answerCatalog(id, this.handlers.onCatalogGet?.(msg.refresh === true));
        return;
      }
      case 'providerSet': {
        const { id } = msg;
        // Validate before the key ever reaches a handler: a provider name is a short slug, and a
        // base URL must be an http(s) origin. An unvalidated baseURL is a credential-exfiltration
        // primitive — it is where the API key gets sent on the very next request.
        const name = String(msg.name ?? '').trim();
        if (!/^[\w.-]{1,64}$/.test(name)) {
          this.answerCatalog(id, Promise.reject(new Error('Invalid provider name.')));
          return;
        }
        const baseURL = String(msg.baseURL ?? '').trim();
        if (baseURL && !/^https?:\/\/[^\s]+$/i.test(baseURL)) {
          this.answerCatalog(id, Promise.reject(new Error('A provider endpoint must be an http(s) URL.')));
          return;
        }
        this.answerCatalog(id, this.handlers.onProviderSet?.({
          name,
          ...(baseURL ? { baseURL } : {}),
          ...(typeof msg.apiKey === 'string' && msg.apiKey ? { apiKey: msg.apiKey } : {}),
        }));
        return;
      }
    }
  }

  /**
   * Answer a catalogue request, correlated by `id`.
   *
   * A front-end blocks its picker on this reply, so every path must produce exactly one message:
   * an unhandled message kind or a rejected fetch answers with an empty catalogue carrying the
   * reason, never with silence.
   */
  private answerCatalog(id: number, work?: Promise<Omit<CatalogResultMsg, 't' | 'id'>>): void {
    Promise.resolve(work ?? { providers: [], models: [], error: 'This engine does not provide a catalogue.' })
      .then(result => this.write({ t: 'catalogResult', id, ...result }))
      .catch((e: any) => this.write({
        t: 'catalogResult', id, providers: [], models: [],
        error: String(e?.message || e || 'The catalogue could not be read.'),
      }));
  }

  /** Number of approval requests still awaiting an answer (for diagnostics / tests). */
  pendingCount(): number { return this.pending.size; }

  /** Remove all listeners. Any unanswered prompts are resolved empty so the engine doesn't hang. */
  detach(): void {
    if (this.emitter) {
      for (const { event, fn } of this.listeners) this.emitter.off(event, fn);
    }
    // Announce interruption BEFORE dropping the emitter so review observers record that these
    // approvals were never answered (front-end gone / shutdown) — not silently approved or denied.
    for (const id of this.pending.keys()) this.announceResolved(id, '', true);
    this.listeners = [];
    this.emitter = null;
    for (const resolve of this.pending.values()) {
      try { resolve(''); } catch { /* ignore */ }
    }
    this.pending.clear();
    this.pendingKind.clear();
  }
}
