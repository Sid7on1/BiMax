import { compressText } from '../memory/headroom.compress';

/**
 * Terminal escapes at the tool/model boundary.
 *
 * Two defects met here. The compressor's ANSI pattern had an OPTIONAL escape byte, so it matched
 * ordinary text — any `[`, digits, a letter — and silently rewrote tool results the model then
 * reasoned against. And nothing asked child processes not to emit colour in the first place, so
 * real escapes were flowing into the context as tokens, where the model learned to echo them back
 * as the bare `[0m` / `[1m` fragments that showed up in Bimax's own replies (the ESC byte is
 * invisible in a DOM text node, so only the letters survive on screen).
 */

describe('compressText only strips real escape sequences', () => {
  // Long enough to pass compressText's own guards, and deliberately not code-shaped.
  const pad = '\nsome ordinary prose line that carries no signal at all.';

  it('leaves a markdown link intact', () => {
    // `[Read the docs](...)` used to come out as `ead the docs](...)`.
    const out = compressText(`See [Read the docs](https://example.com) for details.${pad}`);
    expect(out).toContain('[Read the docs](https://example.com)');
  });

  it('leaves a task-list checkbox intact', () => {
    const out = compressText(`- [x] ship it\n- [ ] document it${pad}`);
    expect(out).toContain('[x]');
  });

  it('leaves an array index by variable intact', () => {
    const out = compressText(`const a: string[] = []; a[i] = compute(n);${pad}`);
    expect(out).toContain('a[i]');
  });

  it('still removes an actual colour escape', () => {
    const out = compressText(`\u001b[31mred text\u001b[0m and more${pad}`);
    expect(out).toContain('red text');
    expect(out).not.toContain('\u001b');
    expect(out).not.toMatch(/\[[0-9;]*m/);
  });
});

describe('BashTool hands the model output with no terminal escapes', () => {
  // The regex and env helper are module-private; exercise them through the tool's real execute()
  // path so the test covers what actually ships rather than a copy of the pattern.
  const load = () => {
    const { createBashTool } = require('../tools/implementations/bash.tool');
    return createBashTool({ approveTaskExecution: jest.fn().mockResolvedValue(undefined) } as any);
  };

  it('strips escapes a command emits anyway', async () => {
    const tool = load();
    // printf writes the escapes directly, so it ignores NO_COLOR by construction — which is
    // exactly the case stripAnsi() exists for.
    const res = await tool.execute({ command: `printf '\\033[31mFAILED\\033[0m tests: 1\\n'` }, { cwd: process.cwd() });
    const text = typeof res === 'string' ? res : res.text ?? JSON.stringify(res);
    expect(text).toContain('FAILED');
    expect(text).not.toContain('\u001b');
    expect(text).not.toContain('[31m');
    expect(text).not.toContain('[0m');
  }, 30_000);

  it('asks the child not to colour in the first place', async () => {
    const tool = load();
    const res = await tool.execute({ command: 'echo "NO_COLOR=$NO_COLOR FORCE_COLOR=$FORCE_COLOR"' }, { cwd: process.cwd() });
    const text = typeof res === 'string' ? res : res.text ?? JSON.stringify(res);
    expect(text).toContain('NO_COLOR=1');
    expect(text).toContain('FORCE_COLOR=0');
  }, 30_000);

  it('leaves TERM alone, because TERM=dumb breaks build scripts that call tput', async () => {
    const tool = load();
    const res = await tool.execute({ command: 'echo "TERM=[$TERM]"' }, { cwd: process.cwd() });
    const text = typeof res === 'string' ? res : res.text ?? JSON.stringify(res);
    expect(text).not.toContain('TERM=[dumb]');
  }, 30_000);
});
