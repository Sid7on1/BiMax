import { stateDir } from '../utils/state.dir';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as readline from 'readline';
import { openSqlite } from '../core/sqlite';
import { CLAIM_TTL_MS } from './epistemic.ledger';
import { attributeTrace, operationOf, TraceEpisode, TraceSpan } from './trace.attribution';
import { expectedCalibrationError, isotonicFit } from './stats';

/** Streaming reader for observational episodes; these must never enter ReplayProvider. */
export async function* readTraceEpisodes(root: string): AsyncGenerator<TraceEpisode> {
  const file = path.join(stateDir('.bimax', root), 'episodes', 'mined', 'trace-outcomes.jsonl');
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const ep = JSON.parse(line);
    if (ep.kind !== 'trace-outcomes' || ep.version !== 1 || ep.replayable !== false) throw new Error('invalid observational episode');
    yield ep;
  }
}

function validSpan(value: unknown): value is TraceSpan {
  if (!value || typeof value !== 'object') return false;
  const s = value as Partial<TraceSpan>;
  return typeof s.traceId === 'string' && s.traceId.length > 0 && typeof s.spanId === 'string' && s.spanId.length > 0
    && typeof s.name === 'string' && typeof s.status === 'string'
    && (s.parentSpanId === undefined || typeof s.parentSpanId === 'string')
    && !!s.attributes && typeof s.attributes === 'object' && !Array.isArray(s.attributes)
    && typeof s.startTimeUnixNano === 'string' && /^\d+$/.test(s.startTimeUnixNano)
    && typeof s.endTimeUnixNano === 'string' && /^\d+$/.test(s.endTimeUnixNano)
    && BigInt(s.endTimeUnixNano) >= BigInt(s.startTimeUnixNano);
}

/**
 * Disk-index first, then one bounded trace at a time, independent of JSONL ordering.
 * The caller supplies the trace bound; oversized/conflicting traces are quarantined,
 * never split into apparently valid trees. SQLite cache uses its engine default.
 * Outputs are rebuilt, not appended: reruns cannot count old spans twice.
 */
