import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TestDependencyMap, relatedByConvention, testStem, isTestPath, importReachable } from '../mind/tdm';
import { EpistemicLedger } from '../mind/epistemic.ledger';

describe('TDM (v2 §3.4) — the check ↔ file map behind evidence attribution', () => {
  let dir: string;

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgw-tdm-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('convention tier recognizes the test-naming conventions across ecosystems', () => {
    expect(testStem('src/__tests__/math.test.ts')).toBe('math');
    expect(testStem('pager_test.go')).toBe('pager');
    expect(testStem('tests/test_auth.py')).toBe('auth');
    expect(relatedByConvention('src/__tests__/math.test.ts', 'src/util/math.ts')).toBe(true);
    expect(relatedByConvention('pkg/pager_test.go', 'pkg/pager.go')).toBe(true);
    expect(relatedByConvention('src/__tests__/math.test.ts', 'src/util/vector.ts')).toBe(false);
    expect(relatedByConvention('src/util/math.ts', 'src/util/math.ts')).toBe(false); // not a test file
    expect(isTestPath('src/__tests__/math.test.ts')).toBe(true);
    expect(isTestPath('src/util/math.ts')).toBe(false);
  });

  it('coverage tier: a scoped coverage run teaches EXACT check→file edges at weight 1.0', () => {
    fs.mkdirSync(path.join(dir, 'coverage'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'coverage', 'coverage-final.json'), JSON.stringify({
      [path.join(dir, 'src/util/vector.ts')]: { path: 'src/util/vector.ts', s: { 0: 3 } },
      [path.join(dir, 'src/__tests__/vector.test.ts')]: { s: { 0: 1 } }, // test files never become "covered sources"
    }), 'utf-8');

    const tdm = new TestDependencyMap(dir);
    expect(tdm.ingestCoverageRun('npx jest src/__tests__/vector.test.ts --coverage')).toBe(1);
    expect(tdm.weightFor('src/__tests__/vector.test.ts', 'src/util/vector.ts'))
      .toEqual({ weight: 1.0, source: 'coverage' });
    // Persisted: a fresh instance over the same root knows it too.
    expect(new TestDependencyMap(dir).weightFor('src/__tests__/vector.test.ts', 'src/util/vector.ts'))
      .toEqual({ weight: 1.0, source: 'coverage' });
  });

  it('coverage ingestion refuses what it cannot attribute: suite-wide runs and --coverage=false', () => {
    const tdm = new TestDependencyMap(dir);
    expect(tdm.ingestCoverageRun('npx jest --coverage')).toBe(0);            // no per-check attribution
    expect(tdm.ingestCoverageRun('npx jest x.test.ts --coverage=false')).toBe(0);
    expect(tdm.ingestCoverageRun('npx jest x.test.ts --coverage')).toBe(0);  // no coverage file exists
  });

  it('tier precedence: coverage > related > import > null', () => {
    const tdm = new TestDependencyMap(dir);
    // related beats nothing:
    expect(tdm.weightFor('src/__tests__/math.test.ts', 'src/util/math.ts'))
      .toEqual({ weight: 0.7, source: 'related' });
    // import tier via injected reachability:
    expect(tdm.weightFor('src/__tests__/integration.test.ts', 'src/util/math.ts', { importReach: () => true }))
      .toEqual({ weight: 0.3, source: 'import' });
    // unrelated, unreachable → null ("0 otherwise" — the plan's rule):
    expect(tdm.weightFor('src/__tests__/integration.test.ts', 'src/util/math.ts', { importReach: () => false }))
      .toBeNull();
  });

  it('importReachable walks IMPORTS edges within the hop budget', () => {
    const nodes = new Map(Object.entries({
      t: { id: 't', filePath: 'src/__tests__/api.test.ts' },
      a: { id: 'a', filePath: 'src/api.ts' },
      b: { id: 'b', filePath: 'src/deep/impl.ts' },
    }));
    const edges: Record<string, { targetId: string; type: string }[]> = {
      t: [{ targetId: 'a', type: 'IMPORTS' }],
      a: [{ targetId: 'b', type: 'IMPORTS' }],
    };
    const store = { getGraph: () => ({ nodes }), getEdgesFrom: (id: string) => edges[id] || [] };
    expect(importReachable(store as any, 'src/__tests__/api.test.ts', 'src/deep/impl.ts')).toBe(true);
    expect(importReachable(store as any, 'src/__tests__/api.test.ts', 'src/unrelated.ts')).toBe(false);
    expect(importReachable(store as any, 'src/__tests__/api.test.ts', 'src/deep/impl.ts', 1)).toBe(false); // 2 hops needed
  });

  it('EpistemicLedger integration: path-scoped test evidence now settles the SOURCE file claim at the related tier', () => {
    const led = new EpistemicLedger(dir);
    led.openClaim('ts', 0.9, 'src/util/math.ts');
    // v1/pre-TDM: `math.test.ts` never matched `math.ts` (basenames differ) → 0 settled.
    const settled = led.resolve(true, { command: 'npx jest src/__tests__/math.test.ts' });
    expect(settled).toBe(1);
    const bucket = led.calibration().find(r => r.range === '90–100%')!;
    expect(bucket.n).toBeCloseTo(0.7); // settled at the convention tier's stated weight
  });

  it('EpistemicLedger integration: red test failure refutes the conventional source sibling', () => {
    const led = new EpistemicLedger(dir);
    led.openClaim('ts', 0.9, 'src/util/math.ts');
    led.openClaim('ts', 0.9, 'src/other/thing.ts');
    const settled = led.resolve(false, { command: 'npm test', output: 'FAIL src/__tests__/math.test.ts\n  ● math › adds' });
    expect(settled).toBe(1); // only the sibling — thing.ts stays open
    const bucket = led.calibration().find(r => r.range === '90–100%')!;
    expect(bucket.observed).toBe(0);
  });
});
