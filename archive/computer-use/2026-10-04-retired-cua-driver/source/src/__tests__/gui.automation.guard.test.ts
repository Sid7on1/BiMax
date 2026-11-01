import { guiAutomationRefusal } from '../tools/gui.automation.guard';

const CAP = 'mcp__bimax-mac__mac_control';

/**
 * Measured 2026-08-18. "play Heaven's Eyes on Spotify" was submitted in the coding lane; the intent
 * heuristic did not recognise it, BashTool stayed on the wire, and the model drove the Mac with
 * `osascript -e 'tell application "Spotify" to play ...'`, `open -a Spotify`, and System Events
 * keystrokes — passing no governor approval, no recipient receipt, no takeover interlock and no
 * stop-before-effect. Two independent defences, because intent detection can always miss a phrasing.
 */
describe('shell is not a Computer Use channel', () => {
  it('refuses the exact commands from the live run', () => {
    for (const command of [
      `osascript -e 'tell application "Spotify" to play track "Heaven'\\''s Eyes"'`,
      `open -a Spotify && sleep 2 && osascript -e 'tell application "System Events" to keystroke "k"'`,
      `osascript -e 'tell application "Spotify" to activate'`,
    ]) {
      const verdict = guiAutomationRefusal(command, CAP);
      expect(verdict.refused).toBe(true);
      expect(verdict.reason).toContain(CAP);
    }
  });

  it('leaves ordinary shell work alone', () => {
    for (const command of [
      'npm test', 'git status', 'rm -rf dist', 'ls -la /Applications',
      'osascript -e "return 2 + 2"',            // computes a value, addresses no application
      'open https://example.com',               // a URL, not -a/-b
      'grep -rn "open -a" src/',                // discussing it is not doing it
    ]) {
      expect(guiAutomationRefusal(command, CAP).refused).toBe(false);
    }
  });

  it('record 65 stage 6: with PressInAppTool, the live command is refused and the model is pointed at the use tools', () => {
    // Measured 2026-10-02 in the installed app: the model said "we are in a terminal environment" and ran this.
    const live = `open -a Music && osascript -e 'tell application "Music" to play (first track whose name is "Espresso" and artist is "Sabrina Carpenter")'`;
    const verdict = guiAutomationRefusal(live, 'PressInAppTool');
    expect(verdict.refused).toBe(true);
    expect(verdict.reason).toContain('LookAtAppTool');
    expect(verdict.reason).toContain('TypeInAppTool');
    expect(verdict.reason).toContain('open -g -a');
    expect(guiAutomationRefusal(`osascript -e 'tell application "Messages" to send "hi" to buddy "Mom"'`, 'PressInAppTool').refused).toBe(true);
    expect(guiAutomationRefusal('open -a Music', 'PressInAppTool').refused).toBe(true);
  });

  it('with PressInAppTool, starting an app in the background is let through — and only that', () => {
    for (const command of ['open -g -a Music', 'open -ga WhatsApp', 'open -g -b com.apple.Music', 'open -g -a "Music" && echo started']) {
      expect(guiAutomationRefusal(command, 'PressInAppTool').refused).toBe(false);
    }
    for (const command of ['open -g -a Music && open -a WhatsApp', `open -g -a Music; osascript -e 'tell application "Music" to play'`]) {
      expect(guiAutomationRefusal(command, 'PressInAppTool').refused).toBe(true);
    }
    // The archived capability keeps its stricter rule.
    expect(guiAutomationRefusal('open -g -a Music', CAP).refused).toBe(true);
  });

  it.each([
    ['open -a Music', "open -g -a 'Music'"],
    ['open -a "Example Player"', "open -g -a 'Example Player'"],
    ["open -a 'Musique'", "open -g -a 'Musique'"],
    ['open -b com.example.player', "open -g -b 'com.example.player'"],
  ])('refuses %s with a copyable background launch, without executing it', (command, expected) => {
    const verdict = guiAutomationRefusal(command, 'PressInAppTool');
    expect(verdict.refused).toBe(true);
    expect(verdict.reason).toContain('Nothing was launched');
    const line = verdict.reason!.split('\n').find((s) => s.startsWith('BashTool '))!;
    const retry = JSON.parse(line.slice('BashTool '.length));
    expect(retry).toEqual({ command: expected, timeout: 10000 });
    expect(guiAutomationRefusal(retry.command, 'PressInAppTool').refused).toBe(false);
    expect(verdict.reason).toContain('usual shell approval and sandbox');
    expect(verdict.reason).toContain('list_apps again');
  });

  it.each([
    'open -a Music && echo extra', 'open -a Music --args --play', 'sudo open -a Music',
    'open -a "$(touch /tmp/injected)"', 'open -a "Music`date`"', 'open -a "$APP"',
    'open -a Music\necho extra', 'open -a "Music; echo extra"', "open -a \"User's Player\"",
  ])('does not construct a replay from shell syntax or extra authority: %s', command => {
    const verdict = guiAutomationRefusal(command, 'PressInAppTool');
    expect(verdict.refused).toBe(true);
    expect(verdict.reason).not.toContain('\nBashTool {');
  });

  it('stays inert when the build has no desktop capability to redirect to', () => {
    const command = `osascript -e 'tell application "Spotify" to play'`;
    expect(guiAutomationRefusal(command, undefined).refused).toBe(false);
    expect(guiAutomationRefusal(command, '').refused).toBe(false);
  });
});

describe('BashTool hands the guard the capability this task really has (record 65 stage 6)', () => {
  // The defect measured 2026-10-02: the guard was right, but BashTool named only the archived tools, so with PressInAppTool
  // registered it passed no capability and the guard stayed inert.
  const { createBashTool } = require('../tools/implementations/bash.tool') as typeof import('../tools/implementations/bash.tool');
  const governor = { approveTaskExecution: jest.fn().mockResolvedValue(undefined) } as any;
  const live = `open -a Music && osascript -e 'tell application "Music" to play (first track whose name is "Espresso")'`;

  it('with PressInAppTool registered, the live command is blocked before the governor or the shell', async () => {
    const tool = createBashTool(governor, () => ['BashTool', 'LookAtAppTool', 'PressInAppTool', 'TypeInAppTool']) as any;
    await expect(tool.execute({ command: live }, { cwd: process.cwd() })).rejects.toThrow(/Command blocked: .*LookAtAppTool/);
    expect(governor.approveTaskExecution).not.toHaveBeenCalled();
  });

  it('looking only (no PressInAppTool): nothing to redirect to, so the guard stays out of the way', async () => {
    const tool = createBashTool(governor, () => ['BashTool', 'LookAtAppTool']) as any;
    const verdictOnly = guiAutomationRefusal(live, undefined);
    expect(verdictOnly.refused).toBe(false);
    void tool;
  });
});
