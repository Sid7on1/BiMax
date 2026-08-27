import { describe, expect, test } from '@jest/globals';
import {
  buildComputerUseExecutionPrompt,
  COMPUTER_USE_EXECUTION_MARKER,
  visibleComputerUsePrompt,
} from '../../renderer/src/computer.use.prompt';

describe('app-owned Control Mac execution prompt', () => {
  test('keeps one-action native execution and end-state proof in the model context', () => {
    const prompt = buildComputerUseExecutionPrompt('Open Calculator and compute 2+2');
    expect(prompt).toContain('mcp__bimax-mac__mac_control');
    expect(prompt).toContain('exactly one mac_control action');
    expect(prompt).toContain('newest native result proves');
    expect(prompt).toContain('Do not give instructions to the user');
  });

  test('removes the private contract from live and restored transcript text', () => {
    const user = 'Open Calculator and compute 2+2';
    const engine = buildComputerUseExecutionPrompt(user);
    expect(engine).toContain(COMPUTER_USE_EXECUTION_MARKER);
    expect(visibleComputerUsePrompt(engine)).toBe(user);
    expect(visibleComputerUsePrompt(user)).toBe(user);
  });

  test('names only packaged native actions and makes a repeated blocker terminal', () => {
    const prompt = buildComputerUseExecutionPrompt('Open Messages');
    expect(prompt).toContain('open, focus, observe, screenshot, click, type, set_value');
    expect(prompt).toContain('Never invent another tool name or action');
    expect(prompt).toContain('Never repeat open/focus/observe after the same blocker');
    expect(prompt).toContain('key/press/hotkey and guessed coordinates are unavailable');
    expect(prompt).not.toContain('use key/type');
  });
});
