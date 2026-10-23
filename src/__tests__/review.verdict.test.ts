import * as path from 'path';
import { requiresBuildVerification, verificationState } from '../review/review.verdict';
import { requiresBuildVerification as fromScope } from '../review/verification.scope';
import * as protocol from '../protocol/protocol';

/**
 * The verdict shared by the engine's review lifecycle and the window's end-of-run summary (UI fix list item 41).
 * It moved out of verification.scope.ts so it could import nothing; these hold it to what it was.
 */

describe('requiresBuildVerification, without `path`', () => {
  const files = [
    'src/agent.ts', 'story.txt', '~/Desktop/story.txt', 'README.MD', 'docs/a.pdf', 'img/logo.svg', 'Makefile',
    'Dockerfile', '.env', '.md', 'docs/.txt', '.github/workflows/ci.yml', 'a.tar.gz', 'dir.v2/run', 'notes.', 'C:\\work\\x.md', 'x.test.tsx',
  ];
  test('answers exactly what the path.extname version answered', () => {
    const before = (file: string): boolean => {
      const ext = path.extname(file).toLowerCase();
      return ext === '' || !['.txt', '.md', '.rtf', '.doc', '.docx', '.odt', '.pdf', '.csv', '.tsv', '.png', '.jpg', '.jpeg',
        '.gif', '.webp', '.svg', '.ico', '.mp3', '.wav', '.m4a', '.mp4', '.mov', '.webm'].includes(ext);
    };
    // A Windows path is the one place the two differ: posix `path` reads `C:\work\x.md` as one name ending in `.md`
    // too, so they agree here as well.
    for (const file of files) expect([file, requiresBuildVerification(file)]).toEqual([file, before(file)]);
  });
  test('the engine’s old import still reaches the same function, and so does the protocol door', () => {
    expect(fromScope).toBe(requiresBuildVerification);
    expect(protocol.requiresBuildVerification).toBe(requiresBuildVerification);
    expect(protocol.verificationState).toBe(verificationState);
  });
});

describe('verificationState', () => {
  const change = (file: string, lastAt: number) => ({ file, lastAt });
  const run = (ok: boolean, at: number, extra: { repoWide?: boolean; coveredFiles?: string[] } = {}) => ({ ok, at, repoWide: true, coveredFiles: [], ...extra });

  test('no run, or only a run before the newest edit: unverified', () => {
    expect(verificationState([change('a.ts', 10)], [])).toBe('unverified');
    expect(verificationState([change('a.ts', 10)], [run(true, 5)])).toBe('unverified');
    // A red run from before the edit is history, not a verdict on the edit.
    expect(verificationState([change('a.ts', 10)], [run(false, 5)])).toBe('unverified');
  });
  test('the newest run decides red; a green retry supersedes it', () => {
    expect(verificationState([change('a.ts', 10)], [run(true, 11), run(false, 12)])).toBe('verification_failed');
    expect(verificationState([change('a.ts', 10)], [run(false, 11), run(true, 12)])).toBe('verified');
  });
  test('green must cover every file a build can check — a narrow run leaves the rest unverified', () => {
    const changes = [change('src/a.ts', 10), change('src/b.ts', 10)];
    expect(verificationState(changes, [run(true, 11, { repoWide: false, coveredFiles: ['src/a.ts'] })])).toBe('unverified');
    expect(verificationState(changes, [run(true, 11, { repoWide: false, coveredFiles: ['src/a.ts', 'b.ts'] })])).toBe('verified');
  });
  test('prose and media need no coverage', () => {
    expect(verificationState([change('src/a.ts', 10), change('README.md', 10)], [run(true, 11, { repoWide: false, coveredFiles: ['src/a.ts'] })])).toBe('verified');
  });
});
