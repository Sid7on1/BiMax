/**
 * Shell is not a Computer Use channel.
 *
 * Measured 2026-08-18: "play Heaven's Eyes on Spotify" was submitted in the coding lane, where the
 * prompt heuristic did not recognise it as desktop control, so BashTool stayed on the wire and the
 * model drove the Mac with `osascript -e 'tell application "Spotify" to play ...'`, `open -a
 * Spotify`, and System Events keystrokes. It reached the user's machine having passed NONE of the
 * Computer Use gates: no governor approval for a Mac action, no recipient receipt, no takeover
 * interlock, no stop-before-effect, and no evidence in the Mac panel.
 *
 * Intent detection can always miss a phrasing, and each miss silently reopened that path. This
 * guard closes it from the other end: when the product actually owns a desktop-control capability,
 * GUI automation through the shell is refused and the model is pointed at that capability. A missed
 * request then fails loudly with the right instruction instead of quietly scripting the machine.
 *
 * Deliberately narrow. It matches only the three shapes that ARE GUI automation, so ordinary shell
 * work — builds, git, package managers, file operations, and even `osascript` that computes a value
 * without addressing an application — is untouched.
 */

/**
 * A command must be RUN to be dangerous. Anchoring each pattern to a command position — start of
 * input, or just after a separator — keeps the guard from refusing a command that merely CONTAINS
 * the text, such as `grep -rn "open -a" src/`, which is reading source, not driving a Mac.
 */
const COMMAND_START = String.raw`(?:^|[;&|]\s*|\n\s*|\$\(\s*|\`\s*)`;

/** `osascript` that addresses an application or drives System Events. */
const APPLESCRIPT_APP_CONTROL = new RegExp(
  `${COMMAND_START}(?:sudo\\s+)?osascript\\b[\\s\\S]*?(?:tell\\s+application|tell\\s+app\\b|System\\s+Events)`, 'i');

/** `open -a <App>` / `open -b <bundle id>` — launching or fronting an application. */
const OPEN_APPLICATION = new RegExp(
  `${COMMAND_START}(?:sudo\\s+)?open\\s+(?:-[a-zA-Z]*\\s+)*-(?:a|b)\\b`, 'i');

/** Synthetic input drivers that reach the window server. */
const SYNTHETIC_INPUT = new RegExp(`${COMMAND_START}(?:sudo\\s+)?cliclick\\b`, 'i');

export interface GuiAutomationVerdict {
  refused: boolean;
  reason?: string;
}

/**
 * Should this shell command be refused as GUI automation?
 *
 * `capabilityToolName` is the desktop-control tool the caller actually has. When there is none —
 * a plain CLI checkout with no computer capability — nothing is refused, because there would be no
 * supported way to do the work and a refusal would only remove an ability without replacing it.
 */
export function guiAutomationRefusal(
  command: string,
  capabilityToolName: string | undefined | null,
): GuiAutomationVerdict {
  if (!capabilityToolName) return { refused: false };
  const text = String(command || '');
  if (!text.trim()) return { refused: false };

  const matched = APPLESCRIPT_APP_CONTROL.test(text) ? 'AppleScript application control'
    : OPEN_APPLICATION.test(text) ? 'launching an application with open -a/-b'
      : SYNTHETIC_INPUT.test(text) ? 'synthetic keyboard/mouse input'
        : null;
  if (!matched) return { refused: false };

  return {
    refused: true,
    reason: `this command performs GUI automation (${matched}), which must go through `
      + `${capabilityToolName} instead of the shell. The shell path bypasses approval, the recipient `
      + `receipt, the user-takeover interlock and stop-before-effect, so a Mac action taken this way `
      + `is invisible to the user and unverifiable. Call ${capabilityToolName} with the equivalent `
      + `action (open / click / type / key) and read its returned frame. If you genuinely need the `
      + `shell for something that is not desktop control, run that part without addressing an `
      + `application.`,
  };
}
