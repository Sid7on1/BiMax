import { stateDir } from '../utils/state.dir';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { LLMProvider, Message, ChatOptions, ChatEvent } from '../core/llm.provider';
import { mindSingletonRoot } from './self.model';
import { getEventLedger } from './event.ledger';

/**
 * Episode bundles — the agent's black-box flight recorder (BiMax v2, Phase 4 minimal).
 *
 * Every AgentLoop.execute() becomes an EPISODE: an append-only, hash-chained JSONL
 * bundle under .bimax/episodes/ recording each LLM call's request hash, the messages
 * that were NEW since the previous call (tool results, nudges — the causal trace), and
 * the full coalesced response stream (thinking, text, tool calls, usage).
 *
 * Two things this buys, per the v2 plan (§7 / §9.5):
 *   - Flight recorder: "why did it edit that file?" is answerable after the fact from
 *     the recorded stream — /episodes renders any past run step by step.
 *   - Replay: ReplayProvider re-serves the recorded responses keyed by request hash,
 *     so a harness/prompt/policy change can be evaluated against RECORDED traffic at
 *     zero token cost — divergence (a request whose hash no longer matches) is itself
 *     the signal, marking exactly where the changed harness alters behavior.
 *
 * Same discipline as the event ledger: recording is strictly best-effort (never throws,
 * BIMAX_RECORDER=0 disables), bundles are tamper-evident (each line's hash covers its
 * predecessor's), and old bundles are pruned so the recorder can be always-on.
 */

const EPISODES_KEPT = 40;             // prune beyond this many bundles (oldest first)
const MSG_CONTENT_CAP = 200_000;      // pathology bound only — tools cap their own output far
                                      // below this; truncation breaks replay fidelity for that
                                      // message, so the ceiling is deliberately generous

export interface RecordedResponse {
  text: string;
  thinking?: string;
  toolCalls: { id: string; name: string; args: string }[];
  usage?: { prompt: number; completion: number };
  error?: string;
  /** Stream ended without a 'done' event (abort / crash mid-stream). */
  incomplete?: boolean;
}

export interface RecordedCall {
  idx: number;
  ts: number;
  reqHash: string;
  msgCount: number;
  /** Sorted tool names advertised on this request — replay re-advertises exactly these. */
  toolNames: string[];
  /** Messages appended to the history since the previous call in this episode. */
  newMessages: (Pick<Message, 'tool_calls'> & { role: string; content?: string; name?: string; tool_call_id?: string })[];
  /** Set when the history SHRANK since the last call (compaction) — newMessages is a snapshot tail. */
  reset?: boolean;
  response: RecordedResponse;
}

export interface EpisodeHeader {
  v: 1;
  id: string;
  session: string;
  startedAt: number;
  sysHash: string;
  /** Full system prompt — replay's default baseline (compare-against-current is the eval). */
  system?: string;
  /** Repo HEAD when the episode started — the snapshot key for history-replay task generation. */
  commit?: string;
  lite: boolean;
}

