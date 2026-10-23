import * as fs from 'fs/promises';
import * as path from 'path';
import * as ts from 'typescript';
import { resolvePath, workspaceWriteBlock } from '../path.util';
import { IGovernor } from '../../core/interfaces';
import { buildTool } from '../tool.factory';
import { backupFile, unifiedDiff, compactDiff, capDiff } from '../../engine/fileEditor';
import { shieldEdit } from '../syntax.check';
import { requestDiffApproval } from '../../engine/diffApproval';
import { checkBlastRadius } from '../../engine/blastGate';
import { fileStateCache } from '../../memory/file-state-cache';
import { globalTransactionManager } from '../../core/transaction.manager';
import { outcomeOk, outcomeError, outcomeRejected } from '../outcome';

interface FoundSymbol {
  name: string;
  kind: string;
  /** Character span in the source: [start, end). Start excludes leading trivia but INCLUDES the
   *  symbol's own JSDoc (replacing a function should replace its doc comment too, not orphan it). */
  start: number;
  end: number;
  line: number; // 1-based, for error hints
}

const SUPPORTED = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);

/** Start of a declaration including its JSDoc block(s), excluding unrelated leading trivia. */
function startWithDocs(node: ts.Node, sf: ts.SourceFile): number {
  const docs = (node as any).jsDoc as ts.JSDoc[] | undefined;
  if (docs?.length) return docs[0].getStart(sf);
  return node.getStart(sf);
}

function push(list: FoundSymbol[], name: string, kind: string, node: ts.Node, sf: ts.SourceFile) {
  const start = startWithDocs(node, sf);
  list.push({ name, kind, start, end: node.end, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
}

/**
 * Collect every addressable symbol in a file: top-level functions/classes/interfaces/types/enums,
 * exported const/let declarations, and class members addressed as `Class.member`.
 */
export function collectSymbols(fileName: string, content: string): FoundSymbol[] {
  const kind = fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true, kind);
  const out: FoundSymbol[] = [];

  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) push(out, stmt.name.text, 'function', stmt, sf);
    else if (ts.isInterfaceDeclaration(stmt)) push(out, stmt.name.text, 'interface', stmt, sf);
    else if (ts.isTypeAliasDeclaration(stmt)) push(out, stmt.name.text, 'type', stmt, sf);
    else if (ts.isEnumDeclaration(stmt)) push(out, stmt.name.text, 'enum', stmt, sf);
    else if (ts.isVariableStatement(stmt)) {
      // One symbol per declared name; the span is the WHOLE statement (splicing a single
      // declarator out of `const a = 1, b = 2;` would corrupt the list).
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) push(out, d.name.text, 'variable', stmt, sf);
      }
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      const className = stmt.name.text;
      push(out, className, 'class', stmt, sf);
      for (const m of stmt.members) {
        const mName = m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)) ? m.name.text
          : ts.isConstructorDeclaration(m) ? 'constructor' : null;
        if (!mName) continue;
        const mKind = ts.isMethodDeclaration(m) ? 'method'
          : ts.isConstructorDeclaration(m) ? 'constructor'
          : ts.isGetAccessorDeclaration(m) ? 'getter'
          : ts.isSetAccessorDeclaration(m) ? 'setter'
          : ts.isPropertyDeclaration(m) ? 'property' : null;
        if (mKind) push(out, `${className}.${mName}`, mKind, m, sf);
      }
    }
  }
  return out;
}

/** Indentation of the line a span starts on — re-applied to inserted code so it sits flush. */
function lineIndent(content: string, offset: number): string {
  const lineStart = content.lastIndexOf('\n', offset - 1) + 1;
  const m = content.slice(lineStart, offset).match(/^[ \t]*/);
  return m ? m[0] : '';
}

/**
 * The agent's scalpel: edit a file BY SYMBOL, not by string matching. Immune to the whitespace/
 * indentation drift that breaks oldString matching — the TypeScript AST decides exactly where a
 * function/class/method begins and ends (JSDoc included).
 */
