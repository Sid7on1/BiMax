import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';
import Parser from 'web-tree-sitter';
import { IGraphStore, GraphNode } from './models';
import { Logger, treeSitterRuntimeAvailable } from '../utils';

// M1 — tree-sitter multi-language backend. Indexes non-TS/JS languages (Python first) into
// the SAME graph model (FILE/CLASS/FUNCTION nodes + CONTAINS/CALLS edges) with line ranges,
// so the whole graph-native context engine (READ_SYMBOL, context packs, @mentions, blast
// gate) works on those repos too. tree-sitter gives node.startPosition/endPosition.row
// directly, so G1 line ranges come for free.
//
// NOTE: init/grammar-load are async (WASM), so this analyzer's methods are async — it fills
// the same role as the synchronous StaticAnalyzer but cannot share its exact sync signature.
// The indexer awaits it as a second, additive pass.

interface LangSpec {
  /** tree-sitter node type for a function/def. */
  funcType: string;
  /** tree-sitter node type for a class. */
  classType: string;
  /** call-expression node type. */
  callType: string;
}

// Per-language node-type map. Python first; the others are wired so adding them later is
// just confirming their node-type names (kept conservative — only what we emit today).
const LANGUAGES: Record<string, { wasm: string; spec: LangSpec }> = {
  '.py': {
    wasm: 'tree-sitter-python',
    spec: { funcType: 'function_definition', classType: 'class_definition', callType: 'call' },
  },
};

// Directories never worth indexing — dependencies, build output, caches, tool/IDE metadata. Matched
// by basename during the file walk. Kept broad on purpose: indexing a venv / site-packages / VS Code
// extensions folder is what balloons the graph into 100k+ junk nodes.
const IGNORED_DIRS = new Set([
  // VCS + our own
  '.git', '.hg', '.svn', '.breakglass',
  // JS / TS deps + build + caches
  'node_modules', 'bower_components', 'jspm_packages', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.parcel-cache', '.cache', '.expo', '.yarn', '.pnpm-store',
  // Python
  '__pycache__', '.venv', 'venv', 'site-packages', '.tox', '.mypy_cache', '.pytest_cache',
  '.ipynb_checkpoints', '.eggs',
  // Rust / Go / Java / .NET / iOS / Dart
  'target', 'vendor', '.gradle', 'Pods', 'obj', 'DerivedData', '.dart_tool', '.cargo', '.rustup',
  // Tooling / IDE / infra
  '.idea', '.vscode', '.vscode-server', '.terraform', '.serverless',
  // macOS home heavyweights (so `/index ~` doesn't crawl the whole machine)
  'Library', 'Applications',
]);

function resolveGrammarWasm(name: string): string | null {
  try {
    return require.resolve(`tree-sitter-wasms/out/${name}.wasm`);
  } catch {
    return null;
  }
}

export class TreeSitterAnalyzer {
  private parser: Parser | null = null;
  private langCache: Map<string, Parser.Language | null> = new Map();
  private excludeMatchers: ((filePath: string) => boolean)[] = [];

  constructor(
    private projectRoot: string,
    private store: IGraphStore,
    excludePatterns: string[] = []
  ) {
    this.setExcludePatterns(excludePatterns);
  }

  public setProjectRoot(newRoot: string) { this.projectRoot = newRoot; }
  public setExcludePatterns(patterns: string[]) {
    this.excludeMatchers = patterns.map(p => (fp: string) => minimatch(fp, p));
  }

  /** Extensions this analyzer can index given the grammars actually present on disk. */
  public static supportedExtensions(): string[] {
    if (!treeSitterRuntimeAvailable()) return [];
    return Object.keys(LANGUAGES).filter(ext => resolveGrammarWasm(LANGUAGES[ext].wasm) !== null);
  }

  /** False when the wasm runtime isn't on disk (standalone binary) — callers must bail. */
  private async init(): Promise<boolean> {
    if (this.parser) return true;
    // Parser.init() without the wasm file aborts with an UNCATCHABLE unhandled rejection
    // (Emscripten) — never call it unless the runtime is really present.
    if (!treeSitterRuntimeAvailable()) {
      Logger.warn('[TreeSitter] wasm runtime not present — non-TS indexing disabled.');
      return false;
    }
    await Parser.init();
    this.parser = new Parser();
    return true;
  }

