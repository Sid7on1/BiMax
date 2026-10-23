import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SelfModel, classifyOutcome, domainOf, __setSelfModel } from '../mind/self.model';
import { HabitMiner, __setHabitMiner } from '../mind/habit.compiler';
import { UserModel, extractDiffFeatures } from '../mind/user.model';
import { EpistemicLedger, isEvidenceCommand } from '../mind/epistemic.ledger';
import { DrivesEngine, __setDrivesEngine } from '../mind/drives.engine';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-mind-'));
}

afterEach(() => {
  __setSelfModel(null);
  __setHabitMiner(null);
  __setDrivesEngine(null);
});

describe('SelfModel', () => {
  test('classifyOutcome: returned error strings count as failures, rejections do not', () => {
    expect(classifyOutcome('Error: No match found for oldString', false)).toBe('err');
    expect(classifyOutcome('Syntax check failed for file.ts', false)).toBe('err');
    expect(classifyOutcome('Edit to a.ts rejected by user. No changes were made.', false)).toBe('rejected');
    expect(classifyOutcome('File written successfully.', false)).toBe('ok');
    expect(classifyOutcome('anything', true)).toBe('err');
  });

  test('domainOf: extension for path tools, program for bash', () => {
    expect(domainOf('EditFileTool', JSON.stringify({ path: 'src/a/b.go' }))).toBe('go');
    expect(domainOf('BashTool', JSON.stringify({ command: '/usr/bin/git status' }))).toBe('git');
    expect(domainOf('TodoWriteTool', '{}')).toBe('-');
    expect(domainOf('EditFileTool', 'not json')).toBe('-');
  });

  test('weak spots require posterior mass, not just a rate — and confidence is grounded', () => {
    const root = tmpRoot();
    const m = new SelfModel(root);
    // A 50% observed rate over only 10 calls is NOT enough evidence against the pooled
    // prior (base 15%) to declare a weak spot — v1's magic threshold would have fired here.
    for (let i = 0; i < 10; i++) m.record('EditFileTool', 'go', i % 2 === 0, 'No match found');
    expect(m.weakSpots()).toHaveLength(0);
    // Ten more observations at the same rate push P(θ > 0.30) past the 0.90 decision mass.
    for (let i = 0; i < 10; i++) m.record('EditFileTool', 'go', i % 2 === 0, 'No match found');
    const weak = m.weakSpots();
    expect(weak.length).toBe(1);
    expect(weak[0].tool).toBe('EditFileTool');
    expect(weak[0].pWeak).toBeGreaterThanOrEqual(0.9);
    // Posterior mean is shrunk toward the prior — below the raw 0.5.
    expect(weak[0].failRate).toBeGreaterThan(0.35);
    expect(weak[0].failRate).toBeLessThan(0.5);
    expect(m.getPromptBlock()).toContain('SELF-KNOWLEDGE');
    expect(m.getPromptBlock()).toContain('SymbolEditTool');
    // Stated confidence = 1 − posterior mean (not the raw 50%).
    const conf = m.confidenceFor('EditFileTool', 'go');
    expect(conf).toBeGreaterThan(0.5);
    expect(conf).toBeLessThan(0.65);
    // An unseen domain inherits the TOOL-level pooled rate (partial pooling), not a constant.
    const unseen = m.confidenceFor('EditFileTool', 'ts');
    expect(unseen).toBeGreaterThan(0.4);
    expect(unseen).toBeLessThan(0.6);
    // 50% failure is weak but NOT escalation-grade (P(θ > 0.45) < 0.90).
    expect(m.escalationDomains()).toHaveLength(0);
  });

  test('sustained heavy failure escalates verification', () => {
    const root = tmpRoot();
    const m = new SelfModel(root);
    for (let i = 0; i < 20; i++) m.record('MultiEditTool', 'go', i % 10 === 0, 'boom'); // 90% fail
    expect(m.escalationDomains()).toHaveLength(1);
    expect(m.escalationDomains()[0]).toContain('MultiEditTool');
  });

  test('healthy cells produce no prompt noise and persist across instances', () => {
    const root = tmpRoot();
    const m = new SelfModel(root);
    for (let i = 0; i < 10; i++) m.record('ReadFileTool', 'ts', true);
    expect(m.getPromptBlock()).toBe('');
    m.saveNow();
    const m2 = new SelfModel(root);
    expect(m2.totals().calls).toBe(10);
  });
});

