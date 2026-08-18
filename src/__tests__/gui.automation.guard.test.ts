import { guiAutomationRefusal } from '../tools/gui.automation.guard';
import { explicitlyRequiresComputerUse } from '../cli/personas/base.persona';

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

  it('stays inert when the build has no desktop capability to redirect to', () => {
    const command = `osascript -e 'tell application "Spotify" to play'`;
    expect(guiAutomationRefusal(command, undefined).refused).toBe(false);
    expect(guiAutomationRefusal(command, '').refused).toBe(false);
  });
});

describe('desktop intent covers apps the surface list never named', () => {
  it('routes media control to Computer Use', () => {
    for (const prompt of [
      "play Heaven's Eyes on Spotify", 'play some music', 'pause the music',
      'increase the volume', 'skip to the next track', 'mute it',
    ]) expect(explicitlyRequiresComputerUse(prompt)).toBe(true);
  });

  it('still leaves software work in the coding lane', () => {
    for (const prompt of [
      'add a pause button to the UI component',
      'refactor the audio player module',
      'write a track parser for the album metadata',
      'run the playbook tests',
      'fix the Messages permission tests',
      'implement shuffle support',
    ]) expect(explicitlyRequiresComputerUse(prompt)).toBe(false);
  });
});
