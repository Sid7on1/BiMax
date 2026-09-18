// CodememBackend — the codebase-memory engine fronted as Bimax's native graph backend.
//
// Approach (b): instead of dumping 14 raw `mcp__codebase-memory__*` tools on the model, we hold
// ONE persistent connection to the binary and route the existing GraphQueryTool / GraphContextTool
// verbs through it (search, callers/callees, blast radius, read symbol, plan context) — plus the
// capabilities the native AST graph lacks: local SEMANTIC vector search (bundled nomic-embed-code
// embeddings, 768d int8) and a clustered ARCHITECTURE overview.
//
// Every method is best-effort and returns null on any miss/error so the caller transparently falls
// back to Bimax's in-memory graph. The engine is never required for Bimax to work.
// See memory [[bake_in_codemem_headroom]].

import * as fs from 'fs';
import { Logger } from '../../utils/logger';
import { engineEvents } from '../../engine/events';
import { openClient } from '../../mcp/client';
import { ensureBinary, SERVER_NAME } from '../../mcp/builtin/codebaseMemory';
import { projectNameFromPath } from './projectName';

/** Pull the text payload out of an MCP tool result and JSON-parse it when possible. */
function parseResult(res: any): any {
  const parts = res?.content;
  let text = '';
  if (Array.isArray(parts)) {
    text = parts.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('');
  } else if (typeof res === 'string') {
    text = res;
  }
  try { return JSON.parse(text); } catch { return text; }
}

const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'for', 'and', 'or', 'is', 'on', 'with', 'how', 'what', 'where']);
/** Turn a natural-language target into keyword array for semantic_query (vocabulary-bridging search). */
function semanticTokens(target: string): string[] {
  const words = target
    .replace(/([a-z])([A-Z])/g, '$1 $2') // split camelCase
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length >= 3 && !STOP.has(w));
  return [...new Set(words)].slice(0, 6);
}

export class CodememBackend {
  private client: any = null;
  private project: string | null = null;
  private ready = false;
  private starting: Promise<void> | null = null;
  private root = process.cwd();

  /** True once connected AND a populated project is resolved. */
  isReady(): boolean { return this.ready && !!this.client && !!this.project; }
  projectName(): string | null { return this.project; }

  /**
   * Connect to the engine and resolve (indexing if needed) the project for `projectRoot`.
   * Idempotent and non-throwing; runs in the background — callers just poll isReady().
   */
  init(projectRoot: string): Promise<void> {
    if (this.starting) return this.starting;
    this.root = projectRoot;
    this.starting = this._init(projectRoot).catch(e => {
      Logger.warn(`[codebase-memory] backend init failed: ${e?.message || e}`);
    });
    return this.starting;
  }

  private async _init(projectRoot: string): Promise<void> {
    if (process.env.BIMAX_DISABLE_CODEBASE_MEMORY === '1') return;
    const bin = await ensureBinary();
    if (!bin) return;
    this.client = await openClient({ name: SERVER_NAME, command: bin, args: [] });
    Logger.info('[codebase-memory] backend connected');
    await this.resolveProject(projectRoot);
  }

  /** Find an existing populated project matching this root, or index one. */
  private async resolveProject(projectRoot: string): Promise<void> {
    const want = realpath(projectRoot);
    const guess = projectNameFromPath(want);

    const existing = await this.findProject(want);
    if (existing) {
      this.project = existing;
      this.markReady();
      Logger.info(`[codebase-memory] using indexed project '${existing}'`);
      return;
    }

    // Not indexed yet — build it. 'full' enables the embedding/similarity edges that power
    // semantic vector search; the index is cached to disk so it's a one-time cost per repo.
    Logger.info(`[codebase-memory] indexing '${guess}' (full, one-time)...`);
    let indexed: any;
    try {
      indexed = await this.call('index_repository', { repo_path: want, mode: 'full' });
    } catch (e: any) {
      Logger.warn(`[codebase-memory] index failed: ${e?.message || e}`);
      return;
    }
    // index_repository echoes the project name it created — trust that over re-deriving.
    const name = indexed?.project || (await this.findProject(want)) || guess;
    this.project = name;
    this.markReady();
    Logger.info(`[codebase-memory] project '${name}' ready (${indexed?.nodes ?? '?'} nodes)`);
  }

  /** Strip the long project-slug prefix from a qualified_name for readable, paste-able output. */
  private shortQN(qn: string): string {
    if (!qn) return qn;
    return this.project && qn.startsWith(this.project + '.') ? qn.slice(this.project.length + 1) : qn;
  }

  /** Flip to ready and nudge the UI snapshot (footer/map badge) + tool-gating to refresh. */
  private markReady(): void {
    this.ready = true;
    try { engineEvents.emit('graph_changed'); } catch { /* events optional */ }
  }

