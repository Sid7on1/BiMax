import type { MenuItemConstructorOptions } from 'electron';

/**
 * The menu bar (fix list item 19).
 *
 * Bimax shipped Electron's bare default menu, so someone looking in the menu bar for how to open a
 * project, or what ⌘B does, found nothing of Bimax in it. This is the Mac-standard set — the app menu,
 * File, Edit, View, Window, Help — naming the actions the app already has.
 *
 * Most of these keys are already handled by the page (App.tsx's keyboard map). Those items show their
 * shortcut with `registerAccelerator: false`: the menu teaches the key without taking it, so the page
 * keeps one handler per key and a menu click sends the same command the key runs. Settings (⌘,) is the
 * one the page does not handle, so the menu owns it.
 *
 * No Trust Center: that was the Computer Use permission journey, and the code-only product gate forbids
 * any frontend exposing it (docs/product-reset/08_ACCEPTANCE_GATES.md).
 */
export type MenuCommand =
  | 'new-thread' | 'open-project' | 'toggle-sidebar' | 'toggle-panel' | 'command-palette'
  | 'terminal' | 'settings' | 'app-health' | 'close-tab';

export interface AppMenuOptions {
  appName: string;
  isMac: boolean;
  /** Development builds get Reload and the developer tools under View. */
  dev: boolean;
  /** Run a command in the main window's page (App.tsx `onMenuCommand`). */
  send: (command: MenuCommand) => void;
  /** Open the ⌘2 bar. Its shortcut is global and user-chosen, so it is not a menu accelerator. */
  openQuickBar: () => void;
  /** The ⌘2 bar's shortcut as shown to people, e.g. "⌘2". */
  quickShortcut: string;
}

export function appMenuTemplate(options: AppMenuOptions): MenuItemConstructorOptions[] {
  const { appName, isMac, dev, send, openQuickBar, quickShortcut } = options;
  // The page owns the key; the menu shows it and sends the same command on a click.
  const shown = (label: string, accelerator: string, command: MenuCommand): MenuItemConstructorOptions =>
    ({ label, accelerator, registerAccelerator: false, click: () => send(command) });

  const appMenu: MenuItemConstructorOptions = {
    label: appName,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      { label: 'Settings…', accelerator: 'CommandOrControl+,', click: () => send('settings') },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  };

  const file: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      shown('New Thread', 'CommandOrControl+N', 'new-thread'),
      { label: `New Task in a Folder (${quickShortcut})`, click: openQuickBar },
      { type: 'separator' },
      shown('Open Project…', 'CommandOrControl+O', 'open-project'),
      { type: 'separator' },
      // ⌘W closes the file tab in front of you once there are tabs (fix list item 8), and the window
      // when there is none — the page decides, since only it knows. ⇧⌘W always closes the window,
      // as in Safari and Chrome.
      shown('Close Tab', 'CommandOrControl+W', 'close-tab'),
      { role: 'close', label: 'Close Window', accelerator: 'CommandOrControl+Shift+W' },
      ...(isMac ? [] : [{ role: 'quit' } as MenuItemConstructorOptions]),
    ],
  };

  // Edit is not decoration on a Mac: without these roles, ⌘C / ⌘V / ⌘Z do nothing in text fields.
  const edit: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'pasteAndMatchStyle' },
      { role: 'delete' },
      { role: 'selectAll' },
    ],
  };

  const view: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      shown('Command Palette…', 'CommandOrControl+K', 'command-palette'),
      { type: 'separator' },
      shown('Show or Hide Sidebar', 'CommandOrControl+B', 'toggle-sidebar'),
      shown('Show or Hide Right Panel', 'CommandOrControl+J', 'toggle-panel'),
      shown('Terminal', 'CommandOrControl+T', 'terminal'),
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      ...(dev ? [{ type: 'separator' } as MenuItemConstructorOptions, { role: 'reload' } as MenuItemConstructorOptions, { role: 'toggleDevTools' } as MenuItemConstructorOptions] : []),
    ],
  };

  const help: MenuItemConstructorOptions = {
    role: 'help',
    submenu: [
      { label: 'App Health & Diagnostics', click: () => send('app-health') },
    ],
  };

  return [
    ...(isMac ? [appMenu] : []),
    file,
    edit,
    view,
    { role: 'windowMenu' },
    help,
  ];
}
