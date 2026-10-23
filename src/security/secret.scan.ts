/**
 * What a secret is — one definition for the engine and the app.
 *
 * The app's notch uses `findSecrets` to recognise a copied key and mask it (God's Land stage 6). The engine uses
 * `redactSecrets` / `redactSecretsDeep` on everything it keeps on disk — session transcripts, the agent log, archived
 * tool output, mind episodes, the execution ledger — so a key that went through a command or a tool result is not
 * left in plain text in ~/.breakglass or <project>/.breakglass. The live turn is untouched: the model still sees what
 * the tool returned; only what is saved is scrubbed.
 *
 * The detection rules are ported from gitleaks (github.com/gitleaks/gitleaks, config/gitleaks.toml at b58d3f1, MIT,
 * Copyright (c) 2019 Zachary Rice): the regex, gitleaks' Shannon-entropy floor where it has one, and its allowlist
 * where it has one. Go's inline flags were rewritten for JavaScript (`(?i)` → the `i` flag, `(?i:[a-z])` → `[a-zA-Z]`).
 */

/** `group` is what a finder reports; `redact` (default: `group`) is the part a redactor replaces — for a URL, only the
 *  password, so a log still says which database it talked to. */
export interface SecretRule { id: string; label: string; regex: RegExp; group: number; redact?: number; entropy?: number; allow?: RegExp[] }

const END = String.raw`(?:[\x60'"\s;]|\\[nr]|$)`;
export const RULES: SecretRule[] = [
  { id: 'aws-access-token', label: 'AWS access key', regex: /\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\b/, group: 1, entropy: 3, allow: [/.+EXAMPLE$/] },
  { id: 'stripe-access-token', label: 'Stripe key', regex: new RegExp(String.raw`\b((?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99})` + END), group: 1, entropy: 2 },
  { id: 'github-pat', label: 'GitHub token', regex: /ghp_[0-9a-zA-Z]{36}/, group: 0, entropy: 3 },
  { id: 'github-fine-grained-pat', label: 'GitHub token', regex: /github_pat_\w{82}/, group: 0, entropy: 3 },
  { id: 'github-oauth', label: 'GitHub token', regex: /gho_[0-9a-zA-Z]{36}/, group: 0, entropy: 3 },
  { id: 'github-app-token', label: 'GitHub token', regex: /(?:ghu|ghs)_[0-9a-zA-Z]{36}/, group: 0, entropy: 3 },
  { id: 'gitlab-pat', label: 'GitLab token', regex: /glpat-[\w-]{20}/, group: 0, entropy: 3 },
  { id: 'slack-bot-token', label: 'Slack token', regex: /xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*/, group: 0, entropy: 3 },
  { id: 'slack-user-token', label: 'Slack token', regex: /xox[pe](?:-[0-9]{10,13}){3}-[a-zA-Z0-9-]{28,34}/, group: 0, entropy: 2 },
  { id: 'slack-webhook-url', label: 'Slack webhook', regex: /(?:https?:\/\/)?hooks.slack.com\/(?:services|workflows|triggers)\/[A-Za-z0-9+/]{43,56}/, group: 0 },
  { id: 'private-key', label: 'Private key', regex: /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S-]{64,}?KEY(?: BLOCK)?-----/i, group: 0 },
  { id: 'anthropic-api-key', label: 'Anthropic key', regex: new RegExp(String.raw`\b(sk-ant-api03-[a-zA-Z0-9_\-]{93}AA)` + END), group: 1 },
  { id: 'openai-api-key', label: 'OpenAI key', regex: new RegExp(String.raw`\b(sk-(?:proj|svcacct|admin)-(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})T3BlbkFJ(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})\b|sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20})` + END), group: 1, entropy: 3 },
  { id: 'gcp-api-key', label: 'Google API key', regex: new RegExp(String.raw`\b(AIza[\w-]{35})` + END), group: 1, entropy: 4, allow: [
    /AIzaSyabcdefghijklmnopqrstuvwxyz1234567/, /AIzaSyAnLA7NfeLquW1tJFpx_eQCxoX-oo6YyIs/, /AIzaSyCkEhVjf3pduRDt6d1yKOMitrUEke8agEM/,
    /AIzaSyDMAScliyLx7F0NPDEJi1QmyCgHIAODrlU/, /AIzaSyD3asb-2pEZVqMkmL6M9N6nHZRR_znhrh0/, /AIzayDNSXIbFmlXbIE6mCzDLQAqITYefhixbX4A/,
    /AIzaSyAdOS2zB6NCsk1pCdZ4-P6GBdi_UUPwX7c/, /AIzaSyASWm6HmTMdYWpgMnjRBjxcQ9CKctWmLd4/, /AIzaSyANUvH9H9BsUccjsu2pCmEkOPjjaXeDQgY/,
    /AIzaSyA5_iVawFQ8ABuTZNUdcwERLJv_a_p4wtM/, /AIzaSyA4UrcGxgwQFTfaI3no3t7Lt1sjmdnP5sQ/, /AIzaSyDSb51JiIcB6OJpwwMicseKRhhrOq1cS7g/,
    /AIzaSyBF2RrAIm4a0mO64EShQfqfd2AFnzAvvuU/, /AIzaSyBcE-OOIbhjyR83gm4r2MFCu4MJmprNXsw/, /AIzaSyB8qGxt4ec15vitgn44duC5ucxaOi4FmqE/,
    /AIzaSyA8vmApnrHNFE0bApF4hoZ11srVL_n0nvY/,
  ] },
  { id: 'npm-access-token', label: 'npm token', regex: new RegExp(String.raw`\b(npm_[a-z0-9]{36})` + END, 'i'), group: 1, entropy: 2 },
  { id: 'huggingface-access-token', label: 'Hugging Face token', regex: new RegExp(String.raw`\b(hf_[a-zA-Z]{34})` + END), group: 1, entropy: 2 },
  { id: 'jwt', label: 'JSON Web Token', regex: new RegExp(String.raw`\b(ey[a-zA-Z0-9]{17,}\.ey[a-zA-Z0-9\/\\_-]{17,}\.(?:[a-zA-Z0-9\/\\_-]{10,}={0,2})?)` + END), group: 1, entropy: 3 },
  { id: 'sendgrid-api-token', label: 'SendGrid key', regex: new RegExp(String.raw`\b(SG\.[a-zA-Z0-9=_\-.]{66})` + END), group: 1, entropy: 2 },
  { id: 'digitalocean-pat', label: 'DigitalOcean token', regex: new RegExp(String.raw`\b(dop_v1_[a-f0-9]{64})` + END), group: 1, entropy: 3 },
  { id: 'shopify-access-token', label: 'Shopify token', regex: /shpat_[a-fA-F0-9]{32}/, group: 0, entropy: 2 },
  { id: 'twilio-api-key', label: 'Twilio key', regex: /SK[0-9a-fA-F]{32}/, group: 0, entropy: 3 },
  // Not gitleaks rules — Bimax's own additions: NVIDIA's API keys (the provider Bimax defaults to), a password inside
  // a connection URL (postgres://user:pass@host), and the plain `sk-…` keys most OpenAI-compatible providers issue
  // (DeepSeek, OpenRouter's sk-or-v1-, Moonshot…), which gitleaks' OpenAI rule does not match. The leading \b keeps
  // "task-runner-2026…" from counting, and a key must carry a digit so a long kebab-case name does not.
  { id: 'nvidia-api-key', label: 'NVIDIA key', regex: /\bnvapi-[A-Za-z0-9_-]{40,}/, group: 0, entropy: 3 },
  { id: 'url-password', label: 'Password in a URL', regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]{3,})@[^\s]+/i, group: 0, redact: 1 },
  { id: 'generic-sk-key', label: 'API key', regex: /\b(sk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,})/, group: 1, entropy: 3.5 },
];

