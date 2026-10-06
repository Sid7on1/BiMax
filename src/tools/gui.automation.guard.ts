/**
 * Computer Use is retired. Keep a narrow shell boundary so known GUI scripting cannot silently
 * replace the removed tools. This is a refusal, not a sandbox or a claim about arbitrary scripts.
 * Ordinary builds, file commands, URLs and launching a local build by path remain available.
 */
const COMMAND_START = String.raw`(?:^|[;&|]\s*|\n\s*|\$\(\s*|\`\s*)`;
const APPLESCRIPT_APP_CONTROL = new RegExp(
  `${COMMAND_START}(?:sudo\\s+)?osascript\\b[\\s\\S]*?(?:tell\\s+application|tell\\s+app\\b|System\\s+Events)`, 'i');
const OPEN_APPLICATION = new RegExp(
  `${COMMAND_START}(?:sudo\\s+)?open\\s+(?:-[a-zA-Z]*\\s+)*-[a-zA-Z]*[ab]\\b`, 'i');
const SYNTHETIC_INPUT = new RegExp(`${COMMAND_START}(?:sudo\\s+)?cliclick\\b`, 'i');

export interface GuiAutomationVerdict {
  refused: boolean;
  reason?: string;
}

export function guiAutomationRefusal(command: string): GuiAutomationVerdict {
  const text = String(command || '');
  const matched = APPLESCRIPT_APP_CONTROL.test(text) ? 'AppleScript application control'
    : OPEN_APPLICATION.test(text) ? 'launching an application by name or bundle id'
      : SYNTHETIC_INPUT.test(text) ? 'synthetic keyboard/mouse input' : null;
  return matched ? {
    refused: true,
    reason: `Computer Use has been removed from Bimax. This command performs ${matched}; run coding commands without controlling other apps.`,
  } : { refused: false };
}
