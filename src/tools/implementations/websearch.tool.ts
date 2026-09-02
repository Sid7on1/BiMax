import { IGovernor } from '../../core/interfaces';
import { buildTool, BuiltTool } from '../tool.factory';
import { requireNetworkConsent } from '../../security/network.consent';

const SEARCH_TIMEOUT_MS = 15000;

/** Strip tags + decode the few HTML entities that show up in result titles/snippets. */
function clean(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** DuckDuckGo HTML wraps result links in a redirector (…/l/?uddg=<encoded real url>). Unwrap it. */
function resolveHref(href: string): string {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : u.toString();
  } catch {
    return href;
  }
}

/**
 * Parse a DuckDuckGo results page into {title, url, snippet} items. Handles BOTH layouts — the
 * `html.duckduckgo.com` page (`result__a` / `result__snippet`) and the `lite.duckduckgo.com` page
 * (`result-link` / `result-snippet`) — and tolerates either attribute order. Exported for testing.
 */
export function parseDuckDuckGoHtml(html: string, max: number): { title: string; url: string; snippet: string }[] {
  // Any <a> whose attributes mark it a result link (either layout); attribute order is irrelevant.
  const anchorRe = /<a\b([^>]*(?:result__a|result-link)[^>]*)>([\s\S]*?)<\/a>/g;
  const hrefRe = /href="([^"]+)"/;
  const titles: { title: string; url: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) && titles.length < max) {
    const href = m[1].match(hrefRe);
    if (href) titles.push({ url: resolveHref(href[1]), title: clean(m[2]) });
  }
  // Snippet cell/anchor in either layout (ends in </a> on the html page, </td> on lite).
  const snippetRe = /class=['"][^'"]*result(?:__snippet|-snippet)[^'"]*['"][^>]*>([\s\S]*?)<\/(?:a|td)>/g;
  const snippets: string[] = [];
  while ((m = snippetRe.exec(html)) && snippets.length < max) snippets.push(clean(m[1]));
  return titles.map((t, i) => ({ ...t, snippet: snippets[i] || '' }));
}

/**
 * WebSearchTool — live web search so the agent can look up current docs / library usage / errors
 * instead of relying on stale training data. Uses DuckDuckGo's HTML endpoint (no API key required).
 */
export function createWebSearchTool(governor: IGovernor): BuiltTool {
  return buildTool({
    name: 'WebSearchTool',
    description: `Search the web and return the top results (title, URL, snippet). Use it to look up current library/API usage, errors, docs, or anything your training data may be stale on. Follow up with WebFetchTool to read a result's full page.`,
    isDestructive: false,
    isConcurrencySafe: true,
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        maxResults: { type: 'number', description: 'How many results to return (default 5, max 10).' },
      },
      required: ['query'],
    },
    execute: async (args: { query: string; maxResults?: number }) => {
      const q = (args.query || '').trim();
      if (!q) return 'WebSearchTool needs a non-empty "query".';
      const max = Math.min(Math.max(1, args.maxResults || 5), 10);

      // Searching IS reaching the network — the query itself leaves the machine. Gated on the
      // search host, once per session. See security/network.consent.ts.
      const refusal = await requireNetworkConsent(governor, {
        target: 'https://duckduckgo.com', tool: 'WebSearchTool', purpose: `search for "${q.slice(0, 60)}"`,
      });
      if (refusal) return refusal;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
      try {
        // Use the lite endpoint via POST with a real browser UA. The `html.duckduckgo.com` GET path
        // is aggressively rate-limited (answers automated requests with an HTTP 202 "anomaly" page,
        // zero results) — which made every search fail and the model retry in a loop. `lite` with a
        // form POST is served normally.
        const res = await fetch('https://lite.duckduckgo.com/lite/', {
          method: 'POST',
          signal: controller.signal,
          redirect: 'follow',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'text/html',
          },
          body: `q=${encodeURIComponent(q)}`,
        });
        const html = await res.text();
        const results = parseDuckDuckGoHtml(html, max);
        if (results.length === 0) {
          // Distinguish a genuine empty result set from a blocked/rate-limited page, so the
          // model (and user) aren't told "no results" when the request was actually refused.
          // DuckDuckGo answers a throttled request with a non-2xx status or an anomaly page.
          if (!res.ok) return `Web search failed: DuckDuckGo returned HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''} (likely rate-limited — retry shortly).`;
          if (/anomaly|unusual traffic|are you a robot/i.test(html)) return `Web search was rate-limited by DuckDuckGo (anomaly page). Retry shortly, or fetch a specific URL with WebFetchTool.`;
          return `No web results for "${q}".`;
        }
        return `Top ${results.length} result(s) for "${q}":\n\n` +
          results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`).join('\n\n');
      } catch (e: any) {
        if (e.name === 'AbortError') return `Web search timed out after ${SEARCH_TIMEOUT_MS / 1000}s.`;
        return `Web search failed: ${e.message}`;
      } finally {
        clearTimeout(timer);
      }
    },
  }, governor);
}
