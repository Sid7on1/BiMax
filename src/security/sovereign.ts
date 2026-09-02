/**
 * Sovereign mode — the machine-checked form of "nothing leaves the premises".
 *
 * ## Why a mode and not a promise
 *
 * The product's positioning is that confidential work stays on the box. Until this module existed
 * that was an architectural intention: `network.consent.ts` asks the user per host, which answers
 * "did the user agree?" and not "did anything leave?". Those are different questions, and only the
 * second one is what an air-gapped deployment is audited on. Sovereign mode answers the second by
 * making external egress fail CLOSED at every seam, and by writing every attempt — allowed and
 * refused alike — to an append-only ledger (`egress.ledger.ts`).
 *
 * A ledger that recorded only refusals would prove nothing about what was allowed, which is the
 * half an auditor actually cares about. So both are recorded, and the report states the count.
 *
 * ## Why classification is by NAME and never by DNS resolution
 *
 * The obvious implementation resolves the hostname and checks whether the address is private. It is
 * wrong twice:
 *
 * 1. **A resolution is itself egress.** Asking a resolver about `secret-project.example.com` leaks
 *    the name to whoever runs the resolver, which on an air-gapped site is the exact leak we are
 *    here to prevent. A check that leaks in order to decide whether leaking is allowed is not a
 *    check.
 * 2. **The answer can change between the check and the connect.** A name that resolved to
 *    10.0.0.5 during the check can resolve to a public address microseconds later (classic DNS
 *    rebinding). Anything derived from the first answer is a claim about the past.
 *
 * So classification is syntactic: literal loopback/private addresses and known-local name suffixes
 * are local, an operator-supplied allowlist covers on-premises hosts that carry ordinary names, and
 * **everything else is external** — including a bare single-label hostname like `gpu01`, which we
 * genuinely cannot prove is local. The refusal names the allowlist so the fix is one setting, not a
 * source edit.
 *
 * ## Why the WHATWG URL parser does the normalising, and not this file
 *
 * Address spellings are adversarial. `http://2130706433/` and `http://0x7f.1/` are both loopback to
 * a connect(2); `http://010.0.0.1/` is 8.0.0.1 (octal) and not the 10.x it resembles;
 * `[::ffff:127.0.0.1]` is stored as `[::ffff:7f00:1]`. A hand-rolled dotted-quad check gets every
 * one of these wrong, and gets them wrong in the dangerous direction at least half the time.
 *
 * `new URL()` applies exactly the canonicalisation the fetch stack will apply before it connects,
 * so classifying its `hostname` classifies **the host the connection will actually be made to**,
 * not the string a caller typed. Every target is therefore pushed through the parser — bare
 * `host:port` forms by re-parsing them as `http://host:port` — before any classification happens.
 * That is the difference between checking the request and checking a description of it.
 *
 * The residual limitation is stated rather than hidden: an allowlisted name whose DNS points off
 * site would be permitted. That is an operator decision recorded in the ledger, not a silent hole.
 */

/** What a destination is, decided syntactically. `external` is the only refusable class. */
export type Destination = 'loopback' | 'private-lan' | 'allowlisted' | 'external';

export interface EgressRequest {
  /** A URL, or a bare `host` / `host:port`. */
  target: string;
  /** Who is trying to reach it — `LlmAdapter`, `WebFetchTool`, `RemoteEmbeddingBackend`, … */
  subsystem: string;
  /** What it intends to do, in the user's words. Recorded in the ledger. */
  purpose?: string;
}

/** Name suffixes that only ever resolve on the local machine or the local network. */
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.intranet'];

/**
 * Session state. `null` means "not decided yet", so the env resolution runs on every read but a
 * `/sovereign on` at runtime still wins. Tests reset with {@link resetSovereignMode}.
 */
let modeOverride: boolean | null = null;
let allowlistOverride: string[] | null = null;

function envFlag(name: string): boolean | null {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return null;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  return null;
}

/**
 * Is sovereign mode active? Resolution: runtime override (`/sovereign`) → `BIMAX_SOVEREIGN` env →
 * off. Config-file resolution is layered in by the caller that owns config, so this module stays
 * free of a config dependency (and therefore testable without one).
 */
export function isSovereign(): boolean {
  if (modeOverride !== null) return modeOverride;
  return envFlag('BIMAX_SOVEREIGN') ?? false;
}

/** Turn the mode on or off for this process. `null` returns to env resolution. */
export function setSovereignMode(on: boolean | null): void {
  modeOverride = on;
}

/** Test seam: forget every runtime override. */
export function resetSovereignMode(): void {
  modeOverride = null;
  allowlistOverride = null;
}

/**
 * Hosts the operator has declared to be on the premises despite carrying an ordinary name — an
 * internal vLLM box at `models.corp.mrpl`, say. Comma or space separated. A leading dot means
 * "this host and everything under it".
 */
