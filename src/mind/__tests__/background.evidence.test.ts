import fs = require('fs');
import * as os from 'os';
import * as path from 'path';
import * as self from '../self.model';
import { beginBackgroundEvidence } from '../background.evidence';
import { EpistemicLedger, __setEpistemicLedger, EVIDENCE_OUTPUT_MAX_CHARS, coverageExecutedPaths } from '../epistemic.ledger';
import { EventLedger, __setEventLedger } from '../event.ledger';
import { resetTracerForTests } from '../../telemetry/trace';

const origin = { traceId: 'origin', spanId: 'launch' };
describe('background evidence identity and completion gates', () => {
  let root: string, ep: EpistemicLedger, ev: EventLedger;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-bg-evidence-'));
    fs.mkdirSync(path.join(root, 'src')); fs.writeFileSync(path.join(root, 'src/a.ts'), 'export const value = 1;');
    jest.spyOn(self, 'mindSingletonRoot').mockReturnValue(root);
    ep = new EpistemicLedger(root); ev = new EventLedger(root);
    __setEpistemicLedger(ep); __setEventLedger(ev);
    process.env.BIMAX_TRACE_DIR = path.join(root, 'traces');
    ep.openClaim('ts', 0.8, 'src/a.ts'); ep.saveNow();
  });
  afterEach(async () => {
    ep.saveNow(); await resetTracerForTests(); __setEpistemicLedger(null); __setEventLedger(null);
    jest.restoreAllMocks(); delete process.env.BIMAX_TRACE_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  });
  it('does nothing at launch, resolves exact scope at completion, and folds completion once', () => {
    const sensor = beginBackgroundEvidence('tsc src/a.ts', root, origin)!;
    expect(ev.count()).toBe(0); expect(ep.stats().open).toBe(1);
    sensor.append('src/'); sensor.append('a.ts(1,1): error TS1000');
    sensor.finish('task', 1, true); sensor.finish('task', 1, true);
    expect(ep.stats()).toMatchObject({ resolved: 1, open: 0 });
    expect(ev.byType('evidence')).toHaveLength(1);
    expect(new EpistemicLedger(root).stats().resolved).toBe(1);
  });
  it.each(['no-file', 'basename', 'wrong-file', 'late-claim', 'changed-file', 'truncated', 'cancelled', 'missing-exit', 'green', 'cross-stream-fragment'])('refuses %s evidence', reason => {
    const sensor = beginBackgroundEvidence('tsc src/a.ts', root, origin)!;
    if (reason === 'late-claim') ep.openClaim('ts', 0.8, 'src/a.ts');
    if (reason === 'changed-file') fs.writeFileSync(path.join(root, 'src/a.ts'), 'export const value = 2;');
    const output = reason === 'no-file' ? 'compiler unavailable' : reason === 'basename' ? 'a.ts(1,1): error'
      : reason === 'wrong-file' ? 'other/a.ts(1,1): error' : 'src/a.ts(1,1): error';
    if (reason === 'cross-stream-fragment') { sensor.append('src/a'); sensor.append('.ts(1,1): error', 'stderr'); }
    else sensor.append(output);
    if (reason === 'truncated') sensor.append('x'.repeat(EVIDENCE_OUTPUT_MAX_CHARS));
    sensor.finish('task', reason === 'green' ? 0 : reason === 'missing-exit' ? null : 1, reason !== 'cancelled');
    expect(ep.stats().resolved).toBe(0); expect(ep.stats().open).toBeGreaterThan(0);
  });
  it('never captures claims minted after launch', () => {
    ep.resolve(false, { output: 'src/a.ts: old error' });
    const sensor = beginBackgroundEvidence('tsc src/a.ts', root, origin)!;
    ep.openClaim('ts', 0.8, 'src/a.ts'); sensor.append('src/a.ts: error'); sensor.finish('task', 1, true);
    expect(ep.stats()).toMatchObject({ resolved: 1, open: 1 });
  });
  it('does not attach evidence without provenance or outside the owning project', () => {
    expect(beginBackgroundEvidence('tsc', root)).toBeUndefined();
    expect(beginBackgroundEvidence('tsc', path.dirname(root), origin)).toBeUndefined();
  });
  it('keeps the last complete snapshot when atomic replacement fails, then retries', () => {
    ep.openClaim('ts', 0.8, 'src/b.ts');
    const rename = jest.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('simulated rename interruption'); });
    ep.saveNow();
    expect(new EpistemicLedger(root).stats().open).toBe(1);
    rename.mockRestore(); ep.saveNow();
    expect(new EpistemicLedger(root).stats().open).toBe(2);
    expect(fs.readdirSync(path.join(root, '.bimax')).some(f => f.endsWith('.tmp'))).toBe(false);
  });

  // A green run's positive scope comes only from the runner's own execution attestation.
  const attest = (file: string, hit: number) => `TN:\nSF:${file}\nLF:3\nLH:${hit}\nend_of_record\n`;

  it('reads executed files out of an LCOV report, and only those', () => {
    expect(coverageExecutedPaths(attest('src/a.ts', 3))).toEqual(['src/a.ts']);
    // Loaded but nothing ran: an SF record is not by itself verification.
    expect(coverageExecutedPaths(attest('src/a.ts', 0))).toEqual([]);
    // A tail cut before its LH strands the record; an unparsed count is never a hit.
    expect(coverageExecutedPaths('SF:src/a.ts\nLF:3\n')).toEqual([]);
    // A stranded record must not inherit the NEXT record's hit count either.
    expect(coverageExecutedPaths('SF:src/a.ts\nLF:3\nSF:src/b.ts\nLH:2\nend_of_record\n')).toEqual(['src/b.ts']);
    expect(coverageExecutedPaths('SF:src/a.ts\nend_of_record\nLH:9\n')).toEqual([]);
    // Full project-relative paths, never a basename that could match another directory.
    expect(coverageExecutedPaths(attest('src/deep/nested/util.ts', 2))).toEqual(['src/deep/nested/util.ts']);
    expect(coverageExecutedPaths('')).toEqual([]);
    // Bounded by the same ceiling the diagnostic parser uses.
    expect(coverageExecutedPaths('.'.repeat(EVIDENCE_OUTPUT_MAX_CHARS) + attest('src/a.ts', 3))).toEqual([]);
  });

  it('settles a claim on a green run the runner attests executed it, as CORRECT', () => {
    const sensor = beginBackgroundEvidence('tsc src/a.ts', root, origin)!;
    sensor.append(attest('src/a.ts', 3));
    sensor.finish('task', 0, true);
    expect(ep.stats()).toMatchObject({ resolved: 1, open: 0 });
    // Confirmation, not refutation: the claim's decile must record it correct.
    expect(ep.calibration().find(r => r.n > 0)!.observed).toBe(1);
    expect(new EpistemicLedger(root).stats().resolved).toBe(1);
  });

  it.each([
    ['attests another file', 'src/other.ts', 3, 'attestation-covers-no-claim'],
    ['attests the claim file as loaded but never run', 'src/a.ts', 0, 'no-execution-attestation'],
  ])('refuses a green run that %s', (_label, file, hit, reason) => {
    const sensor = beginBackgroundEvidence('tsc src/a.ts', root, origin)!;
    sensor.append(attest(file as string, hit as number));
    sensor.finish('task', 0, true);
    expect(ep.stats()).toMatchObject({ resolved: 0, open: 1 });
    expect(ev.byType('evidence_skipped')[0].payload.reason).toBe(reason);
  });

  it('does not treat a path merely mentioned in passing output as executed', () => {
    const sensor = beginBackgroundEvidence('tsc src/a.ts', root, origin)!;
    // The run names src/a.ts in its own output while attesting only src/other.ts.
    sensor.append('checked src/a.ts against the fixture\n' + attest('src/other.ts', 3));
    sensor.finish('task', 0, true);
    expect(ep.stats()).toMatchObject({ resolved: 0, open: 1 });
    const skipped = ev.byType('evidence_skipped')[0].payload;
    expect(skipped.outputFiles).toContain('src/a.ts');   // it was mentioned
    expect(skipped.attestedFiles).not.toContain('src/a.ts'); // it was not executed
    expect(skipped.reason).toBe('attestation-covers-no-claim');
  });
});
