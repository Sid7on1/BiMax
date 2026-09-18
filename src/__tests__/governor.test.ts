import { Governor } from '../governor/governor';
import { GovernorVetoError } from '../core/errors';
import { EventBus } from '../core/event.bus';
import { GlobalPrompter } from '../engine/prompter';
import { engineEvents } from '../engine/events';
import * as path from 'path';
import * as fs from 'fs/promises';

jest.mock('../engine/prompter', () => ({
  GlobalPrompter: {
    ask: jest.fn().mockResolvedValue('y'),
    isBusy: jest.fn().mockReturnValue(false),
    register: jest.fn(),
  }
}));

describe('Governor', () => {
  let governor: Governor;

  beforeEach(async () => {
    await fs.rm(path.join(process.cwd(), '.breakglass/credits'), { recursive: true, force: true }).catch(() => undefined);
    const eventBus = new EventBus();
    governor = new Governor(eventBus);
  });

  describe('FileSystemVeto', () => {
    it('allows valid paths', async () => {
      const validPath = path.join(process.cwd(), 'valid.txt');
      await expect(governor.approveTaskExecution('FILE_WRITE', { targetPath: validPath })).resolves.toBeUndefined();
    });

    it('blocks outside workspace', async () => {
      const invalidPath = '/etc/passwd';
      await expect(governor.approveTaskExecution('FILE_WRITE', { targetPath: invalidPath }))
        .rejects.toThrow(GovernorVetoError);
    });

    it('blocks forbidden extensions', async () => {
      const invalidPath = path.join(process.cwd(), 'secret.pem');
      await expect(governor.approveTaskExecution('FILE_WRITE', { targetPath: invalidPath }))
        .rejects.toThrow(GovernorVetoError);
    });

    it('blocks sibling directories that share the workspace prefix', async () => {
      // e.g. workspace is /work and the target is /work-evil/x.txt — must be rejected
      const siblingPath = process.cwd() + '-evil' + path.sep + 'x.txt';
      await expect(governor.approveTaskExecution('FILE_WRITE', { targetPath: siblingPath }))
        .rejects.toThrow(GovernorVetoError);
    });
  });

  describe('BudgetVeto', () => {
    it('allows within budget', async () => {
      await expect(governor.approveTaskExecution('API_CALL', { estimatedCost: 1.0 })).resolves.toBeUndefined();
    });

    it('blocks over budget', async () => {
      await governor.budget.recordSpend(4.5);
      await expect(governor.approveTaskExecution('API_CALL', { estimatedCost: 1.0 }))
        .rejects.toThrow(GovernorVetoError);
    });

    // The cap used to be silent until it fired, so the first signal a user got was a veto mid-task
    // — observed stopping a real run at 15/16 completed steps, which reads as a crash rather than a
    // budget decision. Warn while there is still budget left to act on.
    it('warns once as the cap approaches, while there is still budget to act on', async () => {
      const seen: string[] = [];
      const onStatus = (m: string) => seen.push(m);
      engineEvents.on('status', onStatus);
      try {
        await governor.budget.recordSpend(3.0);   // 60% — too early to warn
        expect(seen.filter(m => /Daily budget/.test(m))).toHaveLength(0);

        await governor.budget.recordSpend(1.2);   // 84% — warn, with budget still remaining
        const warnings = seen.filter(m => /Daily budget/.test(m));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(/84% used/);
        expect(warnings[0]).toMatch(/\$0\.80 left/);
        expect(warnings[0]).toMatch(/MAX_DAILY_SPEND/);

        await governor.budget.recordSpend(0.2);   // still under the cap — must not nag
        expect(seen.filter(m => /Daily budget/.test(m))).toHaveLength(1);
      } finally {
        engineEvents.off('status', onStatus);
      }
    });

    it('stays quiet when the governor is disabled — nothing will be blocked', async () => {
      const seen: string[] = [];
      const onStatus = (m: string) => seen.push(m);
      engineEvents.on('status', onStatus);
      governor.budget.enabled = false;
      try {
        await governor.budget.recordSpend(4.9);
        expect(seen.filter(m => /Daily budget/.test(m))).toHaveLength(0);
      } finally {
        governor.budget.enabled = true;
        engineEvents.off('status', onStatus);
      }
    });
  });

  describe('external tool control', () => {
    it('asks for destructive generic tools', async () => {
      await governor.approveTaskExecution('TOOL_EXECUTION', { tool: 'BrowserTool', action: 'click', isDestructive: true });
      await governor.approveTaskExecution('TOOL_EXECUTION', { tool: 'mcp__desktop__click', isDestructive: true });
      expect(GlobalPrompter.ask).toHaveBeenCalledWith(expect.stringContaining('BrowserTool'), expect.any(Array));
      expect(GlobalPrompter.ask).toHaveBeenCalledWith(expect.stringContaining('mcp__desktop__click'), expect.any(Array));
    });

    it('blocks destructive external tools in plan mode', async () => {
      governor.mode = 'plan';
      await expect(governor.approveTaskExecution('TOOL_EXECUTION', {
        tool: 'BrowserTool', action: 'click', isDestructive: true,
      })).rejects.toThrow(GovernorVetoError);
    });
  });
});