  /** list_projects → name of the entry whose root_path matches `wantReal`, with nodes>0. */
  private async findProject(wantReal: string): Promise<string | null> {
    try {
      const data = await this.call('list_projects', {});
      const projects = data?.projects;
      if (!Array.isArray(projects)) return null;
      for (const p of projects) {
        if ((p?.nodes || 0) > 0 && p?.root_path && realpath(p.root_path) === wantReal) return p.name;
      }
      return null;
    } catch { return null; }
  }

  private async call(tool: string, args: Record<string, any>): Promise<any> {
    if (!this.client) throw new Error('not connected');
    const res = await this.client.callTool({ name: tool, arguments: args });
    if (res?.isError) throw new Error(typeof res === 'object' ? JSON.stringify(parseResult(res)) : String(res));
    return parseResult(res);
  }

  // ── Native-verb handlers (return formatted string, or null to fall back) ─────────────

  /**
   * SEARCH_NODES (keyword/BM25) and SEMANTIC (vector). semantic=true runs the bundled
   * nomic-embed-code vectors (vocabulary-bridging); else BM25 full-text with camelCase splitting.
   */
  async search(target: string, semantic = false): Promise<string | null> {
    if (!this.isReady()) return null;
    try {
      const args: any = { project: this.project, limit: semantic ? 30 : 25 };
      if (semantic) args.semantic_query = semanticTokens(target);
      else args.query = target;
      const data = await this.call('search_graph', args);
      if (typeof data === 'string') return data || null;
      let rows = [...(data.results || []), ...(data.semantic_results || [])];
      // Keep real definitions; drop File/Folder/Module/Project/Variable noise (semantic mode returns
      // the whole graph scored, so this is what makes the output usable).
      const DEF = new Set(['Function', 'Method', 'Class', 'Interface', 'Route', 'Struct', 'Enum', 'Trait', 'Type', 'Constructor', 'Channel']);
      const defs = rows.filter((r: any) => DEF.has(r.label));
      if (defs.length) rows = defs;
      const seen = new Set<string>();
      const lines = rows
        .filter((r: any) => { const k = r.qualified_name || r.name; if (!k || seen.has(k)) return false; seen.add(k); return true; })
        .slice(0, semantic ? 15 : 25)
        .map((r: any) => `- ${r.label || 'node'} ${this.shortQN(r.qualified_name || r.name)}${r.file_path ? ` (${r.file_path}${r.start_line ? ':' + r.start_line : ''})` : ''}`);
      if (lines.length === 0) return null;
      const more = data.has_more ? `\n…(${data.total} total — narrow the query)` : '';
      const how = semantic ? 'semantic (vector) search' : 'search';
      return `codebase-memory ${how} — ${lines.length} match(es) for "${target}":\n${lines.join('\n')}${more}`;
    } catch (e: any) { Logger.warn(`[codebase-memory] search failed: ${e?.message || e}`); return null; }
  }

  /** GET_DEPENDENTS / GET_DEPENDENCIES via trace_path calls mode. */
  async traceCalls(target: string, direction: 'inbound' | 'outbound'): Promise<string | null> {
    if (!this.isReady()) return null;
    try {
      const data = await this.call('trace_path', { project: this.project, function_name: target, direction, depth: 1, mode: 'calls' });
      if (typeof data === 'string') return data || null;
      const arr = (direction === 'inbound' ? data.callers : data.callees) || [];
      if (!Array.isArray(arr) || arr.length === 0) return null;
      const rel = direction === 'inbound' ? 'directly call (depend on)' : 'are directly called by';
      const list = arr.slice(0, 40).map((x: any) => `- ${this.shortQN(x.qualified_name || x.name)}`);
      return `${list.length} symbol(s) that ${rel} ${target}:\n${list.join('\n')}`;
    } catch (e: any) { Logger.warn(`[codebase-memory] trace failed: ${e?.message || e}`); return null; }
  }

  /** BLAST_RADIUS — deep both-direction trace with risk labels (callers + callees, transitive). */
  async blastRadius(target: string): Promise<string | null> {
    if (!this.isReady()) return null;
    try {
      const data = await this.call('trace_path', { project: this.project, function_name: target, direction: 'both', depth: 5, mode: 'calls', risk_labels: true });
      if (typeof data === 'string') return data || null;
      const callers = data.callers || [];
      const callees = data.callees || [];
      const count = callers.length + callees.length;
      if (count === 0) return null;
      const sev = count > 20 ? '🔴 LARGE' : count > 5 ? '🟡 MODERATE' : '🟢 SMALL';
      const fmt = (x: any) => `  - ${this.shortQN(x.qualified_name || x.name)}${x.risk ? ` [${x.risk}]` : ''}${x.hop ? ` (hop ${x.hop})` : ''}`;
      const sections = [
        `Blast radius for ${target}: ${sev} (${count} reachable)`,
        callers.length ? `Upstream callers (${callers.length}):\n${callers.slice(0, 20).map(fmt).join('\n')}` : '',
        callees.length ? `Downstream callees (${callees.length}):\n${callees.slice(0, 20).map(fmt).join('\n')}` : '',
        count > 20 ? '⚠️ Large reach — review dependents and run tests after editing.' : '',
      ].filter(Boolean);
      return sections.join('\n');
    } catch (e: any) { Logger.warn(`[codebase-memory] blast failed: ${e?.message || e}`); return null; }
  }

