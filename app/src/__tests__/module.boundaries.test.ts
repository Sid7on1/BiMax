import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

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
 * Imports are read with the TypeScript parser, so `import type`, `export … from`, `import()` and `require()` all count
 * and a comment or a string that merely looks like an import does not.
 */

const repo = path.resolve(__dirname, '..', '..', '..');
const engineRoot = path.join(repo, 'src');
const appRoot = path.join(repo, 'app');
const rel = (file: string) => path.relative(repo, file);

const ENGINE_DOORS = new Set(['src/engine/api.ts', 'src/protocol/protocol.ts']);

interface Import { spec: string; typeOnly: boolean; line: number }

function importsOf(file: string): Import[] {
  const text = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: Import[] = [];
  const add = (node: ts.Node, spec: ts.Expression | undefined, typeOnly: boolean) => {
    if (spec && ts.isStringLiteralLike(spec)) {
      found.push({ spec: spec.text, typeOnly, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : undefined;
      // `import { type A, type B }` is as erased as `import type { A, B }`; a bare `import 'x'` is never type-only.
      const typeOnly = !!clause && (clause.isTypeOnly || (!clause.name && !!named && named.length > 0 && named.every((e) => e.isTypeOnly)));
      add(node, node.moduleSpecifier, typeOnly);
    } else if (ts.isExportDeclaration(node)) {
      const named = node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements : undefined;
      add(node, node.moduleSpecifier, node.isTypeOnly || (!!named && named.length > 0 && named.every((e) => e.isTypeOnly)));
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node, node.moduleReference.expression, node.isTypeOnly);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      if (isRequire || callee.kind === ts.SyntaxKind.ImportKeyword) add(node, node.arguments[0], false);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node, node.argument.literal, true); // `typeof import('x')` — a type, never loaded
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The file a relative specifier names, or null for a package / Node built-in. */
function resolve(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.d.ts`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  // A `.js` specifier in TypeScript source names the `.ts` file beside it.
  if (/\.js$/.test(base) && fs.existsSync(base.replace(/\.js$/, '.ts'))) return base.replace(/\.js$/, '.ts');
  return base; // unresolved: still judged by where it points
}

function sourceFiles(dir: string, skip: (dir: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { if (!skip(full)) walk(full); }
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

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
