import * as os from 'os';
import * as path from 'path';

/**
 * Point every test worker's global config + secrets directory at a throwaway path.
 *
 * Without this, a test that persists configuration writes to the developer's REAL
 * `~/.breakglass/config.json`. Measured 2026-09-04: a full suite run set the user's work model to
 * `anything/at-all` — the fixture id from `model.use.guard.test.ts`, whose "an outage does not block
 * a deliberate switch" case calls `action:"use"`, and `use` persists. The model picker then showed
 * "0 available models" and the app could not answer a turn. The test passed, and it broke the app.
 *
 * `src/cli/config.ts` already documents this contamination class (a benchmark with `BGW_MODEL=mock`
 * persisting `{"model":"mock"}`) and already resolves the directory lazily through
 * `BIMAX_BREAKGLASS_DIR` precisely so tests can retarget it. The override existed; nothing set it.
 * `env.loader.ts` honours the same variable, so the secrets file is redirected with it — a test can
 * no longer read, or overwrite, real API keys either.
 *
 * Per-worker (`pid`) rather than one shared directory, so parallel workers cannot race on the same
 * file. An already-set value is respected, so a test that wants its own directory still wins.
 */
if (!process.env.BIMAX_BREAKGLASS_DIR) {
  process.env.BIMAX_BREAKGLASS_DIR = path.join(os.tmpdir(), 'bimax-jest-breakglass', String(process.pid));
}
