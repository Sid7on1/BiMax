import { LLMProvider, Message } from '../core/llm.provider';
import { contentToText, isScreenshotObservationMessage } from '../core/multimodal';
import { Logger } from '../utils/logger';
import { fileStateCache } from './file-state-cache';
import { RECALL_PREFIX } from './recall';
import { archiveOutput } from '../context/output.archive';
import { ContextEvidence, evidenceSpan, fileEvidence, fileVersion, versionOfText } from '../context/evidence';
import { CONTINUATION_PREFIX, ContinuationState, isContinuationMessage } from '../context/continuation';
import { MESSAGE_FRAMING_TOKENS, countTokens, type RequestRecord } from '../context/request.budget';
import { carriedSummary, summarizeLog } from '../context/log.summary';
import { IGraphStore } from '../graph/models';
import { crossRepoMapSync } from '../graph/cross.repo';
import { compressBacklog, proxyCompress, recordCompression, looksLikeCode } from './headroom.compress';
import { cliEvents } from '../cli/events';
import { encode } from 'gpt-tokenizer';


export type ContextMode = 'smart' | 'full';

/**
 * ContextManager — bimax's layered context manager (the analogue of Claude Code's multi-layer
 * compaction stack). Before each API call in SMART mode it runs an ordered set of deterministic
 * passes, cheapest first, so we only pay for the expensive (LLM-summarizing) layer when the cheap
 * ones haven't freed enough room:
 *
 *   1. capToolResults  — truncate any single oversized tool result (no LLM, always).
 *   2. microCompact    — clear OLD tool results, keep the last N intact (no LLM, always).
 *   3. snip            — drop the oldest history beyond a protected tail for runaway sessions (no LLM).
 *   4. compact         — summarize older messages into one system note (LLM, only under token pressure).
 *
 * FULL mode skips all proactive passes — everything is sent until the API itself rejects it, at
 * which point reactiveCompact() recovers. The model always sees the whole history in full mode.
 */
// Module-level graph store reference injected by the container at startup.
// When set, checkAndCompact() injects a compact RepoMap outline at the capToolResults layer.
let _graphStore: IGraphStore | null = null;
/** The note compaction appends to a tool result it compressed; the raw output's archive handle follows it. */
const RAW_OUTPUT_NOTE = 'compressed to save context; the raw output is archived as';

/** The raw output's archive handle in a tool result compaction compressed, or null. */
function rawHandleIn(content: string): string | null {
  const at = content.lastIndexOf(`[${RAW_OUTPUT_NOTE} archive:`);
  if (at < 0) return null;
  return /^archive:[0-9a-f]{32}/.exec(content.slice(at + RAW_OUTPUT_NOTE.length + 2))?.[0] ?? null;
}

export function setContextManagerGraphStore(store: IGraphStore): void { _graphStore = store; }
/** The boot-wired native graph store, for code that needs a RepoMap outside the compaction loop. */
export function getContextManagerGraphStore(): IGraphStore | null { return _graphStore; }

// Pull "code-ish" focus terms from the latest user message to personalize the repo map: camelCase,
// snake_case, paths, or dotted names (setAuthCookie, auth.ts, src/auth). Plain prose words are
// skipped — boosting on "read"/"improve" would surface unrelated symbols. Empty for a vague request,
// so the map falls back to pure PageRank ranking.
export function focusTermsFromMessages(msgs: Message[]): string[] {
  const lastUser = [...msgs].reverse().find(m => m.role === 'user' && !isScreenshotObservationMessage(m));
  const text = lastUser ? contentToText(lastUser.content as any) : '';
  if (!text) return [];
  const terms = new Set<string>();
  for (const w of text.match(/[A-Za-z_][A-Za-z0-9_./-]{2,}/g) || []) {
    if (/[A-Z]/.test(w) || w.includes('_') || w.includes('/') || w.includes('.')) {
      terms.add(w);
      if (terms.size >= 40) break;
    }
  }
  return [...terms];
}

/** Inject a refreshed RepoMap without violating strict tool-result role ordering. */
export function injectRepoMap(messages: Message[], outline: string): Message[] {
  const withoutOldMap = messages.filter(m => !(
    (m.role === 'system' || m.role === 'user')
    && typeof m.content === 'string'
    && m.content.startsWith('[RepoMap]')
  ));
  if (!outline) return withoutOldMap;

  let lastUser = -1;
  for (let i = withoutOldMap.length - 1; i >= 0; i--) {
    if (withoutOldMap[i].role === 'user' && !isScreenshotObservationMessage(withoutOldMap[i])) {
      lastUser = i;
      break;
    }
  }
  const insertionIndex = lastUser >= 0 ? lastUser : withoutOldMap.length;
  // Screenshot observations are protocol turns, not new human requests. Anchor the refreshed map
  // before the latest real user turn so it never lands inside assistant → tool → assistant → user.
  const mapMsg: Message = { role: 'system', content: outline };
  return [
    ...withoutOldMap.slice(0, insertionIndex),
    mapMsg,
    ...withoutOldMap.slice(insertionIndex),
  ];
}

export class ContextManager {
  private readonly MAX_TOKENS: number;
  private readonly COMPACT_THRESHOLD = 0.7; // summarize when reaching 70% of the window
  private readonly WARN_THRESHOLD = 0.5;    // one-time early warning at 50%
  private currentTokens: number = 0;
  private halfWindowWarnEmitted = false;    // fire the 50% nudge only once per session

