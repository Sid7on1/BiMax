import * as fs from 'fs';
import * as path from 'path';

/**
 * Every source file must be TEXT, so that `grep` can see it.
 *
 * WHY THIS EXISTS. `src/evidence/task.guard.ts` contained a raw NUL byte inside a string literal —
 * `join('<NUL>')`, written as the byte itself rather than as `\u0000`. The runtime was fine: NUL is
 * a perfectly good separator. But `file(1)` reported the file as `data`, and **grep skips a file it
 * believes is binary**. A 425-line production file was therefore invisible to every plain grep in
 * this repository.
 *
 * That is not a cosmetic problem. It is how a search-based conclusion becomes silently wrong:
 * searching for `mapToolCall` returned only test files, which read as "this module is never called
 * in production" when in fact `task.guard.ts:132` calls it on every tool call. A second grep-based
 * check — the Thread/worker/core naming gate in `app/src/__tests__/naming.thread.test.ts` — was
 * blind to the same five files without knowing it.
 *
 * Five files were affected (task.guard, habit.compiler, task.metrics, headroom.compress and its
 * test), all using a raw NUL or ESC where the escape sequence was meant. This test is the guard.
 *
 * Deliberately narrow: TAB, LF and CR are ordinary in source. What is banned is the set that makes
 * a tool treat the file as binary.
 */

const ROOTS = ['src', 'app/src'];
const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.css', '.md'];

/** Bytes that make file(1)/grep(1) call a file binary. TAB (0x09), LF (0x0a) and CR (0x0d) are fine. */
function controlBytes(buf: Buffer): number[] {
  const at: number[] = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b < 0x09 || (b >= 0x0e && b < 0x20) || b === 0x7f) at.push(i);
  }
  return at;
}

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (EXTENSIONS.includes(path.extname(entry.name))) out.push(full);
  }
}

test('no source file contains a byte that makes grep treat it as binary', () => {
  const repo = path.resolve(__dirname, '..', '..');
  const files: string[] = [];
  for (const root of ROOTS) {
    const full = path.join(repo, root);
    if (fs.existsSync(full)) walk(full, files);
  }
  expect(files.length).toBeGreaterThan(100); // the scan itself must not silently cover nothing

  const offenders = files.flatMap((file) => {
    const buf = fs.readFileSync(file);
    const at = controlBytes(buf);
    if (at.length === 0) return [];
    const line = buf.subarray(0, at[0]).toString('utf8').split('\n').length;
    const byte = buf[at[0]].toString(16).padStart(2, '0');
    return [`${path.relative(repo, file)}:${line} has ${at.length} raw control byte(s), first 0x${byte}`
      + ` — write it as an escape (\\u0000, \\u001b) so the file stays greppable`];
  });

  expect(offenders).toEqual([]);
});
