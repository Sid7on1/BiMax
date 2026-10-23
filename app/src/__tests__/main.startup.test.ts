import * as fs from 'fs';
import * as path from 'path';

/**
 * main/index.ts's start-up runs inside `app.whenReady().then(async () => …)`. With no `.catch()`, a throw there left
 * the app in the menu bar with no window and no reason (flaw list E40). The file cannot be loaded outside Electron,
 * so this reads it: the start-up promise must end in a catch that shows the error and writes it down.
 */
test('start-up failures are caught, shown and logged', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main', 'index.ts'), 'utf8');
  const start = main.indexOf('app.whenReady().then(async () => {');
  expect(start).toBeGreaterThan(-1);
  const end = main.indexOf('\n}).catch((error: unknown) => {', start);
  expect(end).toBeGreaterThan(start);
  // Nothing between the start and that catch closes the promise chain first.
  expect(main.slice(start, end)).not.toMatch(/\n\}\);/);
  const handler = main.slice(end, main.indexOf('\n});', end + 5));
  expect(handler).toContain('dialog.showErrorBox(');
  expect(handler).toContain('startup-error.log');
});
