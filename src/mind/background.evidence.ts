import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { getTracer, SpanContext } from '../telemetry/trace';
import { getEpistemicLedger, isEvidenceCommand, outputFilePaths, coverageExecutedPaths, EVIDENCE_OUTPUT_MAX_CHARS } from './epistemic.ledger';
import { getEventLedger } from './event.ledger';
import { mindSingletonRoot } from './self.model';
import { claimPath } from './outcome.sensor';

/** Hash using the filesystem's measured block size; never retain the whole file. */
function fingerprint(file: string): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile()) return null;
    // The live probe showed ctime-only metadata churn with identical bytes/inode/mtime.
    // Bind content plus file identity and modification time; ctime is not a content version.
    const identity = (s: typeof before) => [s.dev, s.ino, s.size, s.mtimeNs].join(':');
    const buffer = Buffer.alloc(Number(before.blksize));
    if (!buffer.length) return null;
    const hash = createHash('sha256');
    let n: number;
    while ((n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, n));
    const after = fs.fstatSync(fd, { bigint: true });
    if (identity(before) !== identity(after)) return null;
    return `${identity(after)}:${hash.digest('hex')}`;
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

/**
 * Delayed evidence is bound to launch-time identities and file state. This separate
 * root span outlives the originating AgentLoop; origin is an explicit link, not a
 * forged parent relation. The strict span-tree attributor deliberately does not
 * infer across this link. Live settlement uses captured IDs and exact diagnostic scope.
 */
export function beginBackgroundEvidence(command: string, cwd: string, origin?: SpanContext) {
  if (!origin?.traceId || !origin.spanId || !isEvidenceCommand(command)) return undefined;
  const root = mindSingletonRoot();
  // A project singleton must never score work in a different project.
  if (cwd !== root && !claimPath(path.join(cwd, '.scope'), root, root)) return undefined;
  const ledger = getEpistemicLedger();
  const events = getEventLedger();
  const claims = ledger.claimSnapshot();
  const captured = claims.filter(c => c.id && c.file && claimPath(c.file, root, root) === c.file
    && claims.filter(other => other.file === c.file).length === 1)
    .map(c => ({ id: c.id!, file: c.file!, fingerprint: fingerprint(path.join(root, c.file!)) }));
  const span = getTracer().startSpan('verify_background BashTool', {
    'gen_ai.operation.name': 'verify_background',
    'bimax.origin.trace_id': origin.traceId, 'bimax.origin.span_id': origin.spanId,
    'bimax.evidence.claim_ids': captured.map(c => c.id),
  });
  // Same input ceiling as outputFilePaths. Truncation declines settlement instead
  // of pretending that a bounded tail is complete verifier output.
  const output = { stdout: '', stderr: '' };
  let truncated = false;
  let finished = false;
  return {
    append(chunk: string, channel: 'stdout' | 'stderr' = 'stdout') {
      if (finished || truncated) return;
      if (output.stdout.length + output.stderr.length + chunk.length > EVIDENCE_OUTPUT_MAX_CHARS) { truncated = true; return; }
      output[channel] += chunk;
    },
    finish(taskId: string, exitCode: number | null, completed: boolean) {
      if (finished) return;
      finished = true;
      const diagnostic = `${output.stdout}\n${output.stderr}`;
      const files = [...new Set(outputFilePaths(diagnostic).map(f => claimPath(f, cwd, root)).filter((f): f is string => !!f))];
      const before = ledger.stats();
      const current = ledger.claimSnapshot();
      const fingerprints = captured.map(c => ({ ...c, current: fingerprint(path.join(root, c.file)) }));
      const eligible = fingerprints.filter(c => c.fingerprint !== null
        && c.current === c.fingerprint
        && !current.some(other => other.file === c.file && other.id !== c.id));
      // A green run carries no per-file result to scope itself with: measured under piped
      // capture, `node --test` reports only test names on success and jest only aggregate
      // counts, while both name paths on failure. Positive scope therefore comes solely
      // from the runner's own execution attestation (LCOV). Bimax must never add coverage
      // flags to the model's command in order to manufacture that attestation.
      const green = completed && exitCode === 0 && !truncated;
      const attested = green
        ? [...new Set(coverageExecutedPaths(diagnostic).map(f => claimPath(f, cwd, root)).filter((f): f is string => !!f))]
        : [];
      const scope = (green ? attested : files).filter(f => eligible.some(c => c.file === f));
      const valid = completed && !truncated && Number.isInteger(exitCode)
        && (green ? scope.length > 0 : exitCode! > 0);
      const reason = valid ? null
        : !completed ? 'incomplete-or-cancelled'
        : truncated ? 'truncated-output'
        : !Number.isInteger(exitCode) ? 'missing-exit-code'
        : green && attested.length === 0 ? 'no-execution-attestation'
        : green ? 'attestation-covers-no-claim'
        : 'invalid-exit-code';
      const resolution = valid ? ledger.resolveDetailed(green, {
        command, output: diagnostic, claimIds: eligible.map(c => c.id), exactFiles: scope,
      }) : null;
      ledger.saveNow();
      span.setAttributes({
        'bimax.task.id': taskId, 'bimax.evidence.output_files': files,
        'bimax.evidence.attested_files': attested,
        'bimax.evidence.files': valid ? scope : [], 'bimax.evidence.settled': resolution?.settled ?? 0,
        'bimax.evidence.truncated': truncated,
      });
      if (exitCode !== null) span.setAttribute('bimax.evidence.exit_code', exitCode);
      if (reason) span.setAttribute('bimax.evidence.skip_reason', reason);
      if (valid) span.setAttribute('bimax.evidence.ok', green);
      events.append(valid ? 'evidence' : 'evidence_skipped', {
        ...span.context, origin, taskId, kind: 'background', command, exitCode,
        ok: exitCode === 0, outputFiles: files, attestedFiles: attested, claimIds: eligible.map(c => c.id),
        settled: resolution?.settled ?? 0, coveredFiles: resolution?.coveredFiles ?? [],
        reason, fingerprints, before, after: ledger.stats(),
      });
      span.end(valid || exitCode === 0 ? 'ok' : 'error');
    },
  };
}

