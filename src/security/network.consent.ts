import { IGovernor } from '../core/interfaces';

/**
 * One consent for reaching the network, asked once and remembered for the session.
 *
 * Web access was ungated: `WebFetchTool` and `WebSearchTool` both declare `isDestructive: false`,
 * so the governor was never consulted and a turn could read the internet without the user ever
 * being told it had. For a product whose whole positioning is that confidential work stays on the
 * machine, "did anything leave?" must be answerable, and the answer must not be "look through the
 * transcript".
 *
 * Per-CALL approval is the obvious implementation and the wrong one: a research turn makes dozens
 * of fetches, and a prompt per fetch trains the user to approve without reading — which is worse
 * than not asking. So the grant is per SESSION and per HOST: the first request to a host asks, and
 * every later request to that same host proceeds silently. A new host asks again, because "I let
 * it read the Python docs" is not "I let it read anything".
 *
 * Denial is remembered too. Re-asking for a host the user just refused is how a refusal becomes a
 * war of attrition.
 */

type Verdict = 'granted' | 'denied';

const decisions = new Map<string, Verdict>();

/** Test seam and `/reset` hook — a new session starts with no standing grants. */
export function resetNetworkConsent(): void {
  decisions.clear();
}

export function networkConsentState(): { host: string; verdict: Verdict }[] {
  return [...decisions.entries()].map(([host, verdict]) => ({ host, verdict }));
}

function hostOf(target: string): string {
  try {
    return new URL(target).host || target;
  } catch {
    return target;
  }
}

export interface NetworkConsentRequest {
  /** A URL, or a bare host/search-engine name for a query. */
  target: string;
  /** What the tool intends to do, in the user's words — shown in the prompt. */
  purpose: string;
  tool: string;
}

/**
 * Returns null when the request may proceed, or a refusal string to return to the model.
 *
 * The governor's own mode still applies underneath: in `bypass` (`/governor off`) it approves
 * without prompting, which is the documented meaning of that mode.
 */
export async function requireNetworkConsent(
  governor: IGovernor,
  request: NetworkConsentRequest,
): Promise<string | null> {
  const host = hostOf(request.target);
  const standing = decisions.get(host);
  if (standing === 'granted') return null;
  if (standing === 'denied') {
    return `Refused: you declined network access to ${host} earlier in this session. `
      + `Ask the user directly if this has changed.`;
  }

  try {
    await governor.approveTaskExecution('NETWORK_ACCESS', {
      tool: request.tool,
      host,
      target: request.target,
      purpose: request.purpose,
      isDestructive: false,
      // The prompt line the front-end renders.
      summary: `Allow ${request.tool} to reach ${host}? (${request.purpose})`,
    });
  } catch (e: unknown) {
    decisions.set(host, 'denied');
    return `Refused: the user declined network access to ${host}. `
      + `${e instanceof Error && e.message ? `(${e.message}) ` : ''}Continue without it, or ask them directly.`;
  }

  decisions.set(host, 'granted');
  return null;
}
