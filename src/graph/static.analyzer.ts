import * as ts from 'typescript';
import * as path from 'path';
import * as fs from 'fs';
import { minimatch } from 'minimatch';
import { IGraphStore, GraphNode, GraphEdge, NodeType, EdgeType } from './models';
import { Logger } from '../utils';
import { GraphStore } from './graph.store';
import { publishFileGraph } from './file.graph';

export interface IStaticAnalyzer {
  analyzeProject(): void;
  analyzeSingleFile(absolutePath: string): void;
}

export class StaticAnalyzer implements IStaticAnalyzer {
  private excludeMatchers: ((filePath: string) => boolean)[] = [];

  constructor(
    private projectRoot: string,
    private store: IGraphStore,
    excludePatterns: string[] = []
  ) {
    this.setExcludePatterns(excludePatterns);
  }

  public setExcludePatterns(patterns: string[]) {
    this.excludeMatchers = patterns.map(p => (filePath: string) => minimatch(filePath, p));
  }

  private isExcluded(filePath: string): boolean {
    if (this.excludeMatchers.length === 0) return false;
    const relPath = this.getRelativePath(filePath);
    return this.excludeMatchers.some(match => match(relPath));
  }

  public setProjectRoot(newRoot: string) {
    this.projectRoot = newRoot;
  }

  /** Config discovery only: no Program, type checker or AST extraction for unchanged files. */
  public getProjectFiles(): string[] {
    const configPath = ts.findConfigFile(this.projectRoot, ts.sys.fileExists, 'tsconfig.json');
    if (!configPath) return [];
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
    return ts.parseJsonConfigFileContent(config.config, ts.sys, this.projectRoot).fileNames
      .filter(file => !/\.d\.[cm]?ts$/i.test(file) && !this.isExcluded(file));
  }