  // Cheap-pass tuning. Deliberately conservative so multi-step tasks keep the context they need.
  private readonly TOOL_RESULT_MAX_CHARS = 16000; // cap on a single tool result
  private readonly KEEP_RECENT_TOOL_RESULTS = 6;  // most recent tool outputs left fully intact
  private readonly MIN_ARCHIVED_RESULT_CHARS = 512; // shorter cleared results get the short stub, unarchived
  private readonly SNIP_TRIGGER_MESSAGES = 100;   // only guard against truly runaway histories
  private readonly SNIP_KEEP_TAIL = 60;
  private readonly RESTORE_BUDGET_CHARS = 40_000; // total post-compact file re-injection budget (~10k tok)

  /**
   * What this session showed the model and where it came from (record 50 step 5): recalled memory, restored files and
   * archived tool output. A span goes stale when the source it was taken from changes.
   */
  readonly evidence = new ContextEvidence();
  /** What compaction removed that a long task must keep: the user's words, commands run, the assistant's claims. */
  readonly continuation = new ContinuationState();

  // Real-usage overhead calibration (C4): our estimate only sees `messages`, but the request also
  // carries the system prompt + tool schemas (10-30k tokens the estimate is blind to). The provider's
  // usage report includes everything, so (real − estimate-of-what-we-sent) measures that invisible
  // overhead; folding it into every pressure ratio makes compaction fire when the REQUEST nears the
  // window, not when the visible history does — which was systematically late.
  private lastSentEstimate = 0;
  private overheadTokens = 0;

  // System messages the manager (or the persona) re-generates fresh each turn/compaction. Preserving
  // them across compactions was pure context rot: every compact accreted another stale summary +
  // stale file restorations that all later compacts dutifully kept forever.
  private static readonly TRANSIENT_SYSTEM_PREFIXES = [
    '[Previous Context Summary]',
    '[Post-Compact Restoration',
    '[RepoMap]',
    '[TurnContext]',
    '[ContextManager]',
    '[Older messages aggressively compacted',
    // Recalled memory is evidence for the turn it was retrieved for. Kept durable, a recalled fact
    // outlived its freshness and could never be refreshed (record 47, A04); AgentLoop forgets the
    // session's recalls when compaction drops one, so a question still in play recalls again.
    RECALL_PREFIX,
    // Re-rendered from ContextManager.continuation into every compacted window; an old copy is never kept.
    CONTINUATION_PREFIX,
  ];

  private isTransientSystem(m: Message): boolean {
    return m.role === 'system' && typeof m.content === 'string' &&
      ContextManager.TRANSIENT_SYSTEM_PREFIXES.some(p => (m.content as string).startsWith(p));
  }

  // Epoch counter: incremented at the start of each compact() call.
  // Lets callers detect whether compaction ran between two points in time (ABA prevention).
  private compactionEpoch = 0;

  // Default is a safe generic window (most modern OpenAI-compatible models are >=128k). The agent
  // loop passes the user-configured value when set, so this only applies if nothing wired a real one.
  constructor(private llm: LLMProvider, maxTokens: number = 128000) {
    this.MAX_TOKENS = maxTokens > 0 ? maxTokens : 128000;
  }

  /** Returns the current compaction epoch. Callers can snapshot this and later call checkEpoch(). */
  getEpoch(): number { return this.compactionEpoch; }

  /**
   * Returns true if the epoch hasn't changed since `priorEpoch` was captured — meaning no
   * compaction ran between then and now, so any buffered messages are still valid.
   */
  checkEpoch(priorEpoch: number): boolean { return this.compactionEpoch === priorEpoch; }

  /** Called by the AgentLoop when the LLM returns token usage. */
  updateTokens(promptTokens: number) {
    this.currentTokens = promptTokens;
    // Calibrate the invisible request overhead (system prompt + tool schemas + serialization):
    // real reported prompt tokens minus our estimate of the history we actually sent.
    if (this.lastSentEstimate > 0 && promptTokens > 0) {
      this.overheadTokens = Math.max(0, promptTokens - this.lastSentEstimate);
    }
  }

  /** Estimated request tokens = visible history + calibrated invisible overhead (C4). */
  private effectiveTokens(messages: Message[]): number {
    return this.estimateTokens(messages) + this.overheadTokens;
  }