export async function mineTraces(root: string, opts: { asOfMs: number; maxTraceSpans: number }) {
  if (!Number.isSafeInteger(opts.maxTraceSpans) || opts.maxTraceSpans < 1 || !Number.isFinite(opts.asOfMs)) throw new Error('invalid mining bounds');
  const dir = path.join(stateDir('.bimax', root), 'episodes', 'mined');
  fs.mkdirSync(dir, { recursive: true });
  // Exclusive lock prevents two miners publishing mismatched snapshots.
  const lock = path.join(dir, '.trace-miner.lock');
  const lockFd = fs.openSync(lock, 'wx');
  const tmp = fs.mkdtempSync(path.join(dir, '.trace-miner-'));
  const db = openSqlite(path.join(tmp, 'index.db'));
  const bump = (map: Record<string, number>, key: string, n = 1) => { map[key] = (map[key] ?? 0) + n; };
  const report = {
    schemaVersion: 1, kind: 'historical-trace-mining', asOfMs: opts.asOfMs,
    maxTraceSpans: opts.maxTraceSpans, claimTtlMs: CLAIM_TTL_MS,
    files: [] as { file: string; sha256: string; lines: number; bytes: number }[],
    lines: 0, malformed: 0, duplicates: 0, uniqueSpans: 0, futureSpans: 0,
    episodes: 0, agentSpans: 0, quarantinedSpans: 0, peakTraceSpans: 0,
    attributes: {} as Record<string, number>,
    operations: {} as Record<string, number>, models: {} as Record<string, number>,
    execution: {} as Record<string, number>, reasons: {} as Record<string, number>,
    claims: { total: 0, resolved: 0, expired: 0, open: 0, expiryRate: null as number | null },
    attribution: { attributed: 0, unattributed: 0, uncoveredFraction: null as number | null },
    holdout: { decisions: 0, effect: null, confidenceInterval: null,
      reason: 'No trace-to-policy assignment contract. Retrospective randomization cannot measure an intervention.' },
    calibration: {} as Record<string, unknown>,
    replayableEpisodes: 0,
    limitations: [
      'Execution status is not verified task success or causal blame.',
      'Only complete same-agent ancestry plus explicit exact-file verification can label a claim.',
      'Missing scope, multiple mutations, orphan/cyclic ancestry, cross-agent and cross-trace evidence remain unattributed.',
      'No LLM requests, responses, tool arguments, or results are reconstructed; replay/harness evaluation remains unavailable.',
      'Corpus model/provider/fixture provenance is not sufficient for a production or competitive claim.',
      'Import is explicit/offline; no live observer or prompt intervention is activated.',
    ],
  };
  try {
    if (!db) throw new Error('SQLite unavailable; refusing a silent no-op mining pass');
    db.exec('CREATE TABLE spans (trace TEXT, id TEXT, body TEXT, PRIMARY KEY(trace,id)); CREATE TABLE conflicts (trace TEXT PRIMARY KEY)');
    const insert = db.prepare('INSERT INTO spans VALUES (?,?,?)');
    const lookup = db.prepare('SELECT body FROM spans WHERE trace=? AND id=?');
    const conflict = db.prepare('INSERT OR IGNORE INTO conflicts VALUES (?)');
    const traceDir = path.join(stateDir('.bimax', root), 'traces');
    for (const file of fs.readdirSync(traceDir).filter(f => f.endsWith('.jsonl')).sort()) {
      const input = fs.createReadStream(path.join(traceDir, file));
      const hash = crypto.createHash('sha256');
      let bytes = 0;
      input.on('data', chunk => { hash.update(chunk); bytes += chunk.length; });
      const lines = readline.createInterface({ input, crlfDelay: Infinity });
      let count = 0;
      db.exec('BEGIN');
      try {
        for await (const line of lines) {
          if (!line.trim()) continue;
          count++; report.lines++;
          let s: TraceSpan;
          try { s = JSON.parse(line); if (!validSpan(s)) throw new Error('invalid'); }
          catch { report.malformed++; continue; }
          if (Number(BigInt(s.endTimeUnixNano) / 1_000_000n) > opts.asOfMs) { report.futureSpans++; continue; }
          // Canonicalize key ordering for duplicate detection without altering raw provenance hashes.
          const body = JSON.stringify(s, (_, value) => value && typeof value === 'object' && !Array.isArray(value)
            ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value);
          const old = lookup.get(s.traceId, s.spanId);
          if (old) {
            report.duplicates++;
            if (old.body !== body) conflict.run(s.traceId);
            continue;
          }
          insert.run(s.traceId, s.spanId, body);
          report.uniqueSpans++;
          bump(report.operations, operationOf(s));
          for (const key of Object.keys(s.attributes)) bump(report.attributes, key);
          const model = s.attributes['gen_ai.request.model'];
          if (typeof model === 'string') bump(report.models, model);
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      report.files.push({ file, sha256: hash.digest('hex'), lines: count, bytes });
    }
    const nextTrace = db.prepare('SELECT trace, COUNT(*) AS n FROM spans WHERE trace > ? GROUP BY trace ORDER BY trace LIMIT 1');
    const traceRows = db.prepare('SELECT body FROM spans WHERE trace=? ORDER BY id');
    const conflictRow = db.prepare('SELECT trace FROM conflicts WHERE trace=?');
    const bins = new Map<number, { n: number; correct: number }>();
    const output = path.join(tmp, 'trace-outcomes.jsonl');
    const fd = fs.openSync(output, 'wx');
    let cursor = '';
    try {
      while (true) {
        const row = nextTrace.get(cursor);
        if (!row) break;
        cursor = row.trace;
        if (row.n > opts.maxTraceSpans || conflictRow.get(cursor)) {
          report.quarantinedSpans += Number(row.n);
          bump(report.reasons, row.n > opts.maxTraceSpans ? 'trace-over-memory-bound' : 'conflicting-span-identity', Number(row.n));
          continue;
        }
        const spans: TraceSpan[] = traceRows.all(cursor).map(r => JSON.parse(r.body));
        report.peakTraceSpans = Math.max(report.peakTraceSpans, spans.length);
        const episode = attributeTrace(spans, opts.asOfMs, CLAIM_TTL_MS);
        fs.writeSync(fd, JSON.stringify(episode) + '\n');
        report.episodes++;
        for (const op of episode.operations) {
          if (op.operation === 'invoke_agent') report.agentSpans++;
          bump(report.execution, `${op.operation}:${op.execution}`);
          bump(report.reasons, op.reason);
          report.attribution[op.attribution === 'unattributed' ? 'unattributed' : 'attributed']++;
          if (op.confidence !== null) {
            report.claims.total++;
            if (op.claim === 'expired') report.claims.expired++;
            else if (op.claim === 'open') report.claims.open++;
            else if (op.claim === 'verified' || op.claim === 'refuted') {
              report.claims.resolved++;
              const bin = bins.get(op.confidence) ?? { n: 0, correct: 0 };
              bin.n++; bin.correct += Number(op.claim === 'verified'); bins.set(op.confidence, bin);
            }
          }
        }
      }
    } finally { fs.closeSync(fd); }
    report.claims.expiryRate = report.claims.total ? report.claims.expired / report.claims.total : null;
    report.attribution.uncoveredFraction = report.uniqueSpans
      ? (report.attribution.unattributed + report.quarantinedSpans) / report.uniqueSpans : null;
    const points = [...bins].sort(([a], [b]) => a - b).map(([x, b]) => ({ x, y: b.correct / b.n, w: b.n }));
    report.calibration = {
      before: { n: 0, ece: null, curve: [], reason: 'No labeled trace claims imported before this pass; not the live epistemic ledger.' },
      after: { n: report.claims.resolved,
        ece: points.length ? expectedCalibrationError(points.map(p => ({ conf: p.x, acc: p.y, w: p.w }))) : null,
        curve: isotonicFit(points), empirical: points,
        reason: points.length ? 'Descriptive import calibration only; no held-out improvement experiment.' : 'No scoped verification labels in corpus.' },
      improvement: null,
    };
    // Episode digest lets readers detect an interrupted publication between these two renames.
    const episodeHash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(output)) episodeHash.update(chunk);
    const finalReport = { ...report, episodesSha256: episodeHash.digest('hex') };
    fs.writeFileSync(path.join(tmp, 'trace-mining-report.json'), JSON.stringify(finalReport, null, 2) + '\n');
    fs.renameSync(output, path.join(dir, 'trace-outcomes.jsonl'));
    fs.renameSync(path.join(tmp, 'trace-mining-report.json'), path.join(dir, 'trace-mining-report.json'));
    return finalReport;
  } finally {
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.closeSync(lockFd);
    fs.unlinkSync(lock);
  }
}