describe('HabitMiner', () => {
  test('recurring sequences are mined, compiled to recipes, and hinted in the prompt', () => {
    const root = tmpRoot();
    const miner = new HabitMiner(root);
    // 5 repetitions of edit → build separated by unique reads (so repeats don't collapse).
    for (let i = 0; i < 5; i++) {
      miner.observe('EditFileTool', 'ts', true);
      miner.observe('BashTool', 'npm', true);
      miner.observe('ReadFileTool', `f${i}`, true); // spacer
    }
    const habits = miner.mine();
    const target = habits.find(h => h.key.startsWith('EditFileTool:ts→BashTool:npm'));
    expect(target).toBeDefined();
    expect(target!.count).toBeGreaterThanOrEqual(4);

    const compiled = miner.compileAll();
    expect(compiled.length).toBeGreaterThan(0);
    const files = fs.readdirSync(path.join(root, '.bimax', 'habits'));
    expect(files.length).toBeGreaterThan(0);
    expect(miner.getPromptBlock()).toContain('COMPILED HABITS');
  });

  test('all-bash habits with stable commands compile into executable macros', () => {
    const root = tmpRoot();
    const miner = new HabitMiner(root);
    for (let i = 0; i < 5; i++) {
      miner.observe('BashTool', 'npm', true, 'npm run build');
      miner.observe('BashTool', 'go', true, 'cd tui && go build -o bimax-tui .');
      miner.observe('ReadFileTool', `f${i}`, true); // spacer
    }
    miner.mine();
    miner.compileAll();
    const macros = miner.executable();
    expect(macros).toHaveLength(1);
    expect(macros[0].commands).toEqual(['npm run build', 'cd tui && go build -o bimax-tui .']);
    // The prompt hint now carries the EXACT command chain, not a vague tool list.
    expect(miner.getPromptBlock()).toContain('npm run build && cd tui && go build');
  });

  test('unstable commands do not become macros', () => {
    const root = tmpRoot();
    const miner = new HabitMiner(root);
    for (let i = 0; i < 5; i++) {
      miner.observe('BashTool', 'npm', true, `npm run build -- --seed ${i}`); // varies every time
      miner.observe('BashTool', 'go', true, 'go build');
      miner.observe('ReadFileTool', `f${i}`, true);
    }
    miner.mine();
    miner.compileAll();
    expect(miner.executable()).toHaveLength(0);
  });

  test('mined patterns never span an episode boundary', () => {
    const root = tmpRoot();
    const miner = new HabitMiner(root);
    // The same edit→build pair recurs, but always across a task boundary — coincidence, not habit.
    for (let i = 0; i < 6; i++) {
      miner.observe('EditFileTool', 'ts', true);
      miner.markBoundary();
      miner.observe('BashTool', 'npm', true);
      miner.markBoundary();
    }
    const habits = miner.mine();
    expect(habits.find(h => h.key.includes('EditFileTool:ts→BashTool:npm'))).toBeUndefined();
  });

  test('pure-read sequences and immediate repeats are not habits', () => {
    const root = tmpRoot();
    const miner = new HabitMiner(root);
    for (let i = 0; i < 6; i++) {
      miner.observe('ReadFileTool', 'ts', true);
      miner.observe('GrepTool', '-', true);
    }
    expect(miner.mine()).toHaveLength(0);
  });
});

describe('UserModel', () => {
  test('diff features are extracted and rejections teach a warning predictor', () => {
    const feats = extractDiffFeatures('Edit src/big.ts', '+line\n'.repeat(200));
    expect(feats).toContain('ext:ts');
    expect(feats).toContain('size:large');

    const root = tmpRoot();
    const um = new UserModel(root);
    const bigDiff = '+x\n'.repeat(200);
    for (let i = 0; i < 5; i++) um.recordDiffDecision(false, 'Edit src/a.ts', bigDiff);
    um.recordDiffDecision(true, 'Edit src/a.ts', '+one line');
    const pred = um.predictApproval('Edit src/b.ts', bigDiff);
    expect(pred).not.toBeNull();
    expect(pred!.p).toBeLessThan(0.5);
    expect(pred!.riskyFeatures.length).toBeGreaterThan(0);
    expect(um.getPromptBlock()).toContain('USER MODEL');
  });

  test('corrections become standing preferences; chit-chat does not', () => {
    const root = tmpRoot();
    const um = new UserModel(root);
    um.observeUserMessage("don't use multiple shells, my mac heats up");
    um.observeUserMessage('always run the build after edits');
    um.observeUserMessage('hi how are you');
    um.observeUserMessage("don't use multiple shells, my mac heats up"); // repeat → count 2
    const block = um.getPromptBlock();
    expect(block).toContain('multiple shells');
    expect(block).toContain('(said 2×)');
    expect(block).not.toContain('how are you');
  });
});

