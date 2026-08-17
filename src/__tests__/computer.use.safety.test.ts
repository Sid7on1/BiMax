import '../cli/commands/computer';
import { globalCommandRegistry } from '../cli/commands/registry';
import { Governor, isSensitiveComputerTarget } from '../governor/governor';
import { GovernorVetoError } from '../core/errors';
import { EventBus } from '../core/event.bus';
import { GlobalPrompter } from '../cli/prompter';
import { buildTool } from '../tools/tool.factory';
import { createBrowserTool } from '../tools/implementations/browser.tool';
import { BrowserRuntimePort } from '../browser/browser.runtime';
import { getTaintTracker } from '../mind/taint';
import { IGovernor } from '../core/interfaces';

jest.mock('../cli/prompter', () => ({
  GlobalPrompter: {
    ask: jest.fn().mockResolvedValue('Yes'),
    isBusy: jest.fn().mockReturnValue(false),
    register: jest.fn(),
  },
}));

const ask = GlobalPrompter.ask as jest.Mock;

function freshGovernor(): Governor {
  return new Governor(new EventBus());
}

describe('computer-use safety ladder', () => {
  beforeEach(() => {
    ask.mockClear();
    ask.mockResolvedValue('Yes');
  });

  describe('sensitive-target hard deny', () => {
    it('recognizes credential managers, system security surfaces, and wallets', () => {
      expect(isSensitiveComputerTarget('1Password')).toBe(true);
      expect(isSensitiveComputerTarget('Keychain Access')).toBe(true);
      expect(isSensitiveComputerTarget('System Settings')).toBe(true);
      expect(isSensitiveComputerTarget('Ledger Live')).toBe(true);
      expect(isSensitiveComputerTarget('my.wallet.example')).toBe(true);
      expect(isSensitiveComputerTarget('Safari')).toBe(false);
      expect(isSensitiveComputerTarget('github.com')).toBe(false);
      expect(isSensitiveComputerTarget('')).toBe(false);
    });

    it('denies sensitive apps before any prompt', async () => {
      const governor = freshGovernor();
      await expect(governor.approveTaskExecution('COMPUTER_CONTROL', {
        tool: 'mcp__open-computer-use__click', action: 'click', app: 'Bitwarden', isDestructive: true,
      })).rejects.toThrow(GovernorVetoError);
      expect(ask).not.toHaveBeenCalled();
    });

    it('survives bypass mode — the floor cannot be waived', async () => {
      const governor = freshGovernor();
      governor.mode = 'bypass';
      await expect(governor.approveTaskExecution('COMPUTER_CONTROL', {
        tool: 'mcp__open-computer-use__type', action: 'type', app: 'Keychain Access', isDestructive: true,
      })).rejects.toThrow(/sensitive/i);
    });

    it('survives a persistent allow rule', async () => {
      const governor = freshGovernor();
      governor.addRule({ tool: 'COMPUTER_CONTROL', effect: 'allow', persistent: true });
      await expect(governor.approveTaskExecution('COMPUTER_CONTROL', {
        tool: 'BrowserTool', action: 'type', host: 'wallet.example.com', isDestructive: true,
      })).rejects.toThrow(/sensitive/i);
    });
  });

  describe('session-scoped grants', () => {
    it('offers a domain-scoped grant instead of a blanket "Always Allow This Tool"', async () => {
      const governor = freshGovernor();
      await governor.approveTaskExecution('COMPUTER_CONTROL', {
        tool: 'BrowserTool', action: 'click', host: 'github.com', isDestructive: true,
      });
      const options: string[] = ask.mock.calls[0][1];
      expect(options).toContain('Allow domain github.com for this session');
      expect(options).not.toContain('Always Allow This Tool');
    });

    it('a grant covers later routine actions on the same domain only', async () => {
      const governor = freshGovernor();
      ask.mockImplementation(async (_q: string, options: string[]) =>
        options.find(o => o.startsWith('Allow domain github.com')) || 'Yes');
      await governor.approveTaskExecution('COMPUTER_CONTROL', {
        tool: 'BrowserTool', action: 'click', host: 'github.com', isDestructive: true,
      });
      expect(governor.computerGrants()).toEqual(['domain:github.com']);

      ask.mockClear();
      await governor.approveTaskExecution('COMPUTER_CONTROL', {
        tool: 'BrowserTool', action: 'type', host: 'github.com', isDestructive: true,
      });
      expect(ask).not.toHaveBeenCalled(); // covered by the grant

      await governor.approveTaskExecution('COMPUTER_CONTROL', {
        tool: 'BrowserTool', action: 'click', host: 'evil.example', isDestructive: true,
      });
      expect(ask).toHaveBeenCalledTimes(1); // different domain still asks
    });

    it('revokeComputerGrants clears standing grants and reports the count', async () => {
      const governor = freshGovernor();
      ask.mockImplementation(async (_q: string, options: string[]) =>
        options.find(o => o.startsWith('Allow ')) || 'Yes');
      await governor.approveTaskExecution('COMPUTER_CONTROL', {
        tool: 'BrowserTool', action: 'click', host: 'github.com', isDestructive: true,
      });
      expect(governor.revokeComputerGrants()).toBe(1);
      expect(governor.computerGrants()).toEqual([]);
    });
  });

  describe('high-impact actions', () => {
    it('always prompt with plain Yes/No — no grant option, no blanket allow', async () => {
      const governor = freshGovernor();
      ask.mockImplementation(async (_q: string, options: string[]) =>
        options.find(o => o.startsWith('Allow ')) || 'Yes');
      // Establish a grant for the domain first…
      await governor.approveTaskExecution('COMPUTER_CONTROL', {
        tool: 'BrowserTool', action: 'click', host: 'github.com', isDestructive: true,
      });
      ask.mockClear();
      ask.mockResolvedValue('Yes');
      // …the high-impact upload on the SAME domain must still face the human.
      await governor.approveTaskExecution('COMPUTER_CONTROL', {
        tool: 'BrowserTool', action: 'upload', host: 'github.com', highImpact: true, isDestructive: true,
      });
      expect(ask).toHaveBeenCalledTimes(1);
      expect(ask.mock.calls[0][0]).toContain('HIGH-IMPACT');
      expect(ask.mock.calls[0][1]).toEqual(['Yes', 'No']);
    });

    it('a persistent allow rule does not waive a high-impact action', async () => {
      const governor = freshGovernor();
      governor.addRule({ tool: 'COMPUTER_CONTROL', effect: 'allow', persistent: true });
      await governor.approveTaskExecution('COMPUTER_CONTROL', {
        tool: 'BrowserTool', action: 'upload', host: 'github.com', highImpact: true, isDestructive: true,
      });
      expect(ask).toHaveBeenCalledTimes(1);
    });
  });

  describe('tool factory routing for the desktop companion', () => {
    // The mcp__open-computer-use__* routing test was removed with the Phase 4 extraction (the
    // legacy CU MCP server no longer exists); the routing it pinned lives in the Desktop's
    // bimax-mac provider now. Generic MCP routing is still pinned below.

    it('leaves other MCP tools as generic TOOL_EXECUTION', async () => {
      const seen: string[] = [];
      const governor = {
        approveTaskExecution: jest.fn(async (taskType: string) => { seen.push(taskType); }),
      } as unknown as IGovernor;
      const tool = buildTool({
        name: 'mcp__github__create_issue',
        description: 'test double', schema: { type: 'object', properties: {} },
        isDestructive: true,
        execute: async () => 'ok',
      }, governor);
      await tool.execute({}, { cwd: process.cwd() });
      expect(seen).toEqual(['TOOL_EXECUTION']);
    });
  });

  describe('BrowserTool approval payload and taint', () => {
    const runtime = (url: string | null): BrowserRuntimePort => ({
      close: jest.fn().mockResolvedValue(undefined),
      currentUrl: () => url,
      run: jest.fn().mockImplementation(async (command: any) => ({
        ok: true, action: command.action, url: url || undefined, summary: 'ok',
        consoleErrors: [], failedRequests: [], attempts: 1, durationMs: 1,
      })),
    });

    it('marks uploads high-impact in the approval payload (browser approvals ride TOOL_EXECUTION since the CU extraction)', async () => {
      const approvals: any[] = [];
      const governor = {
        approveTaskExecution: jest.fn(async (t: string, p: any) => { approvals.push({ t, p }); }),
      } as unknown as IGovernor;
      const tool = createBrowserTool(governor, runtime('https://Example.COM/settings'));
      await tool.execute({ action: 'click', elementIndex: 1 }, { cwd: process.cwd() });
      await tool.execute({ action: 'upload', selector: 'input', path: 'a.txt' }, { cwd: process.cwd() });
      // Since the Phase 4 extraction the browser gate is TOOL_EXECUTION with impact metadata
      // (host scoping lives in the Desktop's bimax-mac provider for mac_control). The
      // safety-meaningful invariant survives: an upload is marked high-impact, a click is not.
      const gate = approvals.filter(a => a.t === 'TOOL_EXECUTION');
      expect(gate.length).toBeGreaterThanOrEqual(2);
      expect(gate[0].p.highImpact).toBeUndefined();
      expect(gate[gate.length - 1].p.highImpact).toBe(true);
    });

    it('marks the session tainted after page observations, naming the page', async () => {
      const governor = { approveTaskExecution: jest.fn().mockResolvedValue(undefined) } as unknown as IGovernor;
      const tracker = getTaintTracker();
      tracker.clear('test-reset');
      const tool = createBrowserTool(governor, runtime('https://payload.example/page'));
      await tool.execute({ action: 'snapshot' }, { cwd: process.cwd() });
      expect(tracker.isTainted()).toBe(true);
      expect(tracker.latest()?.source).toBe('web');
      expect(tracker.latest()?.detail).toContain('payload.example');
      tracker.clear('test-reset');
    });

    it('does not taint on pure lifecycle actions (status/close)', async () => {
      const governor = { approveTaskExecution: jest.fn().mockResolvedValue(undefined) } as unknown as IGovernor;
      const tracker = getTaintTracker();
      tracker.clear('test-reset');
      const tool = createBrowserTool(governor, runtime(null));
      await tool.execute({ action: 'status' }, { cwd: process.cwd() });
      await tool.execute({ action: 'close' }, { cwd: process.cwd() });
      expect(tracker.isTainted()).toBe(false);
    });
  });

  describe('/computer status hub', () => {
    const command = () => (globalCommandRegistry as any).commands.get('/computer');

    function ctx(governor?: any) {
      return {
        cwd: process.cwd(),
        options: {
          model: 'stepfun-ai/step-3.7-flash',
          governor,
          llmAdapter: { activeCapabilities: jest.fn().mockResolvedValue({ visionInput: false }) },
        },
        addSystemMessage: jest.fn(),
        executeCommand: jest.fn().mockResolvedValue(undefined),
      } as any;
    }

    it('renders live capability + safety rows without inventing permission state', async () => {
      getTaintTracker().clear('test-reset');
      const governor = freshGovernor();
      const res = await command().execute([], ctx(governor));
      expect(res.type).toBe('menu');
      const labels = res.options.map((o: any) => o.label).join('\n');
      expect(labels).toContain('Browser automation');
      expect(labels).toContain('Desktop control');
      expect(labels).toContain('Session grants (none)');
      expect(labels).toContain('Context taint: clean');
      // No fabricated macOS permission claims: the only permission text is the honest instruction.
      const descs = res.options.map((o: any) => o.desc).join('\n');
      expect(descs).not.toMatch(/accessibility: (granted|enabled|ok)/i);
    });

    it('revoke-grants reports the real count through the governor', async () => {
      const governor = freshGovernor();
      ask.mockImplementation(async (_q: string, options: string[]) =>
        options.find((o: string) => o.startsWith('Allow ')) || 'Yes');
      await governor.approveTaskExecution('COMPUTER_CONTROL', {
        tool: 'BrowserTool', action: 'click', host: 'github.com', isDestructive: true,
      });
      const c = ctx(governor);
      const res = await command().execute(['revoke-grants'], c);
      expect(res.type).toBe('none');
      expect(c.addSystemMessage).toHaveBeenCalledWith('success', expect.stringContaining('Revoked 1'));
      expect(governor.computerGrants()).toEqual([]);
    });
  });
});
