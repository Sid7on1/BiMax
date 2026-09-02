/**
 * The single choke point every outbound request passes through.
 *
 * Classification (`sovereign.ts`) and recording (`egress.ledger.ts`) are deliberately separate and
 * pure; this is the one place that decides and writes, so there is exactly one function to audit
 * and exactly one function for a new egress surface to call. A surface that forgets to call it is
 * the only way data can leave unrecorded, which makes "who calls this?" a checkable question — see
 * the boundary test that enumerates the surfaces.
 *
 * Outside sovereign mode the guard still RECORDS. That is the point of the design: a user who has
 * never enabled the mode can still ask "what did it contact during that task?" and get a complete
 * answer, and enabling the mode later changes the verdict, not the visibility.
 */

import { classifyDestination, hostOf, isSovereign, refusalFor, EgressRequest } from './sovereign';
import { recordEgress } from './egress.ledger';

/**
 * Decide, record, and return either `null` (proceed) or a refusal string for the caller to hand
 * back to the model. Returning a string rather than throwing is the repo's existing convention for
 * tool-visible refusals (`network.consent.ts`), and it keeps a refusal from unwinding a turn.
 */
export function checkEgress(request: EgressRequest): string | null {
  const host = hostOf(request.target);
  const destination = classifyDestination(request.target);
  const sovereign = isSovereign();
  const refused = sovereign && destination === 'external';

  recordEgress({
    at: new Date().toISOString(),
    host: host || request.target,
    destination,
    verdict: refused ? 'refused' : 'allowed',
    subsystem: request.subsystem,
    purpose: request.purpose,
    sovereign,
  });

  return refused ? refusalFor(host || request.target, request.subsystem) : null;
}

/**
 * The throwing form, for seams that are not tool calls and have no way to return a message — a
 * `fetch` wrapper, an SDK client factory. The message is the same; only the delivery differs.
 */
export class EgressRefused extends Error {
  constructor(public readonly host: string, message: string) {
    super(message);
    this.name = 'EgressRefused';
  }
}

export function assertEgressAllowed(request: EgressRequest): void {
  const refusal = checkEgress(request);
  if (refusal) throw new EgressRefused(hostOf(request.target), refusal);
}
