/**
 * The Cua Driver capability manifests Bimax writes for Computer Use, look only (record 65, stage 2).
 *
 * The driver runs in `bounded` mode and enforces these itself, so even a bug in Bimax's own checks cannot make it
 * click: a look grant allows observing one app's windows and names every input tool as denied. Version 2 is the first
 * that may name an application (measured: version 1 is refused with "application identity resources require
 * capability manifest version 2 or later").
 */

/** What a look grant may do: see which apps and windows exist, and read one window's accessibility tree. */
export const LOOK_TOOLS = ['list_apps', 'list_windows', 'get_window_state', 'get_screen_size'] as const;

/**
 * Every tool that changes something, named so the manifest DENIES it rather than merely not allowing it — a denial
 * survives a later driver release that widens the default. Kept in step with `cua-driver list-tools` (0.31.0).
 */
export const INPUT_TOOLS = [
  'click', 'double_click', 'right_click', 'drag', 'scroll', 'move_cursor',
  'type_text', 'set_value', 'press_key', 'hotkey', 'invoke_menu',
  'bring_to_front', 'launch_app', 'kill_app', 'set_window_frame',
  'clipboard_read', 'clipboard_write',
  'browser_click', 'browser_type', 'browser_navigate', 'browser_pointer', 'browser_dialog', 'browser_download',
  'browser_set_input_files', 'browser_prepare', 'page',
  'replay_trajectory', 'start_recording', 'set_config', 'install_extension', 'install_ffmpeg',
] as const;

/** A bundle id as macOS spells them. Anything else is refused before it can reach a YAML document. */
export function validBundleId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9.-]{0,199}$/.test(id);
}

/** One app, look only, for at most `minutes`, ended sooner after `idleMinutes` without a look. */
export function lookManifest(bundleId: string, minutes = 30, idleMinutes = 10): string {
  if (!validBundleId(bundleId)) throw new Error(`not a bundle id: ${JSON.stringify(bundleId)}`);
  return [
    'version: 2',
    'mode: bounded',
    `expires_after: ${Math.max(1, Math.round(minutes))}m`,
    `idle_timeout: ${Math.max(1, Math.round(idleMinutes))}m`,
    'resources:',
    '  apps:',
    `    - bundle_id: ${bundleId}`,
    '      windows: all',
    'allow:',
    `  tools: [${LOOK_TOOLS.join(', ')}]`,
    'deny:',
    `  tools: [${INPUT_TOOLS.join(', ')}]`,
    '',
  ].join('\n');
}

/**
 * The runtime's own manifest, for calls made outside any grant: it may list the running apps (so the user can be
 * asked about the right one) and nothing else.
 */
export function runtimeManifest(): string {
  return [
    'version: 2',
    'mode: bounded',
    'resources: {}',
    'allow:',
    '  tools: [list_apps]',
    'deny:',
    `  tools: [${INPUT_TOOLS.join(', ')}]`,
    '',
  ].join('\n');
}

/**
 * Apps a task never looks at, whatever the user answers: Bimax itself (its own window holds approval cards and keys),
 * and the places macOS asks for a password or shows saved ones.
 */
export const NEVER_LOOK = new Set([
  'ai.bimax.app',
  'com.github.Electron',
  'com.apple.SecurityAgent',
  'com.apple.loginwindow',
  'com.apple.keychainaccess',
  'com.apple.Passwords',
  'com.apple.systempreferences',
]);