  /** READ_SYMBOL — exact source for a symbol. */
  async readSymbol(target: string): Promise<string | null> {
    if (!this.isReady()) return null;
    try {
      const data = await this.call('get_code_snippet', { project: this.project, qualified_name: target, include_neighbors: false });
      return this.fmtSnippet(data, false);
    } catch (e: any) { Logger.warn(`[codebase-memory] read failed: ${e?.message || e}`); return null; }
  }

  /** PLAN_CONTEXT — symbol source plus its neighbors (callers/callees). */
  async planContext(target: string): Promise<string | null> {
    if (!this.isReady()) return null;
    try {
      const data = await this.call('get_code_snippet', { project: this.project, qualified_name: target, include_neighbors: true });
      return this.fmtSnippet(data, true);
    } catch (e: any) { Logger.warn(`[codebase-memory] plan failed: ${e?.message || e}`); return null; }
  }

  /** ARCHITECTURE — clustered structural overview (no native equivalent). */
  async architecture(scopePath?: string): Promise<string | null> {
    if (!this.isReady()) return null;
    try {
      const args: any = { project: this.project };
      if (scopePath) args.path = scopePath;
      const data = await this.call('get_architecture', args);
      if (typeof data === 'string') return data || null;
      const sec: string[] = ['Architecture overview:'];
      const langs = (data.languages || []).map((l: any) => `${l.language} (${l.file_count})`);
      if (langs.length) sec.push(`Languages: ${langs.join(', ')}`);
      const pkgs = (data.packages || []).slice(0, 12).map((p: any) => `  - ${p.name} (${p.node_count} nodes, fan-in ${p.fan_in}/fan-out ${p.fan_out})`);
      if (pkgs.length) sec.push(`Packages:\n${pkgs.join('\n')}`);
      const clusters = (data.clusters || []).slice(0, 8).map((c: any) => `  - ${c.label || c.name}${c.cohesion != null ? ` (cohesion ${c.cohesion})` : ''}${c.member_count ? ` ×${c.member_count}` : ''}`);
      if (clusters.length) sec.push(`Module clusters (community detection):\n${clusters.join('\n')}`);
      const entries = (data.entry_points || []).slice(0, 10).map((e: any) => `  - ${this.shortQN(e.qualified_name || e.name)}${e.file ? ` (${e.file})` : ''}`);
      if (entries.length) sec.push(`Entry points:\n${entries.join('\n')}`);
      const hot = (data.hotspots || []).slice(0, 10).map((h: any) => `  - ${this.shortQN(h.qualified_name || h.name)} (fan-in ${h.fan_in})`);
      if (hot.length) sec.push(`Hotspots (most depended-on):\n${hot.join('\n')}`);
      return sec.length > 1 ? sec.join('\n') : JSON.stringify(data, null, 2);
    } catch (e: any) { Logger.warn(`[codebase-memory] architecture failed: ${e?.message || e}`); return null; }
  }

  private fmtSnippet(data: any, withNeighbors: boolean): string | null {
    if (typeof data === 'string') return data || null;
    // Ambiguous short name → the engine returns candidate suggestions instead of source.
    if (data?.suggestions && !data.source && !data.code) {
      const s = (data.suggestions || []).slice(0, 10).map((x: any) => '- ' + this.shortQN(x.qualified_name || x.name)).join('\n');
      return s ? `"${data.query || ''}" is ambiguous — candidates:\n${s}` : null;
    }
    const code = data.source || data.code || data.snippet;
    if (!code) return null;
    const header = [
      data.qualified_name && `// ${data.label || 'symbol'} ${this.shortQN(data.qualified_name)}`,
      data.file_path && `// ${data.file_path}${data.start_line ? ':' + data.start_line : ''}${data.end_line ? '-' + data.end_line : ''}`,
      data.signature && `// ${data.signature}${data.return_type || ''}`,
    ].filter(Boolean).join('\n');
    let out = `${header}\n${code}`;
    if (withNeighbors) {
      const callers = data.caller_names || [];
      const callees = data.callee_names || [];
      if (callers.length) out += `\n// called by: ${callers.slice(0, 12).join(', ')}`;
      if (callees.length) out += `\n// calls: ${callees.slice(0, 12).join(', ')}`;
    }
    return out;
  }

  async close(): Promise<void> {
    try { await this.client?.close?.(); } catch { /* ignore */ }
    this.client = null; this.ready = false;
  }
}

function realpath(p: string): string {
  try { return fs.realpathSync(p); } catch { return p; }
}

// Process-wide singleton (one engine connection per Bimax process).
export const globalCodemem = new CodememBackend();
export function isCodememReady(): boolean { return globalCodemem.isReady(); }
