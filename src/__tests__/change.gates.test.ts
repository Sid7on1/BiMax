import * as path from 'path';
import {
  coverageFor, escalationDecision, gateCovers, gateProblem, loadGates, parseGates, verdictFor,
  type ChangeGate,
} from '../governor/change.gates';

/**
 * W2 (docs/product-reset/58): can a deterministic check catch a mistake in these files?
 *
 * Every assertion here is about the FAILURE DIRECTION. Reporting a guarded change as unguarded
 * costs tokens. Reporting an unguarded change as guarded ships a defect nothing will catch — and
 * the UI bugs this repo has actually shipped (a `var()` resolving to the wrong theme in a subtree,
 * a spring solver losing 39% of its overshoot, a Radix ref null on first commit) were all invisible
 * in a diff. So the tests lean on the cases where the answer must be "no".
 */

const glass: ChangeGate = {
  id: 'glass-contrast', command: 'npm run check:glass-contrast',
  covers: ['app/src/renderer/src/styles.css'],
  meaning: 'Text would drop below AA over its composited surface.',
};
const motion: ChangeGate = {
  id: 'motion', command: 'npm run check:motion',
  covers: ['app/src/renderer/src/components/ui/motion.ts'],
  meaning: 'Motion tokens no longer match their generated source.',
};
const typecheck: ChangeGate = {
  id: 'typecheck', command: 'npm --prefix app run typecheck',
  covers: ['app/src/**/*.ts', 'app/src/**/*.tsx'],
  excludes: ['app/src/**/__tests__/**'],
  meaning: 'The app no longer typechecks.',
};
const GATES = [glass, motion, typecheck];

describe('coverage', () => {
  test('a glob matches, and an exclude carves back out', () => {
    expect(gateCovers(typecheck, 'app/src/main/index.ts')).toBe(true);
    expect(gateCovers(typecheck, 'app/src/__tests__/threads.test.ts')).toBe(false);
    expect(gateCovers(typecheck, 'src/core/agent.loop.ts')).toBe(false);
  });

  test('backslashes and ./ prefixes normalise rather than silently missing', () => {
    // A path that fails to match reads as "unguarded", which is the safe direction — but it would
    // also make every Windows-shaped path look unguarded and quietly disable the whole feature.
    expect(gateCovers(glass, './app/src/renderer/src/styles.css')).toBe(true);
    expect(gateCovers(glass, 'app\\src\\renderer\\src\\styles.css')).toBe(true);
  });

  test('a file no gate names is unguarded, never assumed covered', () => {
    const c = coverageFor(GATES, ['src/core/agent.loop.ts']);
    expect(c.unguarded).toEqual(['src/core/agent.loop.ts']);
    expect(c.covered).toEqual([]);
    expect(c.gates).toEqual([]);
  });

  test('only the gates that actually matched are returned, in declaration order', () => {
    const c = coverageFor(GATES, ['app/src/renderer/src/styles.css', 'app/src/main/index.ts']);
    expect(c.gates.map((g) => g.id)).toEqual(['glass-contrast', 'typecheck']);
    expect(c.unguarded).toEqual([]);
  });
});

describe('the routing verdict', () => {
  test('fully graded → a cheap model is defensible', () => {
    const v = verdictFor(GATES, ['app/src/renderer/src/styles.css']);
    expect(v.routeClass).toBe('gate-covered');
    expect(v.cheapModelEligible).toBe(true);
    expect(v.reason).toContain('glass-contrast');
  });

  test('ONE ungraded file is enough to refuse — not "most files are covered"', () => {
    const v = verdictFor(GATES, ['app/src/renderer/src/styles.css', 'src/core/agent.loop.ts']);
    expect(v.routeClass).toBe('partially-covered');
    expect(v.cheapModelEligible).toBe(false);
    // The reason must name the ungraded file; "partially covered" alone is not actionable.
    expect(v.reason).toContain('src/core/agent.loop.ts');
  });

  test('nothing graded → refuse, and say so', () => {
    const v = verdictFor(GATES, ['README.md']);
    expect(v).toMatchObject({ routeClass: 'unguarded', cheapModelEligible: false });
  });

  test('no files named → refuse; an unknown change is not a safe change', () => {
    const v = verdictFor(GATES, []);
    expect(v).toMatchObject({ routeClass: 'no-files', cheapModelEligible: false });
  });

  test('no gates declared at all → every change is unguarded', () => {
    // The feature must be inert, not permissive, in a project that has declared nothing.
    expect(verdictFor([], ['app/src/renderer/src/styles.css']).cheapModelEligible).toBe(false);
  });
});

