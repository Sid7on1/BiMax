import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as loader from '../engine/env.loader';

// These tests drive the real secrets loader against a throwaway directory (via BIMAX_BREAKGLASS_DIR)
// so they exercise the exact migration path a fresh/legacy install hits — no mocking of fs. POSIX
// mode assertions are skipped on platforms without them (Windows), where the loader is a documented
// best-effort no-op.
const POSIX = process.platform !== 'win32';

function mode(p: string): number {
  return fs.statSync(p).mode & 0o777;
}

describe('breakglass credential permissions', () => {
  let dir: string;
  const prevDir = process.env.BIMAX_BREAKGLASS_DIR;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-bg-'));
    process.env.BIMAX_BREAKGLASS_DIR = dir;
    delete process.env.NVIDIA_API_KEY;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (prevDir === undefined) delete process.env.BIMAX_BREAKGLASS_DIR; else process.env.BIMAX_BREAKGLASS_DIR = prevDir;
  });

  const file = () => path.join(dir, '.env');

  it('creates new credentials as 0700 dir / 0600 file', () => {
    // Start clean (mkdtemp made the dir 0700 already); remove so the write path creates it fresh.
    fs.rmSync(dir, { recursive: true, force: true });
    loader.saveApiKeyToEnv('NVIDIA_API_KEY', 'secret-value');
    expect(fs.existsSync(file())).toBe(true);
    if (POSIX) {
      expect(mode(dir)).toBe(0o700);
      expect(mode(file())).toBe(0o600);
    }
  });

  it('migrates a legacy permissive 0755/0644 install to 0700/0600 on load', () => {
    fs.writeFileSync(file(), 'NVIDIA_API_KEY=legacy\n');
    if (POSIX) { fs.chmodSync(dir, 0o755); fs.chmodSync(file(), 0o644); }

    loader.loadGlobalEnv();

    if (POSIX) {
      expect(mode(dir)).toBe(0o700);
      expect(mode(file())).toBe(0o600);
    }
    expect(process.env.NVIDIA_API_KEY).toBe('legacy');
  });

  it('hardenBreakglassPermissions reports what it tightened', () => {
    fs.writeFileSync(file(), 'X=1\n');
    const r = loader.hardenBreakglassPermissions();
    expect(r.skippedSymlink).toBe(false);
    if (POSIX) { expect(r.dir).toBe(true); expect(r.env).toBe(true); }
  });

  it('is a safe no-op when nothing exists yet (failure handling)', () => {
    fs.rmSync(dir, { recursive: true, force: true });
    const r = loader.hardenBreakglassPermissions();
    expect(r).toEqual({ dir: false, env: false, skippedSymlink: false });
    expect(() => loader.loadGlobalEnv()).not.toThrow();
  });

  (POSIX ? it : it.skip)('does not follow a symlinked .env on load', () => {
    // A planted symlink pointing at an attacker-controlled file.
    const decoy = path.join(os.tmpdir(), `bimax-decoy-${Date.now()}.env`);
    fs.writeFileSync(decoy, 'NVIDIA_API_KEY=attacker\n');
    fs.symlinkSync(decoy, file());
    try {
      loader.loadGlobalEnv();
      // The attacker value must NOT have been injected into the environment.
      expect(process.env.NVIDIA_API_KEY).toBeUndefined();
    } finally {
      fs.rmSync(decoy, { force: true });
    }
  });

  (POSIX ? it : it.skip)('refuses to write credentials through a symlink', () => {
    const target = path.join(os.tmpdir(), `bimax-target-${Date.now()}`);
    fs.writeFileSync(target, 'original\n');
    fs.symlinkSync(target, file());
    try {
      expect(() => loader.saveApiKeyToEnv('NVIDIA_API_KEY', 'x')).toThrow(/symlink/i);
      // The symlink target was left intact — not clobbered with our content.
      expect(fs.readFileSync(target, 'utf-8')).toBe('original\n');
    } finally {
      fs.rmSync(target, { force: true });
    }
  });

  it('logs the path but never the secret value', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    loader.saveApiKeyToEnv('NVIDIA_API_KEY', 'topsecret-DO-NOT-LOG');
    delete process.env.NVIDIA_API_KEY;
    loader.loadGlobalEnv();
    const logged = spy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logged).toMatch(/\.env|breakglass|bimax-bg/);
    expect(logged).not.toContain('topsecret-DO-NOT-LOG');
    spy.mockRestore();
  });
});
