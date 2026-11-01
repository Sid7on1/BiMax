import type { Message } from '../core/llm.provider';
import { contentToText, isScreenshotObservationMessage } from '../core/multimodal';

/** Engine observations/nudges must not replace the human request protected by context trimming. */
export function latestHumanRequest(messages: readonly Message[]): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === 'user' && !isScreenshotObservationMessage(message)
      && !/^\[(?:ContextManager|INCOMPLETE REPLY)\]/.test(contentToText(message.content))) return message;
  }
  return undefined;
}

/**
 * Retain a recent non-system suffix, its complete leading tool exchange, and the full active request.
 * The request can precede many tool rounds: preserving all work since it would defeat compaction.
 * Invalid leading result groups are discarded rather than assigning them to an unrelated call.
 */
export function retainRecentHistory(messages: readonly Message[], count: number): Message[] {
  const history = messages.filter((m) => m.role !== 'system');
  let start = Math.max(0, history.length - Math.max(0, count));
  if (history[start]?.role === 'tool') {
    let owner = start - 1;
    while (owner >= 0 && history[owner].role === 'tool') owner--;
    let end = start;
    while (end < history.length && history[end].role === 'tool') end++;
    const calls = history[owner]?.role === 'assistant' ? history[owner].tool_calls ?? [] : [];
    const ids = new Set(calls.map((call) => call.id));
    const results = history.slice(owner + 1, end);
    const returned = new Set(results.map((result) => result.tool_call_id));
    const complete = calls.length > 0 && ids.size === calls.length && returned.size === results.length
      && results.length === calls.length && results.every((result) => result.role === 'tool' && ids.has(result.tool_call_id ?? ''));
    start = complete ? owner : end;
  }
  const tail = history.slice(start);
  const request = latestHumanRequest(history);
  return request && !tail.includes(request) ? [request, ...tail] : tail;
}
