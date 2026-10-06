import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IGovernor } from '../core/interfaces';
import { OutcomeManager, __setOutcomeManager } from '../outcome/outcome.manager';
import { createOutcomeTool } from '../tools/implementations/outcome.tool';

const governor = { approveTaskExecution: jest.fn().mockResolvedValue(undefined) } as unknown as IGovernor;

describe('OutcomeTool', () => {
  let dir: string;
  let manager: OutcomeManager;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-outcome-tool-'));
    manager = new OutcomeManager({ sessionId: () => 'tool-session', directory: () => dir });
    manager.syncSession();
    __setOutcomeManager(manager);
  });

  afterEach(() => {
    manager.shutdown();
    __setOutcomeManager(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses verified finish until real evidence satisfies the contract', async () => {
    const tool = createOutcomeTool(governor);
    const defined = await tool.execute({
      action: 'define', objective: 'Deliver a tested change',
      criteria: [{ id: 'tests', description: 'The targeted tests pass', verification: 'build_test', files: ['targeted.test.ts'] }],
    });
    expect(defined).toMatch(/Completion gate: CLOSED/);

    const rejected = await tool.execute({ action: 'finish', finish_status: 'verified' });
    expect(rejected).toMatch(/Completion rejected by the engine/);
    expect(rejected).toMatch(/Criterion not passed/);

    const claimed = await tool.execute({
      action: 'record_evidence', evidence_kind: 'test', evidence_summary: 'jest targeted suite passed',
      evidence_source: 'npx jest targeted.test.ts', evidence_ok: true, criterion_ids: ['tests'],
    });
    expect(claimed).toMatch(/Completion gate: CLOSED/);
    manager.onBuildEvidence({ command: 'npx jest targeted.test.ts', ok: true, coveredFiles: ['targeted.test.ts'] });
    expect(manager.snapshot()?.canComplete).toBe(true);
    const finished = await tool.execute({ action: 'finish', finish_status: 'verified' });
    expect(finished).toMatch(/Phase: verified/);
  });
});
