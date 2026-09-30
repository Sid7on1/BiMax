import fs from 'fs';
import path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { runSummary } from '../renderer/src/run.summary.model';
import { RunSummaryRow, finishTracker } from '../renderer/src/components/Transcript';
import type { TranscriptItem } from '../renderer/src/engine.state';
import type { ReviewSnapshot } from '../renderer/src/protocol';

/**
 * UI fix list items 24 and 41: a step that finishes while you watch settles once, and a run that changed files ends
 * on one line saying what changed and whether it was checked.
 */

const T0 = Date.parse('2026-10-01T10:00:00Z');
const user = (id: string, at: number): TranscriptItem => ({ kind: 'msg', msg: { id, role: 'user', content: 'do it', timestamp: new Date(at).toISOString() } as never });
const reply = (id: string, at: number): TranscriptItem => ({ kind: 'msg', msg: { id, role: 'assistant', content: 'done', timestamp: new Date(at).toISOString() } as never });

function review(over: Partial<ReviewSnapshot> = {}): ReviewSnapshot {
  return {
    sessionId: 's', state: 'unverified', nextAction: '', approvals: [], changes: [], verifications: [], checkpoints: [],
    lastCheckpoint: null, todos: [], interrupted: false, updatedAt: T0, ...over,
  };
}
const change = (file: string, lastAt: number, edits = 1) => ({ file, tools: ['Edit'], edits, lastAt });
const check = (command: string, ok: boolean, at: number, coveredFiles: string[] = [], repoWide = true) => ({ command, ok, settled: 1, coveredFiles, repoWide, at });

const run = [user('u1', T0), reply('a1', T0 + 9000)];