  private async languageFor(ext: string): Promise<Parser.Language | null> {
    if (this.langCache.has(ext)) return this.langCache.get(ext)!;
    const entry = LANGUAGES[ext];
    const wasmPath = entry ? resolveGrammarWasm(entry.wasm) : null;
    if (!wasmPath) { this.langCache.set(ext, null); return null; }
    try {
      const lang = await Parser.Language.load(wasmPath);
      this.langCache.set(ext, lang);
      return lang;
    } catch (e: any) {
      Logger.warn(`[TreeSitter] Failed to load grammar for ${ext}: ${e.message}`);
      this.langCache.set(ext, null);
      return null;
    }
  }

  private getRelativePath(absPath: string): string {
    return path.relative(this.projectRoot, absPath).replace(/\\/g, '/');
  }

  private isExcluded(relPath: string): boolean {
    return this.excludeMatchers.some(m => m(relPath));
  }

  /** Recursively collect indexable source files under projectRoot. */
  private collectFiles(dir: string, out: string[] = []): string[] {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.') {
        if (IGNORED_DIRS.has(e.name)) continue;
      }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue;
        this.collectFiles(full, out);
      } else if (LANGUAGES[path.extname(e.name)]) {
        const rel = this.getRelativePath(full);
        if (!this.isExcluded(rel)) out.push(full);
      }
    }
    return out;
  }

  /** Discover supported paths without parsing their contents. */
  public getProjectFiles(): string[] {
    if (TreeSitterAnalyzer.supportedExtensions().length === 0) return [];
    return this.collectFiles(this.projectRoot);
  }

  /** Index every supported non-TS file under the project root into the shared graph. */
  public async analyzeProject(): Promise<void> {
    if (!(await this.init())) return;
    const files = this.collectFiles(this.projectRoot);
    if (files.length === 0) return;

    // Pass 1 — parse each file once, emit nodes + CONTAINS, and remember the tree so the
    // call-resolution pass doesn't re-parse. Build a name→ids map for CALLS resolution.
    const trees: { file: string; ext: string; root: Parser.SyntaxNode }[] = [];
    const nameToIds = new Map<string, string[]>();

    for (const file of files) {
      const ext = path.extname(file);
      const lang = await this.languageFor(ext);
      if (!lang) continue;
      let source: string;
      try { source = fs.readFileSync(file, 'utf8'); } catch { continue; }
      this.parser!.setLanguage(lang);
      const tree = this.parser!.parse(source);
      trees.push({ file, ext, root: tree.rootNode });
      this.extractNodes(tree.rootNode, file, ext, nameToIds);
    }

    // Pass 2 — resolve CALLS by callee name (a function defined exactly once in the project).
    for (const { file, ext, root } of trees) {
      this.extractCalls(root, file, ext, nameToIds);
    }

    Logger.info(`[TreeSitter] Indexed ${trees.length} file(s) across ${TreeSitterAnalyzer.supportedExtensions().join(', ')}.`);
  }

  /** Parse and index a single file (used by the live observer for incremental updates). */
  public async analyzeSingleFile(absolutePath: string): Promise<boolean> {
    const ext = path.extname(absolutePath);
    if (!LANGUAGES[ext]) return false;
    if (!(await this.init())) return false;
    const lang = await this.languageFor(ext);
    if (!lang) return false;
    let source: string;
    try { source = fs.readFileSync(absolutePath, 'utf8'); } catch { return false; }
    this.parser!.setLanguage(lang);
    const tree = this.parser!.parse(source);
    const nameToIds = new Map<string, string[]>();
    this.extractNodes(tree.rootNode, absolutePath, ext, nameToIds);
    this.extractCalls(tree.rootNode, absolutePath, ext, nameToIds);
    return true;
  }

  private signatureOf(node: Parser.SyntaxNode): string {
    const first = node.text.split('\n')[0].trim();
    return first.length > 200 ? first.slice(0, 197) + '...' : first;
  }

  private addSymbol(node: GraphNode, nameToIds: Map<string, string[]>) {
    this.store.addNode(node);
    const list = nameToIds.get(node.name) || [];
    list.push(node.id);
    nameToIds.set(node.name, list);
  }

  private extractNodes(root: Parser.SyntaxNode, file: string, ext: string, nameToIds: Map<string, string[]>) {
    const relPath = this.getRelativePath(file);
    const fileId = `file:${relPath}`;
    this.store.addNode({ id: fileId, name: path.basename(file), type: 'FILE', filePath: relPath });

    const spec = LANGUAGES[ext].spec;

    for (let i = 0; i < root.namedChildCount; i++) {
      const child = root.namedChild(i)!;

      if (child.type === spec.funcType) {
        const name = child.childForFieldName('name')?.text;
        if (!name) continue;
        const id = `func:${relPath}:${name}`;
        this.addSymbol({
          id, name, type: 'FUNCTION', filePath: relPath,
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
          signature: this.signatureOf(child),
        }, nameToIds);
        this.store.addEdge({ sourceId: fileId, targetId: id, type: 'CONTAINS' });
      } else if (child.type === spec.classType) {
        const className = child.childForFieldName('name')?.text;
        if (!className) continue;
        const classId = `class:${relPath}:${className}`;
        this.addSymbol({
          id: classId, name: className, type: 'CLASS', filePath: relPath,
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
          signature: this.signatureOf(child),
        }, nameToIds);
        this.store.addEdge({ sourceId: fileId, targetId: classId, type: 'CONTAINS' });

        // Methods inside the class body.
        const body = child.childForFieldName('body');
        if (body) {
          for (let j = 0; j < body.namedChildCount; j++) {
            const m = body.namedChild(j)!;
            if (m.type !== spec.funcType) continue;
            const mName = m.childForFieldName('name')?.text;
            if (!mName) continue;
            const mId = `func:${relPath}:${className}.${mName}`;
            this.addSymbol({
              id: mId, name: `${className}.${mName}`, type: 'FUNCTION', filePath: relPath,
              startLine: m.startPosition.row + 1,
              endLine: m.endPosition.row + 1,
              signature: this.signatureOf(m),
            }, nameToIds);
            this.store.addEdge({ sourceId: classId, targetId: mId, type: 'CONTAINS' });
          }
        }
      }
    }
  }

  /** The id of the nearest enclosing function/method for a node, or null at module scope. */
  private enclosingSymbolId(node: Parser.SyntaxNode, relPath: string, funcType: string, classType: string): string | null {
    let cur: Parser.SyntaxNode | null = node.parent;
    while (cur) {
      if (cur.type === funcType) {
        const name = cur.childForFieldName('name')?.text;
        if (!name) return null;
        // Method? walk up for an enclosing class to build Class.method.
        let p: Parser.SyntaxNode | null = cur.parent;
        while (p) {
          if (p.type === classType) {
            const cls = p.childForFieldName('name')?.text;
            return cls ? `func:${relPath}:${cls}.${name}` : `func:${relPath}:${name}`;
          }
          if (p.type === funcType) break; // nested function — stop at the inner one
          p = p.parent;
        }
        return `func:${relPath}:${name}`;
      }
      cur = cur.parent;
    }
    return null;
  }

  private extractCalls(root: Parser.SyntaxNode, file: string, ext: string, nameToIds: Map<string, string[]>) {
    const relPath = this.getRelativePath(file);
    const spec = LANGUAGES[ext].spec;

    const visit = (node: Parser.SyntaxNode) => {
      if (node.type === spec.callType) {
        const fn = node.childForFieldName('function');
        // Bare-name calls only (e.g. `helper(x)`); attribute calls (`a.b()`) are skipped to
        // avoid false matches — keeping CALLS precise rather than noisy.
        if (fn && fn.type === 'identifier') {
          const targets = nameToIds.get(fn.text);
          if (targets && targets.length === 1) {
            const callerId = this.enclosingSymbolId(node, relPath, spec.funcType, spec.classType);
            if (callerId && callerId !== targets[0]) {
              this.store.addEdge({ sourceId: callerId, targetId: targets[0], type: 'CALLS' });
            }
          }
        }
      }
      for (let i = 0; i < node.namedChildCount; i++) visit(node.namedChild(i)!);
    };
    visit(root);
  }
}
