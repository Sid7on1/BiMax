import fs from 'node:fs';
import path from 'node:path';
import { supportsProtocolMajor } from '../shared/protocol.compat';

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

describe('Desktop builds and ships its own engine', () => {
  // This suite used to assert the OPPOSITE: that prepare-engine.sh never mentions `bun build` or
  // src/index.ts, and that app/engine.lock.json pins an immutable manifest digest to download. That
  // was the right guard while the engine was a separately published product with its own release
  // and version. It is not any more — the terminal product went to the archive on 2026-09-06, the
  // v1.1.0 release the lock pinned was never actually published, and this suite's own comment
  // already recorded that engine publishing had "NO PIPELINE AND NO GUARD".
  //
  // The lock also pinned protocol 3.1.0 while the engine has been emitting 3.2.0, so the one fact
  // it asserted about the engine was stale as well. The lock and resolver are in
  // ~/Developer/bimax-archive. What replaces them is a build, and these are its terms.

  test('the engine is built from this repo, not downloaded from a release', () => {
    const prepare = read('app/scripts/prepare-engine.sh');
    expect(prepare).toMatch(/bun build/);
    expect(prepare).toMatch(/src\/index\.ts/);
    // No network, no pinned digest, no version to drift: nothing to fetch means nothing to verify.
    expect(prepare).not.toMatch(/fetch|curl|https:\/\/github\.com|manifestSha256/);
    expect(fs.existsSync(path.join(repo, 'app/engine.lock.json'))).toBe(false);
    expect(fs.existsSync(path.join(repo, 'app/scripts/resolve-engine-artifact.mjs'))).toBe(false);
  });

  test('a packaged app resolves its engine from its own bundle and refuses a development fallback', () => {
    const engine = read('app/src/main/engine.ts');
    expect(engine).toMatch(/process\.resourcesPath, 'engine', 'index\.js'/);
    expect(engine).toMatch(/PackagedRuntimeError/);
    expect(engine).toMatch(/refusing a development fallback/);
  });

  test('the shipped engine bundle is what electron-builder packs', () => {
    const builder = read('app/electron-builder.yml');
    expect(builder).toMatch(/extraResources:/);
    expect(builder).toMatch(/from: engine/);
  });
});
