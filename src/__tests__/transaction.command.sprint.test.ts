import fs = require('fs/promises');
import * as os from 'os';
import * as path from 'path';
import { TransactionManager } from '../core/transaction.manager';
import { Command, CommandContext, globalCommandRegistry } from '../engine/commands/registry';
import { globalTransactionManager } from '../core/transaction.manager';
import '../engine/commands/tx';

jest.mock('../engine/commands/registry', () => ({ globalCommandRegistry: { register: jest.fn() } }));
jest.mock('../core/transaction.manager', () => {
  const actual = jest.requireActual('../core/transaction.manager');
  return { ...actual, globalTransactionManager: new actual.TransactionManager({ maxTotalSnapshotBytes: 4 }) };
});

const command: Command = (globalCommandRegistry.register as jest.Mock).mock.calls[0][0];
const execute = (verb: string) => command.execute(verb.split(' '), {} as CommandContext);

describe('/tx command — coverage and honest lifecycle receipts', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bimax-tx-command-')); });
  afterEach(async () => {
    jest.restoreAllMocks();
    globalTransactionManager.commit();
    for (const pending of globalTransactionManager.pendingRecoveries()) {
      for (const file of pending.paths) {
        if (path.basename(file) === 'TWO') await fs.rm(file, { force: true });
        else await fs.writeFile(file, 'old!');
      }
    }
    await globalTransactionManager.recover();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('shows actual coverage and the shared byte budget, including unprotected paths', async () => {
    expect(await execute('begin')).toMatchObject({ level: 'success' });
    const first = path.join(dir, 'first');
    const second = path.join(dir, 'second');
    await fs.writeFile(first, 'old!');
    await fs.writeFile(second, 'old!');
    await globalTransactionManager.trackEdit(first, 'new');
    await globalTransactionManager.trackEdit(second, 'new');
    const status = await execute('status');
    expect(status).toMatchObject({ level: 'error' });
    expect((status as any).content).toContain('1 protected, 1 unprotected');
    expect((status as any).content).toContain('4 / 4 bytes');
    expect(await execute('commit')).toMatchObject({ level: 'success' });
    expect(await execute('commit')).toMatchObject({ level: 'error' });
    expect(await execute('rollback')).toMatchObject({ level: 'error' });
  });

  it('reports pending snapshot refusals as errors and leaves the transaction open', async () => {
    await execute('begin');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const capture = (globalTransactionManager as any).capture.bind(globalTransactionManager);
    jest.spyOn(globalTransactionManager as any, 'capture').mockImplementation(async (...args: any[]) => {
      await gate;
      return capture(...args);
    });
    const track = globalTransactionManager.trackEdit(path.join(dir, 'new'), 'new');
    const commit = await execute('commit');
    const rollback = await execute('rollback');
    release();
    await track;
    expect(commit).toMatchObject({ level: 'error' });
    expect(rollback).toMatchObject({ level: 'error' });
    expect(globalTransactionManager.isOpen()).toBe(true);
    expect(await execute('commit')).toMatchObject({ level: 'success' });
  });

  it('shows all retained transactions and refuses beginning or recovering during restoration', async () => {
    for (const id of ['ONE', 'TWO']) {
      const file = path.join(dir, id);
      if (id === 'ONE') await fs.writeFile(file, 'old!');
      globalTransactionManager.begin(id);
      await globalTransactionManager.trackEdit(file, 'new');
      await fs.writeFile(file, 'human');
      await globalTransactionManager.rollbackDetailed();
    }
    const status = await execute('status');
    expect((status as any).content).toContain('Transaction ONE');
    expect((status as any).content).toContain('Transaction TWO');
    expect((status as any).content).toContain('4 / 4 bytes');
    const tx: TransactionManager = globalTransactionManager;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const capture = (tx as any).capture.bind(tx);
    jest.spyOn(tx as any, 'capture').mockImplementation(async (...args: any[]) => {
      await gate;
      return capture(...args);
    });
    const recovery = execute('recover');
    const during = await execute('status');
    const begin = await execute('begin');
    const duplicate = await execute('recover');
    release();
    const result = await recovery;
    expect((during as any).content).toContain('Restoration is in progress');
    expect(begin).toMatchObject({ level: 'error' });
    expect(duplicate).toMatchObject({ level: 'error' });
    expect(result).toMatchObject({ level: 'error' });
  });
});
