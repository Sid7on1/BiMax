import * as dotenv from 'dotenv';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as readline from 'readline';
import * as crypto from 'crypto';

// The provider credential lives in ~/.breakglass/.env. It must be owner-only (dir 0700, file 0600):
// a world/group-readable secret is a real defect (v1.0.0 shipped 0755/0644). Every entry point that
// reads or writes it FIRST migrates the modes, because a permissive install won't fix itself and we
// can't trust creation-time umask. All of this is best-effort on filesystems without POSIX modes
// (Windows/exFAT) and never logs the secret — only the path.

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * The canonical secrets directory and file. `BIMAX_BREAKGLASS_DIR` relocates it (multi-profile
 * setups, and a hermetic path for tests), defaulting to ~/.breakglass. Functions, not constants, so
 * the override is read at call time.
 */
function breakglassDir(): string {
  return process.env.BIMAX_BREAKGLASS_DIR || path.join(os.homedir(), '.breakglass');
}
function globalEnvFile(): string { return path.join(breakglassDir(), '.env'); }

/** True when `p` exists and is a symbolic link. A symlink here is an attacker redirect, not our file. */
function isSymlink(p: string): boolean {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

export interface HardenResult {
  /** The directory mode was tightened (or confirmed) to 0700. */
  dir: boolean;
  /** The .env mode was tightened (or confirmed) to 0600. */
  env: boolean;
  /** A symlink was found at the dir or file and left untouched — the caller must not follow it. */
  skippedSymlink: boolean;
}

/**
 * Bring ~/.breakglass to 0700 and ~/.breakglass/.env to 0600, migrating any legacy permissive
 * install in place. Touches modes only — never the file contents — so it is safe to call on every
 * startup and cannot leak the secret. A symlinked dir or file is deliberately left alone (see
 * `skippedSymlink`): chmod would follow the link and re-permission an attacker-chosen target.
 * Never throws; a filesystem that rejects chmod (Windows, network FS) simply reports `false`.
 */
export function hardenBreakglassPermissions(): HardenResult {
  const dir = breakglassDir();
  const file = globalEnvFile();
  const result: HardenResult = { dir: false, env: false, skippedSymlink: false };

  if (isSymlink(dir)) { result.skippedSymlink = true; return result; }
  try {
    if (fs.existsSync(dir)) { fs.chmodSync(dir, DIR_MODE); result.dir = true; }
  } catch { /* best-effort: no POSIX modes on this filesystem */ }

  if (isSymlink(file)) { result.skippedSymlink = true; return result; }
  try {
    if (fs.existsSync(file)) { fs.chmodSync(file, FILE_MODE); result.env = true; }
  } catch { /* best-effort */ }

  return result;
}

function writeGlobalEnv(globalEnvPath: string, content: string): void {
  // Refuse to write through a symlink — following it would clobber an attacker-chosen target
  // (e.g. a symlink at ~/.breakglass/.env pointing at ~/.ssh/authorized_keys) with our content.
  if (isSymlink(globalEnvPath)) {
    throw new Error(`Refusing to write credentials: ${globalEnvPath} is a symlink, not a regular file.`);
  }
  const globalDir = path.dirname(globalEnvPath);
  if (isSymlink(globalDir)) {
    throw new Error(`Refusing to write credentials: ${globalDir} is a symlink, not a regular directory.`);
  }
  fs.mkdirSync(globalDir, { recursive: true, mode: DIR_MODE });
  // Existing installs may have inherited a permissive umask. Tighten both the directory and the
  // secret file every time credentials change instead of trusting creation-time defaults.
  try { fs.chmodSync(globalDir, DIR_MODE); } catch { /* best-effort */ }
  fs.writeFileSync(globalEnvPath, content, { encoding: 'utf-8', mode: FILE_MODE });
  try { fs.chmodSync(globalEnvPath, FILE_MODE); } catch { /* best-effort */ }
}

export function loadGlobalEnv(): void {
  const globalEnvPath = globalEnvFile();
  // Migrate any legacy permissive modes BEFORE reading — v1.0.0 shipped 0755/0644.
  const hardened = hardenBreakglassPermissions();
  // A symlinked secrets file is suspicious (another local user could have planted it to feed us
  // attacker-controlled env vars). Do not follow it; leave the process env untouched and say so.
  if (hardened.skippedSymlink || isSymlink(globalEnvPath)) {
    console.log(`[Env] Skipped ${globalEnvPath}: symlink not followed (owner-only regular file expected).`);
    return;
  }
  if (fs.existsSync(globalEnvPath)) {
    const parsed = dotenv.parse(fs.readFileSync(globalEnvPath, 'utf-8'));
    for (const [key, value] of Object.entries(parsed)) {
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
    console.log(`[Env] Loaded global env from ${globalEnvPath}`);
  }
}

export async function ensureApiKeys(): Promise<void> {
  const nvidiaKey = process.env.NVIDIA_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEYS;
  if (nvidiaKey || openaiKey) return;

  const globalEnvPath = globalEnvFile();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('\nNo API keys found. Set up your NVIDIA API key to use bimax:');
  console.log('  (get one free at https://build.nvidia.com/explore/)');
  const answer = await new Promise<string>(resolve => {
    rl.question('Paste your NVIDIA_API_KEY: ', resolve);
  });
  rl.close();

  const trimmed = answer.trim();
  if (!trimmed) {
    console.log('No key provided. You can set NVIDIA_API_KEY later in ~/.breakglass/.env');
    return;
  }

  writeGlobalEnv(globalEnvPath, `NVIDIA_API_KEY=${trimmed}\n`);
  process.env.NVIDIA_API_KEY = trimmed;
  console.log(`[Env] Saved API key to ${globalEnvPath}`);
}

export function saveApiKeyToEnv(envVar: string, key: string): void {
  const globalEnvPath = globalEnvFile();
  const existing: Record<string, string> = {};
  if (fs.existsSync(globalEnvPath) && !isSymlink(globalEnvPath)) {
    const parsed = dotenv.parse(fs.readFileSync(globalEnvPath, 'utf-8'));
    Object.assign(existing, parsed);
  }
  existing[envVar] = key;
  const content = Object.entries(existing)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n') + '\n';
  writeGlobalEnv(globalEnvPath, content);
  process.env[envVar] = key;
}

export function ensureJwtSecret(): string {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;

  const newSecret = crypto.randomBytes(32).toString('hex');
  saveApiKeyToEnv('JWT_SECRET', newSecret);
  process.env.JWT_SECRET = newSecret;
  return newSecret;
}
