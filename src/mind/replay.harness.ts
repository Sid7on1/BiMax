import { AgentLoop } from '../core/agent.loop';
import { Message } from '../core/llm.provider';
import {
  LoadedEpisode, ReplayProvider, loadEpisode,
} from './episode.recorder';
import { mindSingletonRoot } from './self.model';
import { inReplayScope } from '../core/replay.scope';

/**
 * Replay harness (BiMax v2, Phase 4 — the divergence-report consumer).
 *
 * Re-drives a REAL AgentLoop over a recorded episode: LLM responses come from the
 * bundle's ReplayProvider, tool calls are answered from the recorded tool results
 * (side-effect-free — nothing executes), and the learning observers stand down.
 *
 * What that measures: with an unchanged harness the re-run is deterministic — every
 * request hash matches its recording and the report says IDENTICAL (the determinism
 * gate). After a harness change (system prompt, context assembly, sanitizer, tool
 * surface), the first request whose hash no longer matches is the exact point where
 * the change alters the agent's trajectory — an eval on recorded traffic at zero
 * token cost, which is D5's whole demand.
 */

export interface ReplayReport {
  id: string;
  callsRecorded: number;
  callsServed: number;
  divergences: { idx: number; expected: string; got: string }[];
  /** The system prompt used for the re-run differed from the recorded one. */
  systemChanged: boolean;
  /** Served every recorded call with zero divergence — bit-for-bit trajectory match. */
  identical: boolean;
  /** Tool executions that ran past the recorded results (a diverged trajectory asked for more). */
  toolResultsMissing: number;
  /** Text the re-run yielded (what the user would have seen). */
  finalText: string;
  /** Fidelity caveats baked into the recording itself (compaction snapshots, multimodal markers). */
  caveats: string[];
}

/**
 * A ToolRegistry stand-in serving the episode's recorded reality: schemas advertise
 * exactly the tool names the NEXT recorded call advertised (so request hashes can
 * match), and execute() answers with the recorded tool results in recorded order.
 */
function recordedToolRegistry(ep: LoadedEpisode, provider: ReplayProvider) {
  // Recorded tool results, in the order the original loop appended them.
  const results: { id?: string; content: string }[] = [];
  for (const c of ep.calls) {
    for (const m of c.newMessages) {
      if (m.role === 'tool') results.push({ id: m.tool_call_id, content: m.content || '' });
    }
  }
  let cursor = 0;
  let missing = 0;
  let lastNames: string[] = ep.calls[0]?.toolNames || [];
  // Every tool name this episode ever advertised or called — getTool answers only for
  // these, matching the original registry's "unknown tool" behavior.
  const known = new Set<string>();
  for (const c of ep.calls) {
    for (const n of c.toolNames || []) known.add(n);
    for (const t of c.response?.toolCalls || []) known.add(t.name);
  }

  const makeTool = (name: string) => ({
    name,
    isConcurrencySafe: false, // sequential — preserves the recorded result order exactly
    execute: async () => {
      const next = results[cursor++];
      if (!next) { missing++; return '[replay] No recorded result left for this tool call — the trajectory diverged past the recording.'; }
      return next.content;
    },
  });

  return {
    getSchemas: () => {
      const next = provider.peekNext();
      if (next?.toolNames?.length) lastNames = next.toolNames;
      return lastNames.map(n => ({ type: 'function', function: { name: n, parameters: { type: 'object', properties: {} } } }));
    },
    getTool: (name: string) => (known.has(name) ? makeTool(name) : undefined),
    missingCount: () => missing,
  };
}

/** Reconstruct the exact Message the original loop held from its recorded form. */
function toMessage(m: LoadedEpisode['calls'][number]['newMessages'][number]): Message {
  const out: Message = { role: m.role as Message['role'] };
  if (m.content !== undefined) out.content = m.content;
  if (m.name) out.name = m.name;
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  if (m.tool_calls) out.tool_calls = m.tool_calls;
  return out;
}

/**
 * Re-run one recorded episode through the current harness. `systemPrompt` defaults to
 * the RECORDED prompt (determinism check); pass a different one to evaluate a prompt
 * change against recorded traffic.
 */
export async function replayEpisode(
  idOrFile: string,
  opts?: { root?: string; systemPrompt?: string }
): Promise<ReplayReport | { error: string }> {
  const ep = loadEpisode(idOrFile, opts?.root || mindSingletonRoot());
  if (!ep) return { error: `No episode bundle "${idOrFile}" found.` };
  if (!ep.chainOk) return { error: `Bundle hash chain is broken at line ${ep.brokenAt} — refusing to replay a tampered recording.` };
  if (ep.calls.length === 0) return { error: 'Bundle has no recorded calls.' };
  if (ep.header.system === undefined) {
    return { error: 'Bundle predates replay support (no system prompt recorded) — record a fresh episode.' };
  }

  const caveats: string[] = [];
  if (ep.calls.some(c => c.reset)) caveats.push('recording spans a compaction — the snapshot tail is approximate');
  if (ep.calls.some(c => c.newMessages.some(m => typeof m.content === 'string' && m.content.startsWith('[multimodal content:')))) {
    caveats.push('recording contains multimodal content (stored as markers) — those requests diverge by construction');
  }

  const system = opts?.systemPrompt ?? ep.header.system;
  const provider = new ReplayProvider(ep.calls);
  const registry = recordedToolRegistry(ep, provider);
  // Call 0's delta IS the full history at the first request (lastMsgCount started at 0).
  const initialMessages = ep.calls[0].newMessages.map(toMessage);

  return inReplayScope(async () => {
    const loop = new AgentLoop(provider, registry as any);
    let finalText = '';
    const gen = loop.execute(initialMessages, system, {
      maxIterations: ep.calls.length + 2,
      useLite: ep.header.lite,
    });
    for await (const chunk of gen) finalText += chunk;

    return {
      id: ep.header.id,
      callsRecorded: ep.calls.length,
      callsServed: provider.served,
      divergences: [...provider.divergences],
      systemChanged: system !== ep.header.system,
      identical: provider.served === ep.calls.length && provider.divergences.length === 0
        && registry.missingCount() === 0,
      toolResultsMissing: registry.missingCount(),
      finalText: finalText.trim(),
      caveats,
    };
  });
}
