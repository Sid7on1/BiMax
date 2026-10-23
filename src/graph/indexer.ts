import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { StaticAnalyzer } from './static.analyzer';
import { TreeSitterAnalyzer } from './treesitter.analyzer';
import { SemanticAugmenter } from './semantic.augmenter';
import { GraphStore } from './graph.store';
import { SqliteGraphStore } from './sqlite.graph.store';
import { Logger } from '../utils';
import { publishFileGraph } from './file.graph';

export class CodebaseIndexer {
  public enabled: boolean = true;
  public excludePatterns: string[] = [];

  constructor(
    private projectRoot: string,
    private graphStore: GraphStore,
    private analyzer: StaticAnalyzer,
    private augmenter: SemanticAugmenter
  ) {}

  public setProjectRoot(newRoot: string) {
    this.projectRoot = newRoot;
    this.analyzer.setProjectRoot(newRoot);
    this.augmenter.setProjectRoot(newRoot);
  }

  /**
   * Multi-language AST pass: index non-TS/JS files (Python, …) via tree-sitter into the same
   * graph. Additive and best-effort — runs after the TS analyzer and never throws upward, so
   * a repo with no tsconfig still gets a graph from its other languages.
   */
  private async runTreeSitterPass(): Promise<void> {
    try {
      const tsa = new TreeSitterAnalyzer(this.projectRoot, this.graphStore, this.excludePatterns);
      await tsa.analyzeProject();
    } catch (e: any) {
      Logger.warn(`[CodebaseIndexer] tree-sitter pass skipped: ${e.message}`);
    }
  }

  /**
   * @param interactive  Only true for a standalone (non-TUI) CLI invocation. MUST be false when
   *   called from inside the Ink TUI: Ink owns process.stdin in raw mode, and opening a second
   *   readline interface here makes two consumers fight over the same raw TTY — a stdin busy-loop
   *   that pins a CPU core and freezes the UI (the "Mac frying an egg while idle" bug). In the TUI
   *   we AST-index silently and leave semantic ingestion as an explicit opt-in (/graph ingest).
   */
  public async autoIndex(force: boolean = false, interactive: boolean = false): Promise<void> {
    if (!this.enabled) {
      Logger.info(`[CodebaseIndexer] Skipped — disabled by config.`);
      return;
    }
    // Store-agnostic "already indexed" check: count nodes in the LOADED store (works for
    // both the SQLite and the legacy JSON backends). If the store looks empty, give it one
    // load attempt — boot paths that skipped loadFromDisk (or a fresh SQLite DB sitting
    // next to a legacy playground.json awaiting migration) are covered by this.
    if (this.graphStore.getGraph().nodes.size === 0) {
      try { await this.graphStore.loadFromDisk(); } catch { /* treat as unindexed */ }
    }
    const needsIndexing = this.graphStore.getGraph().nodes.size === 0;

    if (!force && !needsIndexing) {
      // Already indexed — keep it FRESH instead of frozen (v2 §3.9): re-parse changed
      // files in the background, bounded, never blocking boot.
      this.refreshStale().catch(() => { /* freshness is best-effort */ });
      return;
    }

    if (force) {
      this.graphStore.clear(); // Clear existing graph if forced
    }

    Logger.info(`[CodebaseIndexer] Indexing codebase (AST) for ${this.projectRoot}…`);

    // 1. Physical Indexing — never let an unreadable/invalid tsconfig kill the boot. The TS
    // pass and the tree-sitter pass are independent: a failure in one must not skip the other.
    try {
      this.analyzer.analyzeProject();
    } catch (e: any) {
      Logger.warn(`[CodebaseIndexer] TS AST pass skipped: ${e.message}`);
    }
    await this.runTreeSitterPass();
    await this.graphStore.saveToDisk();
    if (this.graphStore instanceof SqliteGraphStore) this.graphStore.recordFileHashes(this.projectRoot);

    const nodeCount = this.graphStore.getGraph().nodes.size;
    if (nodeCount === 0) {
      Logger.warn(`[CodebaseIndexer] No indexable source found in ${this.projectRoot}.`);
      return;
    }
    Logger.info(`[CodebaseIndexer] Codebase index complete: ${nodeCount} nodes extracted.`);

    // 2. Semantic ingestion prompt — ONLY for a standalone CLI run. Never under the Ink TUI:
    // readline + Ink both reading the raw TTY deadlock-spin on stdin (100% CPU, frozen UI).
    if (interactive && process.stdout.isTTY) {
      await this.promptForSemanticIngestion(nodeCount);
    } else {
      Logger.info(`[CodebaseIndexer] AST index ready (${nodeCount} nodes). Run semantic ingestion explicitly with /index-ai when you want LLM metadata.`);
    }
  }