/** Deterministic JSON with recursively sorted keys — object key order must not change hashes. */
function stableStringify(v: any): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v).filter(k => v[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

export function requestToolNames(options: ChatOptions): string[] {
  return (options.tools || [])
    .map((t: any) => t?.function?.name || t?.name || '?')
    .sort();
}

/**
 * Canonical hash of one LLM request — the replay key. Covers everything that shapes the
 * response: full message history, system prompt, tool NAMES (schemas are huge and change
 * with descriptions; the name set is what alters model behavior), sampling knobs, tier.
 * Key-order-insensitive so a replay that RECONSTRUCTS messages hashes identically.
 */
export function hashRequest(messages: Message[], options: ChatOptions): string {
  const body = stableStringify({
    system: options.system || '',
    lite: !!options.lite,
    temperature: options.temperature ?? null,
    effort: options.reasoningEffort ?? null,
    tools: requestToolNames(options),
    messages,
  });
  return crypto.createHash('sha256').update(body).digest('hex');
}

// --- Replay guard -----------------------------------------------------------
// While a replay is driving a real AgentLoop, the learning observers (self-model,
// habit miner, epistemic claims, event ledger) and the recorder itself must stand
// down — a replayed episode re-observed as fresh experience would double-count
// every outcome it already learned from.
let replayActive = false;
export function setReplayActive(on: boolean): void { replayActive = on; }
export function isReplayActive(): boolean { return replayActive; }

const SESSION_ID = `${process.pid}-${Date.now().toString(36)}`;

function episodesDir(root: string): string {
  return path.join(stateDir('.bimax', root), 'episodes');
}

/**
 * One stored message for the bundle. Full fidelity is the goal — replay reconstructs the
 * initial history and serves tool results from these, so tool_calls are preserved and
 * truncation only fires at a pathology bound. Multimodal parts are the one lossy case
 * (reduced to a marker) — a replay across them diverges by construction and says so.
 */
function capMessage(m: Message): RecordedCall['newMessages'][number] {
  let content: string | undefined;
  if (typeof m.content === 'string') {
    content = m.content.length > MSG_CONTENT_CAP
      ? m.content.slice(0, MSG_CONTENT_CAP) + `\n…[truncated ${m.content.length - MSG_CONTENT_CAP} chars]`
      : m.content;
  } else if (Array.isArray(m.content)) {
    content = `[multimodal content: ${m.content.length} part(s)]`;
  }
  const out: RecordedCall['newMessages'][number] = { role: m.role };
  if (content !== undefined) out.content = content;
  if (m.name) out.name = m.name;
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  if (m.tool_calls) out.tool_calls = m.tool_calls;
  return out;
}

/**
 * Writes one episode bundle, one JSONL line per LLM call, hash-chained like the event
 * ledger: line N's `h` covers its own body plus line N−1's `h`. Self-flushing — the
 * bundle is valid after every call, so no close step is needed (a crash simply leaves
 * the last completed call as the end of the recording).
 */
export class EpisodeWriter {
  readonly id: string;
  private filePath: string;
  private prevHash = '';
  private headerWritten = false;
  private disabled: boolean;
  private lastMsgCount = 0;
  private idx = 0;

  constructor(private root: string = mindSingletonRoot()) {
    this.id = `e-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
    this.filePath = path.join(episodesDir(root), `${this.id}.jsonl`);
    this.disabled = process.env.BIMAX_RECORDER === '0';
  }

  file(): string { return this.filePath; }

  private writeLine(obj: Record<string, any>): void {
    const body = JSON.stringify(obj);
    const h = crypto.createHash('sha256').update(`${this.prevHash}|${body}`).digest('hex');
    fs.appendFileSync(this.filePath, JSON.stringify({ ...obj, h }) + '\n', 'utf-8');
    this.prevHash = h;
  }

  private ensureHeader(options: ChatOptions): void {
    if (this.headerWritten) return;
    fs.mkdirSync(episodesDir(this.root), { recursive: true });
    pruneEpisodes(this.root);
    const header: EpisodeHeader = {
      v: 1,
      id: this.id,
      session: SESSION_ID,
      startedAt: Date.now(),
      sysHash: crypto.createHash('sha256').update(options.system || '').digest('hex').slice(0, 16),
      system: options.system || '',
      lite: !!options.lite,
    };
    try {
      const { execFileSync } = require('child_process');
      header.commit = String(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: this.root, stdio: 'pipe', timeout: 3000 })).trim();
    } catch { /* not a git repo — history-replay just won't offer this episode */ }
    this.writeLine(header);
    this.headerWritten = true;
    // One anchor event in the ledger per episode — the bundle itself holds the detail.
    getEventLedger().append('episode', { id: this.id, session: SESSION_ID });
  }

  /** Record one completed (or aborted) LLM call. Never throws. */
  recordCall(messages: Message[], options: ChatOptions, reqHash: string, response: RecordedResponse): void {
    if (this.disabled) return;
    try {
      this.ensureHeader(options);
      const reset = messages.length < this.lastMsgCount;
      const delta = reset ? messages.slice(-6) : messages.slice(this.lastMsgCount);
      const call: RecordedCall = {
        idx: this.idx++,
        ts: Date.now(),
        reqHash,
        msgCount: messages.length,
        toolNames: requestToolNames(options),
        newMessages: delta.map(capMessage),
        response,
      };
      if (reset) call.reset = true;
      this.lastMsgCount = messages.length;
      this.writeLine(call as any);
    } catch { /* best-effort — recording must never break the agent */ }
  }
}

/** LLMProvider wrapper that streams through unchanged while recording each call. */
export class RecordingProvider implements LLMProvider {
  constructor(private inner: LLMProvider, readonly writer: EpisodeWriter) {}

  async *chat(messages: Message[], options: ChatOptions): AsyncGenerator<ChatEvent> {
    const reqHash = hashRequest(messages, options);
    let text = '';
    let thinking = '';
    const toolCalls: RecordedResponse['toolCalls'] = [];
    let usage: RecordedResponse['usage'];
    let error: string | undefined;
    let sawDone = false;
    try {
      for await (const ev of this.inner.chat(messages, options)) {
        switch (ev.type) {
          case 'token': text += ev.text; break;
          case 'thinking': thinking += ev.text; break;
          case 'tool_call': toolCalls.push({ id: ev.id, name: ev.name, args: ev.args }); break;
          case 'usage': usage = { prompt: ev.prompt, completion: ev.completion }; break;
          case 'error': error = ev.message; break;
          case 'done': sawDone = true; break;
        }
        yield ev;
      }
    } finally {
      // Runs on normal completion AND when the consumer abandons the stream (abort) —
      // an interrupted call is recorded as incomplete rather than lost.
      const response: RecordedResponse = { text, toolCalls };
      if (thinking) response.thinking = thinking;
      if (usage) response.usage = usage;
      if (error) response.error = error;
      if (!sawDone) response.incomplete = true;
      this.writer.recordCall(messages, options, reqHash, response);
    }
  }
}

/**
 * Start recording an episode around a provider. The one integration point for the agent
 * loop: wraps the provider when recording is possible, hands back the original when not.
 */
export function startEpisodeRecording(inner: LLMProvider, root?: string): { llm: LLMProvider; id: string | null } {
  // A replayed run must not record a fresh episode of itself.
  if (process.env.BIMAX_RECORDER === '0' || replayActive) return { llm: inner, id: null };
  // Callers such as the counterfactual lab may provide an explicit recorder so they can own the
  // episode id and location. Wrapping it again creates two adjacent ledger anchors for one run;
  // the empty interval between them then makes the recorded-failure census read 0/0. Reuse the
  // existing recorder instead of nesting flight recorders.
  if (inner instanceof RecordingProvider) return { llm: inner, id: inner.writer.id };
  try {
    const writer = new EpisodeWriter(root);
    return { llm: new RecordingProvider(inner, writer), id: writer.id };
  } catch {
    return { llm: inner, id: null };
  }
}

// ---------------------------------------------------------------------------
// Reading side — list, load/verify, replay.
// ---------------------------------------------------------------------------

export interface EpisodeSummary {
  id: string;
  file: string;
  startedAt: number;
  endedAt: number;
  calls: number;
  toolCalls: number;
  bytes: number;
  incomplete: boolean;
}

export interface LoadedEpisode {
  header: EpisodeHeader;
  calls: RecordedCall[];
  chainOk: boolean;
  brokenAt: number | null;   // 1-based line number of the first bad hash
  file: string;
}

function parseBundle(file: string): LoadedEpisode | null {
  try {
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(l => l.trim());
    if (lines.length === 0) return null;
    let prev = '';
    let chainOk = true;
    let brokenAt: number | null = null;
    const parsed: any[] = [];
    for (let i = 0; i < lines.length; i++) {
      const obj = JSON.parse(lines[i]);
      const { h, ...body } = obj;
      const expect = crypto.createHash('sha256').update(`${prev}|${JSON.stringify(body)}`).digest('hex');
      if (chainOk && expect !== h) { chainOk = false; brokenAt = i + 1; }
      prev = h;
      parsed.push(obj);
    }
    const header = parsed[0] as EpisodeHeader;
    if (header?.v !== 1 || !header.id) return null;
    return { header, calls: parsed.slice(1) as RecordedCall[], chainOk, brokenAt, file };
  } catch {
    return null;
  }
}

export function listEpisodes(root: string = mindSingletonRoot()): EpisodeSummary[] {
  try {
    const dir = episodesDir(root);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort();
    const out: EpisodeSummary[] = [];
    for (const f of files) {
      const full = path.join(dir, f);
      const ep = parseBundle(full);
      if (!ep) continue;
      const last = ep.calls[ep.calls.length - 1];
      out.push({
        id: ep.header.id,
        file: full,
        startedAt: ep.header.startedAt,
        endedAt: last?.ts || ep.header.startedAt,
        calls: ep.calls.length,
        toolCalls: ep.calls.reduce((a, c) => a + (c.response?.toolCalls?.length || 0), 0),
        bytes: fs.statSync(full).size,
        incomplete: !!last?.response?.incomplete,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function loadEpisode(idOrFile: string, root: string = mindSingletonRoot()): LoadedEpisode | null {
  const file = idOrFile.endsWith('.jsonl') ? idOrFile : path.join(episodesDir(root), `${idOrFile}.jsonl`);
  return parseBundle(file);
}

function pruneEpisodes(root: string): void {
  try {
    const dir = episodesDir(root);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - (EPISODES_KEPT - 1)))) {
      fs.unlinkSync(path.join(dir, f));
    }
  } catch { /* best-effort */ }
}

/**
 * Serves a recorded episode as an LLMProvider — the replay half of the recorder.
 *
 * Matching: a request whose hash equals an unserved recorded call gets that call's
 * response (deterministic replay). A request with NO hash match — the harness changed
 * the prompt/context — gets the next unserved call IN ORDER, and the mismatch is logged
 * as a divergence: the precise point where the change under test alters the trajectory.
 * When the recording is exhausted, an unrecoverable error event ends the run.
 */
export class ReplayProvider implements LLMProvider {
  readonly divergences: { idx: number; expected: string; got: string }[] = [];
  served = 0;
  private consumed = new Set<number>();

  constructor(private calls: RecordedCall[]) {}

  /** The next unserved recorded call — the replay harness advertises ITS tool names. */
  peekNext(): RecordedCall | undefined {
    return this.calls.find(c => !this.consumed.has(c.idx));
  }

  async *chat(messages: Message[], options: ChatOptions): AsyncGenerator<ChatEvent> {
    const got = hashRequest(messages, options);
    let rec = this.calls.find(c => !this.consumed.has(c.idx) && c.reqHash === got);
    if (!rec) {
      rec = this.calls.find(c => !this.consumed.has(c.idx));
      if (rec) this.divergences.push({ idx: rec.idx, expected: rec.reqHash, got });
    }
    if (!rec) {
      yield { type: 'error', message: 'Replay exhausted — no recorded calls left in this episode.', recoverable: false };
      return;
    }
    this.consumed.add(rec.idx);
    this.served++;
    const r = rec.response;
    if (r.thinking) yield { type: 'thinking', text: r.thinking };
    if (r.text) yield { type: 'token', text: r.text };
    for (const tc of r.toolCalls || []) yield { type: 'tool_call', id: tc.id, name: tc.name, args: tc.args };
    if (r.usage) yield { type: 'usage', prompt: r.usage.prompt, completion: r.usage.completion };
    if (r.error) yield { type: 'error', message: r.error, recoverable: false };
    yield { type: 'done' };
  }
}
