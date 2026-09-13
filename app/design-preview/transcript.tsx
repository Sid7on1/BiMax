import React from 'react';
import { Transcript } from '../src/renderer/src/components/Transcript';
import { EngineStore } from '../src/renderer/src/engine.store';
import type { TranscriptItem } from '../src/renderer/src/engine.state';

/**
 * The **real** transcript, against a fixture.
 *
 * `chat.tsx` next door is a different thing: an `@ai-sdk/react` mock used to design *streaming*
 * behaviour. It deliberately is not this component. That left `Transcript.tsx` — the largest surface
 * in the app and the one the user spends every minute of a task looking at — with no preview at all,
 * so a change to a tool-call card or an error row could only be seen by running a live task and
 * hoping it produced one.
 *
 * The fixture is the set of rows that are hard to get right, not a happy path: a running call, a
 * finished call, a failed call, a fenced code block, and a system error.
 */
const t = (min: number): string => new Date(Date.now() - min * 60_000).toISOString();

const ITEMS: TranscriptItem[] = [
  {
    kind: 'msg',
    msg: {
      id: 'm1', role: 'user', timestamp: t(9),
      content: 'The sidebar reads as a flat grey panel when the window is not maximised. Why?',
    },
  },
  {
    kind: 'msg',
    msg: {
      id: 'm2', role: 'assistant', timestamp: t(8), thoughtMs: 4200,
      content: 'The panel is translucent, but something behind it is opaque — so `backdrop-filter` '
        + 'has nothing to sample. Checking how the window itself is configured before touching CSS.',
    },
    thought: 'backdrop-filter samples what is *behind* the element. If the window paints an opaque '
      + 'background, the material never reaches the blur. Check main/index.ts first.',
  },
  {
    kind: 'tool',
    call: {
      id: 'c1', toolName: 'readFile', status: 'success', startTime: t(8), endTime: t(8),
      input: JSON.stringify({ path: 'src/main/index.ts', range: [370, 392] }, null, 2),
      output: "backgroundColor: '#161412',\nvibrancy: 'sidebar',\nvisualEffectState: 'active',",
    },
  },
  {
    kind: 'msg',
    msg: {
      id: 'm3', role: 'assistant', timestamp: t(7),
      content: 'Found it. The window asks for `vibrancy: \'sidebar\'` and then covers it with an '
        + 'opaque `backgroundColor`, so macOS never gets to show the material.\n\n'
        + '```ts\n// before\nbackgroundColor: \'#161412\',\n// after\nbackgroundColor: \'#00000000\',\n```\n\n'
        + 'Clearing it and letting each non-glass pane paint its own surface fixes it.',
    },
  },
  {
    kind: 'tool',
    call: {
      id: 'c2', toolName: 'bash', status: 'error', startTime: t(6), endTime: t(6),
      input: 'npm run test:renderer -- --grep vibrancy',
      output: 'Error: Cannot find module \'./components/LiveTarget\'\n  at design-preview/inspector.tsx:2',
    },
  },
  {
    kind: 'msg',
    msg: {
      id: 'm4', role: 'system', level: 'error', timestamp: t(6),
      content: 'Tool `bash` exited 1 — the design-preview harness does not build.',
    },
  },
  {
    kind: 'tool',
    call: {
      id: 'c3', toolName: 'editFile', status: 'running', startTime: t(1),
      input: JSON.stringify({ path: 'src/main/index.ts' }, null, 2),
      output: '',
    },
  },
];

export function TranscriptPreview(): React.ReactElement {
  const store = React.useMemo(() => new EngineStore(), []);
  return (
    <div className="app-surface flex h-[620px] w-[720px] flex-col overflow-hidden rounded-[14px] border border-line">
      <Transcript items={ITEMS} store={store} onMenuSelect={() => {}} />
    </div>
  );
}