  /**
   * Run the layered compaction before an API call. In FULL mode this is a no-op (reactiveCompact
   * still recovers on a 413). In SMART mode it applies the cheap passes always, then summarizes
   * only if still over the token threshold.
   */
  async checkAndCompact(messages: Message[], mode: ContextMode = 'smart'): Promise<Message[]> {
    if (mode === 'full') {
      // Even with no compaction, record what we're sending so updateTokens can calibrate overhead.
      this.lastSentEstimate = this.estimateTokens(messages);
      return messages;
    }

    // Layer 0 — deterministic in-process log compression, only under TOKEN PRESSURE. The default
    // compactor is compressBacklog: bounded, deterministic, in-process, and code-safe (skipCode
    // keeps code verbatim; error/warning lines are always preserved). Opt out entirely with
    // BIMAX_DISABLE_COMPRESSION=1.
    //
    // The optional Headroom Kompress ML compressor is STRICTLY opt-in (BIMAX_ENABLE_HEADROOM=1):
    // it spawns a separately-provisioned localhost sidecar, and NOTHING on the foreground turn path
    // may create a Python venv, pip-install, download a model, or open a listener. Without the
    // explicit opt-in it is never imported, so a user turn does deterministic in-process work only.
    let msgs: Message[] = messages;
    const pressureRatio = this.effectiveTokens(messages) / this.MAX_TOKENS;
    if (process.env.BIMAX_DISABLE_COMPRESSION !== '1' && pressureRatio >= this.COMPACT_THRESHOLD) {
      // Which model the saving is attributed to (for the per-model /headroom report).
      let model = 'unknown';
      try { const c = require('../cli/config').getConfig(); model = c.model || c.liteModel || 'unknown'; } catch { /* config optional */ }

      let saved = 0;
      let usedProxy = false;
      if (process.env.BIMAX_ENABLE_HEADROOM === '1') {
        // Explicitly-enabled ML path. Fire-and-forget warm-up (idempotent); NEVER wait for the
        // sidecar in front of a turn — if it isn't ready, the native pass below covers this turn.
        import('./headroomProxy').then(m => m.ensureHeadroomProxy().catch(() => {})).catch(() => {});
        const proxied = await proxyCompress(messages as any, model === 'unknown' ? '' : model, this.MAX_TOKENS);
        if (proxied) {
          const before = this.estimateTokens(messages);
          const after = this.estimateTokens(proxied.messages as Message[]);
          if (after > before) {
            // Sanity net: a compactor that GROWS the context is a regression. Keep the original.
            Logger.warn(`[Headroom] proxy returned a LARGER context (${before} → ${after} tok); discarding its result.`);
          } else {
            // Stack the lossless native pass on top to also collapse repetitive log spam.
            const stacked = compressBacklog(proxied.messages as any, { protectRecent: 0, skipCode: true });
            msgs = stacked.messages as Message[];
            const finalAfter = this.estimateTokens(msgs);
            saved = Math.max(0, before - finalAfter, proxied.saved);
            usedProxy = true;
            if (saved > 0) recordCompression(model, before, Math.max(0, before - saved), 'proxy');
          }
        }
      }
      if (!usedProxy) {
        // Default deterministic path: collapse repetitive log/ANSI spam in tool outputs. skipCode
        // guarantees code passes through VERBATIM; error/warning lines are always kept.
        const { messages: compressed, stats } = compressBacklog(messages as any, { protectRecent: 0, skipCode: true });
        msgs = compressed as Message[];
        saved = stats.saved;
        if (saved > 0) recordCompression(model, stats.compressedBefore, stats.compressedAfter, 'native');
      }
      msgs = this.keepRawOutput(messages, msgs);
      if (saved > 0) {
        Logger.info(`[Headroom] ${usedProxy ? 'Kompress proxy' : 'native'} compression saved ~${saved} tokens (model ${model})`);
        // Token-meter refresh only. This must NOT be 'graph_changed' — the TUI renders that as
        // "code graph updated", which is a lie for a context-token refresh.
        try { cliEvents.emit('context_changed'); } catch { /* best-effort */ }
      }
    }

    msgs = this.capToolResults(msgs);
    // microCompact only under pressure (C3): running it unconditionally destroyed old tool results
    // even at 5% usage (context the model may still need, for zero benefit) AND moved its stub
    // boundary every round — rewriting history bytes mid-prefix, churning the provider cache.
    if (this.effectiveTokens(msgs) / this.MAX_TOKENS >= this.WARN_THRESHOLD) {
      msgs = this.microCompact(msgs);
    }
    msgs = this.snip(msgs);

    // RepoMap (aider-style): refresh it EVERY turn so it reflects current files and re-ranks toward
    // THIS request (focus terms from the latest user message). Strip any prior map first so history
    // keeps exactly one copy — current, personalized, no accumulation.
    //
    // PLACEMENT MATTERS: the map is injected immediately BEFORE the latest user message, never at
    // messages[0]. A per-turn-changing message at the head of the conversation invalidates the
    // provider's prompt-prefix cache for the ENTIRE history on every single turn — the silent tax
    // that made long sessions slow and expensive. Near the tail, only the last few messages are
    // uncached; everything earlier stays a byte-stable, cacheable prefix. (Within one agent-loop
    // turn the position is stable too — tool rounds append after it.)
    if (_graphStore) {
      try {
        // Cross-repo (PR3): merges every indexed repo in a multi-repo workspace into one map; with a
        // single repo it returns exactly the old single-repo outline. Sync — never blocks on disk.
        const outline = crossRepoMapSync(_graphStore, 1500, focusTermsFromMessages(msgs));
        msgs = injectRepoMap(msgs, outline);
      } catch { /* pagerank optional — never fail the compaction loop */ }
    }

    // Heavy fallback: summarize only when the cheap passes left us above the threshold.
    // Ratio includes the calibrated request overhead (system prompt + schemas) — see updateTokens.
    const ratio = this.effectiveTokens(msgs) / this.MAX_TOKENS;

    // One-time early nudge at 50% so the model can be conservative before forced compaction.
    if (!this.halfWindowWarnEmitted && ratio >= this.WARN_THRESHOLD) {
      this.halfWindowWarnEmitted = true;
      Logger.warn(`[ContextManager] Context window ${Math.round(ratio * 100)}% full — approaching compaction threshold.`);
      msgs = [
        ...msgs,
        {
          role: msgs[msgs.length - 1]?.role === 'tool' ? 'user' as const : 'system' as const,
          content: `[ContextManager] You have used ~${Math.round(ratio * 100)}% of your context window. To avoid forced compaction, prefer targeted reads (startLine/endLine), release unneeded context with FreeContextTool, and avoid re-reading files you already have.`,
        },
      ];
    }

    if (ratio > this.COMPACT_THRESHOLD) {
      Logger.warn(`[ContextManager] ${Math.round(ratio * 100)}% after cheap passes — summarizing older history.`);
      msgs = await this.compact(msgs);
    }
    // What we're actually sending this round — updateTokens diffs the provider's real usage
    // against this to keep the overhead calibration current.
    this.lastSentEstimate = this.estimateTokens(msgs);
    return msgs;
  }

