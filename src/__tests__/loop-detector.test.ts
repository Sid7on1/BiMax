import { LoopDetector } from '../core/loop-detector';

describe('LoopDetector — interleaved repeats', () => {
  it('fires a hard signal when the SAME call recurs non-consecutively (the thrash bug)', () => {
    const d = new LoopDetector();
    // Model interleaves: read evaluator, then other files, then evaluator again, … never twice in a
    // row. The old "N-in-a-row" check missed this; the count-in-window check must catch it.
    const others = ['a.ts', 'b.ts', 'c.ts'];
    let hard = null as ReturnType<LoopDetector['record']>;
    for (let i = 0; i < 4; i++) {
      d.record('Read', JSON.stringify({ path: 'evaluator.ts' }), 'contents');
      const sig = d.record('Read', JSON.stringify({ path: others[i % others.length] }), 'contents');
      if (sig?.severity === 'hard') hard = sig; // a filler read should never be the hard trigger
    }
    // The 4th interleaved evaluator read is the hard stop.
    const last = d.record('Read', JSON.stringify({ path: 'evaluator.ts' }), 'contents');
    expect(last?.severity).toBe('hard');
    expect(last?.type).toBe('generic_repeat');
  });

  it('does not fire for a normal read → edit → re-read (2 identical reads)', () => {
    const d = new LoopDetector();
    expect(d.record('Read', '{"path":"x.ts"}', 'v1')).toBeNull();
    d.record('Edit', '{"path":"x.ts"}', 'ok');
    expect(d.record('Read', '{"path":"x.ts"}', 'v2')).toBeNull();
  });
});

describe('LoopDetector — error thrashing (varying args, repeated failure)', () => {
  it('fires when the same tool keeps ERRORING with DIFFERENT args', () => {
    const d = new LoopDetector();
    // A classic edit-match spiral: the model tweaks the old_string each time, and each attempt fails.
    // generic_repeat can't see this because the args differ every time.
    let sig = null as ReturnType<LoopDetector['record']>;
    for (let i = 0; i < 4; i++) {
      sig = d.record('EditFileTool', JSON.stringify({ old: `attempt-${i}` }), 'Tool Error: no match found', true);
    }
    expect(sig?.type).toBe('error_thrashing');
    expect(sig?.severity).toBe('hard');
    expect(sig?.tool).toBe('EditFileTool');
  });

  it('escalates soft → hard as failures accumulate', () => {
    const d = new LoopDetector();
    expect(d.record('BashTool', '{"cmd":"a"}', 'err', true)).toBeNull();          // 1 fail
    expect(d.record('BashTool', '{"cmd":"b"}', 'err', true)).toBeNull();          // 2 fails
    expect(d.record('BashTool', '{"cmd":"c"}', 'err', true)?.severity).toBe('soft'); // 3 → soft
  });

  it('does not fire when the calls SUCCEED (isError=false), even with repeated tool', () => {
    const d = new LoopDetector();
    for (let i = 0; i < 6; i++) {
      const sig = d.record('BashTool', JSON.stringify({ cmd: `step-${i}` }), 'ok', false);
      expect(sig).toBeNull();
    }
  });

  it('infers failure from result text when isError is omitted', () => {
    const d = new LoopDetector();
    let sig = null as ReturnType<LoopDetector['record']>;
    for (let i = 0; i < 4; i++) {
      sig = d.record('EditFileTool', JSON.stringify({ old: `v${i}` }), 'Tool Error: could not apply edit');
    }
    expect(sig?.type).toBe('error_thrashing');
  });
});

describe('LoopDetector — visual provider progress', () => {
  const result = (frameHash: string) => JSON.stringify({ ok: true, action: 'click', frameHash, screenshot: `/tmp/${Date.now()}.png` });

  it('allows repeated visual actions while the captured pixels keep changing', () => {
    const d = new LoopDetector();
    for (let i = 0; i < 500; i++) {
      expect(d.record('HostVisionTool', '{"action":"click","x":10,"y":10}', result(`frame-${i}`))).toBeNull();
    }
  });

  it('detects a visual action polling the same unchanged frame', () => {
    const d = new LoopDetector();
    const args = '{"action":"observe"}';
    expect(d.record('HostVisionTool', args, result('same-frame'))).toBeNull();
    expect(d.record('HostVisionTool', args, result('same-frame'))).toBeNull();
    expect(d.record('HostVisionTool', args, result('same-frame'))?.type).toBe('no_progress_poll');
  });

  it('is not defeated by a volatile field in an otherwise identical result', () => {
    // The screenshot path changes every call while the frame does not — which is what a real visual
    // tool emits. Hashing the WHOLE result made this poll invisible: the two guards cancelled out
    // (frameHash suppresses generic_repeat, and no_progress_poll never matched because the path
    // differed), so a vision tool stuck on one frame was caught by nothing. Explicit counters here
    // rather than Date.now(), which made the test above pass or fail on millisecond boundaries.
    const d = new LoopDetector();
    const args = '{"action":"observe"}';
    const withPath = (n: number) =>
      JSON.stringify({ ok: true, action: 'click', frameHash: 'frozen', screenshot: `/tmp/frame-${n}.png` });

    expect(d.record('HostVisionTool', args, withPath(1))).toBeNull();
    expect(d.record('HostVisionTool', args, withPath(2))).toBeNull();
    expect(d.record('HostVisionTool', args, withPath(3))?.type).toBe('no_progress_poll');
  });

  it('still allows progress when the frame changes but the path does not', () => {
    // The mirror image: identical result envelope, moving frame. Must stay silent.
    const d = new LoopDetector();
    const args = '{"action":"observe"}';
    const withFrame = (n: number) =>
      JSON.stringify({ ok: true, action: 'click', frameHash: `frame-${n}`, screenshot: '/tmp/fixed.png' });

    for (let i = 0; i < 20; i++) {
      expect(d.record('HostVisionTool', args, withFrame(i))).toBeNull();
    }
  });
});
