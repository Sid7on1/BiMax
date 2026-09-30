import fs from 'node:fs';
import path from 'node:path';
import { PALETTE_COMMANDS, paletteEntries, firstPaletteSelection, movePaletteSelection } from '../renderer/src/palette.model';
const active = { busy: true, editor: true, files: true };

test('20–30 distinct frequent outcomes, each wired into the same dispatcher as menu and shortcuts', () => {
  expect(PALETTE_COMMANDS.length).toBeGreaterThanOrEqual(20);
  expect(PALETTE_COMMANDS.length).toBeLessThanOrEqual(30);
  expect(new Set(PALETTE_COMMANDS.map(entry => entry.id)).size).toBe(PALETTE_COMMANDS.length);
  const app = fs.readFileSync(path.resolve(__dirname, '../renderer/src/App.tsx'), 'utf8');
  for (const { id } of PALETTE_COMMANDS) expect(app).toContain(`case '${id}':`);
  expect(app).toContain('onCommand={runCommand}');
});
test('file commands and Stop stay discoverable but do not execute when there is no target', () => {
  const entries = paletteEntries('', { busy: false, editor: false, files: false });
  expect(entries.filter(entry => entry.disabled).map(entry => entry.id)).toEqual(['stop-task', 'find-file', 'close-file', 'next-file', 'previous-file']);
  expect(paletteEntries('', active).every(entry => !entry.disabled)).toBe(true);
});
test('a search finds an outcome or its group, without a hidden fallback when empty', () => {
  expect(paletteEntries('  REPLACE ', active).map(entry => entry.id)).toEqual(['find-file']);
  expect(paletteEntries('appearance', active).map(entry => entry.id)).toEqual(['moonlight', 'starlight', 'appearance-auto']);
  expect(paletteEntries('no such command', active)).toEqual([]);
  expect(firstPaletteSelection([])).toBe(0);
  expect(movePaletteSelection([], 0, 1)).toBe(0);
  expect(movePaletteSelection([], 0, -1)).toBe(0);
});
test('keyboard navigation skips unavailable rows in both directions and clamps at each end', () => {
  const entries = paletteEntries('', { busy: false, editor: false, files: false });
  const stop = entries.findIndex(entry => entry.id === 'stop-task');
  expect(movePaletteSelection(entries, stop - 1, 1)).toBe(stop + 1);
  expect(movePaletteSelection(entries, stop + 1, -1)).toBe(stop - 1);
  const editor = paletteEntries('Editor', { busy: false, editor: false, files: false });
  expect(firstPaletteSelection(editor)).toBe(0);
  expect(movePaletteSelection(editor, 0, 1)).toBe(0);
  expect(movePaletteSelection(entries, 0, -1)).toBe(0);
  expect(movePaletteSelection(entries, entries.length - 1, 1)).toBe(entries.length - 1);
});
