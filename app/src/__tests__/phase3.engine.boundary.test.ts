import fs from 'node:fs';
import path from 'node:path';
import { supportsProtocolMajor } from '../shared/protocol.compat.gen';

const repo = path.resolve(__dirname, '..', '..', '..');
const read = (file: string) => fs.readFileSync(path.join(repo, file), 'utf8');

describe('Phase 3 versioned client protocol', () => {
  test('current Desktop supports current and previous majors, and rejects outside the window', () => {
    expect(supportsProtocolMajor(2)).toBe(true);
    expect(supportsProtocolMajor(3)).toBe(true);
    expect(supportsProtocolMajor(1)).toBe(false);
    expect(supportsProtocolMajor(4)).toBe(false);
  });

  test('golden data preserves current and previous-engine journeys', () => {
    const current = JSON.parse(read('src/protocol/schema/golden/current-v3.json'));
    const previous = JSON.parse(read('src/protocol/schema/golden/previous-v2.json'));
    expect(current.journeys).toEqual(expect.objectContaining({
      transcript: expect.any(Array), approval_interrupt_resume: expect.any(Array),
      crash_recovery: expect.any(Array), malformed_frames: expect.any(Array),
    }));
    expect(previous.protocolVersion).toBe('2.0.0');
    expect(previous.journey.some((step: any) => step.message?.t === 'ready' && step.message.protocol === 2)).toBe(true);
  });

  test('the committed schema declares a dialect and models hello plus both directions', () => {
    const schema = JSON.parse(read('src/protocol/schema/protocol.schema.json'));
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    const variants = schema.anyOf as Array<{ properties?: { t?: { const?: string } } }>;
    const tags = new Set(variants.map((v) => v.properties?.t?.const));
    for (const tag of ['hello', 'ready', 'request', 'interrupt', 'resume']) expect(tags.has(tag)).toBe(true);
  });
});

describe('Phase 3 engine release and Desktop consumption boundary', () => {
  // The matching producer-side test ('Terminal release publishes per-chip engines, manifest,
  // checksums, schema, and fixtures') read release.sh and .github/workflows/release.yml. Both went
  // to archive/cli-tui/ on 2026-09-06 with the terminal product, so ENGINE PUBLISHING CURRENTLY HAS
  // NO PIPELINE AND NO GUARD — the app resolves its engine from a local build. Restore a gate here
  // when an app-owned release workflow exists. The consumer-side pins below still hold.

  test('Desktop pins an immutable manifest and never compiles Terminal engine source', () => {
    const lock = JSON.parse(read('app/engine.lock.json'));
    expect(lock.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(lock.protocol).toEqual({ version: '3.1.0', minCompatibleMajor: 2, maxCompatibleMajor: 3 });
    const prepare = read('app/scripts/prepare-engine.sh');
    const resolver = read('app/scripts/resolve-engine-artifact.mjs');
    expect(prepare + resolver).not.toMatch(/bun build|src\/index\.ts|dist\/index\.js|npx tsx/);
    expect(resolver).toContain('BIMAX_ENGINE_LOCAL_OVERRIDE');
    expect(resolver).toContain('BIMAX_ENGINE_ARTIFACT_DIR');
    expect(resolver).toContain('digest mismatch');
    expect(resolver).toContain('size mismatch');
  });

  test('release builds explicitly forbid the contributor override', () => {
    expect(read('app/scripts/resolve-engine-artifact.mjs')).toContain("BIMAX_RELEASE_BUILD === '1'");
    expect(read('app/package.json')).toContain('BIMAX_RELEASE_BUILD=1');
  });
});