describe('declaration parsing refuses what it cannot trust', () => {
  test.each([
    ['missing command', { id: 'a', covers: ['x'], meaning: 'm' }],
    ['covers nothing', { id: 'a', command: 'c', covers: [], meaning: 'm' }],
    ['no meaning', { id: 'a', command: 'c', covers: ['x'] }],
    ['empty glob', { id: 'a', command: 'c', covers: ['  '], meaning: 'm' }],
  ])('%s is rejected with a reason', (_label, bad) => {
    expect(gateProblem(bad)).toBeTruthy();
  });

  test('a valid gate passes, and both file shapes parse', () => {
    expect(gateProblem(glass)).toBeNull();
    expect(parseGates([glass]).gates).toHaveLength(1);
    expect(parseGates({ gates: [glass, motion] }).gates).toHaveLength(2);
  });

  test('a bad entry is dropped with a problem, and the good ones still load', () => {
    // Dropping is the safe direction (fewer gates → more "unguarded"), but it must be VISIBLE:
    // a gate that silently vanished would make a guarded area look ungraded with no explanation.
    const { gates, problems } = parseGates([glass, { id: 'broken' }, motion]);
    expect(gates.map((g) => g.id)).toEqual(['glass-contrast', 'motion']);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('broken');
  });

  test('a duplicate id is refused rather than shadowing the first', () => {
    const { gates, problems } = parseGates([glass, { ...motion, id: 'glass-contrast' }]);
    expect(gates).toHaveLength(1);
    expect(problems[0]).toContain('duplicate');
  });

  test('garbage input yields no gates and an explanation', () => {
    expect(parseGates(null).gates).toEqual([]);
    expect(parseGates('nope').problems).toHaveLength(1);
  });
});

describe("this repository's own declaration", () => {
  // Not a unit test of a fixture — the real .bimax/gates.json, so a typo in it is caught here
  // rather than by silently classifying a guarded file as unguarded at runtime.
  const repo = path.resolve(__dirname, '..', '..');
  const loaded = loadGates(repo);

  test('it parses with no problems', () => {
    expect(loaded.declared).toBe(true);
    expect(loaded.problems).toEqual([]);
    expect(loaded.gates.length).toBeGreaterThan(0);
  });

  test('the stylesheet is graded by the contrast checker', () => {
    const v = verdictFor(loaded.gates, ['app/src/renderer/src/styles.css']);
    expect(v.cheapModelEligible).toBe(true);
    expect(v.coverage.gates.map((g) => g.id)).toContain('glass-contrast');
  });

  test('the engine is graded by the bundle check, which is what tsc cannot do', () => {
    const v = verdictFor(loaded.gates, ['src/core/agent.loop.ts']);
    expect(v.coverage.gates.map((g) => g.id)).toContain('engine-bundle');
  });

  test('the areas with no gate are honestly reported as unguarded', () => {
    // docs, scripts and build config are graded by nothing today. That is a true statement about
    // this repo, and the feature's value depends on it staying true rather than being papered over.
    const v = verdictFor(loaded.gates, ['docs/product-reset/58_RETIREMENT_AND_BACKEND_PLAN.md']);
    expect(v.routeClass).toBe('unguarded');
    expect(v.cheapModelEligible).toBe(false);
  });

  test('a missing declaration is not an error, just no coverage', () => {
    const none = loadGates(path.join(path.sep, 'tmp', 'definitely-not-a-bimax-project'));
    expect(none).toMatchObject({ declared: false, problems: [], gates: [] });
  });
});

describe('escalation — the trigger the router rejected option 5 for lacking', () => {
  test('a gate refusing the quick model escalates', () => {
    const d = escalationDecision('lite', ['glass-contrast']);
    expect(d.escalate).toBe(true);
    expect(d.reason).toContain('glass-contrast');
  });

  test('all gates green never escalates', () => {
    expect(escalationDecision('lite', []).escalate).toBe(false);
  });

  test('the work model failing is a bug to report, not an escalation', () => {
    // Escalating here would re-run the strongest model against itself — the "double latency+cost"
    // failure the original routing decision named.
    const d = escalationDecision('heavy', ['typecheck']);
    expect(d.escalate).toBe(false);
    expect(d.reason).toContain('nothing stronger');
  });
});