  private promptForSemanticIngestion(nodeCount: number): Promise<void> {
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      console.log(`\nShould I also run **Semantic Ingestion** to add LLM meta-data (purpose, risk scores) to these nodes?`);
      console.log(`(Warning: This will make ~${nodeCount} API calls using your configured LLM keys)`);
      
      rl.question(`Run Semantic Ingestion? [Y/n] `, async (answer) => {
        rl.close();
        if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes' || answer === '') {
          console.log(`\n🚀 Starting Semantic Ingestion... I'll let you know when I'm done.`);
          await this.augmenter.augmentGraph();
          console.log(`\n🧠 Semantic Ingestion complete! The graph now has Mythos-level intelligence.`);
        } else {
          console.log(`\nSkipping Semantic Ingestion. You can run it manually later.`);
        }
        resolve();
      });
    });
  }

  /**
   * Incremental refresh (v2 §3.9): re-parse ONLY the files whose content hash moved
   * since the last (re)index, prune nodes of deleted files. Needs the SQLite store
   * (which carries the hash baseline); on the JSON store it reports 'unsupported'.
   * Bounded: past `fullThreshold` stale files a full reindex is cheaper and cleaner.
   */
  public async refreshStale(opts?: { fullThreshold?: number }): Promise<{ supported: boolean; changed: number; deleted: number; full: boolean }> {
    if (!(this.graphStore instanceof SqliteGraphStore) || !this.graphStore.isAvailable()) {
      return { supported: false, changed: 0, deleted: 0, full: false };
    }
    const store = this.graphStore;
    const { changed, deleted } = store.staleFiles(this.projectRoot);
    // Hash rows only know old paths. Config discovery also finds new/renamed TS/JS
    // files without constructing a Program or reparsing the unchanged majority.
    const known = store.recordedFiles();
    const pending = new Set(changed);
    try {
      const candidates = [...this.analyzer.getProjectFiles(),
        ...new TreeSitterAnalyzer(this.projectRoot, store, this.excludePatterns).getProjectFiles()];
      for (const abs of candidates) {
        const rel = path.relative(this.projectRoot, abs);
        if (!known.has(rel) && !pending.has(rel)) {
          changed.push(rel);
          pending.add(rel);
        }
      }
    } catch (e: any) {
      Logger.warn(`[CodebaseIndexer] source discovery failed: ${e.message}`);
    }
    if (changed.length === 0 && deleted.length === 0) return { supported: true, changed: 0, deleted: 0, full: false };

    const threshold = opts?.fullThreshold ?? 200;
    if (changed.length + deleted.length > threshold) {
      Logger.info(`[CodebaseIndexer] ${changed.length + deleted.length} stale files — beyond the incremental budget, full reindex.`);
      await this.buildAstIndex();
      return { supported: true, changed: changed.length, deleted: deleted.length, full: true };
    }

    // Keep deletion baselines until the graph commit succeeds. A crash/failure before
    // that commit must leave enough evidence to prune the old persisted nodes again.
    for (const rel of deleted) store.removeFileNodes(rel, true);
    const tsLike = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
    const refreshed: string[] = [];
    const parsedStates = new Map<string, NonNullable<ReturnType<typeof store.captureFileState>>>();
    // Capture all identities before constructing the shared Program; later files must
    // never certify newer disk bytes against an older compiler snapshot.
    const inputStates = new Map(changed.map(rel => [rel, store.captureFileState(this.projectRoot, rel)]));
    let snapshot: ReturnType<StaticAnalyzer['createProgram']> | undefined;
    try { if (changed.some(rel => tsLike.test(rel))) snapshot = this.analyzer.createProgram(); }
    catch (e: any) { Logger.warn(`[CodebaseIndexer] compiler snapshot unavailable: ${e.message}`); }
    for (const rel of changed) {
      const abs = path.isAbsolute(rel) ? rel : path.join(this.projectRoot, rel);
      try {
        const state = inputStates.get(rel);
        if (!state) throw new Error('Source unavailable or changed while reading.');
        if (tsLike.test(rel)) {
          if (!snapshot) throw new Error('Compiler snapshot unavailable.');
          this.analyzer.analyzeSingleFile(abs, snapshot);
        } else {
          const replacement = new GraphStore(':memory:');
          const tsa = new TreeSitterAnalyzer(this.projectRoot, replacement, this.excludePatterns);
          if (!await tsa.analyzeSingleFile(abs)) throw new Error('No parser or grammar available for source.');
          publishFileGraph(store, rel, replacement.getGraph());
        }
        refreshed.push(rel);
        parsedStates.set(rel, state);
      } catch (e: any) {
        Logger.warn(`[CodebaseIndexer] incremental re-parse of ${rel} failed: ${e.message}`);
      }
    }
    await this.graphStore.saveToDisk();
    store.recordFileHashes(this.projectRoot, refreshed, parsedStates, deleted);
    Logger.info(`[CodebaseIndexer] Incremental refresh: ${refreshed.length} file(s) re-parsed, ${deleted.length} pruned, ${changed.length - refreshed.length} parse failures pending.`);
    return { supported: true, changed: changed.length, deleted: deleted.length, full: false };
  }

  public async buildAstIndex(): Promise<number> {
    Logger.info(`[CodebaseIndexer] Manually triggering AST indexing for ${this.projectRoot}`);
    this.graphStore.clear();
    try {
      this.analyzer.analyzeProject();
    } catch (e: any) {
      Logger.warn(`[CodebaseIndexer] TS AST pass skipped: ${e.message}`);
    }
    await this.runTreeSitterPass();
    await this.graphStore.saveToDisk();
    if (this.graphStore instanceof SqliteGraphStore) this.graphStore.recordFileHashes(this.projectRoot);
    return this.graphStore.getGraph().nodes.size;
  }

  public async buildSemanticIndex(): Promise<void> {
    Logger.info(`[CodebaseIndexer] Manually triggering Semantic Ingestion for ${this.projectRoot}`);
    await this.augmenter.augmentGraph();
    await this.graphStore.saveToDisk();
  }
}
