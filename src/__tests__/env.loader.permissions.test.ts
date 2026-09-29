let mockTestHome = '';
jest.mock('os', () => {
  const actual = jest.requireActual('os');
  return { ...actual, homedir: () => mockTestHome || actual.homedir() };
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadGlobalEnv, saveApiKeyToEnv, setEnvLine } from '../engine/env.loader';
import * as dotenv from 'dotenv';

describe('global provider credential permissions', () => {
  let home: string;
  let breakglassOverride: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-credentials-'));
    mockTestHome = home;
    // This suite isolates by mocking `os.homedir()`, so it must own the resolved credential path.
    // `BIMAX_BREAKGLASS_DIR` (set for every worker by jest.setup.ts, to keep tests off the real
    // ~/.breakglass) takes precedence over homedir and would send loadGlobalEnv/saveApiKeyToEnv to
    // that directory instead — leaving this test's own mode assertions looking at a directory
    // nothing ever touched. Drop it here and restore it after.
    breakglassOverride = process.env.BIMAX_BREAKGLASS_DIR;
    delete process.env.BIMAX_BREAKGLASS_DIR;
  });

  afterEach(() => {
    delete process.env.TEST_PROVIDER_API_KEY;
    delete process.env.SECOND_PROVIDER_API_KEY;
    if (breakglassOverride === undefined) delete process.env.BIMAX_BREAKGLASS_DIR;
    else process.env.BIMAX_BREAKGLASS_DIR = breakglassOverride;
    mockTestHome = '';
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('tightens an existing credential file when Bimax loads it', () => {
    const dir = path.join(home, '.breakglass');
    const file = path.join(dir, '.env');
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.writeFileSync(file, 'TEST_PROVIDER_API_KEY=existing-secret\n', { mode: 0o644 });

    loadGlobalEnv();

    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(process.env.TEST_PROVIDER_API_KEY).toBe('existing-secret');
  });

  it('creates and re-tightens the credential directory and file as owner-only', () => {
    saveApiKeyToEnv('TEST_PROVIDER_API_KEY', 'first-secret');

    const dir = path.join(home, '.breakglass');
    const file = path.join(dir, '.env');
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    fs.chmodSync(dir, 0o755);
    fs.chmodSync(file, 0o644);
    saveApiKeyToEnv('SECOND_PROVIDER_API_KEY', 'second-secret');

    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8')).toContain('TEST_PROVIDER_API_KEY=first-secret');
    expect(fs.readFileSync(file, 'utf8')).toContain('SECOND_PROVIDER_API_KEY=second-secret');
  });
});

describe('saving one key leaves the rest of the credential file alone', () => {
  const file = [
    '# provider keys',
    'NVIDIA_API_KEY=nvapi-old',
    '',
    '# off 2026-09-29: OTHER_URL=https://example.com',
    'QUOTED="a value # with a hash"',
    'PEM="-----BEGIN KEY-----',
    'abc',
    '-----END KEY-----"',
    'TAIL=1',
  ].join('\n') + '\n';

  test('comments, blanks, order and quoting survive; the key changes where it stands', () => {
    const out = setEnvLine(file, 'NVIDIA_API_KEY', 'nvapi-new');
    expect(out).toBe(file.replace('NVIDIA_API_KEY=nvapi-old', 'NVIDIA_API_KEY=nvapi-new'));
    expect(dotenv.parse(out)).toEqual(expect.objectContaining({ NVIDIA_API_KEY: 'nvapi-new', QUOTED: 'a value # with a hash', TAIL: '1' }));
  });

  test('a new key is appended; a multi-line value is replaced whole; a duplicate is dropped', () => {
    expect(setEnvLine(file, 'NEW_KEY', 'x')).toBe(file + 'NEW_KEY=x\n');
    const pem = setEnvLine(file, 'PEM', 'short');
    expect(pem).toContain('PEM=short\nTAIL=1\n');
    expect(pem).not.toContain('abc');
    expect(setEnvLine('A=1\nB=2\nA=3\n', 'A', '9')).toBe('A=9\nB=2\n');
    expect(setEnvLine('', 'A', '1')).toBe('A=1\n');
  });

  test('a value that needs quoting is quoted, so it reads back whole', () => {
    const out = setEnvLine('', 'P', 'has space # and hash');
    expect(dotenv.parse(out).P).toBe('has space # and hash');
  });

  test('through saveApiKeyToEnv on disk', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-envline-'));
    const override = process.env.BIMAX_BREAKGLASS_DIR;
    process.env.BIMAX_BREAKGLASS_DIR = path.join(home, '.breakglass');
    try {
      fs.mkdirSync(process.env.BIMAX_BREAKGLASS_DIR, { recursive: true });
      const envFile = path.join(process.env.BIMAX_BREAKGLASS_DIR, '.env');
      fs.writeFileSync(envFile, file, { mode: 0o600 });
      saveApiKeyToEnv('TEST_PROVIDER_API_KEY', 'k-1');
      expect(fs.readFileSync(envFile, 'utf8')).toBe(file + 'TEST_PROVIDER_API_KEY=k-1\n');
    } finally {
      delete process.env.TEST_PROVIDER_API_KEY;
      if (override === undefined) delete process.env.BIMAX_BREAKGLASS_DIR; else process.env.BIMAX_BREAKGLASS_DIR = override;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
