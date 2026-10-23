import {
  MeasurementRecorder, MeasurementIntegrityError, serializeSpan, sampleResources,
  providerUsage, USAGE_UNAVAILABLE, SpanRecord, REDACTED, MAX_ATTR_CHARS,
} from '../telemetry/measure';

/**
 * F01's honesty rules, as tests. Each one exists because the corresponding lie is easy to tell with
 * a plausible-looking number: a stage that never ran reported as 0 ms, a character count presented
 * as token usage, or a prompt fragment riding along in an attribute.
 */
describe('measurement recorder — identity and structure', () => {
  it('links task, turn, attempt and round ids down the tree', () => {
    const r = new MeasurementRecorder();
    const task = r.startTask('repair', { fixture: 'C01' });
    const turn = task.child('turn', 'turn-1');
    const attempt = turn.child('attempt', 'attempt-1');
    const round = attempt.child('round', 'provider-round-1');
    const stage = round.child('stage', 'context-assembly');

    expect(task.turnId).toBeNull();
    expect(task.attemptId).toBeNull();
    expect(turn.turnId).not.toBeNull();
    expect(attempt.turnId).toBe(turn.turnId);
    expect(attempt.attemptId).not.toBeNull();
    // A round and its stages inherit the attempt they belong to rather than minting a new one.
    expect(round.attemptId).toBe(attempt.attemptId);
    expect(stage.attemptId).toBe(attempt.attemptId);
    expect(stage.taskId).toBe(task.taskId);

    const spans = r.snapshot();
    expect(spans.map(s => s.kind)).toEqual(['task', 'turn', 'attempt', 'round', 'stage']);
    expect(spans[4].parentId).toBe(round.id);
  });

  it('leaves an unfinished stage null instead of reporting it as zero', () => {
    const r = new MeasurementRecorder();
    const task = r.startTask('task');
    const never = task.child('stage', 'verification-that-never-ran');
    task.end();

    const spans = r.snapshot();
    const open = spans.find(s => s.name === 'verification-that-never-ran')!;
    expect(open.endMs).toBeNull();
    expect(open.durationMs).toBeNull();
    // The unfinished stage is visible, not silently missing from the record.
    expect(r.openSpans().map(s => s.name)).toEqual(['verification-that-never-ran']);
    expect(never.ended).toBe(false);
    // And the stage that did run has a real number.
    expect(spans.find(s => s.name === 'task')!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('end() is idempotent so a try/finally double-end cannot restate a duration', () => {
    const r = new MeasurementRecorder();
    const task = r.startTask('task');
    task.end();
    const first = r.snapshot()[0].durationMs;
    task.end();
    expect(r.snapshot()[0].durationMs).toBe(first);
  });

  it('bounds retained spans and reports how many were dropped', () => {
    const r = new MeasurementRecorder({ maxSpans: 5 });
    const task = r.startTask('task');
    for (let i = 0; i < 20; i++) task.child('stage', `s${i}`).end();
    expect(r.snapshot().length).toBe(5);
    expect(r.droppedSpans()).toBe(16); // 21 opened, 5 retained
  });
});

describe('measurement recorder — a character count is never a token count', () => {
  it('keeps streamed characters separate from provider usage', () => {
    const r = new MeasurementRecorder();
    const task = r.startTask('task');
    const round = task.child('round', 'provider-round');
    round.setStreamedChars(4096);
    round.setUsage(providerUsage({ inputTokens: 900, outputTokens: 120, cachedInputTokens: 800 }));
    round.end();

    const span = r.snapshot().find(s => s.kind === 'round')!;
    expect(span.streamedChars).toBe(4096);
    expect(span.usage.source).toBe('provider');
    expect(span.usage.inputTokens).toBe(900);
    expect(span.usage.outputTokens).toBe(120);
    expect(span.usage.cachedInputTokens).toBe(800);
    // Nothing anywhere copied the character count into a token field.
    expect(Object.values(span.usage)).not.toContain(4096);
  });

  it('reports every token field as null when the provider supplied no usage', () => {
    const r = new MeasurementRecorder();
    const task = r.startTask('task');
    const round = task.child('round', 'provider-round');
    round.setStreamedChars(4096);
    round.end();

    const span = r.snapshot().find(s => s.kind === 'round')!;
    expect(span.usage).toEqual(USAGE_UNAVAILABLE);
    expect(span.usage.inputTokens).toBeNull();
    expect(span.streamedChars).toBe(4096);
  });

  it('refuses to serialize token counts the provider never supplied', () => {
    const forged: SpanRecord = {
      id: 'x', parentId: null, taskId: 't', turnId: null, attemptId: null,
      kind: 'round', name: 'forged', startMs: 0, endMs: 1, durationMs: 1,
      attributes: {}, redactedAttributes: 0,
      // The mutant: streamed characters relabelled as tokens while usage stays "unavailable".
      usage: { source: 'unavailable', inputTokens: 4096, outputTokens: null, cachedInputTokens: null, cacheCreationTokens: null },
      streamedChars: 4096, resourcesAtEnd: null,
    };
    expect(() => serializeSpan(forged)).toThrow(MeasurementIntegrityError);
  });

  it('refuses to serialize a claimed provider usage with no counts', () => {
    const forged: SpanRecord = {
      id: 'x', parentId: null, taskId: 't', turnId: null, attemptId: null,
      kind: 'round', name: 'forged', startMs: 0, endMs: 1, durationMs: 1,
      attributes: {}, redactedAttributes: 0,
      usage: { source: 'provider', inputTokens: null, outputTokens: null, cachedInputTokens: null, cacheCreationTokens: null },
      streamedChars: null, resourcesAtEnd: null,
    };
    expect(() => serializeSpan(forged)).toThrow(/without input\/output token counts/);
  });

  it('refuses to serialize a duration on a span that never ended', () => {
    const forged: SpanRecord = {
      id: 'x', parentId: null, taskId: 't', turnId: null, attemptId: null,
      kind: 'stage', name: 'forged', startMs: 0, endMs: null, durationMs: 250,
      attributes: {}, redactedAttributes: 0, usage: USAGE_UNAVAILABLE,
      streamedChars: null, resourcesAtEnd: null,
    };
    expect(() => serializeSpan(forged)).toThrow(/never ended/);
  });
});

describe('measurement recorder — records carry no free text', () => {
  it('redacts an attribute that looks like a prompt or a source fragment', () => {
    const r = new MeasurementRecorder();
    const task = r.startTask('task', {
      model: 'claude-opus-5',
      prompt: 'x'.repeat(MAX_ATTR_CHARS + 1),
      snippet: 'function a() {\n  return secret;\n}',
      rounds: 3,
      cached: true,
    });
    task.end();

    const span = r.snapshot()[0];
    expect(span.attributes.model).toBe('claude-opus-5'); // short scalars survive
    expect(span.attributes.rounds).toBe(3);
    expect(span.attributes.cached).toBe(true);
    expect(span.attributes.prompt).toBe(REDACTED);
    expect(span.attributes.snippet).toBe(REDACTED);
    expect(span.redactedAttributes).toBe(2);
  });

  it('snapshot returns copies, so a caller cannot mutate the retained record', () => {
    const r = new MeasurementRecorder();
    const task = r.startTask('task', { model: 'a' });
    task.end();
    r.snapshot()[0].attributes.model = 'tampered';
    expect(r.snapshot()[0].attributes.model).toBe('a');
  });
});

describe('resource sampling', () => {
  it('reports finite memory and either a finite event-loop delay or null, never NaN', () => {
    const s = sampleResources();
    expect(s.rssBytes).toBeGreaterThan(0);
    expect(s.heapUsedBytes).toBeGreaterThan(0);
    for (const value of [s.eventLoopDelayMs, s.eventLoopDelayMaxMs]) {
      if (value !== null) expect(Number.isFinite(value)).toBe(true);
    }
  });
});
