import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { observeClaim, observeCommandOutcome, claimPath, commandOutput } from '../outcome.sensor';
import { EpistemicLedger, __setEpistemicLedger } from '../epistemic.ledger';
import { EventLedger, __setEventLedger } from '../event.ledger';
import * as selfModel from '../self.model';
import { Span, AttrValue, toOtlpJson } from '../../telemetry/trace';

function capture(id: string) {
  const attributes: Record<string, AttrValue> = {};
  const span: Span = { context: { traceId: 'live-test', spanId: id },
    setAttribute: (k, v) => { attributes[k] = v; },
    setAttributes: values => { Object.assign(attributes, values); }, end: () => {} };
  return { span, attributes };
}

describe('reachable command outcome sensor', () => {
  let root: string, ledger: EpistemicLedger, events: EventLedger;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-sensor-'));
    jest.spyOn(selfModel, 'mindSingletonRoot').mockReturnValue(root);
    ledger = new EpistemicLedger(root); events = new EventLedger(root);
    __setEpistemicLedger(ledger); __setEventLedger(events);
  });
  afterEach(() => {
    ledger.saveNow(); __setEpistemicLedger(null); __setEventLedger(null);
    jest.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true });
  });
  it('decodes Bash JSON output, persists an exact-file refutation and records the transition', () => {
    observeClaim(capture('edit').span, 'WriteFileTool', 'ts', 0.8, 'src/a.ts', root);
    const check = capture('check');
    const result = observeCommandOutcome(check.span, { command: 'npx tsc src/a.ts',
      result: JSON.stringify({ stdout: '', stderr: '\nsrc/a.ts(1,1): error TS2322: wrong type\n' }),
      exitCode: 2, background: false, cwd: root });
    expect(result?.settled).toBe(1);
    expect(check.attributes['bimax.evidence.files']).toEqual(['src/a.ts']);
    expect(new EpistemicLedger(root).stats()).toMatchObject({ open: 0, resolved: 1 });
    expect(events.byType('evidence')[0].payload).toMatchObject({
      spanId: 'check', before: { open: 1, resolved: 0 }, after: { open: 0, resolved: 1 },
    });
  });
  it('red output naming no files retains the claim even when the command names it', () => {
    observeClaim(capture('edit').span, 'WriteFileTool', 'ts', 0.8, 'src/a.ts', root);
    const check = capture('check');
    const result = observeCommandOutcome(check.span, { command: 'npx tsc src/a.ts',
      result: JSON.stringify({ stderr: 'compiler unavailable' }), exitCode: 1, background: false, cwd: root });
    expect(result?.settled).toBe(0);
    expect(check.attributes['bimax.evidence.files']).toEqual([]);
    expect(new EpistemicLedger(root).stats()).toMatchObject({ open: 1, resolved: 0 });
  });
  it.each([{ background: true, exitCode: 0 }, { background: false, exitCode: undefined },
    { background: false, exitCode: NaN }, { background: false, exitCode: -1 }])('does not score incomplete execution %j', args => {
    const check = capture('check');
    expect(observeCommandOutcome(check.span, { command: 'npm test', result: 'src/a.ts: error', cwd: root, ...args })).toBeNull();
    expect(check.attributes).toEqual({}); expect(events.count()).toBe(0);
  });
  it('does not upgrade a green mention into scoped trace verification', () => {
    const check = capture('check');
    observeCommandOutcome(check.span, { command: 'npm test', result: 'src/a.ts', exitCode: 0, background: false, cwd: root });
    expect(check.attributes['bimax.evidence.output_files']).toEqual(['src/a.ts']);
    expect(check.attributes['bimax.evidence.files']).toEqual([]);
  });
  it('normalizes exact project-relative paths, excludes outside paths and preserves OTLP arrays', () => {
    expect(claimPath(path.join(root, 'src/a.ts'), root, root)).toBe('src/a.ts');
    expect(claimPath('../a.ts', root, root)).toBeUndefined();
    expect(commandOutput('{"stdout":"a\\nb","stderr":"c"}')).toBe('a\nb\nc');
    const encoded = JSON.stringify(toOtlpJson([{ traceId: 't', spanId: 's', name: 'test',
      startTimeUnixNano: '0', endTimeUnixNano: '1', status: 'ok', attributes: { files: ['src/a.ts'] } }]));
    expect(JSON.parse(encoded).resourceSpans[0].scopeSpans[0].spans[0].attributes[0].value)
      .toEqual({ arrayValue: { values: [{ stringValue: 'src/a.ts' }] } });
  });
});
