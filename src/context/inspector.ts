import type { ContextManager } from '../memory/context.manager';
import type { EvidenceSpan } from './evidence';

/**
 * The evidence inspector (record 50 step 8): what the model was shown, what no longer matches its source, what the last
 * request's budget held and what gave way to fit it, in plain words.
 *
 * It holds no truth logic of its own. Every statement is read from the session's records — `ContextManager.evidence`,
 * `lastRequest` and `continuation` — and only phrased here, so the app shows exactly what the engine knows.
 */

const MAX_STALE_LISTED = 10;

const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');
const plural = (n: number, one: string, many: string): string => `${fmt(n)} ${n === 1 ? one : many}`;

function describeSource(span: EvidenceSpan): string {
  const locator = span.locator;
  if (locator.kind === 'file') {
    const lines = locator.startLine !== undefined ? ` (lines ${locator.startLine}-${locator.endLine ?? locator.startLine})` : '';
    return `${locator.path}${lines}`;
  }
  if (locator.kind === 'memory') return `memory "${locator.documentId}"`;
  if (locator.kind === 'tool-output') return `an earlier tool output (${locator.handle})`;
  return `a ${locator.label.replace(/-/g, ' ')} built from other evidence`;
}

/** The record's stale reason, in words a user reads. */
function plainReason(reason: string): string {
  if (/ is gone or unreadable$/.test(reason)) return 'it was deleted or can no longer be read';
  if (/ changed$/.test(reason)) return 'it changed after the model saw it';
  if (/which was evicted/.test(reason)) return 'it was built from evidence dropped from the record, so it can no longer be checked';
  if (/which is not in the record/.test(reason)) return 'it was built from evidence that was never recorded, so it cannot be checked';
  if (/^built from stale /.test(reason)) return 'it was built from something that changed';
  return reason || 'it no longer matches its source';
}

export function describeContext(manager: ContextManager | null): string {
  if (!manager) return 'Nothing to show yet: send a message first, then run /evidence again.';
  const lines: string[] = ['Evidence and budget', ''];

  const request = manager.lastRequest;
  if (!request) {
    lines.push('No request has been sent in this session yet.');
  } else {
    lines.push(request.sent ? 'Last request: sent.' : "Last request: not sent, because it did not fit the model's context window.");
    lines.push(`- Window of ${fmt(request.window)} tokens: instructions ${fmt(request.system)}, tool definitions ${fmt(request.tools)}, reply reserve ${fmt(request.outputReserve)}, safety margin ${fmt(request.margin)}, and the conversation ${fmt(request.messages)} of the ${fmt(Math.max(0, request.messageBudget))} left for it.`);
    lines.push(request.steps.length ? `- To fit, Bimax ${request.steps.join('; then ')}.` : '- Nothing had to give way.');
    const resident = request.residentEvidenceIds.map((id) => manager.evidence.get(id)).filter((span): span is EvidenceSpan => !!span);
    const kinds = new Map<string, number>();
    for (const span of resident) {
      const kind = span.locator.kind === 'file' ? 'file' : span.locator.kind === 'memory' ? 'memory' : span.locator.kind === 'tool-output' ? 'archived output' : 'recall block';
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    }
    const breakdown = [...kinds].map(([kind, n]) => plural(n, kind, kind === 'memory' ? 'memories' : `${kind}s`)).join(', ');
    lines.push(`- It carried ${plural(request.residentEvidenceIds.length, 'tracked piece', 'tracked pieces')} of evidence${breakdown ? `: ${breakdown}` : ''}.`);
  }

  lines.push('');
  const spans = manager.evidence.all();
  const stale = spans.filter((span) => manager.evidence.isStale(span.id));
  if (!spans.length) {
    lines.push('No evidence has been recorded in this session yet.');
  } else if (!stale.length) {
    lines.push(`All ${plural(spans.length, 'recorded piece', 'recorded pieces')} of evidence still match their sources.`);
  } else {
    lines.push(`${fmt(stale.length)} of ${plural(spans.length, 'recorded piece', 'recorded pieces')} of evidence no longer match their sources. The model saw them earlier and should read them again before relying on them:`);
    for (const span of stale.slice(0, MAX_STALE_LISTED)) lines.push(`- ${describeSource(span)}: ${plainReason(manager.evidence.staleReason(span.id) ?? '')}.`);
    if (stale.length > MAX_STALE_LISTED) lines.push(`- and ${fmt(stale.length - MAX_STALE_LISTED)} more.`);
  }
  if (manager.evidence.evictedCount) {
    lines.push(`${plural(manager.evidence.evictedCount, 'older piece was', 'older pieces were')} dropped from the record to keep it small; anything built from them counts as out of date.`);
  }

  lines.push('');
  const carried = manager.continuation.counts();
  lines.push(carried.instructions + carried.evicted + carried.commands + carried.claims
    ? `Carried across compaction: ${plural(carried.instructions, 'of your messages', 'of your messages')}${carried.evicted ? ` (and ${fmt(carried.evicted)} more, archived)` : ''}, ${plural(carried.commands, 'command', 'commands')} and ${plural(carried.claims, "of the assistant's claims", "of the assistant's claims")}.`
    : 'Nothing has been compacted away yet.');
  return lines.join('\n');
}
