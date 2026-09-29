import path from 'node:path';
import { importsOf, resolve, sourceFiles } from './support/import.graph';

/**
 * No import cycles (flaw list C24). A cycle between modules that run code at load time means one of them sees the
 * other half-initialised — an `undefined` import at start-up — and the usual workaround is an inline `require()` that
 * hides the cycle instead of removing it. `agent.loop.ts` had four; by 2026-09-30 none of them was guarding a real
 * cycle any more, and the only two cycles left in `src/` were type-only imports written as value imports.
 *
 * Counted: top-level value imports and `export … from`. Not counted: `import type` (erased), and `import()` /
 * `require()`, which load when they run, not when the module loads.
 */

const repo = path.resolve(__dirname, '..', '..');
const notProduct = (d: string) => /(^|\/)(node_modules|__tests__|out|dist|release)$/.test(d);

/** Groups of files that import each other at load time (Tarjan's strongly connected components of size > 1). */
function cycles(root: string): string[][] {
  const files = sourceFiles(root, notProduct).filter((f) => !f.endsWith('.d.ts'));
  const known = new Set(files);
  const edges = new Map<string, string[]>();
  for (const file of files) {
    edges.set(file, importsOf(file)
      .filter((imp) => !imp.typeOnly && !imp.dynamic)
      .map((imp) => resolve(file, imp.spec))
      .filter((target): target is string => !!target && known.has(target)));
  }
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const found: string[][] = [];
  const connect = (v: string): void => {
    index.set(v, counter); low.set(v, counter); counter++;
    stack.push(v); onStack.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!index.has(w)) { connect(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      const group: string[] = [];
      let w: string;
      do { w = stack.pop()!; onStack.delete(w); group.push(w); } while (w !== v);
      if (group.length > 1 || (edges.get(v) ?? []).includes(v)) found.push(group.map((f) => path.relative(repo, f)).sort());
    }
  };
  for (const file of files) if (!index.has(file)) connect(file);
  return found;
}

test('the engine (src/) has no import cycles', () => {
  expect(cycles(path.join(repo, 'src'))).toEqual([]);
});

test('the app (app/src) has no import cycles', () => {
  expect(cycles(path.join(repo, 'app', 'src'))).toEqual([]);
});
