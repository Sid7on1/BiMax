import { guiAutomationRefusal } from '../tools/gui.automation.guard';
import { createBashTool } from '../tools/implementations/bash.tool';
import { exec, execFile } from 'child_process';

// Fault injection must never execute the GUI command when the very guard under test is disabled.
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  exec: jest.fn((_command, _options, callback) => callback(null, { stdout: '', stderr: '' })),
  execFile: jest.fn((_binary, _argv, _options, callback) => callback(null, { stdout: '', stderr: '' })),
}));

describe('app-owned Computer Use has no coding shell fallback', () => {
  test.each([
    `osascript -e 'tell application "Music" to play'`,
    `open -a Music && osascript -e 'tell application "System Events" to keystroke "k"'`,
    'open -g -a Music', 'open -ga WhatsApp', 'open -b com.apple.Music',
    'cliclick c:50,50', 'sudo cliclick t:hello',
    `echo ready; osascript -e 'tell app "Messages" to activate'`,
    'arc-cua', 'bimax-cu --identity', 'sudo /tmp/bimax-cu',
    'env TEST=1 /tmp/arc-cua', '"/Applications/Bimax.app/Contents/Resources/cu-runtime/bimax-cu/bimax-cu"',
    "'/tmp/bimax-cu'", 'echo ready; /tmp/arc-cua',
  ])('refuses %s without advertising a removed capability', command => {
    const result = guiAutomationRefusal(command);
    expect(result.refused).toBe(true);
    expect(result.reason).toContain('unavailable through the coding shell');
    expect(result.reason).not.toMatch(/LookAtAppTool|PressInAppTool|TypeInAppTool|ScrollInAppTool|mac_control/);
  });

  test.each(['npm test', 'git status', 'rm -rf dist', 'ls -la /Applications',
    'osascript -e "return 2 + 2"', 'open https://example.com', 'open build/Fixture.app',
    'rg "open -a" src/', 'echo "cliclick c:50,50"',
    'rg "bimax-cu" app/', 'echo arc-cua', 'cat /tmp/bimax-cu',
  ])('keeps ordinary coding command %s', command => {
    expect(guiAutomationRefusal(command)).toEqual({ refused: false });
  });

  test.each([`osascript -e 'tell application "Music" to play'`, '/tmp/bimax-cu'])('a real shell tool refuses %s before approval and execution', async command => {
    const governor = { approveTaskExecution: jest.fn() } as any;
    const tool = createBashTool(governor) as any;
    await expect(tool.execute({ command }, { cwd: process.cwd() }))
      .rejects.toThrow('GUI control is unavailable through the coding shell');
    expect(governor.approveTaskExecution).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });
});
