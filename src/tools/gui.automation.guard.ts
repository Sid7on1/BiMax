/**
 * Native Computer Use belongs to the Mac app. Keep a narrow shell boundary so known GUI scripting
 * cannot bypass its session and approval policy. This is not a sandbox for arbitrary scripts.
 * Ordinary builds, file commands, URLs and launching a local build by path remain available.
 */
const COMMAND_START = String.raw`(?:^|[;&|]\s*|\n\s*|\$\(\s*|\`\s*)`;
const APPLESCRIPT_APP_CONTROL = new RegExp(
  `${COMMAND_START}(?:sudo\\s+)?osascript\\b[\\s\\S]*?(?:tell\\s+application|tell\\s+app\\b|System\\s+Events)`, 'i');
const OPEN_APPLICATION = new RegExp(
  `${COMMAND_START}(?:sudo\\s+)?open\\s+(?:-[a-zA-Z]*\\s+)*-[a-zA-Z]*[ab]\\b`, 'i');
const SYNTHETIC_INPUT = new RegExp(`${COMMAND_START}(?:sudo\\s+)?cliclick\\b`, 'i');
const NATIVE_CU_BINARY = new RegExp(
  `${COMMAND_START}(?:sudo\\s+)?(?:env\\s+(?:[A-Za-z_]\\w*=[^\\s]+\\s+)*)?["']?(?:[^\\s"']*/)?(?:arc-cua|bimax-cu)["']?(?=\\s|$|[;&|])`, 'i');

export interface GuiAutomationVerdict {
  refused: boolean;
  reason?: string;
}

export function guiAutomationRefusal(command: string): GuiAutomationVerdict {
  const text = String(command || '');
  const matched = APPLESCRIPT_APP_CONTROL.test(text) ? 'AppleScript application control'
    : OPEN_APPLICATION.test(text) ? 'launching an application by name or bundle id'
      : SYNTHETIC_INPUT.test(text) ? 'synthetic keyboard/mouse input'
        : NATIVE_CU_BINARY.test(text) ? 'direct native Computer Use driver execution' : null;
  return matched ? {
    refused: true,
    reason: `GUI control is unavailable through the coding shell. This command performs ${matched}; use the app-owned capability when available.`,
  } : { refused: false };
}