  /** One compiler snapshot may serve a bounded batch; each refresh constructs a fresh one. */
  public createProgram(): ts.Program {
    const configPath = ts.findConfigFile(this.projectRoot, ts.sys.fileExists, 'tsconfig.json');
    if (!configPath) throw new Error(`Could not find a valid tsconfig.json at ${this.projectRoot}.`);
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
    const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, this.projectRoot);
    return ts.createProgram(parsedConfig.fileNames, parsedConfig.options);
  }

  public analyzeProject(): void {
    Logger.info(`[StaticAnalyzer] Initializing TS Program for: ${this.projectRoot}`);
    const program = this.createProgram();
    const typeChecker = program.getTypeChecker();

    const sourceFiles = program.getSourceFiles()
      .filter(sf => !sf.isDeclarationFile)
      .filter(sf => !this.isExcluded(sf.fileName));

    Logger.info(`[StaticAnalyzer] Parsing ${sourceFiles.length} source files...`);

    // Pass 1: Extract Nodes (Files, Classes, Functions)
    for (const sourceFile of sourceFiles) {
      this.extractNodes(sourceFile);
    }

    // Pass 2: Extract Edges (Imports, Calls)
    for (const sourceFile of sourceFiles) {
      this.extractEdges(sourceFile, typeChecker);
    }

    const nodesCount = this.store.getGraph().nodes.size;
    const edgesCount = this.store.getGraph().edges.length;
    Logger.info(`[StaticAnalyzer] Graph generation complete. Extracted ${nodesCount} nodes and ${edgesCount} wires.`);
  }

  public analyzeSingleFile(absolutePath: string, snapshot?: ts.Program) {
    const relPath = this.getRelativePath(absolutePath);
    // Prepare the replacement before publishing; failed parsing preserves the last good graph.
    const program = snapshot ?? this.createProgram();
    const typeChecker = program.getTypeChecker();
    
    const sourceFile = program.getSourceFile(absolutePath);
    if (!sourceFile) {
      throw new Error(`Could not find source file in TS Program: ${absolutePath}`);
    }

    const replacement = new GraphStore(':memory:');
    const extractor = new StaticAnalyzer(this.projectRoot, replacement);
    extractor.extractNodes(sourceFile);
    extractor.extractEdges(sourceFile, typeChecker);
    publishFileGraph(this.store, relPath, replacement.getGraph());

    Logger.info(`[StaticAnalyzer] Hot-reloaded AST for ${relPath}`);
  }

  private addNode(node: GraphNode) {
    this.store.addNode(node);
  }

  private addEdge(edge: GraphEdge) {
    this.store.addEdge(edge);
  }

  private getRelativePath(absolutePath: string): string {
    return path.relative(this.projectRoot, absolutePath);
  }

  /**
   * Source location of an AST node as 1-based, inclusive line numbers, plus the
   * declaration's first line as a short signature. Lets the graph point the agent at the
   * exact span of a symbol so it can read just that symbol instead of the whole file.
   */
  private locOf(node: ts.Node, sourceFile: ts.SourceFile): { startLine: number; endLine: number; signature: string } {
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
    const declaration = node.getText(sourceFile);
    const firstLine = declaration.split('\n', 1)[0].trim();
    let signature = firstLine.length > 200 ? firstLine.slice(0, 197) + '...' : firstLine;
    // Detach the <=200 UTF-16 units from large bodies; sliced strings can retain source text.
    if (declaration.length > 4096) signature = Buffer.from(signature, 'utf16le').toString('utf16le');
    return { startLine: start.line + 1, endLine: end.line + 1, signature };
  }

  private extractNodes(sourceFile: ts.SourceFile) {
    const relPath = this.getRelativePath(sourceFile.fileName);
    const fileNodeId = `file:${relPath}`;

    // Add File Node
    this.addNode({
      id: fileNodeId,
      name: path.basename(sourceFile.fileName),
      type: 'FILE',
      filePath: relPath
    });

    const visit = (node: ts.Node) => {
      if (ts.isClassDeclaration(node) && node.name) {
        const className = node.name.text;
        const classId = `class:${relPath}:${className}`;
        this.addNode({
          id: classId,
          name: className,
          type: 'CLASS',
          filePath: relPath,
          ...this.locOf(node, sourceFile)
        });
        
        // Edge from File to Class
        this.addEdge({ sourceId: fileNodeId, targetId: classId, type: 'CONTAINS' });
        
        // Extract methods inside class
        ts.forEachChild(node, (member) => {
          if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
            const methodName = member.name.text;
            const methodId = `func:${relPath}:${className}.${methodName}`;
            this.addNode({
              id: methodId,
              name: methodName,
              type: 'FUNCTION',
              filePath: relPath,
              ...this.locOf(member, sourceFile)
            });
            this.addEdge({ sourceId: classId, targetId: methodId, type: 'CONTAINS' });
          }
        });

      } else if (ts.isFunctionDeclaration(node) && node.name) {
        const funcName = node.name.text;
        const funcId = `func:${relPath}:${funcName}`;
        this.addNode({
          id: funcId,
          name: funcName,
          type: 'FUNCTION',
          filePath: relPath,
          ...this.locOf(node, sourceFile)
        });

        // Edge from File to Function
        this.addEdge({ sourceId: fileNodeId, targetId: funcId, type: 'CONTAINS' });
      } else if (ts.isBlock(node)) {
        const blockId = `block:${relPath}:${node.pos}`;
        this.addNode({
          id: blockId,
          name: `Block@${node.pos}`,
          type: 'BLOCK',
          filePath: relPath
        });
        
        // Find parent container to link
        const parentId = this.findNearestContainerId(node.parent, relPath, fileNodeId);
        if (parentId) {
          this.addEdge({ sourceId: parentId, targetId: blockId, type: 'CONTAINS' });
        }
      } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const varName = node.name.text;
        const varId = `var:${relPath}:${varName}@${node.pos}`;
        this.addNode({
          id: varId,
          name: varName,
          type: 'VARIABLE',
          filePath: relPath,
          ...this.locOf(node, sourceFile)
        });

        const parentId = this.findNearestContainerId(node.parent, relPath, fileNodeId);
        if (parentId) {
          this.addEdge({ sourceId: parentId, targetId: varId, type: 'CONTAINS' });
          this.addEdge({ sourceId: parentId, targetId: varId, type: 'DECLARES_VARIABLE' });
        }
      } else if (ts.isStatement(node) && !ts.isBlock(node)) {
        const stmtId = `stmt:${relPath}:${node.pos}`;
        const stmtName = ts.SyntaxKind[node.kind];
        
        this.addNode({
          id: stmtId,
          name: `${stmtName}@${node.pos}`,
          type: 'STATEMENT',
          filePath: relPath
        });

        const parentId = this.findNearestContainerId(node.parent, relPath, fileNodeId);
        if (parentId) {
          this.addEdge({ sourceId: parentId, targetId: stmtId, type: 'CONTAINS' });
        }
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);
  }

  private findNearestContainerId(node: ts.Node, relPath: string, defaultId: string): string {
    let current: ts.Node | undefined = node;
    while (current) {
      if (ts.isBlock(current)) return `block:${relPath}:${current.pos}`;
      if (ts.isFunctionDeclaration(current) && current.name) return `func:${relPath}:${current.name.text}`;
      if (ts.isMethodDeclaration(current) && current.name && ts.isIdentifier(current.name)) {
        const parent = current.parent;
        if (ts.isClassDeclaration(parent) && parent.name) {
          return `func:${relPath}:${parent.name.text}.${current.name.text}`;
        }
      }
      if (ts.isClassDeclaration(current) && current.name) return `class:${relPath}:${current.name.text}`;
      current = current.parent;
    }
    return defaultId;
  }

  // A checker owns compiler state; keep it scoped to extraction, never the long-lived analyzer.
  private extractEdges(sourceFile: ts.SourceFile, typeChecker: ts.TypeChecker) {
    const relPath = this.getRelativePath(sourceFile.fileName);
    const fileNodeId = `file:${relPath}`;

    const visit = (node: ts.Node) => {
      // Find the most granular container for this node
      const currentContainerId = this.findNearestContainerId(node, relPath, fileNodeId);

      // Detect Imports
      if (ts.isImportDeclaration(node)) {
        const moduleSpecifier = node.moduleSpecifier;
        if (ts.isStringLiteral(moduleSpecifier)) {
          const importPath = moduleSpecifier.text;
          
          // Heuristic: If it's a relative path, try to resolve to a file node
          if (importPath.startsWith('.')) {
            let resolvedExt = '';
            const absoluteImportDir = path.dirname(sourceFile.fileName);
            const resolvedPath = path.resolve(absoluteImportDir, importPath);
            
            // Basic resolution (very simplified, usually TS Compiler API does this better)
            if (fs.existsSync(resolvedPath + '.ts')) resolvedExt = '.ts';
            else if (fs.existsSync(path.join(resolvedPath, 'index.ts'))) resolvedExt = '/index.ts';

            if (resolvedExt) {
              const targetRelPath = this.getRelativePath(resolvedPath + resolvedExt);
              const targetNodeId = `file:${targetRelPath}`;
              this.addEdge({ sourceId: fileNodeId, targetId: targetNodeId, type: 'IMPORTS' });
            }
          }
        }
      }

      // Detect Function Calls
      if (ts.isCallExpression(node)) {
        const signature = typeChecker.getResolvedSignature(node);
        
        // --- Runtime Event Graph: Detect eventBus.emit and eventBus.on ---
        if (ts.isPropertyAccessExpression(node.expression)) {
          const propName = node.expression.name.text;
          if (propName === 'emit' || propName === 'on') {
            const firstArg = node.arguments[0];
            if (firstArg && ts.isStringLiteral(firstArg)) {
              const eventName = firstArg.text;
              const eventNodeId = `event:${eventName}`;
              
              this.addNode({
                id: eventNodeId,
                name: eventName,
                type: 'EVENT',
                filePath: '' // Events span across files
              });

              if (propName === 'emit') {
                this.addEdge({ sourceId: currentContainerId, targetId: eventNodeId, type: 'PUBLISHES_TO' });
              } else if (propName === 'on') {
                this.addEdge({ sourceId: currentContainerId, targetId: eventNodeId, type: 'SUBSCRIBES_TO' });
              }
            }
          }
        }

        if (signature) {
          const decl = signature.getDeclaration();
          if (decl && decl.getSourceFile()) {
            const targetFile = decl.getSourceFile();
            const targetRelPath = this.getRelativePath(targetFile.fileName);
            
            let targetId = '';
            if (ts.isFunctionDeclaration(decl) && decl.name) {
              targetId = `func:${targetRelPath}:${decl.name.text}`;
            } else if (ts.isMethodDeclaration(decl) && decl.name && ts.isIdentifier(decl.name)) {
              const parent = decl.parent;
              if (ts.isClassDeclaration(parent) && parent.name) {
                targetId = `func:${targetRelPath}:${parent.name.text}.${decl.name.text}`;
              }
            }

            if (targetId) {
              this.addEdge({ sourceId: currentContainerId, targetId: targetId, type: 'CALLS' });
            }
          }
        }
      }

      // Detect Variable Usage
      if (ts.isIdentifier(node)) {
        const symbol = typeChecker.getSymbolAtLocation(node);
        if (symbol && symbol.valueDeclaration) {
          const decl = symbol.valueDeclaration;
          if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
            const targetFile = decl.getSourceFile();
            const targetRelPath = this.getRelativePath(targetFile.fileName);
            const varId = `var:${targetRelPath}:${decl.name.text}@${decl.pos}`;
            
            // Avoid self-references (a declaration using itself in its init)
            if (currentContainerId !== varId) {
              this.addEdge({ sourceId: currentContainerId, targetId: varId, type: 'USES_VARIABLE' });
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);
  }
}
