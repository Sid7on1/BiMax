import type { Message } from './llm.provider';
import { contentToText } from './multimodal';

/**
 * What particular providers need at the wire, kept apart from the adapter that sends requests (flaw list C15): NVIDIA
 * NIM's message-order rules, RFC 7807 error bodies the OpenAI SDK cannot read, and the real target of a `fetch`.
 */

/**
 * The URL a `fetch` call is actually aimed at. The SDK may hand us a string, a `URL`, or a
 * `Request`, and the guard must classify the real destination rather than the configured base —
 * they differ whenever the SDK builds a path or a caller passes an absolute override. Falls back
 * to the base URL only when the argument carries no usable URL at all.
 */
export function requestUrlOf(input: unknown, fallback: string): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  const url = (input as { url?: unknown } | null)?.url;
  return typeof url === 'string' && url ? url : fallback;
}

/**
 * NVIDIA NIM chat templates accept one system block at the beginning and reject system roles
 * later in the conversation. They also require a completed assistant turn between a tool result
 * and a fresh user turn. Normalize those provider-specific constraints at the final wire boundary
 * so context injectors cannot accidentally create another role-order 400.
 */
export function normalizeNvidiaMessages(messages: Message[]): Message[] {
  const systems = messages.filter(m => m.role === 'system');
  const conversation = messages.filter(m => m.role !== 'system');
  const out: Message[] = [];

  if (systems.length > 0) {
    out.push({
      role: 'system',
      content: systems.map(m => contentToText(m.content as any)).filter(Boolean).join('\n\n'),
    });
  }

  for (const message of conversation) {
    if (out[out.length - 1]?.role === 'tool' && message.role === 'user') {
      out.push({
        role: 'assistant',
        content: 'Tool results received. I will use the new user-provided context to continue.',
      });
    }
    out.push(message);
  }
  return out;
}

/**
 * OpenAI's SDK expects JSON errors to be shaped as `{ error: { message } }`. NVIDIA's API gateway
 * returns RFC 7807 problem documents instead (`{ title, status, detail }`). The SDK discards that
 * top-level document and constructs `410 status code (no body)`, hiding the one field that explains
 * the failure. Normalize only failed JSON/problem responses, keep the body bounded, and leave every
 * successful/unknown response byte-for-byte untouched.
 */
export async function normalizeProviderErrorResponse(response: Response): Promise<Response> {
  if (response.ok) return response;
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('json') && !contentType.includes('problem')) return response;

    let text: string;
  try { text = await response.clone().text(); } catch { return response; }
  if (!text || text.length > 16_384) return response;

  let problem: any;
  try { problem = JSON.parse(text); } catch { return response; }
  if (!problem || typeof problem !== 'object' || problem.error) return response;
  const detail = typeof problem.detail === 'string' ? problem.detail.trim() : '';
  const title = typeof problem.title === 'string' ? problem.title.trim() : '';
  const message = detail || title;
  if (!message) return response;

  const headers = new Headers(response.headers);
  headers.set('content-type', 'application/json');
  headers.delete('content-length');
  return new Response(JSON.stringify({
    error: {
      message,
      ...(title ? { type: title.toLowerCase().replace(/\s+/g, '_') } : {}),
      ...(response.status === 410 ? { code: 'model_gone' } : {}),
    },
  }), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
