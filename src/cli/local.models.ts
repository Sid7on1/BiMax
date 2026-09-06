/**
 * Discovery of the models an on-premises server is actually holding.
 *
 * The shipped catalogue (`cli/models.ts`) is a curated list of hosted model ids. On an air-gapped
 * box that list is not merely wrong, it is unusable: the operator has whatever they pulled onto the
 * GPU server, under whatever names that server gives them, and no amount of curation can know that
 * in advance. So the local presets ask.
 *
 * Every server behind the local presets — Ollama, vLLM, LM Studio, llama.cpp — implements
 * `GET /v1/models`, which is the same OpenAI-compatible surface the chat path already relies on.
 * That call is loopback traffic; the egress perimeter records it and permits it, and it is a
 * genuine part of the audit trail rather than an exception to it.
 */

import { LlmProvider, LOCAL_PLACEHOLDER_KEY } from './provider';

export interface DiscoveredModel {
  id: string;
  /** Which local server answered, so a UI can group two servers running side by side. */
  provider: string;
  /** Bytes on disk, when the server reports it (Ollama does; vLLM does not). */
  sizeBytes?: number;
}

export interface DiscoveryResult {
  models: DiscoveredModel[];
  /** Why nothing came back, phrased for the operator. Absent when the query succeeded. */
  error?: string;
}

/** `{ data: [{ id }] }` is the OpenAI shape; Ollama adds fields we read opportunistically. */
function parseModels(payload: unknown, provider: string): DiscoveredModel[] {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const out: DiscoveredModel[] = [];
  for (const entry of data) {
    const id = (entry as { id?: unknown })?.id;
    if (typeof id !== 'string' || !id) continue;
    const size = (entry as { size?: unknown })?.size;
    out.push({ id, provider, ...(typeof size === 'number' ? { sizeBytes: size } : {}) });
  }
  // Stable order so the picker does not reshuffle between refreshes.
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Ask one local server what it is serving.
 *
 * Never throws. A server that is not running is the ordinary case on a fresh machine, and it is
 * information for the operator, not an exception for the caller to handle: the message says which
 * address was tried, because "connection refused" without an address is the least useful diagnostic
 * in the product.
 */
export async function discoverLocalModels(
  provider: LlmProvider,
  options?: { baseURL?: string; timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<DiscoveryResult> {
  const baseURL = (options?.baseURL || provider.baseURL).replace(/\/+$/, '');
  const doFetch = options?.fetchImpl ?? fetch;
  const controller = new AbortController();
  // A local server answers in milliseconds. A long timeout here would stall the picker on a box
  // where nothing is listening, which is precisely when the operator needs a fast, clear answer.
  const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? 2_000);
  try {
    const response = await doFetch(`${baseURL}/models`, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${process.env[provider.apiKeyEnv] || LOCAL_PLACEHOLDER_KEY}` },
    });
    if (!response.ok) {
      return { models: [], error: `${provider.name} at ${baseURL} answered HTTP ${response.status}` };
    }
    const models = parseModels(await response.json(), provider.name);
    return models.length > 0
      ? { models }
      : { models: [], error: `${provider.name} at ${baseURL} is running but has no models loaded` };
  } catch (error: unknown) {
    const reason = (error as { name?: string })?.name === 'AbortError'
      ? 'did not answer within the timeout'
      : `is not reachable (${(error as Error)?.message || 'unknown error'})`;
    return { models: [], error: `${provider.name} at ${baseURL} ${reason}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask every local preset at once and merge what answers.
 *
 * Concurrent because these are independent loopback probes with a short timeout; serial would make
 * a machine running none of them wait the sum of the timeouts before saying so.
 */
export async function discoverAllLocalModels(
  providers: LlmProvider[],
  options?: { timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<{ models: DiscoveredModel[]; errors: string[] }> {
  const results = await Promise.all(providers.map(p => discoverLocalModels(p, options)));
  return {
    models: results.flatMap(r => r.models),
    errors: results.map(r => r.error).filter((e): e is string => typeof e === 'string'),
  };
}
