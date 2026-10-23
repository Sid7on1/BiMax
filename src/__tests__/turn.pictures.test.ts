import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HeadlessSession } from '../protocol/headless.session';
import { engineEvents } from '../engine/events';

/**
 * Backlog N5: a picture attached in the ⌘2 bar reaches the model as an image. The bar writes one `- Picture: <path>`
 * line per picture (app/src/main/quick.context.ts); the session must hand exactly those to the persona as `images`
 * on the full path (the lite lane sends no images; a picture line always holds a path, which keeps it off that lane)
 * and name any it cannot send.
 */

function persona() {
  const calls: Array<{ lane: string; images?: string[] }> = [];
  return {
    calls,
    messages: [] as any[],
    async converse() { calls.push({ lane: 'converse' }); return 'ok'; },
    async execute(_prompt: string, _onToken?: unknown, options?: { images?: string[] }) { calls.push({ lane: 'execute', images: options?.images }); return 'ok'; },
  };
}
const session = (p: ReturnType<typeof persona>) => new HeadlessSession({
  personas: { bimax: p } as any,
  options: { llmAdapter: { userModel: 'm', defaultModel: 'm', chatCompletion: jest.fn() }, maxToolIterations: 3 },
  graphStore: {} as any,
});

let dir: string;
const prevPersist = process.env.BIMAX_PERF_PERSIST;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-n5-turn-')); process.env.BIMAX_PERF_PERSIST = '0'; });
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (prevPersist === undefined) delete process.env.BIMAX_PERF_PERSIST; else process.env.BIMAX_PERF_PERSIST = prevPersist;
});

test('a picture line goes to the model as an image, even on a one-word question', async () => {
  const shot = path.join(dir, 'Screenshot 2026-09-21 at 10.00.00.png');
  fs.writeFileSync(shot, Buffer.alloc(8));
  const p = persona();
  // Both ways the bar has closed its context block: `]` after the last line, and on a line of its own.
  await session(p).dispatch(`[What the user had open or dropped on the ⌘2 bar:\n- Picture: ${shot}]\n\nthoughts?`);
  await session(p).dispatch(`[What the user had open or dropped on the ⌘2 bar:\n- Picture: ${shot}\n]\n\nthoughts?`);
  expect(p.calls).toEqual([{ lane: 'execute', images: [shot] }, { lane: 'execute', images: [shot] }]);
});

test('a picture that cannot be sent is named in a warning, and the turn still runs', async () => {
  const messages: any[] = [];
  const listen = (m: any) => messages.push(m);
  engineEvents.on('message', listen);
  try {
    const p = persona();
    await session(p).dispatch(`- Picture: ${path.join(dir, 'gone.png')}\n\nwhat is wrong here?`);
    expect(p.calls).toEqual([{ lane: 'execute', images: [] }]);
    expect(messages.find((m) => m.level === 'warn')?.content).toMatch(/Not sent as a picture .*: gone\.png$/);
  } finally {
    engineEvents.off('message', listen);
  }
});

test('an ordinary greeting still takes the light lane', async () => {
  const p = persona();
  await session(p).dispatch('hi');
  expect(p.calls).toEqual([{ lane: 'converse' }]);
});
