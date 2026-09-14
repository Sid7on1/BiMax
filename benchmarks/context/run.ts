/**
 * Runs the context benchmark and writes one create-only run record. See DESIGN.md.
 *
 *   npm run bench:context
 *
 * Needs Bun, whose SQLite has FTS5. Set BIMAX_CONTEXT_BENCH_OUT to write the record somewhere other than
 * benchmarks/context/results (a scratch run, for example). Exits 0 for a valid run whatever it scores, and 2
 * for an invalid one.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { performance } from 'perf_hooks';
import { GRADER_VERSION, graderSelfCheck } from './graders';
import type { CaseResult } from './cases';

const ROOT = path.resolve(__dirname, '../..');
const BENCH_DIR = path.join(ROOT, 'benchmarks', 'context');

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-context-bench-'));

  // Every engine-written file (logs, stores, config) lands in the temporary directory, never in the user's
  // real state. This must happen before any engine module loads: the logger picks its directory at import.
  process.env.BIMAX_STATE_DIR = path.join(temp, 'state');
  process.env.BIMAX_BREAKGLASS_DIR = path.join(temp, 'breakglass');

  // No network. A grade must never depend on a provider, and any attempted call makes the run invalid.
  let networkCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    networkCalls++;
    throw new Error('network is disabled in the context benchmark');
  }) as unknown as typeof fetch;

  const selfCheck = graderSelfCheck();
  const { buildCases, BENCHMARK_VERSION, FAMILIES } = await import('./cases');
  const { openSqlite } = await import('../../src/core/sqlite');

  const fts5 = (() => {
    const db = openSqlite(':memory:');
    if (!db) return false;
    try {
      db.exec('CREATE VIRTUAL TABLE fts5_probe USING fts5(x)');
      return true;
    } catch {
      return false;
    } finally {
      db.close();
    }
  })();

  const invalidReasons: string[] = [];
  const failedChecks = selfCheck.filter((check) => !check.ok).map((check) => check.name);
  if (failedChecks.length) invalidReasons.push(`grader self-check failed: ${failedChecks.join('; ')}`);
  if (!fts5) invalidReasons.push('SQLite FTS5 is unavailable on this runtime; run it under Bun');

  const results: CaseResult[] = [];
  if (!invalidReasons.length) {
    for (const benchCase of buildCases(temp)) {
      const started = performance.now();
      const base = { id: benchCase.id, family: benchCase.family, title: benchCase.title };
      try {
        const outcome = await benchCase.run();
        results.push({ ...base, ...outcome, metrics: { ...outcome.metrics, wallMs: Math.round(performance.now() - started) } });
      } catch (error) {
        results.push({ ...base, outcome: 'error', metrics: { wallMs: Math.round(performance.now() - started) }, error: (error as Error).message });
      }
    }
  }

  globalThis.fetch = realFetch;
  if (networkCalls > 0) invalidReasons.push(`${networkCalls} network call(s) were attempted`);

  const gradedResults = results.filter((result) => result.outcome !== 'measured');
  const byFamily = Object.fromEntries(FAMILIES.map((family) => {
    const own = results.filter((result) => result.family === family);
    return [family, {
      passed: own.filter((result) => result.outcome === 'pass').length,
      graded: own.filter((result) => result.outcome !== 'measured').length,
      measured: own.filter((result) => result.outcome === 'measured').length,
      errors: own.filter((result) => result.outcome === 'error').length,
    }];
  }));

  const sourceHash = ['cases.ts', 'graders.ts', 'run.ts']
    .reduce((hash, file) => hash.update(fs.readFileSync(path.join(BENCH_DIR, file))), createHash('sha256'))
    .digest('hex');
  const buildHash = git(['rev-parse', 'HEAD']);
  const endedAt = new Date();
  const runId = `${startedAt.toISOString().replace(/[:.]/g, '-')}_${(buildHash ?? 'nogit').slice(0, 7)}`;
  const cpus = os.cpus();

  const record = {
    schema_version: '1.0',
    benchmark: BENCHMARK_VERSION,
    run_id: runId,
    started_at: startedAt.toISOString(),
    ended_at: endedAt.toISOString(),
    fixture_version: `sha256:${sourceHash}`,
    product: 'bimax-engine',
    product_version: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version as string,
    build_hash: buildHash,
    build_dirty: (git(['status', '--porcelain', '--', 'src', 'benchmarks/context']) ?? '') !== '',
    runtime: { bun: process.versions.bun ?? null, node_compat: process.version, platform: process.platform, arch: process.arch },
    machine: { cpu: cpus[0]?.model ?? 'unknown', cores: cpus.length, memory_gb: Math.round(os.totalmem() / 2 ** 30), os_release: os.release() },
    retrieval: {
      generation_model: 'none: no model is called',
      embedding: 'none: the dense stage is off, the local default',
      reranker: 'none',
      code_lexical: 'SQLite FTS5 bm25',
      memory_lexical: 'in-process BM25',
      summarizer: 'a fixture that keeps nothing',
    },
    validity: { valid: invalidReasons.length === 0, invalid_reasons: invalidReasons, fts5, network_calls: networkCalls },
    grader: { version: GRADER_VERSION, self_check_passed: failedChecks.length === 0, self_check: selfCheck },
    summary: {
      cases: results.length,
      graded: gradedResults.length,
      passed: gradedResults.filter((result) => result.outcome === 'pass').length,
      failed: gradedResults.filter((result) => result.outcome !== 'pass').length,
      measured: results.length - gradedResults.length,
      by_family: byFamily,
    },
    cases: results,
  };

  const outDir = process.env.BIMAX_CONTEXT_BENCH_OUT?.trim() || path.join(BENCH_DIR, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const recordFile = path.join(outDir, `${runId}.json`);
  fs.writeFileSync(recordFile, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  fs.rmSync(temp, { recursive: true, force: true });

  const lines = [
    `Context benchmark ${BENCHMARK_VERSION} — ${record.validity.valid ? 'valid' : `INVALID: ${invalidReasons.join('; ')}`}`,
    '',
    `${'family'.padEnd(16)}${'passed'.padStart(8)}${'measured'.padStart(10)}`,
    ...FAMILIES.map((family) => {
      const row = byFamily[family];
      return `${family.padEnd(16)}${`${row.passed}/${row.graded}`.padStart(8)}${String(row.measured).padStart(10)}`;
    }),
    `${'total'.padEnd(16)}${`${record.summary.passed}/${record.summary.graded}`.padStart(8)}${String(record.summary.measured).padStart(10)}`,
    '',
    ...results.filter((result) => result.outcome === 'fail' || result.outcome === 'error')
      .map((result) => `${result.outcome.toUpperCase().padEnd(6)} ${result.id.padEnd(4)} ${result.title}${result.error ? ` (${result.error})` : ''}`),
    '',
    `record: ${recordFile.startsWith(ROOT + path.sep) ? path.relative(ROOT, recordFile) : recordFile}`,
  ];
  process.stdout.write(lines.join('\n') + '\n');
  process.exitCode = record.validity.valid ? 0 : 2;
}

main().catch((error) => {
  process.stderr.write(`context benchmark crashed: ${(error as Error).stack ?? error}\n`);
  process.exitCode = 1;
});