describe('EpistemicLedger', () => {
  test('evidence commands are recognized', () => {
    expect(isEvidenceCommand('npm test')).toBe(true);
    expect(isEvidenceCommand('npx tsc --noEmit')).toBe(true);
    expect(isEvidenceCommand('go build ./...')).toBe(true);
    expect(isEvidenceCommand('ls -la')).toBe(false);
    expect(isEvidenceCommand('git status')).toBe(false);
  });

  test('red evidence refutes ONLY claims whose file the failure output names', () => {
    const root = tmpRoot();
    const led = new EpistemicLedger(root);
    led.openClaim('ts', 0.9, 'src/broken.ts');
    led.openClaim('ts', 0.9, 'src/innocent.ts');
    // Failure output names only broken.ts → innocent.ts stays open (v1 refuted both).
    const settled = led.resolve(false, { command: 'npx tsc --noEmit', output: "src/broken.ts(12,3): error TS2304: Cannot find name 'x'." });
    expect(settled).toBe(1);
    // A later repo-wide green run confirms the innocent claim.
    expect(led.resolve(true, { command: 'npm run build', output: 'ok' })).toBe(1);
    const curve = led.calibration();
    const bucket = curve.find(r => r.range === '90–100%')!;
    expect(bucket.n).toBe(2);
    expect(bucket.observed).toBeCloseTo(0.5); // one refuted, one confirmed — not two false
  });

  test('returns an auditable file-scope receipt for green verification', () => {
    const root = tmpRoot();
    const led = new EpistemicLedger(root);
    led.openClaim('ts', 0.9, 'src/a.ts');
    led.openClaim('ts', 0.9, 'src/b.ts');
    expect(led.resolveDetailed(true, { command: 'npx tsc src/a.ts' })).toEqual({
      settled: 1, coveredFiles: ['src/a.ts'], repoWide: false,
    });
    expect(led.resolveDetailed(true, { command: 'npm test' })).toEqual({
      settled: 1, coveredFiles: ['src/b.ts'], repoWide: true,
    });
  });

  test('unattributable red evidence resolves nothing instead of poisoning labels', () => {
    const root = tmpRoot();
    const led = new EpistemicLedger(root);
    led.openClaim('ts', 0.9, 'src/a.ts');
    expect(led.resolve(false, { command: 'npm test', output: 'something exploded, no file named' })).toBe(0);
    expect(led.calibration()).toHaveLength(0); // nothing settled
  });

  test('overconfidence emerges from scoped refutations; green scoped runs confirm matches only', () => {
    const root = tmpRoot();
    const led = new EpistemicLedger(root);
    for (let i = 0; i < 6; i++) led.openClaim('ts', 0.9, `src/f${i}.ts`);
    const out = Array.from({ length: 6 }, (_, i) => `FAIL src/f${i}.ts`).join('\n');
    expect(led.resolve(false, { command: 'npm test', output: out })).toBe(6);
    const over = led.overconfidentDomains();
    expect(over).toHaveLength(1);
    expect(over[0].domain).toBe('ts');
    expect(led.getPromptBlock()).toContain('CALIBRATION');
  });

  test('well-calibrated claims produce no escalation', () => {
    const root = tmpRoot();
    const led = new EpistemicLedger(root);
    for (let i = 0; i < 6; i++) led.openClaim('go', 0.9, `pkg/g${i}.go`);
    led.resolve(true, { command: 'go test ./...', output: 'ok' });
    expect(led.overconfidentDomains()).toHaveLength(0);
    expect(led.getPromptBlock()).toBe('');
  });
});

describe('DrivesEngine', () => {
  test('todo-debt drive measures and deviates above setpoint', async () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    // 70 TODO markers > setpoint 60 → deviation.
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), Array.from({ length: 70 }, (_, i) => `// TODO item ${i}`).join('\n'));
    const engine = new DrivesEngine(root);
    await engine.check({ only: 'todo-debt' });
    const dev = engine.deviations();
    expect(dev.map(d => d.id)).toContain('todo-debt');
    expect(engine.getPromptBlock()).toContain('DRIVES');
    const task = engine.nextRestorationTask();
    expect(task).not.toBeNull();
    expect(task!.drive.id).toBe('todo-debt');
  });

  test('healthy drives produce no prompt block; disable works', async () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const x = 1;');
    const engine = new DrivesEngine(root);
    await engine.check({ only: 'todo-debt' });
    expect(engine.deviations()).toHaveLength(0);
    expect(engine.getPromptBlock()).toBe('');
    expect(engine.setEnabled('todo-debt', false)).toBe(true);
    expect(engine.list().find(d => d.id === 'todo-debt')!.enabled).toBe(false);
    expect(engine.setEnabled('nope', false)).toBe(false);
  });
});