/** Shannon entropy in bits per character — gitleaks' measure for "random enough to be a real key". */
export function entropy(text: string): number {
  if (!text) return 0;
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) { const p = n / text.length; bits -= p * Math.log2(p); }
  return bits;
}

export interface Found { rule: string; label: string; value: string }

/** Every secret in `text` by the rules above, each once. */
export function findSecrets(text: string): Found[] {
  const found: Found[] = [];
  for (const rule of RULES) {
    const global = new RegExp(rule.regex.source, rule.regex.flags.includes('g') ? rule.regex.flags : `${rule.regex.flags}g`);
    for (const match of text.matchAll(global)) {
      const value = (rule.group ? match[rule.group] : match[0]) ?? '';
      const whole = match[0];
      if (!value) continue;
      if (rule.entropy !== undefined && entropy(value) < rule.entropy) continue;
      if (rule.allow?.some((a) => a.test(value) || a.test(whole))) continue;
      if (!found.some((f) => f.value === value)) found.push({ rule: rule.id, label: rule.label, value });
    }
  }
  return found;
}

export function looksLikeSecret(text: string): boolean { return findSecrets(text).length > 0; }

const compiled = new Map<SecretRule, RegExp>();
/** The rule's regex with `g` (every match) and `d` (group offsets) — built once per rule. */
function withIndices(rule: SecretRule): RegExp {
  let re = compiled.get(rule);
  if (!re) {
    const flags = new Set(rule.regex.flags.split(''));
    flags.add('g'); flags.add('d');
    re = new RegExp(rule.regex.source, [...flags].join(''));
    compiled.set(rule, re);
  }
  re.lastIndex = 0;
  return re;
}

/** `text` with every secret the rules recognise replaced by `[redacted:<rule id>]`. Text without one comes back as is. */
export function redactSecrets(text: string): string {
  if (typeof text !== 'string' || text.length < 8) return text;
  const spans: Array<[number, number, string]> = [];
  for (const rule of RULES) {
    for (const match of text.matchAll(withIndices(rule))) {
      const value = (rule.group ? match[rule.group] : match[0]) ?? '';
      if (!value) continue;
      if (rule.entropy !== undefined && entropy(value) < rule.entropy) continue;
      if (rule.allow?.some((a) => a.test(value) || a.test(match[0]))) continue;
      const at = match.indices?.[rule.redact ?? rule.group];
      if (at) spans.push([at[0], at[1], rule.id]);
    }
  }
  if (!spans.length) return text;
  // Overlapping finds (a JWT inside a URL, say) collapse into the widest span that covers them.
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let out = '';
  let cursor = 0;
  for (const [start, end, id] of spans) {
    if (start < cursor) continue;
    out += text.slice(cursor, start) + `[redacted:${id}]`;
    cursor = end;
  }
  return out + text.slice(cursor);
}

/** `redactSecrets` applied to every string inside `value` (objects, arrays), returning a copy. Keys are kept. */
export function redactSecretsDeep<T>(value: T, depth = 0): T {
  if (typeof value === 'string') return redactSecrets(value) as unknown as T;
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactSecretsDeep(v, depth + 1)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactSecretsDeep(v, depth + 1);
  return out as unknown as T;
}
