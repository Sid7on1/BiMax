import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Governor } from '../governor/governor';
import { EventBus } from '../core/event.bus';
import { GlobalPrompter } from '../engine/prompter';
import { requireNetworkConsent, resetNetworkConsent } from '../security/network.consent';
import { resetSovereignMode, setSovereignMode } from '../security/sovereign';

let root: string, oldRoot: string | undefined;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'bimax-admission-'));
  oldRoot = process.env.BIMAX_THREAD_ROOT;
  delete process.env.BIMAX_THREAD_ROOT;
  resetNetworkConsent();
  resetSovereignMode();
});
afterEach(async () => {
  jest.restoreAllMocks();
  resetNetworkConsent();
  resetSovereignMode();
  if (oldRoot === undefined) delete process.env.BIMAX_THREAD_ROOT;
  else process.env.BIMAX_THREAD_ROOT = oldRoot;
  await fs.rm(root, { recursive: true, force: true });
});
test('F03 remembered grant binds the concrete MCP server/tool, preserves A and refuses B', async () => {
  const ask = jest.spyOn(GlobalPrompter, 'ask').mockResolvedValueOnce('Always Allow This Tool').mockResolvedValue('No');
  const g = new Governor(new EventBus());
  const a = { tool: 'mcp__one__read', isDestructive: true };
  await g.approveTaskExecution('TOOL_EXECUTION', a);
  await g.approveTaskExecution('TOOL_EXECUTION', a);
  await expect(g.approveTaskExecution('TOOL_EXECUTION', { ...a, tool: 'mcp__two__read' })).rejects.toThrow();
  expect(ask).toHaveBeenCalledTimes(2);
});
test('F03 legacy unscoped allows fail closed and explicit deny wins over an earlier allow', async () => {
  const ask = jest.spyOn(GlobalPrompter, 'ask').mockResolvedValue('No');
  const g = new Governor(new EventBus());
  g.addRule({ tool: 'TOOL_EXECUTION', effect: 'allow', persistent: true });
  await expect(
    g.approveTaskExecution('TOOL_EXECUTION', { tool: 'mcp__a__mutate', isDestructive: true }),
  ).rejects.toThrow();
  g.addRule({ tool: 'TOOL_EXECUTION', subject: 'mcp__a__mutate', effect: 'allow', persistent: true });
  g.addRule({ tool: 'TOOL_EXECUTION', effect: 'deny', persistent: true });
  await expect(
    g.approveTaskExecution('TOOL_EXECUTION', { tool: 'mcp__a__mutate', isDestructive: true }),
  ).rejects.toThrow('explicitly denied');
  expect(ask).toHaveBeenCalledTimes(1);
});
test.each([false, true])('F07 first-host consent asks and caches a denial with Thread scope=%s', async (scoped) => {
  if (scoped) process.env.BIMAX_THREAD_ROOT = root;
  const ask = jest.spyOn(GlobalPrompter, 'ask').mockResolvedValue('No');
  const g = new Governor(new EventBus());
  const request = { target: 'https://consent-fixture.invalid/', tool: 'WebFetchTool', purpose: 'fixture' };
  expect(await requireNetworkConsent(g, request)).toMatch(/Refused/);
  expect(await requireNetworkConsent(g, request)).toMatch(/Refused/);
  expect(ask).toHaveBeenCalledTimes(1);
});
test('F07 granted host is reused, foreign host asks, unattended cannot mint a grant, sovereign policy wins', async () => {
  const ask = jest.spyOn(GlobalPrompter, 'ask').mockResolvedValue('Yes');
  const g = new Governor(new EventBus()),
    request = { target: 'https://one.invalid/', tool: 'WebFetchTool', purpose: 'fixture' };
  expect(await requireNetworkConsent(g, request)).toBeNull();
  expect(await requireNetworkConsent(g, request)).toBeNull();
  expect(await requireNetworkConsent(g, { ...request, target: 'https://two.invalid/' })).toBeNull();
  expect(ask).toHaveBeenCalledTimes(2);
  g.mode = 'unattended';
  expect(await requireNetworkConsent(g, { ...request, target: 'https://three.invalid/' })).toMatch(/Refused/);
  g.mode = 'bypass';
  setSovereignMode(true);
  expect(await requireNetworkConsent(g, { ...request, target: 'https://four.invalid/' })).toMatch(/Refused/);
  expect(ask).toHaveBeenCalledTimes(2);
});
