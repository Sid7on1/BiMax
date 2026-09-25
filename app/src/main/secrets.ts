import { createHash } from 'crypto';
import { readdirSync, readFileSync, statSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * God's Land stage 6 (docs/product-reset/gods-land/03_PLAN.md): secrets. What is a secret, how it is shown masked, and
 * which ones the notch can offer — from `.env` files in folders the person opened in Bimax, never anywhere else.
 *
 * Values never leave the app except to the notch's helper, one at a time, when the person presses to reveal or
 * authenticates to copy. They are never sent to a model, never logged, and never written in plain text (clipboard.ts
 * seals the ones it keeps). The notch always gets the masked form first.
 *
 * The detection rules are ported from gitleaks (github.com/gitleaks/gitleaks, config/gitleaks.toml at b58d3f1, MIT,
 * Copyright (c) 2019 Zachary Rice): the regex, gitleaks' Shannon-entropy floor where it has one, and its allowlist
 * where it has one. Go's inline flags were rewritten for JavaScript (`(?i)` → the `i` flag, `(?i:[a-z])` → `[a-zA-Z]`).
 */

export interface SecretRule { id: string; label: string; regex: RegExp; group: number; entropy?: number; allow?: RegExp[] }

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
  // Not gitleaks rules — Bimax's own additions: NVIDIA's API keys (the provider Bimax defaults to), and a password inside
  // a connection URL (postgres://user:pass@host).
  { id: 'nvidia-api-key', label: 'NVIDIA key', regex: /\bnvapi-[A-Za-z0-9_-]{40,}/, group: 0, entropy: 3 },
  { id: 'url-password', label: 'Password in a URL', regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]{3,})@[^\s]+/i, group: 0 },
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

const PREFIXES = ['nvapi-', 'sk-ant-api03-', 'sk-proj-', 'sk-svcacct-', 'sk-admin-', 'github_pat_', 'dop_v1_', 'sk_live_', 'sk_test_', 'sk_prod_', 'rk_live_', 'rk_test_',
  'ghp_', 'gho_', 'ghu_', 'ghs_', 'glpat-', 'xoxb-', 'xoxp-', 'xoxe-', 'shpat_', 'npm_', 'hf_', 'SG.', 'AKIA', 'ASIA', 'AIza', 'eyJ'];

/** The masked form the notch shows: a recognisable prefix, dots, the last four. Never enough to use. */
export function maskSecret(value: string): string {
  const v = value.trim();
  const key = /^(-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----)/.exec(v);
  if (key) return `${key[1]} ••••`;
  const url = /^([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(@.*)$/i.exec(v);
  if (url) return `${url[1]}••••${url[2]}`;
  const prefix = PREFIXES.find((p) => v.startsWith(p)) ?? '';
  const tail = v.length - prefix.length > 12 ? v.slice(-4) : '';
  return `${prefix || v.slice(0, Math.min(3, Math.floor(v.length / 4)))}••••${tail}`;
}

// ── .env files ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface EnvEntry { key: string; value: string; line: number }

/** KEY=VALUE lines of a dotenv file: `export`, quotes and trailing comments handled; comments and blanks skipped. */
export function parseEnv(text: string): EnvEntry[] {
  const out: EnvEntry[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(raw);
    if (!m) return;
    let value = m[2]!.trim();
    const quoted = /^(['"`])([\s\S]*)\1$/.exec(value);
    if (quoted) value = quoted[2]!;
    else value = value.replace(/\s+#.*$/, '').trim();
    out.push({ key: m[1]!, value, line: i + 1 });
  });
  return out;
}

const SECRET_NAME = /(SECRET|TOKEN|PASSWORD|PASSWD|PWD|API_?KEY|ACCESS_?KEY|PRIVATE|CREDENTIAL|AUTH|DSN|DATABASE_URL|CONNECTION_STRING|WEBHOOK)/i;
const PLACEHOLDER = /^(|x+|\*+|\.+|<.*>|\$\{.*\}|your[_-].*|change[_-]?me|example.*|replace[_-]?me|todo|none|null|false|true|0|1|test|dummy|sample|placeholder)$/i;

/** The entries of a dotenv file worth offering: a value a rule recognises, or a secret-named key with a real value. */
export function envSecrets(text: string): Array<EnvEntry & { label: string }> {
  return parseEnv(text).flatMap((entry) => {
    if (PLACEHOLDER.test(entry.value)) return [];
    const found = findSecrets(entry.value);
    if (found.length) return [{ ...entry, value: found[0]!.value, label: found[0]!.label }];
    if (SECRET_NAME.test(entry.key) && entry.value.length >= 8 && !/\s/.test(entry.value)) return [{ ...entry, label: 'Secret' }];
    return [];
  });
}

// ── Scanning the folders opened in Bimax ────────────────────────────────────────────────────────────────────────────

export interface SecretEntry { id: string; label: string; key: string; masked: string; where: string; value: string }

export const SCAN_LIMITS = { files: 200, bytes: 64 * 1024, depth: 2 };
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'vendor', 'Pods', '.venv', 'venv', '__pycache__', 'DerivedData']);
const isEnvFile = (name: string): boolean => name === '.env' || name.startsWith('.env.') || name.endsWith('.env');

/**
 * Secrets in dotenv files under `roots` — the folders the person opened in Bimax. Never the home folder or the disk
 * as a whole, never deeper than two levels, never through node_modules or .git, never a file over 64 KB, never more
 * than 200 files. Values stay in the returned entries; the notch gets `masked`.
 */
export function scanFolders(roots: readonly string[], home = os.homedir()): SecretEntry[] {
  const entries: SecretEntry[] = [];
  let files = 0;
  const seenRoots = new Set<string>();
  for (const root of roots) {
    const resolved = path.resolve(root);
    if (seenRoots.has(resolved) || resolved === path.parse(resolved).root || resolved === path.resolve(home)) continue;
    seenRoots.add(resolved);
    const walk = (dir: string, depth: number): void => {
      let names: string[];
      try { names = readdirSync(dir); } catch { return; }
      for (const name of names) {
        if (files >= SCAN_LIMITS.files) return;
        const full = path.join(dir, name);
        let stat;
        try { stat = statSync(full); } catch { continue; }
        if (stat.isDirectory()) {
          if (depth < SCAN_LIMITS.depth && !SKIP_DIRS.has(name) && !(name.startsWith('.') && name !== '.config')) walk(full, depth + 1);
          continue;
        }
        if (!stat.isFile() || !isEnvFile(name) || stat.size > SCAN_LIMITS.bytes) continue;
        files++;
        let text: string;
        try { text = readFileSync(full, 'utf8'); } catch { continue; }
        const where = path.join(path.basename(resolved), path.relative(resolved, full));
        for (const secret of envSecrets(text)) {
          const id = createHash('sha256').update(`${full}\0${secret.key}\0${secret.line}`).digest('hex').slice(0, 16);
          entries.push({ id, label: secret.label, key: secret.key, masked: maskSecret(secret.value), where, value: secret.value });
        }
      }
    };
    walk(resolved, 0);
  }
  return entries;
}
