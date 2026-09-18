import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  findCriticalSymbol,
  checkBlastRadius,
  setBlastGateEnabled,
  registerBlastConfirmer,
  registerBlastGraphStore,
} from '../engine/blastGate';
import { GraphStore } from '../graph/graph.store';
import { GraphNode } from '../graph/models';
import { createEditFileTool } from '../tools/implementations/edit.tool';
import { IGovernor } from '../core/interfaces';

const governor = { approveTaskExecution: jest.fn().mockResolvedValue(undefined) } as unknown as IGovernor;

function storeWith(nodes: Partial<GraphNode>[]): GraphStore {
  const store = new GraphStore(':memory:');
  for (const n of nodes) {
    store.addNode({ id: n.id!, name: n.name!, type: n.type || 'FUNCTION', ...n } as GraphNode);
  }
  return store;
}

// Reset the module singletons between tests (they are process-global by design).
afterEach(() => {
  setBlastGateEnabled(false);
  registerBlastConfirmer(null);
  registerBlastGraphStore(null);
});

describe('findCriticalSymbol (G5, pure)', () => {
  it('finds a CRITICAL symbol whose relative path is a suffix of the absolute path', () => {
    const store = storeWith([
      { id: 'func:src/pay.ts:handlePayment', name: 'handlePayment', filePath: 'src/pay.ts', criticality: 'CRITICAL' },
    ]);
    const hit = findCriticalSymbol(store, '/home/u/proj/src/pay.ts');
    expect(hit?.name).toBe('handlePayment');
  });

  it('prefers CRITICAL over HIGH in the same file', () => {
    const store = storeWith([
      { id: 'a', name: 'lo', filePath: 'src/x.ts', criticality: 'HIGH' },
      { id: 'b', name: 'hi', filePath: 'src/x.ts', criticality: 'CRITICAL' },
    ]);
    expect(findCriticalSymbol(store, '/p/src/x.ts')?.name).toBe('hi');
  });

  it('returns null when the file owns no HIGH/CRITICAL symbol', () => {
    const store = storeWith([
      { id: 'a', name: 'meh', filePath: 'src/x.ts', criticality: 'LOW' },
    ]);
    expect(findCriticalSymbol(store, '/p/src/x.ts')).toBeNull();
  });
});

describe('checkBlastRadius (G5, mode behavior)', () => {
  const store = storeWith([
    { id: 'func:src/pay.ts:handlePayment', name: 'handlePayment', filePath: 'src/pay.ts', criticality: 'CRITICAL' },
  ]);

  it('auto-allows when the gate is OFF (default / print / sub-agent)', async () => {
    const confirmer = jest.fn().mockResolvedValue(false);
    registerBlastGraphStore(store);
    registerBlastConfirmer(confirmer);
    setBlastGateEnabled(false);
    expect(await checkBlastRadius('/p/src/pay.ts')).toBe(true);
    expect(confirmer).not.toHaveBeenCalled();
  });

  it('auto-allows when no confirmer is registered (worker / print mode)', async () => {
    registerBlastGraphStore(store);
    registerBlastConfirmer(null);
    setBlastGateEnabled(true);
    expect(await checkBlastRadius('/p/src/pay.ts')).toBe(true);
  });

  it('prompts and honours a decline when ON and interactive', async () => {
    const confirmer = jest.fn().mockResolvedValue(false);
    registerBlastGraphStore(store);
    registerBlastConfirmer(confirmer);
    setBlastGateEnabled(true);
    expect(await checkBlastRadius('/p/src/pay.ts')).toBe(false);
    expect(confirmer).toHaveBeenCalledTimes(1);
  });

  it('does not prompt for a file with no gated symbol', async () => {
    const confirmer = jest.fn().mockResolvedValue(false);
    registerBlastGraphStore(store);
    registerBlastConfirmer(confirmer);
    setBlastGateEnabled(true);
    expect(await checkBlastRadius('/p/src/unrelated.ts')).toBe(true);
    expect(confirmer).not.toHaveBeenCalled();
  });
});

describe('EditFileTool × blast gate (G5, integration)', () => {
  let dir: string;
  let file: string;
  let store: GraphStore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgw-blast-'));
    file = path.join(dir, 'pay.ts');
    fs.writeFileSync(file, 'const fee = 1;\n');
    store = storeWith([
      { id: 'func:pay.ts:handlePayment', name: 'handlePayment', filePath: 'pay.ts', criticality: 'CRITICAL' },
    ]);
    registerBlastGraphStore(store);
    setBlastGateEnabled(true);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('blocks the write when the gate is declined', async () => {
    registerBlastConfirmer(async () => false);
    const tool = createEditFileTool(governor);
    const res = await tool.execute({ path: file, oldString: 'const fee = 1;', newString: 'const fee = 2;' }, { cwd: dir });
    expect(res).toMatch(/blast-radius gate/);
    expect(fs.readFileSync(file, 'utf8')).toBe('const fee = 1;\n'); // untouched
  });

  it('applies the write when the gate is accepted', async () => {
    registerBlastConfirmer(async () => true);
    const tool = createEditFileTool(governor);
    const res = await tool.execute({ path: file, oldString: 'const fee = 1;', newString: 'const fee = 2;' }, { cwd: dir });
    expect(res).toMatch(/Edited/);
    expect(fs.readFileSync(file, 'utf8')).toBe('const fee = 2;\n');
  });
});
