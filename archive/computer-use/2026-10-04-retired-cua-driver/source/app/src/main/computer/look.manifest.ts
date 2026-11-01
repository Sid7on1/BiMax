/**
 * The Cua Driver capability manifests Bimax writes for Computer Use: look (record 65, stage 2) and use (stage 6, §6h).
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
 * Record 65 stage 6 (§6h), using an app: the input tools a use session may call, and nothing else. `click` performs an
 * AX action (press, or a text box's confirm — its Return) on the element token of a snapshot taken in the same session:
 * no pointer, no focus change, no coordinates; `set_value` writes one text box's value or picks one pop-up item the same
 * way; `scroll` turns the wheel over one element by its token, in the background. Ability 4 (an app brought forward for
 * one step, on the person's card each time): `type_text` types into one box by its token and `press_key` sends Return —
 * the only key look.driver.ts ever names — both only with delivery_mode foreground, which puts the previous front app
 * back. Every other input tool stays denied by name — shortcuts, dragging, coordinates, launching or keeping an app in
 * front.
 */
export const USE_TOOLS = ['click', 'set_value', 'scroll', 'type_text', 'press_key'] as const;

/**
 * Controls a press never targets even though they publish a press: those that open a menu (in the background a native
 * menu can take over the screen; picking from one is its own ability, later) and text boxes (typed into, not pressed).
 */
export const PRESS_EXCLUDED_ROLES: ReadonlySet<string> = new Set([
  // Not AXMenuButton: its press is its own action and its menu is AXShowMenu (measured: Music lists each song as one, and
  // its press plays the song).
  'AXWindow', 'AXMenuBar', 'AXMenuBarItem', 'AXPopUpButton', 'AXComboBox',
  'AXTextField', 'AXTextArea', 'AXSecureTextField', 'AXSearchField',
]);

/** Pop-up buttons, whose items a task picks without opening the menu (the driver's set_value presses the item). */
export const PICK_ROLES: ReadonlySet<string> = new Set(['AXPopUpButton']);

/** The boxes a task may type into. Never a password field: AXSecureTextField is not here and never will be. */
export const TYPE_ROLES: ReadonlySet<string> = new Set(['AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField']);

/**
 * Apps never looked at or used, by name, whatever the person answers (beside {@link NEVER_LOOK}'s bundle ids):
 * password managers, wallets and banking apps. The same families as the engine governor's sensitive-target floor, which
 * still runs first.
 */
const NEVER_USE_NAMES: RegExp[] = [
  /keychain|passwords?\b|1password|lastpass|bitwarden|dashlane|keepass|keeper|enpass|proton pass/i,
  /\bwallet\b|metamask|ledger|trezor|exodus|coinbase|binance|kraken|crypto/i,
  /\bbank|banking|paypal|venmo|zelle|cash app|revolut|robinhood|\bwise\b|schwab|fidelity|vanguard/i,
  /system settings|system preferences/i,
];

export function isNeverUsed(name: string): boolean {
  return NEVER_USE_NAMES.some((pattern) => pattern.test(name));
}

/** One use session: the look tools plus {@link USE_TOOLS}, for one app, short-lived. */
export function useManifest(bundleId: string, minutes = 5, idleMinutes = 2): string {
  if (!validBundleId(bundleId) || NEVER_LOOK.has(bundleId)) throw new Error(`not an app a task may use: ${JSON.stringify(bundleId)}`);
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
    `  tools: [${[...LOOK_TOOLS, ...USE_TOOLS].join(', ')}]`,
    'deny:',
    `  tools: [${INPUT_TOOLS.filter((tool) => !(USE_TOOLS as readonly string[]).includes(tool)).join(', ')}]`,
    '',
  ].join('\n');
}

/**
 * The runtime's own manifest, for calls made outside any grant: it may list the running apps (so the user can be
 * asked about the right one) and nothing else. The driver refuses a runtime manifest without both limits (measured:
 * "legacy capability manifests require expires_after and idle_timeout"); look.driver.ts starts a fresh runtime when
 * they run out.
 */
export const RUNTIME_HOURS = 12;
export const RUNTIME_IDLE_MINUTES = 30;

export function runtimeManifest(): string {
  return [
    'version: 2',
    'mode: bounded',
    `expires_after: ${RUNTIME_HOURS}h`,
    `idle_timeout: ${RUNTIME_IDLE_MINUTES}m`,
    // Listing apps is a "desktop display observation" to the driver (measured: refused as outside the manifest without
    // this). The only tool allowed here is list_apps, so the grant reaches no screenshot and no window.
    'resources:',
    '  desktop:',
    '    display: true',
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