  /**
   * Layer 1 — cap a single oversized tool result so one giant Bash/log dump can't dominate the
   * window. Keeps the head and tail (where the signal usually is) and notes how much was elided.
   *
   * CODE IS NEVER ELIDED: a source-file read or code-dense output passes through verbatim no
   * matter its size (`looksLikeCode`). Partially-elided code is worse than either extreme — the
   * model edits against a file it believes it has whole. Code leaves the window only via the
   * explicit, whole-result mechanisms (micro-compact stubs of OLD results, FreeContextTool), never
   * via silent mid-content truncation.
   */
  /**
   * Compression is lossy — order, individual samples and ANSI are gone — and it ran before any archive existed, so a
   * compressed result could later be cleared with only its compressed form saved, or none at all (audit 51, U11). Each
   * tool result compression changed is archived raw first and carries that handle; a result that would not stay
   * shorter with the note, or whose raw form cannot be saved, keeps its compressed form as before.
   */
  private keepRawOutput(before: Message[], after: Message[]): Message[] {
    if (before.length !== after.length) return after;
    return after.map((m, i) => {
      const raw = before[i]?.content;
      if (m.role !== 'tool' || typeof raw !== 'string' || typeof m.content !== 'string' || m.content === raw) return m;
      if (raw.length < this.MIN_ARCHIVED_RESULT_CHARS || rawHandleIn(m.content)) return m;
      const handle = this.archive(raw);
      if (!handle) return m;
      // A log keeps its shape: the line count and first failures of the raw output lead the compressed form (step 6d).
      const summary = carriedSummary(m.content) ? null : summarizeLog(raw);
      const content = `${summary ? `${summary}\n` : ''}${m.content}\n[${RAW_OUTPUT_NOTE} ${handle} (ContextArchiveTool)]`;
      return content.length < raw.length ? { ...m, content } : m;
    });
  }

  private capToolResults(messages: Message[]): Message[] {
    const max = this.TOOL_RESULT_MAX_CHARS;
    let trimmed = 0;
    const out = messages.map(m => {
      if (m.role !== 'tool' || typeof m.content !== 'string' || m.content.length <= max) return m;
      if (looksLikeCode(m.content)) return m; // code survives every compaction path verbatim
      trimmed++;
      const head = m.content.slice(0, Math.floor(max * 0.7));
      const tail = m.content.slice(-Math.floor(max * 0.2));
      const elided = m.content.length - head.length - tail.length;
      // The whole result is archived first, so the cut middle stays recoverable instead of silently lost. A result
      // compression already archived raw keeps that handle: the raw output is the better original.
      const archived = rawHandleIn(m.content) ?? this.archive(m.content);
      const where = archived ? `; the full result is archived as ${archived} (ContextArchiveTool)` : '';
      const summary = carriedSummary(m.content) ? null : summarizeLog(m.content);
      return { ...m, content: `${summary ? `${summary}\n` : ''}${head}\n\n… [${elided} chars elided to save context${where}] …\n\n${tail}` };
    });
    if (trimmed) Logger.info(`[ContextManager] Capped ${trimmed} oversized tool result(s).`);
    return out;
  }

  /**
   * Layer 2 — micro-compact: clear the content of OLD tool results, keeping the most recent
   * KEEP_RECENT_TOOL_RESULTS intact. No LLM call. The tool message itself (and its tool_call_id)
   * is preserved so tool_use/tool_result pairing never breaks — only its body becomes a stub.
   */
  /** Archive a tool result before it leaves the prompt, record it as evidence, and return its handle (null if unsaved). */
  private archive(text: string): string | null {
    const archived = archiveOutput(text);
    if (!archived) return null;
    this.evidence.admit(evidenceSpan({
      sourceId: `tool-output:${archived.id}`,
      sourceVersion: `sha256:${archived.sha256}`,
      locator: { kind: 'tool-output', handle: archived.handle },
      rawHandle: archived.handle,
      text: text.slice(0, 280),
      scope: {},
      derivedFrom: [],
      kind: 'observation',
    }));
    return archived.handle;
  }

