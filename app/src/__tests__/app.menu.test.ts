import fs from 'fs';
import path from 'path';
import type { MenuItemConstructorOptions } from 'electron';
import { appMenuTemplate, type MenuCommand } from '../main/app.menu';

/**
 * Fix list item 19: Bimax shipped Electron's default menu bar, so nothing of Bimax was in it. The menu
 * now names the app's actions, and every one of them runs the same code the keyboard does.
 */

const read = (rel: string): string => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

function build(isMac = true, dev = false) {
  const sent: MenuCommand[] = [];
  let quick = 0;
  const template = appMenuTemplate({
    appName: 'Bimax', isMac, dev, send: (c) => sent.push(c), openQuickBar: () => { quick++; }, quickShortcut: '⌘2',
  });
  return { template, sent, quick: () => quick };
}

function items(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return template.flatMap((menu) => [menu, ...items((menu.submenu as MenuItemConstructorOptions[] | undefined) ?? [])]);
}

function click(item: MenuItemConstructorOptions): void {
  (item.click as unknown as () => void)();
}

test('the Mac menu set: the app menu, File, Edit, View, Window, Help', () => {
  const { template } = build();
  expect(template.map((menu) => menu.label ?? menu.role)).toEqual(['Bimax', 'File', 'Edit', 'View', 'windowMenu', 'help']);
  expect(build(false).template.map((menu) => menu.label ?? menu.role)).toEqual(['File', 'Edit', 'View', 'windowMenu', 'help']);
});

test('Edit carries the roles text fields need — without them ⌘C and ⌘V do nothing', () => {
  const edit = build().template.find((menu) => menu.label === 'Edit')!;
  const roles = (edit.submenu as MenuItemConstructorOptions[]).map((item) => item.role).filter(Boolean);
  for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']) expect(roles).toContain(role);
});

test('every command the menu sends is one the page runs, and the page owns its keys', () => {
  const { template, sent } = build();
  const app = read('renderer/src/App.tsx');
  const commands = items(template).filter((item) => item.click && item.label && !item.label.startsWith('New Task'));
  expect(commands.length).toBeGreaterThanOrEqual(8);
  for (const item of commands) {
    click(item);
    const command = sent[sent.length - 1];
    expect([item.label, app.includes(`case '${command}':`)]).toEqual([item.label, true]);
    // A key the page already handles is SHOWN, not registered — or the menu would take it from the page.
    if (item.accelerator && command !== 'settings') expect([item.label, item.registerAccelerator]).toEqual([item.label, false]);
  }
  // ⌘, is the one key the page does not handle, so the menu owns it.
  const settings = items(template).find((item) => item.label === 'Settings…')!;
  expect(settings.accelerator).toBe('CommandOrControl+,');
  expect(settings.registerAccelerator).toBeUndefined();
});

test('the keyboard map and the menu share one command table', () => {
  const app = read('renderer/src/App.tsx');
  expect(app).toContain('if (mod && KEYS[key]) { event.preventDefault(); runCommand(KEYS[key]); return; }');
  expect(app).toContain('window.bimax.onMenuCommand?.((command) => { runCommand(command); })');
});

test('the ⌘2 bar is in File, by its current shortcut, and opens the bar', () => {
  const { template, quick } = build();
  const entry = items(template).find((item) => item.label?.startsWith('New Task in a Folder'))!;
  expect(entry.label).toBe('New Task in a Folder (⌘2)');
  expect(entry.accelerator).toBeUndefined(); // global and user-chosen: never a menu accelerator
  click(entry);
  expect(quick()).toBe(1);
});

test('no Trust Center or Computer Use entry (the code-only product gate)', () => {
  const labels = items(build(true, true).template).map((item) => String(item.label ?? item.role ?? ''));
  for (const label of labels) expect(label).not.toMatch(/trust|computer|control mac|permission/i);
});

test('developer tools only in a development build', () => {
  const roles = (dev: boolean) => items(build(true, dev).template).map((item) => item.role);
  expect(roles(true)).toContain('toggleDevTools');
  expect(roles(false)).not.toContain('toggleDevTools');
});

test('main installs it at start-up and again when the ⌘2 shortcut changes', () => {
  const main = read('main/index.ts');
  expect(main.match(/installAppMenu\(\);/g)?.length).toBeGreaterThanOrEqual(2);
  expect(main).toContain('Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate({');
});

test('⌘W is Close Tab, which the page decides; ⇧⌘W always closes the window (fix list item 8)', () => {
  const { template, sent } = build();
  const all = items(template);
  const closeTab = all.find((item) => item.label === 'Close Tab')!;
  expect(closeTab.accelerator).toBe('CommandOrControl+W');
  expect(closeTab.registerAccelerator).toBe(false);
  click(closeTab);
  expect(sent[sent.length - 1]).toBe('close-tab');
  const closeWindow = all.find((item) => item.label === 'Close Window')!;
  expect([closeWindow.role, closeWindow.accelerator]).toEqual(['close', 'CommandOrControl+Shift+W']);
  // Nothing else may hold ⌘W, or it would take the key from the page.
  expect(all.filter((item) => item.accelerator === 'CommandOrControl+W')).toHaveLength(1);
});
