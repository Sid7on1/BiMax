export interface MacCapabilityConfig {
  computerPip: boolean;
  computerVisible: boolean;
  computerRecord: boolean;
  computerApprovals: 'always' | 'high-impact-only';
}

function enabled(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return !/^(0|false|off|no)$/i.test(value);
}

/** Provider configuration is injected by Electron main, never by model arguments. */
export async function loadMacCapabilityConfig(): Promise<MacCapabilityConfig> {
  return {
    // The exact-window ScreenCaptureKit preview is the operator's live view while Bimax keeps the
    // controlled app in the background. It is a non-activating presentation surface and never a
    // coordinate/input surface. The Electron-owned environment can still disable it explicitly.
    // Jest constructs real runtime instances and some legacy tests clear provider environment in
    // cleanup while cosmetic syncs are still settling. Never launch an AppKit/ScreenCaptureKit
    // process from that unit harness; packaged/ordinary processes still default the preview on.
    computerPip: enabled('BIMAX_COMPUTER_PIP', process.env.NODE_ENV !== 'test'),
    // The packaged app must not yank the user away from Claude/ChatGPT/another foreground app.
    // Foreground remains an explicit internal/test policy, never the model-facing default.
    computerVisible: enabled('BIMAX_COMPUTER_VISIBLE', false),
    computerRecord: enabled('BIMAX_COMPUTER_RECORD', false),
    computerApprovals: process.env.BIMAX_COMPUTER_APPROVALS === 'high-impact-only'
      ? 'high-impact-only' : 'always',
  };
}

export const loadConfig = loadMacCapabilityConfig;
export function __resetConfigForTests(): void { /* environment-backed: no cache */ }