  private microCompact(messages: Message[]): Message[] {
    const toolIdx = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter(i => i >= 0);
    if (toolIdx.length <= this.KEEP_RECENT_TOOL_RESULTS) return messages;

    const clearBefore = toolIdx[toolIdx.length - this.KEEP_RECENT_TOOL_RESULTS];
    let cleared = 0;
    const out = messages.map((m, i) => {
      if (m.role !== 'tool' || i >= clearBefore) return m;
      if (typeof m.content === 'string' && m.content.startsWith('[tool result cleared')) return m; // already stubbed
      cleared++;
      // Code is never silently TRUNCATED: an old code result is evicted WHOLE and replaced with a
      // resolvable reference — the file path when the read header carries one — so the model re-reads
      // real content instead of reasoning over a half-cut ghost.
      //
      // A re-read returns the file as it is NOW, and the agent edits files: read foo.ts → evict →
      // edit foo.ts → a re-read hands back different bytes. So the stub never promises that re-reading
      // gets the original back.
      //
      // What it can offer is the plumbing this comment once asked for instead of a bare hash: the cleared
      // text is archived under its content hash before the stub replaces it, and ContextArchiveTool checks
      // that hash on every read. The handle returns the earlier output, labelled as earlier; a re-read
      // returns the current file (record 50 step 5). When the archive cannot be written, the stub says
      // nothing about one.
      // A stub with a handle runs to about 130 characters, so a result shorter than MIN_ARCHIVED_RESULT_CHARS
      // keeps the short stub instead: archiving it would make micro-compaction grow the context it shrinks.
      const archived = typeof m.content === 'string' && (rawHandleIn(m.content)
        ?? (m.content.length >= this.MIN_ARCHIVED_RESULT_CHARS ? this.archive(m.content) : null));
      const saved = archived ? ` The cleared output is archived as ${archived} (ContextArchiveTool).` : '';
      if (typeof m.content === 'string' && looksLikeCode(m.content)) {
        const file = m.content.match(/^FILE\s+(.+?):/m)?.[1];
        return {
          ...m,
          content: file
            ? `[tool result cleared to save context — code from ${file}; re-read it for the current contents, which may have changed since.${saved}]`
            : `[tool result cleared to save context — code output; re-run the tool for a current result, which may differ from the cleared one.${saved}]`,
        };
      }
      const stub = archived
        ? `[tool result cleared to save context — archived as ${archived}; read it back with ContextArchiveTool]`
        : '[tool result cleared to save context]';
      // A cleared log keeps its one-line summary, when the stub stays well under what it replaces (step 6d).
      const summary = archived && typeof m.content === 'string' ? carriedSummary(m.content) ?? summarizeLog(m.content) : null;
      const withSummary = summary ? `${stub}\n${summary}` : stub;
      return { ...m, content: typeof m.content === 'string' && withSummary.length * 2 <= m.content.length ? withSummary : stub };
    });
    if (cleared) Logger.info(`[ContextManager] Micro-compacted ${cleared} old tool result(s).`);
    return out;
  }

  /**
   * Reactive cheap recovery for a provider-reported context overflow. Unlike the proactive
   * micro-compact pass in checkAndCompact(), this is intentionally not pressure-gated: the
   * provider has already told us the request is too large. Tool-call/result structure remains
   * intact because microCompact only replaces old result bodies by message id.
   */
  reactiveDrain(messages: Message[]): { messages: Message[]; changed: boolean } {
    const drained = this.microCompact(messages);
    return {
      messages: drained,
      changed: drained.some((message, index) => message !== messages[index]),
    };
  }

  /**
   * Layer 3 — snip: a blunt guard for runaway sessions. When the non-system history grows past
   * SNIP_TRIGGER_MESSAGES, keep only the last SNIP_KEEP_TAIL of it (plus all system messages),
   * never letting the kept window begin on an orphaned tool result.
   */
  private snip(messages: Message[]): Message[] {
    const nonSystem = messages.filter(m => m.role !== 'system');
    if (nonSystem.length <= this.SNIP_TRIGGER_MESSAGES) return messages;

    const tail = this.dropLeadingOrphanToolMessages(nonSystem.slice(-this.SNIP_KEEP_TAIL));
    this.continuation.absorb(nonSystem.filter(m => !tail.includes(m)), (text) => this.archive(text));
    const system = messages.filter(m => m.role === 'system' && !isContinuationMessage(m));
    Logger.warn(`[ContextManager] Snipped ${nonSystem.length - tail.length} old message(s) (runaway history guard).`);
    return [...system, ...this.continuationMessages(), ...tail];
  }

  /**
   * A `tool` message is only valid immediately after the assistant `tool_calls` that produced it.
   * When a window starts partway through a tool exchange, the leading `tool` messages are orphaned
   * and the API rejects the request — so drop them until the window begins on a user/assistant turn.
   */
  private dropLeadingOrphanToolMessages(messages: Message[]): Message[] {
    let start = 0;
    while (start < messages.length && messages[start].role === 'tool') start++;
    return messages.slice(start);
  }

  // Per-message token counts, keyed by message identity. The compaction passes preserve object
  // identity for every message they don't touch, and a message's content never mutates in place —
  // so across a long session only the handful of NEW/rewritten messages are ever re-tokenized.
  // (The old implementation re-encoded the ENTIRE conversation with gpt-tokenizer on every single
  // turn — an O(session) CPU spike per turn that grew with the thing it was supposed to manage.)
  private tokenCache = new WeakMap<object, { content: unknown; reasoning: unknown; tokens: number }>();

