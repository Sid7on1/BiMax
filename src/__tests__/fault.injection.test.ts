import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// §12: the fault-injection harness exercises real recovery paths and provably does not leak into
// production behaviour (disarmed = no-op). Sites: ledger.append, ledger.rewrite, config.write,
// shell.spawn.

describe('fault injection harness', () => {
  let dir: string;

  beforeEach(() => {
    jest.resetModules();
    delete process.env.BIMAX_FAULT;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-fault-'));
  });
  afterEach(() => {
    delete process.env.BIMAX_FAULT;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function faultMod() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('../core/fault.injection') as typeof import('../core/fault.injection');
  }

  test('disarmed (production): every fault point is a no-op', () => {
    const { faultPoint } = faultMod();
    expect(() => faultPoint('ledger.append')).not.toThrow();
    expect(() => faultPoint('config.write')).not.toThrow();
    process.env.BIMAX_FAULT = '';
    expect(() => faultPoint('shell.spawn')).not.toThrow();
  });

  test('count semantics: site:N fires the first N hits then passes', () => {
    process.env.BIMAX_FAULT = 'ledger.append:2';
    const { faultPoint } = faultMod();
    expect(() => faultPoint('ledger.append')).toThrow('injected fault');
    expect(() => faultPoint('ledger.append')).toThrow('injected fault');
    expect(() => faultPoint('ledger.append')).not.toThrow();
    // Unarmed sites are untouched even while another site is armed.
    expect(() => faultPoint('config.write')).not.toThrow();
  });

  test('ledger.append fault: task execution continues, journal degrades gracefully', () => {
    process.env.BIMAX_FAULT = 'ledger.append:1';
    const { ExecutionLedger } = require('../core/execution.ledger') as typeof import('../core/execution.ledger');
    const ledger = new ExecutionLedger(dir);
    // First append eats the injected EIO — the ledger is an observer, callers never crash.
    expect(() => ledger.append({ taskId: 'a', type: 'created', title: 'a' })).not.toThrow();
    // Second append (fault exhausted) lands normally.
    ledger.append({ taskId: 'b', type: 'created', title: 'b', command: 'ls', cwd: '/tmp' });
    const ids = ledger.readAll().map(r => r.taskId);
    expect(ids).toEqual(['b']);
  });

  test('ledger.rewrite fault: compaction failure leaves the journal valid and complete', () => {
    const { ExecutionLedger } = require('../core/execution.ledger') as typeof import('../core/execution.ledger');
    const ledger = new ExecutionLedger(dir);
    ledger.append({ taskId: 'x', type: 'created', title: 'x', command: 'ls', cwd: '/tmp' });
    ledger.append({ taskId: 'x', type: 'transition', state: 'completed' });
    process.env.BIMAX_FAULT = 'ledger.rewrite';
    expect(() => ledger.clearCompleted()).not.toThrow();
    delete process.env.BIMAX_FAULT;
    // The rewrite failed mid-cleanup — but the ORIGINAL journal survived intact (atomicity).
    expect(ledger.readAll()).toHaveLength(2);
    expect(fs.readdirSync(dir).filter(f => f.includes('.tmp-'))).toHaveLength(0);
  });

  test('shell.spawn fault: the task lands failed-resumable with its command recorded', () => {
    process.env.BIMAX_EXECUTION_DIR = dir;
    try {
      const { __resetExecutionLedgerForTests } = require('../core/execution.ledger') as typeof import('../core/execution.ledger');
      const { __resetTaskRegistryForTests } = require('../core/task.registry') as typeof import('../core/task.registry');
      __resetExecutionLedgerForTests(dir);
      const reg = __resetTaskRegistryForTests();
      process.env.BIMAX_FAULT = 'shell.spawn:1';
      const { startShellTask } = require('../core/shell.tasks') as typeof import('../core/shell.tasks');
      const { task, summary } = startShellTask('echo hello', { cwd: dir });
      expect(task.state).toBe('failed-resumable');
      expect(task.command).toBe('echo hello');
      expect(summary).toContain('failed to start');
      expect(summary).toContain('/tasks retry');
      // The registry holds the failure honestly; nothing is wedged in a live state.
      expect(reg.live()).toHaveLength(0);
    } finally {
      delete process.env.BIMAX_EXECUTION_DIR;
    }
  });

  test('config.write fault: save rejects, the on-disk config survives untouched, no tmp litter', async () => {
    process.env.BIMAX_BREAKGLASS_DIR = dir;
    try {
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ model: 'before' }), 'utf-8');
      const cfg = require('../engine/config') as typeof import('../engine/config');
      cfg.__resetConfigForTests?.();
      await cfg.loadConfig();
      process.env.BIMAX_FAULT = 'config.write';
      await expect(cfg.saveConfig({ model: 'after' } as any)).rejects.toThrow('injected fault');
      delete process.env.BIMAX_FAULT;
      const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'));
      expect(onDisk.model).toBe('before');
      expect(fs.readdirSync(dir).filter(f => f.includes('.tmp-'))).toHaveLength(0);
    } finally {
      delete process.env.BIMAX_BREAKGLASS_DIR;
    }
  });
});
