import { randomUUID } from 'node:crypto';
import type { PresentationPart } from '../protocol/presentation';
interface Grant {
  expires: number;
  owner: object;
  alive: () => boolean;
  read: () => Promise<unknown>;
  call: (name: string, args: unknown, signal: AbortSignal) => Promise<unknown>;
  busy: boolean;
  controller?: AbortController;
}
const grants = new Map<string, Grant>();
/** Engine-local capabilities are issued only after a real tool result, and revoked on connection retirement. */
export function grantMcpUi(
  part: Extract<PresentationPart, { kind: 'mcp-app' }>,
  grant: Omit<Grant, 'expires' | 'busy'>,
): PresentationPart {
  for (const [id, value] of grants) if (!value.alive() || value.expires < Date.now()) grants.delete(id);
  while (grants.size >= 32) grants.delete(grants.keys().next().value!);
  const id = randomUUID();
  grants.set(id, { ...grant, expires: Date.now() + 15 * 60_000, busy: false });
  return { ...part, id };
}
export function revokeMcpUi(owner: object) {
  for (const [id, grant] of grants)
    if (grant.owner === owner) {
      grant.controller?.abort(new Error('Tool UI connection retired.'));
      grants.delete(id);
    }
}
export async function requestMcpUi(raw: unknown): Promise<unknown> {
  const request = raw as { grant: string; operation: string; name?: string; args?: unknown };
  if (!request || typeof request.grant !== 'string' || JSON.stringify(request).length > 64_000)
    throw new Error('Invalid tool UI request.');
  const grant = grants.get(request.grant);
  if (!grant || !grant.alive() || grant.expires < Date.now())
    throw new Error('Tool UI expired. Run its producing tool again.');
  if (request.operation === 'cancel') {
    grant.controller?.abort(new Error('Tool UI closed. Completion may be unknown; do not replay it.'));
    return {};
  }
  if (request.operation === 'read') return grant.read();
  if (request.operation !== 'call' || typeof request.name !== 'string')
    throw new Error('Unsupported tool UI action.');
  if (grant.busy) throw new Error('A tool UI action is already running.');
  grant.busy = true;
  const controller = new AbortController();
  grant.controller = controller;
  const timer = setTimeout(
    () =>
      controller.abort(new Error('Tool UI action timed out. Completion may be unknown; do not replay it.')),
    30_000,
  );
  try {
    return await grant.call(request.name, request.args, controller.signal);
  } finally {
    clearTimeout(timer);
    grant.busy = false;
    grant.controller = undefined;
  }
}