describe('DrivesEngine persistence gate', () => {
  test('tree-hygiene alarms only after the breach persists ≥30 minutes', async () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, '.git')); // makes the drive applicable
    const now = Date.now();
    // Hand-craft state: a single fresh breach → WIP, no deviation.
    fs.mkdirSync(path.join(root, '.bimax'), { recursive: true });
    const write = (history: { at: string; ok: boolean }[]) => fs.writeFileSync(
      path.join(root, '.bimax', 'drives.json'),
      JSON.stringify({ version: 1, drives: { 'tree-hygiene': {
        lastOk: false, lastValue: '40 uncommitted paths', lastRun: new Date(now).toISOString(), history,
      } } }),
    );
    write([{ at: new Date(now).toISOString(), ok: false }]);
    let engine = new DrivesEngine(root);
    expect(engine.deviations().map(d => d.id)).not.toContain('tree-hygiene');
    // Two breaches 40 minutes apart with no green in between → persistent, alarms.
    write([
      { at: new Date(now - 40 * 60_000).toISOString(), ok: false },
      { at: new Date(now).toISOString(), ok: false },
    ]);
    engine = new DrivesEngine(root);
    expect(engine.deviations().map(d => d.id)).toContain('tree-hygiene');
    // A green measurement in between resets the breach run.
    write([
      { at: new Date(now - 40 * 60_000).toISOString(), ok: false },
      { at: new Date(now - 20 * 60_000).toISOString(), ok: true },
      { at: new Date(now).toISOString(), ok: false },
    ]);
    engine = new DrivesEngine(root);
    expect(engine.deviations().map(d => d.id)).not.toContain('tree-hygiene');
  });
});

describe('verify-coverage drive (ledger → drives integration)', () => {
  test('low verification coverage becomes a measurable deviation; small n stays quiet', async () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, '.bimax'), { recursive: true });
    // 5 resolved out of 25 total (20% coverage, n ≥ 20) → deviating.
    const buckets = Array.from({ length: 10 }, (_, i) => (i === 9 ? { n: 5, correct: 5 } : { n: 0, correct: 0 }));
    fs.writeFileSync(path.join(root, '.bimax', 'epistemic.json'),
      JSON.stringify({ version: 2, open: [], buckets, domains: {}, expired: 20, unattributed: 0 }));
    const engine = new DrivesEngine(root);
    await engine.check({ only: 'verify-coverage' });
    expect(engine.deviations().map(d => d.id)).toContain('verify-coverage');
    // Too little data → no judgment.
    fs.writeFileSync(path.join(root, '.bimax', 'epistemic.json'),
      JSON.stringify({ version: 2, open: [], buckets: buckets.map(() => ({ n: 0, correct: 0 })), domains: {}, expired: 5, unattributed: 0 }));
    const engine2 = new DrivesEngine(root);
    await engine2.check({ only: 'verify-coverage' });
    expect(engine2.deviations().map(d => d.id)).not.toContain('verify-coverage');
  });
});

describe('Edit Shield — multi-language gates', () => {
  const { shieldEdit } = require('../tools/syntax.check');
  const hasGofmt = (() => {
    try { require('child_process').execFileSync('which', ['gofmt'], { stdio: 'pipe' }); return true; } catch { return false; }
  })();

  (hasGofmt ? test : test.skip)('Go edits that break syntax are refused; clean Go passes', () => {
    const good = 'package main\n\nfunc main() {\n\tprintln("hi")\n}\n';
    const broken = 'package main\n\nfunc main() {\n\tprintln("hi")\n// missing brace\n';
    expect(shieldEdit('/tmp/x.go', good, broken)).toContain('INTRODUCE');
    expect(shieldEdit('/tmp/x.go', good, good.replace('hi', 'yo'))).toBeNull();
    // Already-broken files stay editable mid-repair (count-delta contract).
    expect(shieldEdit('/tmp/x.go', broken, broken.replace('hi', 'yo'))).toBeNull();
  });
});

// DreamEngine's suite was archived with it on 2026-09-19 (docs/product-reset/58). It asserted that
// a healthy repo journals a cycle and skips practice — a true statement about code that had never
// run outside this test: zero `dream_episode` rows in the event ledger, ever.
