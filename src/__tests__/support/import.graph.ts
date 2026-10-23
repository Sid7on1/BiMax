import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/**
 * Reading imports for the structure tests (the monolith's boundaries in app/src/__tests__/module.boundaries.test.ts,
 * import cycles in src/__tests__/import.cycles.test.ts). One reader, so the two tests can never disagree about what
 * counts as an import.
 *
 * Imports are read with the TypeScript parser, so `import type`, `export … from`, `import()` and `require()` all count
 * and a comment or a string that merely looks like an import does not. `dynamic` marks `import()`/`require()`: those
 * load when they run, not when the module loads, so they cannot take part in a load-order cycle.
 */

export interface Import { spec: string; typeOnly: boolean; dynamic: boolean; line: number }

export function importsOf(file: string): Import[] {
  const text = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: Import[] = [];
  const add = (node: ts.Node, spec: ts.Expression | undefined, typeOnly: boolean, dynamic = false) => {
    if (spec && ts.isStringLiteralLike(spec)) {
      found.push({ spec: spec.text, typeOnly, dynamic, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
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
      if (isRequire || callee.kind === ts.SyntaxKind.ImportKeyword) add(node, node.arguments[0], false, true);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node, node.argument.literal, true); // `typeof import('x')` — a type, never loaded
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The file a relative specifier names, or null for a package / Node built-in. */
export function resolve(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.d.ts`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  // A `.js` specifier in TypeScript source names the `.ts` file beside it.
  if (/\.js$/.test(base) && fs.existsSync(base.replace(/\.js$/, '.ts'))) return base.replace(/\.js$/, '.ts');
  return base; // unresolved: still judged by where it points
}

export function sourceFiles(dir: string, skip: (dir: string) => boolean): string[] {
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