export function sovereignAllowlist(): string[] {
  if (allowlistOverride !== null) return allowlistOverride;
  const raw = process.env.BIMAX_SOVEREIGN_ALLOW || '';
  return raw.split(/[,\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
}

/** Replace the allowlist for this process (settings UI, tests). `null` returns to env resolution. */
export function setSovereignAllowlist(hosts: string[] | null): void {
  allowlistOverride = hosts === null ? null : hosts.map(h => h.trim().toLowerCase()).filter(Boolean);
}

/**
 * The host a connection to `target` would actually be made to: lower-cased, userinfo dropped,
 * address spellings canonicalised by the URL parser, IPv6 brackets removed, one trailing dot
 * removed. Empty string when nothing parseable is there.
 *
 * Userinfo is the trap worth naming: `https://localhost@evil.example/` contains the string
 * `localhost`, and any check that looks for local names inside the raw target calls it local. The
 * parser drops userinfo before `hostname` is read, so the answer is `evil.example`.
 */
export function hostOf(target: string): string {
  const trimmed = (target || '').trim();
  if (!trimmed) return '';
  const parsed = parseTarget(trimmed);
  if (!parsed) return '';
  let host = parsed.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);  // WHATWG keeps brackets
  return host.endsWith('.') ? host.slice(0, -1) : host;
}

/**
 * Parse as a URL, falling back to re-parsing under a dummy scheme so a bare `host[:port]` gets the
 * same canonicalisation a full URL gets. A target that yields no host either way returns null, and
 * its caller treats that as external — a check that cannot identify a destination must never
 * report it as safe.
 *
 * The fallback is driven by "no hostname", not by "it threw", because the failure that matters
 * does not throw: `new URL('gpu01:8000')` SUCCEEDS, reading `gpu01:` as the scheme and leaving the
 * hostname empty. A guard that only retried on an exception would classify every bare `host:port`
 * — the exact form a local model endpoint is written in — as an unparseable target.
 */
function parseTarget(trimmed: string): URL | null {
  const direct = tryUrl(trimmed);
  if (direct?.hostname) return direct;
  // `http://data:text/plain,x` and `http://file:///etc/passwd` both fail this parse (invalid port),
  // so a host-less scheme stays host-less rather than being resurrected as a fake authority.
  const prefixed = tryUrl(`http://${trimmed}`);
  return prefixed?.hostname ? prefixed : null;
}

function tryUrl(s: string): URL | null {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

/** Canonical dotted-quad → octets. The URL parser has already normalised the spelling. */
function ipv4Octets(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function classifyIpv4(o: number[]): Destination {
  if (o[0] === 127) return 'loopback';                                   // 127.0.0.0/8, all of it
  if (o[0] === 10) return 'private-lan';                                 // 10.0.0.0/8
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return 'private-lan';    // 172.16.0.0/12
  if (o[0] === 192 && o[1] === 168) return 'private-lan';                // 192.168.0.0/16
  if (o[0] === 169 && o[1] === 254) return 'private-lan';                // link-local
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return 'private-lan';   // CGNAT / mesh VPNs
  if (o[0] === 0) return 'private-lan';                                  // 0.0.0.0/8 — "this host"
  return 'external';
}

/**
 * Expand an IPv6 literal to 16 bytes, or null if it is not one. Written out rather than
 * pattern-matched because the compressed forms are where the mistakes live: `::1` and
 * `0:0:0:0:0:0:0:1` are the same address, and `::ffff:7f00:1` is how the parser stores
 * `::ffff:127.0.0.1` — a prefix match on the printed string misses both.
 */
function parseIpv6(input: string): number[] | null {
  if (!input.includes(':')) return null;
  let s = input.replace(/%.*$/, '');                                     // drop a zone id (fe80::1%en0)

  // A trailing dotted-quad (`::ffff:127.0.0.1`) becomes the two hex groups it encodes.
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4) {
    const o = ipv4Octets(v4[1]);
    if (!o) return null;
    const g1 = (((o[0] << 8) | o[1]) >>> 0).toString(16);
    const g2 = (((o[2] << 8) | o[3]) >>> 0).toString(16);
    s = `${s.slice(0, v4.index)}${g1}:${g2}`;
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];

  let groups: string[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  }

  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  return bytes;
}

function classifyIpv6(b: number[]): Destination {
  const zerosUpTo = (n: number): boolean => b.slice(0, n).every(x => x === 0);
  if (zerosUpTo(15) && b[15] === 1) return 'loopback';                   // ::1
  if (b.every(x => x === 0)) return 'private-lan';                       // :: — "this host"
  if (zerosUpTo(10) && b[10] === 0xff && b[11] === 0xff) {               // IPv4-mapped
    return classifyIpv4(b.slice(12));
  }
  if ((b[0] & 0xfe) === 0xfc) return 'private-lan';                      // fc00::/7 unique-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return 'private-lan';     // fe80::/10 link-local
  return 'external';
}

function allowlisted(host: string): boolean {
  return sovereignAllowlist().some(entry =>
    entry.startsWith('.') ? host === entry.slice(1) || host.endsWith(entry) : host === entry,
  );
}

/**
 * Classify a destination without touching the network. An empty or unparseable target is
 * `external`: a check that cannot identify where a request is going must not report it as safe.
 */
export function classifyDestination(target: string): Destination {
  const host = hostOf(target);
  if (!host) return 'external';

  const v6 = parseIpv6(host);
  if (v6) {
    const c = classifyIpv6(v6);
    return c === 'external' && allowlisted(host) ? 'allowlisted' : c;
  }

  const v4 = ipv4Octets(host);
  if (v4) {
    const c = classifyIpv4(v4);
    return c === 'external' && allowlisted(host) ? 'allowlisted' : c;
  }

  if (host === 'localhost') return 'loopback';
  if (LOCAL_SUFFIXES.some(s => host.endsWith(s))) {
    return host.endsWith('.localhost') ? 'loopback' : 'private-lan';
  }
  if (allowlisted(host)) return 'allowlisted';

  // Everything else, including a bare single-label hostname. We cannot prove it is local, and a
  // sovereignty guarantee built on an unproven assumption is not one.
  return 'external';
}

/** A refusal carries the destination and the one setting that would legitimately permit it. */
export function refusalFor(host: string, subsystem: string): string {
  return `Refused by sovereign mode: ${subsystem} tried to reach "${host}", which is not on this `
    + `machine or its local network. No data left the premises. If "${host}" really is an `
    + `on-premises host, add it to BIMAX_SOVEREIGN_ALLOW; otherwise this request has no local `
    + `equivalent and the task must be completed from local sources.`;
}
