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
 * The detection rules (ported from gitleaks) live in src/security/secret.scan.ts, shared with the engine, which uses
 * them to scrub what it saves to disk. The app takes them through the engine's public API, src/engine/api.ts.
 */

export { RULES, entropy, findSecrets, looksLikeSecret } from '../../../src/engine/api';
export type { SecretRule, Found } from '../../../src/engine/api';
import { findSecrets } from '../../../src/engine/api';

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