describe('the end of a run (item 41)', () => {
  test('nothing while the run is still going, before any run, or when it changed nothing', () => {
    const r = review({ changes: [change('src/a.ts', T0 + 1000)] });
    expect(runSummary(run, r, true)).toBeNull();
    expect(runSummary([], r, false)).toBeNull();
    expect(runSummary(run, null, false)).toBeNull();
    expect(runSummary(run, review(), false)).toBeNull();
  });

  test('only this run: files edited before the person’s latest message are an earlier run’s', () => {
    const r = review({ changes: [change('src/old.ts', T0 - 60_000), change('src/a.ts', T0 + 1000)] });
    const summary = runSummary(run, r, false)!;
    expect(summary.files.map((f) => f.file)).toEqual(['src/a.ts']);
    expect(summary.key).toBe('run-u1');
  });

  test('checked and green: the file by name and the command that passed', () => {
    const r = review({ changes: [change('src/retry.ts', T0 + 1000, 3)], verifications: [check('npm test', true, T0 + 2000)] });
    const s = runSummary(run, r, false)!;
    expect(s.verdict).toBe('verified');
    expect(s.headline).toBe('Changed retry.ts · npm test passed');
    expect(s.next).toBe('');
  });

  test('red: the newest check after the edits failed, and a fix is the next move', () => {
    const r = review({ changes: [change('src/a.ts', T0 + 1000), change('src/b.ts', T0 + 1500)], verifications: [check('npm test', false, T0 + 2000)] });
    const s = runSummary(run, r, false)!;
    expect(s.verdict).toBe('failed');
    expect(s.headline).toBe('Changed 2 files · npm test failed');
    expect(s.next).toMatch(/fix/i);
  });

  test('a green retry after a red one is verified; an edit after green is not', () => {
    const retried = review({ changes: [change('src/a.ts', T0 + 1000)], verifications: [check('npm test', false, T0 + 2000), check('npm test', true, T0 + 3000)] });
    expect(runSummary(run, retried, false)!.verdict).toBe('verified');
    // A red check from before the latest edit says nothing about the edit: not checked, not failed.
    const redBefore = review({ changes: [change('src/a.ts', T0 + 4000)], verifications: [check('npm test', false, T0 + 3000)] });
    expect(runSummary(run, redBefore, false)!.verdict).toBe('unchecked');
    const editedAfter = review({ changes: [change('src/a.ts', T0 + 4000)], verifications: [check('npm test', true, T0 + 3000)] });
    expect(runSummary(run, editedAfter, false)!.verdict).toBe('unchecked');
    expect(runSummary(run, editedAfter, false)!.headline).toBe('Changed a.ts · not checked yet');
  });

  test('a check that covered only some of the code leaves the run unchecked', () => {
    const r = review({
      changes: [change('src/a.ts', T0 + 1000), change('src/b.ts', T0 + 1000)],
      verifications: [check('npx jest a', true, T0 + 2000, ['src/a.ts'], false)],
    });
    expect(runSummary(run, r, false)!.verdict).toBe('unchecked');
  });

  test('text and media need no test — no warning for a README', () => {
    const s = runSummary(run, review({ changes: [change('README.md', T0 + 1000)] }), false)!;
    expect(s.verdict).toBe('no-check-needed');
    expect(s.headline).toBe('Changed README.md · no test needed for text or media');
  });

  test('a stopped run says so, whatever its checks said', () => {
    const s = runSummary(run, review({ interrupted: true, changes: [change('src/a.ts', T0 + 1000)], verifications: [check('npm test', true, T0 + 2000)] }), false)!;
    expect(s.verdict).toBe('stopped');
    expect(s.headline).toBe('Stopped · changed a.ts so far');
  });

  test('a question waiting on the person is not an ending', () => {
    expect(runSummary(run, review({ state: 'awaiting_approval', changes: [change('src/a.ts', T0 + 1000)] }), false)).toBeNull();
  });

  test('the line says it in words beside the icon, and opens Review', () => {
    const s = runSummary(run, review({ changes: [change('src/a.ts', T0 + 1000)], verifications: [check('npm test', false, T0 + 2000)] }), false)!;
    const html = renderToStaticMarkup(<RunSummaryRow summary={s} onReview={() => {}} />);
    expect(html).toContain('data-verdict="failed"');
    expect(html).toContain('Changed a.ts · npm test failed');
    expect(html).toContain('>Review</button>');
    expect(html).toContain('Needs a fix');
    expect(html).toContain('class="run-summary ');
    // Without a way to open Review, no dead button.
    expect(renderToStaticMarkup(<RunSummaryRow summary={s} />)).not.toContain('>Review</button>');
  });

  test('the app ends the conversation on it', () => {
    const app = fs.readFileSync(path.join(__dirname, '../renderer/src/App.tsx'), 'utf8');
    expect(app).toContain('const runEnd = useMemo(() => runSummary(state.items, state.review, busy)');
    expect(app).toMatch(/summary=\{runEnd\}\s*onReview=\{\(\) => openInspector\('review'\)\}/);
  });
});

describe('a finish you watch settles once (item 24)', () => {
  test('a step seen running and then finishing settles; one that mounts finished never does', () => {
    const watched = finishTracker(true);
    expect(watched(true)).toBe(false);
    expect(watched(false)).toBe(true);
    expect(watched(false)).toBe(true); // stays settled, it does not re-fire
    const history = finishTracker(false);
    expect(history(false)).toBe(false);
    expect(history(false)).toBe(false);
  });

  test('both kinds of step row wear it, and Reduce Motion stills it', () => {
    const transcript = fs.readFileSync(path.join(__dirname, '../renderer/src/components/Transcript.tsx'), 'utf8');
    expect(transcript).toContain("const settled = useJustFinished(running);");
    expect(transcript).toContain("const settled = useJustFinished(visualStatus === 'running');");
    expect(transcript.match(/settled && 'status-settle'/g)).toHaveLength(2);
    const css = fs.readFileSync(path.join(__dirname, '../renderer/src/styles.css'), 'utf8');
    expect(css).toMatch(/\.status-settle \{ display: inline-flex; animation: status-settle 220ms/);
    expect(css).toContain(':root[data-reduce-motion] .status-settle { animation: none; }');
  });
});
