import fs from 'node:fs';
import path from 'node:path';
import { importsOf, resolve, sourceFiles } from '../../../src/__tests__/support/import.graph';

/**
 * The monolith's boundaries, enforced (record 64, M5). Bimax is one app and one process, and its parts stay apart by
 * rule rather than by a process boundary — Shopify's Packwerk idea, without a new dependency: each part has a public
 * API, and a test fails when code reaches past it.
 *
 *   • The app takes source from the engine (`src/`) only through `src/engine/api.ts` and `src/protocol/protocol.ts`.
 *     It runs the engine from its built bundle; importing an engine internal would couple the two silently, and Rollup
 *     cannot bundle the engine at all.
 *   • What those two doors expose imports nothing further, so the app's bundle can never pull engine internals in.
 *   • The engine never imports Electron or the app.
 *   • The window (renderer, preload) never imports the app's main-process CODE. Type-only imports are allowed: they
 *     compile to nothing, and they are how the supervisor's wire shapes stay single-sourced (see global.d.ts).
 *
 * Imports are read with the TypeScript parser (src/__tests__/support/import.graph.ts).
 */

const repo = path.resolve(__dirname, '..', '..', '..');
const engineRoot = path.join(repo, 'src');
const appRoot = path.join(repo, 'app');
const rel = (file: string) => path.relative(repo, file);

const ENGINE_DOORS = new Set(['src/engine/api.ts', 'src/protocol/protocol.ts']);

const notProduct = (d: string) => /(^|\/)(node_modules|__tests__|out|dist|release)$/.test(d);
const inside = (file: string, dir: string) => file === dir || file.startsWith(dir + path.sep);

const appFiles = [
  ...sourceFiles(path.join(appRoot, 'src'), notProduct),
  ...sourceFiles(path.join(appRoot, 'design-preview'), notProduct),
];
const engineFiles = sourceFiles(engineRoot, notProduct);

test('the scan sees the code it guards (a zero cannot mean it looked in the wrong place)', () => {
  expect(appFiles.length).toBeGreaterThan(100);
  expect(engineFiles.length).toBeGreaterThan(300);
  expect(appFiles.some((f) => rel(f) === 'app/src/main/engine.ts')).toBe(true);
  expect(engineFiles.some((f) => rel(f) === 'src/engine/api.ts')).toBe(true);
});

test('the app takes engine source only through its public API and the protocol types', () => {
  const crossings: string[] = [];
  let doorsUsed = 0;
  for (const file of appFiles) {
    for (const imp of importsOf(file)) {
      const target = resolve(file, imp.spec);
      if (!target || !inside(target, engineRoot)) continue;
      if (ENGINE_DOORS.has(rel(target))) { doorsUsed += 1; continue; }
      crossings.push(`${rel(file)}:${imp.line} imports ${rel(target)}`);
    }
  }
  expect(crossings).toEqual([]);
  expect(doorsUsed).toBeGreaterThan(0);
});

test('what the doors expose imports nothing further, so the app bundle never pulls engine internals in', () => {
  const problems: string[] = [];
  for (const door of ENGINE_DOORS) {
    const file = path.join(repo, door);
    for (const imp of importsOf(file)) {
      if (imp.typeOnly) continue;
      const target = resolve(file, imp.spec);
      if (!target) { problems.push(`${door}:${imp.line} imports the package ${imp.spec}`); continue; }
      const further = importsOf(target).filter((i) => !i.typeOnly);
      if (further.length) problems.push(`${door} re-exports ${rel(target)}, which imports ${further.map((i) => i.spec).join(', ')}`);
    }
  }
  expect(problems).toEqual([]);
});

test('the engine never imports Electron or the app', () => {
  const crossings: string[] = [];
  for (const file of engineFiles) {
    for (const imp of importsOf(file)) {
      if (imp.spec === 'electron' || imp.spec.startsWith('electron/')) crossings.push(`${rel(file)}:${imp.line} imports ${imp.spec}`);
      const target = resolve(file, imp.spec);
      if (target && inside(target, appRoot)) crossings.push(`${rel(file)}:${imp.line} imports ${rel(target)}`);
    }
  }
  expect(crossings).toEqual([]);
});

test('the window never imports main-process code; type-only imports are allowed', () => {
  const main = path.join(appRoot, 'src', 'main');
  const windowFiles = appFiles.filter((f) => inside(f, path.join(appRoot, 'src', 'renderer')) || inside(f, path.join(appRoot, 'src', 'preload')));
  expect(windowFiles.length).toBeGreaterThan(50);
  const crossings: string[] = [];
  let typeOnly = 0;
  for (const file of windowFiles) {
    for (const imp of importsOf(file)) {
      const target = resolve(file, imp.spec);
      if (!target || !inside(target, main)) continue;
      if (imp.typeOnly) { typeOnly += 1; continue; }
      crossings.push(`${rel(file)}:${imp.line} imports ${rel(target)}`);
    }
  }
  expect(crossings).toEqual([]);
  expect(typeOnly).toBeGreaterThan(0); // global.d.ts's supervisor shapes: proves type-only imports are seen, not missed
});

test('the import reader tells a type-only import from a real one', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'bimax-boundaries-'));
  const file = path.join(dir, 'probe.ts');
  fs.writeFileSync(file, [
    "import type { A } from './a';",
    "import { type B, type C } from './b';",
    "import { D, type E } from './d';",
    "export * from './f';",
    "export type { G } from './g';",
    "const h = require('./h');",
    "const i = import('./i');",
    "type J = typeof import('./j');",
    "// import { K } from './k';",
    "const l = \"from './l'\";",
  ].join('\n'));
  const got = importsOf(file).map((i) => `${i.spec}:${i.typeOnly ? 'type' : 'value'}`);
  expect(got).toEqual(['./a:type', './b:type', './d:value', './f:value', './g:type', './h:value', './i:value', './j:type']);
  fs.rmSync(dir, { recursive: true, force: true });
});
