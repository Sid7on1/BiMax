import { IGovernor } from '../../core/interfaces';
import { buildTool } from '../tool.factory';
import { requireNetworkConsent } from '../../security/network.consent';
import { fetchPublicText, publicUrl } from './public-request';

const MAX_RESPONSE_CHARS = 100_000;

/**
 * Reject URLs that point at loopback/link-local/private hosts so the agent
 * cannot be steered into probing internal services (basic SSRF guard).
 */
export function validateFetchUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
  try { return { ok: true, url: publicUrl(raw) }; }
  catch (error) { return { ok: false, reason: (error as Error).message }; }
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
  execute: async (args: { url: string }, context?: { signal?: AbortSignal }) => {
    try {
      const res = await fetchPublicText(args.url, async url => {
        const refusal = await requireNetworkConsent(governor, { target: url.href, tool: 'WebFetchTool', purpose: 'read this page' });
        if (refusal) throw new Error(refusal);
      }, context?.signal);
      let text = res.body;
      if (res.contentType.includes('html')) text = htmlToText(text);
      else if (res.contentType.includes('json')) {
        try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* bounded plain-text fallback */ }
      }
      if (text.length > MAX_RESPONSE_CHARS) text = text.slice(0, MAX_RESPONSE_CHARS) + '\n...[truncated]';
      return `HTTP ${res.status} ${res.statusText} (${res.contentType.split(';')[0] || 'unknown type'})\n\n${text}`;
    } catch (error) {
      context?.signal?.throwIfAborted();
      return `Error fetching page: ${(error as Error).message}`;
    }
  },
}, governor);
