import { IGovernor } from '../../core/interfaces';
import { buildTool } from '../tool.factory';
import { requireNetworkConsent } from '../../security/network.consent';

const MAX_RESPONSE_CHARS = 100_000;
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Reject URLs that point at loopback/link-local/private hosts so the agent
 * cannot be steered into probing internal services (basic SSRF guard).
 */
export function validateFetchUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `Invalid URL: ${raw}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `Only http/https URLs are allowed (got ${url.protocol})` };
  }
  const host = url.hostname.toLowerCase();
  const isPrivate =
    host === 'localhost' || host === '0.0.0.0' || host === '[::1]' || host === '::1' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    host.endsWith('.local') || host.endsWith('.internal');
  if (isPrivate) {
    return { ok: false, reason: `Refusing to fetch private/internal host: ${host}` };
  }
  return { ok: true, url };
}

/** Strip an HTML document down to readable text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\s*(br|\/p|\/div|\/h[1-6]|\/li|\/tr)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

export const createWebFetchTool = (governor: IGovernor) => buildTool({
  name: 'WebFetchTool',
  description: `Fetches a URL and returns its content as readable text. Use it to read documentation, changelogs, GitHub READMEs, API references, or any public web page the user points you at.

# Instructions
- Only **http/https** URLs to public hosts are allowed; localhost and private network ranges are blocked.
- HTML pages are converted to plain text; JSON and plain-text responses are returned as-is.
- Responses are truncated to ${MAX_RESPONSE_CHARS.toLocaleString()} characters.`,
  isDestructive: false,
  isConcurrencySafe: true,
  schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The absolute http(s) URL to fetch.' },
    },
    required: ['url'],
  },
  execute: async (args: { url: string }) => {
    const check = validateFetchUrl(args.url);
    if (!check.ok) return `Error: ${check.reason}`;

    // Reaching the network is a decision the user owns. Asked once per host per session, so a
    // research turn does not become a stream of prompts. See security/network.consent.ts.
    const refusal = await requireNetworkConsent(governor, {
      target: String(check.url), tool: 'WebFetchTool', purpose: 'read this page',
    });
    if (refusal) return refusal;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(check.url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'BiMax-Agent/1.0 (+https://bimax.ai)', Accept: 'text/html,application/json,text/plain,*/*' },
      });
      const contentType = res.headers.get('content-type') || '';
      const body = await res.text();

      let text: string;
      if (contentType.includes('html')) {
        text = htmlToText(body);
      } else if (contentType.includes('json')) {
        try {
          text = JSON.stringify(JSON.parse(body), null, 2);
        } catch {
          text = body;
        }
      } else {
        text = body;
      }

      const truncated = text.length > MAX_RESPONSE_CHARS
        ? text.slice(0, MAX_RESPONSE_CHARS) + `\n...[truncated, ${text.length.toLocaleString()} chars total]`
        : text;
      return `HTTP ${res.status} ${res.statusText} (${contentType.split(';')[0] || 'unknown type'})\n\n${truncated}`;
    } catch (e: any) {
      if (e.name === 'AbortError') return `Error: request timed out after ${FETCH_TIMEOUT_MS / 1000}s: ${args.url}`;
      return `Error fetching ${args.url}: ${e.message}`;
    } finally {
      clearTimeout(timer);
    }
  },
}, governor);