  private countMessageTokens(m: Message): number {
    const key = m as unknown as object;
    const hit = this.tokenCache.get(key);
    if (hit && hit.content === m.content && hit.reasoning === m.reasoning_content) return hit.tokens;
    let tokens: number;
    try {
      tokens = encode(`${contentToText(m.content)}${m.reasoning_content || ''}`).length;
    } catch {
      tokens = Math.ceil(`${String(contentToText(m.content) ?? '')}${m.reasoning_content || ''}`.length / 4);
    }
    this.tokenCache.set(key, { content: m.content, reasoning: m.reasoning_content, tokens });
    return tokens;
  }

  estimateTokens(messages: Message[]): number {
    // +1 per message ≈ the joining newline the old whole-conversation encode counted.
    let total = 0;
    for (const m of messages) total += this.countMessageTokens(m) + 1;
    return total;
  }

  /** Layer 4 — summarize older messages into a single system note (the one LLM-backed pass). */
  async compact(messages: Message[]): Promise<Message[]> {
    // Keep only DURABLE system messages (C2). Transients are either superseded by this compact
    // (the previous summary — folded into the new summarization input below — and the previous
    // file restorations) or regenerated fresh next turn (RepoMap, TurnContext, pressure nudges).
    // The old behavior kept every one of them forever: each compaction accreted another stale
    // summary + up to 250KB of stale restorations that all later compactions preserved.
    const systemMessages = messages.filter(m => m.role === 'system' && !this.isTransientSystem(m));
    const priorSummaries = messages.filter(m =>
      this.isTransientSystem(m) && (m.content as string).startsWith('[Previous Context Summary]'));

    // Preserve the last 15 messages. Trim any leading orphan tool results so the window can't
    // begin with a `tool` message whose parent assistant tool_calls was cut.
    const recentMessages = this.dropLeadingOrphanToolMessages(
      messages.filter(m => m.role !== 'system').slice(-15)
    );

    const olderMessages = messages.filter(m =>
      m.role !== 'system' && !recentMessages.includes(m)
    );

    // Nothing to summarize — return BEFORE touching the epoch, so checkEpoch() doesn't see a
    // phantom "compaction happened" when none did (which falsely invalidated buffered messages).
    if (olderMessages.length === 0) {
      return messages;
    }

    // Increment epoch only now that a real compaction is underway, so a concurrent caller can
    // detect a compaction in flight.
    this.compactionEpoch++;
    const myEpoch = this.compactionEpoch;

    Logger.info(`[ContextManager] Summarizing ${olderMessages.length} older messages (epoch ${myEpoch})...`);

    // Flatten any multimodal (image) content to text before serializing: a base64 data URL can be
    // megabytes, and embedding it in the summary prompt would blow up tokens/cost and likely 400 the
    // very summarizer meant to SHRINK context. contentToText replaces image parts with "[image]".
    // The previous compaction's summary leads the input so its goal/decisions/progress carry forward
    // into the NEW summary instead of being silently dropped with the transient strip above.
    const olderForSummary = [
      ...priorSummaries.map(m => ({ role: 'system' as const, content: contentToText(m.content) })),
      ...olderMessages.map(m => ({ ...m, content: contentToText(m.content) })),
    ];

    const summaryPrompt: Message[] = [
      {
        role: 'system',
        content: `You are summarizing a coding session. Output ONLY these five sections with NO other prose:

## Goal
One sentence: the exact task or question the user gave.

## Progress
Bullet list of what was actually completed — include file paths, function names, commands run, and test results.

## Key Decisions
Up to 3 bullets: non-obvious choices made and the reason (e.g. "Used X not Y because..."). Omit if nothing non-obvious occurred.

## Next Steps
What should happen next to finish the task. If the task is done, write "DONE".

## Relevant Files
Comma-separated list of files created, modified, or important to the task.`,
      },
      {
        role: 'user',
        content: `Summarize these messages into the five sections above:\n${JSON.stringify(olderForSummary)}`,
      },
    ];

    let summaryText = '';
    try {
      // Summarization is cheap aux work — route it to the lite model when one is configured.
      const generator = this.llm.chat(summaryPrompt, { lite: true });
      for await (const event of generator) {
        if (event.type === 'token') summaryText += event.text;
      }
    } catch (e: any) {
      Logger.error(`[ContextManager] Failed to summarize context: ${e.message}`);
      summaryText = '[Older conversation history dropped due to context limits]';
    }

    // If another compact() call ran while we were awaiting the LLM, our result is stale —
    // return original messages unchanged so the later epoch's result takes precedence.
    if (this.compactionEpoch !== myEpoch) {
      Logger.warn(`[ContextManager] Epoch mismatch after compact (started ${myEpoch}, now ${this.compactionEpoch}) — discarding stale result.`);
      return messages;
    }

    const summaryMsg: Message = {
      role: 'system',
      content: `[Previous Context Summary]\n${summaryText}`,
    };
    // The summary is a narrative a summarizer may get wrong or leave empty, so it is not the only record: the
    // continuation state keeps what these messages said, word for word (record 50 step 6).
    this.continuation.absorb(olderMessages, (text) => this.archive(text));

    // Post-compact file restoration: re-inject recently-read files as synthetic attachments
    // so the model doesn't need to re-read files it was actively working with. Bounded by a TOTAL
    // budget (C5): unbudgeted, 5 files × 50KB could pour ~60k tokens right back into the window the
    // compaction just fought to free. Most-recent files first; one oversized file can't starve a
    // smaller, newer one behind it.
    const recentReads = fileStateCache.getRecentReads();
    const fileAttachments: Message[] = [];
    let restoreUsed = 0, restoreSkipped = 0, restoreStale = 0;
    for (const f of recentReads) {
      if (restoreUsed + f.content.length > this.RESTORE_BUDGET_CHARS) { restoreSkipped++; continue; }
      // Cached content whose file was edited externally (or deleted) since the read must NEVER be
      // re-injected as current — that silently feeds the model a stale version of the file it is about
      // to modify. "Verified unchanged on disk" is a claim about bytes, and a matching mtime is not
      // proof: a rewrite that put the old mtime back was restored as current (record 47, A01). So the
      // file is read now and compared with the hash taken when it was cached; a read cached without a
      // hash is verified only when it was the complete file, by comparing the text itself. A preview of
      // a large file has neither, so it is never restored as the file. The comparison runs through the
      // session's evidence, so an earlier restoration of a file that has since changed goes stale too.
      const claimed = f.fileHash ? `sha256:${f.fileHash}` : f.complete ? versionOfText(f.content) : null;
      const current = await fileVersion(f.path);
      this.evidence.sourceChanged(`file:${f.path}`, current);
      let mtimeHolds = false;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        mtimeHolds = (require('fs') as typeof import('fs')).statSync(f.path).mtimeMs === f.mtime;
      } catch { /* deleted/unreadable — do not restore */ }
      if (!claimed || !mtimeHolds || current !== claimed) { restoreStale++; continue; }
      restoreUsed += f.content.length;
      // A partial read is labeled as exactly that — never presented as the complete file.
      const scope = f.complete
        ? 'complete file'
        : `PARTIAL read (offset ${f.offset}${f.limit >= 0 ? `, limit ${f.limit}` : ''}) — NOT the whole file`;
      fileAttachments.push({
        role: 'system' as const,
        content: `[Post-Compact Restoration — ${f.path} — ${scope}, verified unchanged on disk]\n${f.content}`,
      });
      this.evidence.admit(fileEvidence(f.path, f.content, claimed, { partial: !f.complete }));
    }

