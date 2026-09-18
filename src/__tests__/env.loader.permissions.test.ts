let mockTestHome = '';
jest.mock('os', () => {
  const actual = jest.requireActual('os');
  return { ...actual, homedir: () => mockTestHome || actual.homedir() };
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadGlobalEnv, saveApiKeyToEnv } from '../engine/env.loader';

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