export const createSymbolEditTool = (governor: IGovernor) => buildTool({
  name: 'SymbolEditTool',
  description: `Surgically edit a TypeScript/JavaScript file BY SYMBOL NAME — no string matching. The file's AST locates the exact span of a function/class/method/interface/type/enum/variable, so the edit cannot miss or hit the wrong occurrence.

# Actions
- replace: swap the symbol's entire declaration (JSDoc included) for { newCode }.
- delete: remove the symbol's declaration entirely.
- insert_before / insert_after: add { newCode } immediately before/after the symbol's declaration.

# Addressing
- Top-level: pass the bare name — "connectAll", "McpManager", "PROTOCOL_VERSION".
- Class members: pass "ClassName.memberName" — "McpManager.reconnect", "Foo.constructor".

# When to use
- Rewriting/removing a whole function, method, or class — ONE call replaces the whole span; no fragile multi-line oldString.
- When EditFileTool keeps failing with "oldString not found" on a large block.
- NOT for sub-line tweaks inside a function — EditFileTool is better for one-line changes.`,
  isDestructive: true,
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File to edit (.ts/.tsx/.js/.jsx — supports ~/).' },
      symbol: { type: 'string', description: 'Symbol to target: "name" or "ClassName.member".' },
      action: { type: 'string', enum: ['replace', 'delete', 'insert_before', 'insert_after'], description: 'What to do at the symbol.' },
      newCode: { type: 'string', description: 'The code to write (required for replace/insert_*).' },
    },
    required: ['path', 'symbol', 'action'],
  },
  execute: async (rawArgs: any, context?: any) => {
    const args = {
      path: rawArgs.path ?? rawArgs.file_path ?? rawArgs.filePath,
      symbol: rawArgs.symbol,
      action: rawArgs.action,
      newCode: rawArgs.newCode ?? rawArgs.new_code ?? rawArgs.code,
    };
    const cwd = context?.cwd || process.cwd();
    const fullPath = resolvePath(args.path, cwd);
    const wsBlock = workspaceWriteBlock(fullPath);
    if (wsBlock) return outcomeError('permission', `Error: ${wsBlock}`);
    const ext = path.extname(fullPath).toLowerCase();
    if (!SUPPORTED.has(ext)) {
      return outcomeError('invalid_args', `Error: SymbolEditTool only understands JS/TS files (got '${ext || 'no extension'}'). Use EditFileTool for other file types.`);
    }
    if (args.action !== 'delete' && !args.newCode) {
      return outcomeError('invalid_args', `Error: action "${args.action}" requires newCode.`);
    }

    let content: string;
    try {
      content = await fs.readFile(fullPath, 'utf8');
    } catch (e: any) {
      if (e.code === 'ENOENT') return outcomeError('not_found', `Error: File not found: ${args.path}.`);
      throw e;
    }

    const symbols = collectSymbols(fullPath, content);
    const matches = symbols.filter(s => s.name === args.symbol);
    if (matches.length === 0) {
      // The surgical part of the error: show what IS addressable so the next call succeeds.
      const listing = symbols.slice(0, 40).map(s => `  ${s.name} (${s.kind}, line ${s.line})`).join('\n');
      return outcomeError('not_found', `Error: no symbol named '${args.symbol}' in ${args.path}. Addressable symbols:\n${listing || '  (none found — is the file empty or non-standard?)'}`);
    }
    if (matches.length > 1) {
      return outcomeError('ambiguous_match', `Error: '${args.symbol}' is ambiguous in ${args.path} (${matches.map(m => `${m.kind} at line ${m.line}`).join(', ')}). This usually means declaration merging/overloads — use EditFileTool for this one.`);
    }
    const sym = matches[0];

    // Splice the new content. Inserted code adopts the target's own indentation so a method
    // inserted next to another method sits flush without the model hand-counting spaces.
    const indent = lineIndent(content, sym.start);
    const reindent = (code: string) => code.split('\n').map((l, i) => (i === 0 || l.trim() === '' ? l : indent + l)).join('\n');
    let updated: string;
    switch (args.action) {
      case 'replace':
        updated = content.slice(0, sym.start) + reindent(args.newCode.trimEnd()) + content.slice(sym.end);
        break;
      case 'delete': {
        // Take the whole lines the span covers, plus the trailing newline.
        const from = content.lastIndexOf('\n', sym.start - 1) + 1;
        let to = content.indexOf('\n', sym.end);
        to = to === -1 ? content.length : to + 1;
        updated = content.slice(0, from) + content.slice(to);
        break;
      }
      case 'insert_before':
        updated = content.slice(0, sym.start) + reindent(args.newCode.trimEnd()) + '\n\n' + indent + content.slice(sym.start);
        break;
      case 'insert_after':
        updated = content.slice(0, sym.end) + '\n\n' + indent + reindent(args.newCode.trimEnd()) + content.slice(sym.end);
        break;
      default:
        return outcomeError('invalid_args', `Error: unknown action "${args.action}". Use replace, delete, insert_before, or insert_after.`);
    }

    // Same safety rails as EditFileTool: shield → blast radius → diff approval → tx/backup → write.
    const shield = shieldEdit(fullPath, content, updated);
    if (shield) return outcomeError('syntax', `SymbolEdit to ${args.path} refused by Edit Shield: ${shield}`);
    if (!(await checkBlastRadius(fullPath))) {
      return outcomeRejected(`SymbolEdit to ${args.path} cancelled — declined at the blast-radius gate. No changes were made.`);
    }
    const approved = await requestDiffApproval(
      `SymbolEdit ${args.path} — ${args.action} ${sym.kind} '${sym.name}'`,
      unifiedDiff(content, updated, args.path),
    );
    if (!approved) return outcomeRejected(`SymbolEdit to ${args.path} rejected by user. No changes were made.`);

    await globalTransactionManager.trackEdit(fullPath, updated);
    await backupFile(fullPath);
    await fs.writeFile(fullPath, updated, 'utf8');
    fileStateCache.invalidate(fullPath);

    return outcomeOk(`SymbolEdit applied: ${args.action} ${sym.kind} '${sym.name}' in ${args.path} (was line ${sym.line}):\n` +
      capDiff(compactDiff(content, updated, args.path)));
  },
}, governor);
