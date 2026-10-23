import { compressText, compressBacklog, looksLikeCode } from '../memory/headroom.compress';

describe('compressText', () => {
  it('collapses runs of near-identical log lines but keeps one representative', () => {
    const log = Array.from({ length: 50 }, (_, i) => `[10:00:${i}] DEBUG worker ${i} item id=${i} ok`).join('\n');
    const out = compressText(log);
    expect(out).toContain('similar lines elided');
    expect(out.length).toBeLessThan(log.length / 2);
    expect(out.split('\n')[0]).toContain('DEBUG worker 0'); // representative kept
  });

  it('never collapses error/warning lines — the signal an agent needs', () => {
    const lines = [
      ...Array.from({ length: 20 }, (_, i) => `INFO step ${i} done`),
      'ERROR deploy failed: port 8080 already in use',
      'WARNING low disk space',
    ].join('\n');
    const out = compressText(lines);
    expect(out).toContain('ERROR deploy failed: port 8080 already in use');
    expect(out).toContain('WARNING low disk space');
    expect(out).toContain('similar lines elided');
  });

  it('strips ANSI escape codes', () => {
    const colored = '\u001b[31mred\u001b[0m plain';
    expect(compressText(colored)).toBe('red plain');
  });

  it('squeezes blank-line runs', () => {
    expect(compressText('a\n\n\n\n\nb')).toBe('a\n\nb');
  });

  it('leaves short/varied content unchanged', () => {
    const code = 'function f() {\n  return 1;\n}';
    expect(compressText(code)).toBe(code);
  });
});

// The /v1/compress generic token-classifier mangles source code (drops braces/keywords). looksLikeCode
// is the guard that tells proxyCompress which tool outputs to restore verbatim vs. let it compress.
describe('looksLikeCode', () => {
  it('flags a bimax FILE read', () => {
    expect(looksLikeCode('FILE src/auth/session.ts:\nexport class Session {}')).toBe(true);
  });
  it('flags dense source even without a FILE header', () => {
    const code = Array.from({ length: 10 }, (_, i) => `export function fn${i}(a, b) { return a + b + ${i}; }`).join('\n');
    expect(looksLikeCode(code)).toBe(true);
  });
  it('does NOT flag a repetitive log/build dump (let those compress)', () => {
    const log = Array.from({ length: 30 }, (_, i) => `[12:00:${i}] INFO compiled ./src/m${i}.ts in ${i}ms ok`).join('\n');
    expect(looksLikeCode(log)).toBe(false);
  });
  it('ignores tiny/empty content', () => {
    expect(looksLikeCode('')).toBe(false);
    expect(looksLikeCode('ok')).toBe(false);
  });
});

describe('compressBacklog', () => {
  const bigLog = Array.from({ length: 60 }, (_, i) => `[t${i}] DEBUG processed item ${i} status=ok`).join('\n');

  it('compresses OLD tool outputs and reports tokens saved', () => {
    const msgs = [
      { role: 'system', content: 'sys' },
      { role: 'tool', content: bigLog },          // old → compressed
      ...Array.from({ length: 6 }, () => ({ role: 'user', content: 'recent turn' })),
    ];
    const { messages, stats } = compressBacklog(msgs, { protectRecent: 6 });
    expect(stats.compressedMessages).toBe(1);
    expect(stats.saved).toBeGreaterThan(0);
    expect((messages[1].content as string).length).toBeLessThan(bigLog.length);
  });

  it('protects the most recent turns and non-tool roles', () => {
    const msgs = [
      { role: 'user', content: bigLog },          // user → never compressed
      { role: 'tool', content: bigLog },          // recent (within protect window) → untouched
    ];
    const { messages, stats } = compressBacklog(msgs, { protectRecent: 6 });
    expect(stats.compressedMessages).toBe(0);
    expect(messages[0].content).toBe(bigLog);
    expect(messages[1].content).toBe(bigLog);
  });

  it('skipCode leaves code-shaped tool outputs verbatim while still collapsing log spam', () => {
    const repeatedCode = Array.from({ length: 30 }, (_, i) => `export function fn${i}(a, b) { return a + b + ${i}; }`).join('\n');
    const log = Array.from({ length: 60 }, () => '[t] INFO compiled file in Nms ok').join('\n');
    const msgs = [
      { role: 'tool', content: `FILE src/x.ts:\n${repeatedCode}` },  // code → must stay verbatim
      { role: 'tool', content: `$ build\n${log}\ndone` },            // logs → collapse
      ...Array.from({ length: 6 }, () => ({ role: 'user', content: 'recent' })),
    ];
    const { messages, stats } = compressBacklog(msgs, { protectRecent: 6, skipCode: true });
    expect(messages[0].content).toBe(`FILE src/x.ts:\n${repeatedCode}`);  // untouched
    expect((messages[1].content as string).length).toBeLessThan((msgs[1].content as string).length);
    expect(stats.compressedMessages).toBe(1);                            // only the log message
  });

  it('ignores tool outputs below the min size', () => {
    const msgs = [
      { role: 'tool', content: 'small output' },
      ...Array.from({ length: 6 }, () => ({ role: 'assistant', content: 'x' })),
    ];
    const { stats } = compressBacklog(msgs, { protectRecent: 6, minChars: 400 });
    expect(stats.compressedMessages).toBe(0);
  });
});

// The /headroom report once showed "100% smaller (25,004 → 0 tok)" because the proxy pass recorded
// before=saved, after=0. These lock the invariant: a real pass produces sane before > after > 0 and a
// ratio strictly between 0 and 1. The module keeps process-wide state, so each test gets a fresh copy.
describe('headroom report math', () => {
  function freshReport() {
    let mod!: typeof import('../memory/headroom.compress');
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- isolateModules needs sync require for a fresh copy
    jest.isolateModules(() => { mod = require('../memory/headroom.compress'); });
    return mod;
  }

  it('records real before/after — never after=0 / 100% for a partial compression', () => {
    const { recordCompression, getHeadroomReport } = freshReport();
    recordCompression('minimaxai/minimax-m3', 25004, 17003, 'proxy');
    const r = getHeadroomReport();
    expect(r.totalBefore).toBe(25004);
    expect(r.totalAfter).toBe(17003);
    expect(r.totalSaved).toBe(8001);
    expect(r.totalAfter).toBeGreaterThan(0);            // the bug was after = 0
    expect(r.ratio).toBeGreaterThan(0);                 // the bug made ratio = 0 ⇒ "100% smaller"
    expect(r.ratio).toBeLessThan(1);
    expect(Math.round((1 - r.ratio) * 100)).toBe(32);   // the % shown in /headroom
  });

  it('accumulates per model and sorts by savings', () => {
    const { recordCompression, getHeadroomReport, getHeadroomSavedTokens } = freshReport();
    recordCompression('model-a', 1000, 800, 'proxy');
    recordCompression('model-a', 1000, 900, 'proxy');
    recordCompression('model-b', 2000, 1000, 'native');
    const r = getHeadroomReport();
    expect(getHeadroomSavedTokens()).toBe(300 + 1000);
    expect(r.compressions).toBe(3);
    expect(r.byModel[0].model).toBe('model-b');         // biggest saver first
    expect(r.byModel.find(m => m.model === 'model-a')!.count).toBe(2);
  });

  it('ignores a no-op pass (after >= before)', () => {
    const { recordCompression, getHeadroomReport } = freshReport();
    recordCompression('model-x', 500, 500, 'proxy');
    expect(getHeadroomReport().totalSaved).toBe(0);
  });
});