    if (fileAttachments.length > 0 || restoreSkipped > 0 || restoreStale > 0) {
      Logger.info(`[ContextManager] Restored ${fileAttachments.length} recently-read file(s) post-compact${restoreSkipped ? ` (${restoreSkipped} skipped — over the ${this.RESTORE_BUDGET_CHARS}-char budget)` : ''}${restoreStale ? ` (${restoreStale} not restored — not verified unchanged on disk)` : ''}.`);
    }

    const compacted = [...systemMessages, summaryMsg, ...this.continuationMessages(), ...fileAttachments, ...recentMessages];
    this.currentTokens = this.estimateTokens(compacted);
    return compacted;
  }

  /** The continuation state as one system message, or nothing while it is empty. */
  private continuationMessages(maxChars?: number): Message[] {
    const text = this.continuation.render((saved) => this.archive(saved), maxChars);
    return text ? [{ role: 'system', content: text }] : [];
  }

  /** The model's context window this manager budgets for, in tokens. */
  get contextWindow(): number {
    return this.MAX_TOKENS;
  }

  /** The last request's budget: what it held, what gave way, whether it was sent. Null before the first request. */
  lastRequest: RequestRecord | null = null;

  recordRequest(record: RequestRecord): void {
    this.lastRequest = record;
  }

  private toolCallTokens = new WeakMap<object, number>();

  /** Tokens the messages take in a request: their content, the tool calls they carry, and each message's framing. */
  requestTokens(messages: Message[]): number {
    let total = 0;
    for (const m of messages) {
      total += this.countMessageTokens(m) + MESSAGE_FRAMING_TOKENS;
      const calls = (m as { tool_calls?: unknown[] }).tool_calls;
      if (calls?.length) {
        const key = calls as unknown as object;
        let tokens = this.toolCallTokens.get(key);
        if (tokens === undefined) {
          tokens = countTokens(JSON.stringify(calls));
          this.toolCallTokens.set(key, tokens);
        }
        total += tokens;
      }
    }
    return total;
  }

  /**
   * Fit `messages` into `budget` request tokens at the request boundary (record 50 step 6c), cheapest loss first:
   * blocks that are rebuilt anyway (the repo map, restored files, nudges), then old tool results, then a summary of
   * older turns, then the oldest turns themselves, and last the length of the continuation state. Everything that
   * leaves goes through the continuation state, and the latest user message never leaves. The caller checks whether
   * the result fits and refuses to send it when it does not.
   */
  async fitWithin(messages: Message[], budget: number): Promise<{ messages: Message[]; tokens: number; steps: string[] }> {
    const steps: string[] = [];
    let out = messages;
    const fits = (): boolean => this.requestTokens(out) <= budget;
    if (!fits()) {
      const kept = out.filter((m) => !this.isRebuiltLater(m));
      if (kept.length !== out.length) { out = kept; steps.push('removed the repo map and restored files, which are rebuilt later'); }
    }
    if (!fits()) {
      const drained = this.reactiveDrain(out);
      if (drained.changed) { out = drained.messages; steps.push('cleared old tool results'); }
    }
    if (!fits()) {
      const compacted = await this.compact(out);
      if (compacted !== out && this.requestTokens(compacted) < this.requestTokens(out)) { out = compacted; steps.push('summarized older turns'); }
    }
    if (!fits()) {
      const trimmed = this.moveOldestTurnsOut(out, budget);
      if (trimmed !== out) { out = trimmed; steps.push('moved the oldest turns into the continuation state'); }
    }
    if (!fits()) {
      const shortened = this.shortenContinuation(out, budget);
      if (shortened !== out) { out = shortened; steps.push('shortened the continuation state, archiving the rest'); }
    }
    return { messages: out, tokens: this.requestTokens(out), steps };
  }

  private isRebuiltLater(m: Message): boolean {
    if (typeof m.content !== 'string') return false;
    const content = m.content;
    if (content.startsWith('[RepoMap]')) return m.role === 'system' || m.role === 'user';
    return m.role === 'system' && ['[Post-Compact Restoration', '[TurnContext]', '[ContextManager]'].some((prefix) => content.startsWith(prefix));
  }

  /** Drop whole turns from the front, a call with its results, until the request fits or the latest user message is next. */
  private moveOldestTurnsOut(messages: Message[], budget: number): Message[] {
    const system = messages.filter((m) => m.role === 'system' && !isContinuationMessage(m));
    let tail = messages.filter((m) => m.role !== 'system');
    const latestUser = [...tail].reverse().find((m) => m.role === 'user');
    let current = messages;
    while (tail.length && this.requestTokens(current) > budget) {
      let cut = 1;
      while (cut < tail.length && tail[cut].role === 'tool') cut++;
      const leaving = tail.slice(0, cut);
      if (latestUser && leaving.includes(latestUser)) break;
      this.continuation.absorb(leaving, (text) => this.archive(text));
      tail = tail.slice(cut);
      current = [...system, ...this.continuationMessages(), ...tail];
    }
    return current;
  }

  /** Re-render the continuation state short enough for the request to fit, when it is what stands in the way. */
  private shortenContinuation(messages: Message[], budget: number): Message[] {
    const at = messages.findIndex((m) => isContinuationMessage(m));
    if (at < 0) return messages;
    const over = this.requestTokens(messages) - budget;
    const blockTokens = this.requestTokens([messages[at]]);
    const [shortened] = this.continuationMessages(Math.max(0, (blockTokens - over) * 3));
    if (!shortened || shortened.content === messages[at].content) return messages;
    const out = [...messages];
    out[at] = shortened;
    return out;
  }

  /**
   * The residency ledger (record 47 §3.5): ids of the admitted, current evidence spans whose text is in `messages` — a
   * recall block and the memories it was built from, a restored file, a tool output named by its archive handle.
   */
  residentEvidence(messages: Message[]): string[] {
    const contents = messages.map((m) => (typeof m.content === 'string' ? m.content : contentToText(m.content)));
    const exact = new Set(contents);
    const handles = new Set<string>();
    for (const content of contents) for (const handle of content.match(/archive:[0-9a-f]{32}/g) ?? []) handles.add(handle);
    const resident = new Set<string>();
    for (const span of this.evidence.all()) {
      if (this.evidence.isStale(span.id)) continue;
      const locator = span.locator;
      const present = (span.rawHandle !== undefined && handles.has(span.rawHandle))
        || (locator.kind === 'derived' && exact.has(span.text))
        || (locator.kind === 'file' && contents.some((content) => content.startsWith(`[Post-Compact Restoration — ${locator.path} —`)));
      if (!present) continue;
      resident.add(span.id);
      for (const dep of span.derivedFrom) if (dep.sourceId.startsWith('span:')) resident.add(dep.sourceId.slice('span:'.length));
    }
    return [...resident];
  }

  /** Reactive recovery: fires when the API rejects a request as too long. Cuts the window hard. */
  async reactiveCompact(messages: Message[], error: any): Promise<Message[]> {
    // Match everything classifyStreamError treats as a context overflow (413s, "too large",
    // provider codes), not just two message spellings — a mismatch here meant the agent loop
    // decided "compact and retry" but this guard rethrew, killing the turn instead.
    const msg = String(error?.message || '');
    const isContextOverflow =
      /too long|too large|maximum context|context length|context window/i.test(msg) ||
      error?.code === 'prompt_too_long' || error?.code === 'context_length_exceeded' ||
      error?.status === 413;
    if (isContextOverflow) {
      Logger.warn(`[ContextManager] Reactive compact triggered by API error: ${error.message}`);
      this.currentTokens = this.MAX_TOKENS; // force it
      // Same transient strip as compact() (C6) — an overflow caused by accreted summaries/
      // restorations must actually SHRINK here, or the retry 413s again and the turn dies.
      // Exception: keep the newest [Previous Context Summary] — no new summary is generated on
      // this path, so dropping it would erase everything the session learned before the overflow.
      const durableSystem = messages.filter(m => m.role === 'system' && !this.isTransientSystem(m));
      const lastSummary = [...messages].reverse().find(m =>
        this.isTransientSystem(m) && (m.content as string).startsWith('[Previous Context Summary]'));
      const recentMessages = this.dropLeadingOrphanToolMessages(
        messages.filter(m => m.role !== 'system').slice(-5)
      );
      this.continuation.absorb(messages.filter(m => m.role !== 'system' && !recentMessages.includes(m)), (text) => this.archive(text));
      return [
        ...durableSystem,
        ...(lastSummary ? [lastSummary] : []),
        ...this.continuationMessages(),
        { role: 'system', content: '[Older messages aggressively compacted due to API context limits]' } as Message,
        ...recentMessages,
      ];
    }
    throw error;
  }
}
