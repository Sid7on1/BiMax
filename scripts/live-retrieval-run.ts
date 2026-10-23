/**
 * Assertion-based live retrieval evidence journey.
 *
 * Required:
 *   BIMAX_RETRIEVAL_EVIDENCE_DIR=/absolute/artifact/dir NVIDIA_API_KEY=... \
 *     npx tsx scripts/live-retrieval-run.ts
 *
 * The command never treats a 200 response or a printed hit list as proof. It writes a run record
 * and exits non-zero unless expected files are in top-3, dense+rerank actually ran, active-space
 * coverage is complete, and the meaning margin clears its floor. Keys and source text are omitted.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { loadConfig } from '../src/engine/config';
import { ApiKeyManager } from '../src/credits/api.key.manager';
import { buildKeyPool } from '../src/engine/provider';
import { CodeIndex } from '../src/memory/code.index';
import { RemoteEmbeddingBackend, dot } from '../src/memory/embeddings';
import { RemoteReranker } from '../src/memory/rerank';
import { resolveMemorySettings, rerankURLFor } from '../src/memory/settings';

const MIN_MARGIN = 0.05;
const SOURCE_ROOT = path.resolve(__dirname, '..');
const SOURCES = [
  'src/memory/fusion.ts',
  'src/engine/commands/retrieval.ts',
  'src/memory/vector.store.ts',
  'src/memory/code.index.ts',
  'src/memory/sqlite.code.store.ts',
  'src/memory/embeddings.ts',
  'src/memory/rerank.ts',
  'src/memory/settings.ts',
];
const CASES = [
  { query: 'where do ranked lists from two retrievers become one', expected: 'src/memory/fusion.ts' },
  { query: 'the probe command proving embeddings are live', expected: 'src/engine/commands/retrieval.ts' },
  { query: 'keep two copies of the same fact from filling the store', expected: 'src/memory/vector.store.ts' },
];

function sha256(parts: string[]): string {
  const hash = crypto.createHash('sha256');
  for (const part of parts) hash.update(part).update('\0');
  return hash.digest('hex');
}

async function main(): Promise<void> {
  const evidenceDir = process.env.BIMAX_RETRIEVAL_EVIDENCE_DIR;
  if (!evidenceDir || !path.isAbsolute(evidenceDir)) {
    throw new Error('BIMAX_RETRIEVAL_EVIDENCE_DIR must be absolute so the raw run is preserved');
  }
  await loadConfig();
  const keys = buildKeyPool();
  if (!keys.length) throw new Error('no provider key available in this shell');

  const startedAt = new Date().toISOString();
  const runId = `retrieval-${startedAt.replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-live-retrieval-'));
  const corpusRoot = path.join(tmp, 'corpus');
  for (const rel of SOURCES) {
    const dest = path.join(corpusRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(SOURCE_ROOT, rel), dest);
  }

  const settings = resolveMemorySettings();
  const manager = new ApiKeyManager(keys);
  const resolveKey = async () => {
    const key = await manager.getNextKey();
    if (!key.keyStr) return null;
    const baseURL = key.baseURL || 'https://integrate.api.nvidia.com/v1';
    return { apiKey: key.keyStr, baseURL, rerankURL: rerankURLFor(baseURL) };
  };
  const embeddings = new RemoteEmbeddingBackend({
    resolve: resolveKey,
    model: settings.embeddingModel,
    dimensions: settings.embeddingDimensions,
  });
  const reranker = new RemoteReranker({ resolve: resolveKey, model: settings.rerankModel });
  const record: any = {
    schema: 'bimax.retrieval-evidence.v1',
    runId,
    startedAt,
    finishedAt: null,
    status: 'fail',
    sourceHash: sha256(SOURCES.flatMap((rel) => [rel, fs.readFileSync(path.join(SOURCE_ROOT, rel), 'utf8')])),
    scriptHash: sha256([fs.readFileSync(__filename, 'utf8')]),
    models: { embedding: embeddings.id, reranker: settings.rerankModel },
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    acceptance: { topK: 3, minMargin: MIN_MARGIN, requiredStages: ['dense', 'reranked'] },
    sync: null,
    cases: [],
    margin: null,
    rerankerControl: null,
    failures: [] as string[],
  };

  try {
    const index = new CodeIndex(embeddings, reranker, {
      root: corpusRoot,
      storePath: path.join(tmp, 'live-index.db'),
    });
    const syncStarted = Date.now();
    const sync = await index.sync(100);
    const stats = index.stats();
    record.sync = { ...sync, ...stats, wallMs: Date.now() - syncStarted };
    if (sync.pending !== 0) record.failures.push(`sync left ${sync.pending} file(s) pending`);
    if (stats.chunks === 0 || stats.embedded !== stats.chunks) {
      record.failures.push(`active-space coverage ${stats.embedded}/${stats.chunks}`);
    }

    for (const fixture of CASES) {
      const t0 = Date.now();
      const hits = await index.search(fixture.query, 3);
      const mode = index.stats().lastMode;
      const actual = hits.map((hit) => hit.path);
      const passed = actual.includes(fixture.expected) && mode.dense && mode.reranked;
      record.cases.push({ ...fixture, actual, mode, wallMs: Date.now() - t0, passed });
      if (!actual.includes(fixture.expected)) record.failures.push(`missing ${fixture.expected} for: ${fixture.query}`);
      if (!mode.dense || !mode.reranked) record.failures.push(`required stages absent for: ${fixture.query}`);
    }

    const passages = await embeddings.embed([
      'CI is red on main after the last merge',
      'the sidebar corner radius interpolates from 22px to 14px',
    ], 'passage');
    const query = await embeddings.embed(['the build is failing'], 'query');
    if (!passages || !query) {
      record.failures.push(`embedding control unavailable: ${embeddings.unavailableReason() ?? 'unknown'}`);
    } else {
      const paraphrase = dot(query[0], passages[0]);
      const unrelated = dot(query[0], passages[1]);
      const margin = paraphrase - unrelated;
      record.margin = { paraphrase, unrelated, margin, passed: margin >= MIN_MARGIN };
      if (margin < MIN_MARGIN) record.failures.push(`meaning margin ${margin.toFixed(4)} below ${MIN_MARGIN}`);

      const ranked = await reranker.rerank('the build is failing', [
        { id: 'paraphrase', text: 'CI is red on main after the last merge' },
        { id: 'unrelated', text: 'the sidebar corner radius interpolates from 22px to 14px' },
      ]);
      record.rerankerControl = { order: ranked?.map((item) => item.id) ?? [], passed: ranked?.[0]?.id === 'paraphrase' };
      if (ranked?.[0]?.id !== 'paraphrase') record.failures.push('reranker did not rank the paraphrase first');
    }

    record.status = record.failures.length ? 'fail' : 'pass';
  } catch (error: any) {
    record.failures.push(error?.message ?? String(error));
  } finally {
    record.finishedAt = new Date().toISOString();
    fs.mkdirSync(evidenceDir, { recursive: true });
    const artifact = path.join(evidenceDir, `${runId}.json`);
    fs.writeFileSync(artifact, JSON.stringify(record, null, 2), { encoding: 'utf8', flag: 'wx' });
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`Retrieval evidence: ${record.status.toUpperCase()} — ${artifact}`);
    for (const failure of record.failures) console.error(`- ${failure}`);
  }

  if (record.status !== 'pass') process.exitCode = 1;
}

main().catch((error) => {
  console.error(`LIVE RUN FAILED BEFORE ARTIFACT: ${error?.message ?? error}`);
  process.exitCode = 1;
});
