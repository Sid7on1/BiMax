/**
 * Phase 2, slice 1 — supported Desktop runtime and IPC security baseline.
 *
 * Two things are proved here:
 *
 *  1. The RUNTIME contract — Electron sits on a currently supported major line and the macOS floor
 *     is declared by both app packaging and the native Swift target (Desktop coding gate, row 1).
 *  2. The IPC BOUNDARY — sender identity, navigation, permissions and every renderer payload are
 *     checked before a privileged operation runs (Desktop coding gate, rows 5 and 6).
 *
 * The policy module (app/src/main/security.ts) is deliberately Electron-free, so the whole matrix
 * runs as ordinary units, the same way app/src/main/supervisor does in desktop.supervisor.test.ts.
 * Each guard below has at least one case that a neutered implementation passes and the real one
 * refuses — a check that only ever asserts the happy path is not evidence.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

import {
  REQUIRED_WEB_PREFERENCES, RENDERER_CSP, InvalidPayloadError,
  isTrustedSender, isTrustedRendererUrl, isAllowedNavigation, isAllowedPermission,
  asBoundedInt, asBoundedString, asFileContent, asPtyInput,
  asGitPathspec, asSupervisorAction, isProtocolFrame, resolveWithinRoot,
  asPastedFileName, asPastedBytes,
  SUPERVISOR_ACTIONS,
} from '../main/security';
import { listDir, readFilePreview, writeFileContent } from '../main/files';
import { gitDiff } from '../main/git';

const repo = path.resolve(__dirname, '..', '..', '..');
const read = (relative: string): string => fs.readFileSync(path.join(repo, relative), 'utf8');

// Electron's own support policy is "the latest three stable majors". 33 was already out of support
// at the time of this slice; this floor is the product's own statement of what it will ship on and
// must be raised deliberately, not drifted past.
const MINIMUM_SUPPORTED_ELECTRON_MAJOR = 41;
const MINIMUM_MACOS = '13.0';

describe('Desktop runtime is on a supported line', () => {
  const appPkg = JSON.parse(read('app/package.json')) as {
    devDependencies: Record<string, string>;
  };

  test('Electron is pinned to a currently supported major', () => {
    const range = appPkg.devDependencies.electron;
    const major = Number(/(\d+)/.exec(range)?.[1]);
    expect(Number.isInteger(major)).toBe(true);
    expect(major).toBeGreaterThanOrEqual(MINIMUM_SUPPORTED_ELECTRON_MAJOR);
  });

  test('the installed Electron matches the declared range, so the lockfile cannot lag the manifest', () => {
    const installed = path.join(repo, 'app/node_modules/electron/package.json');
    if (!fs.existsSync(installed)) return; // dependency-free checkout: the manifest test above still holds
    const version = (JSON.parse(fs.readFileSync(installed, 'utf8')) as { version: string }).version;
    expect(Number(version.split('.')[0])).toBeGreaterThanOrEqual(MINIMUM_SUPPORTED_ELECTRON_MAJOR);
  });

  test('the build toolchain moved with it — electron-builder and electron-vite support that runtime', () => {
    expect(Number(/(\d+)/.exec(appPkg.devDependencies['electron-builder'])?.[1])).toBeGreaterThanOrEqual(26);
    expect(Number(/(\d+)/.exec(appPkg.devDependencies['electron-vite'])?.[1])).toBeGreaterThanOrEqual(5);
  });

  test('the macOS floor is enforced by app packaging, not only documented', () => {
    const config = yaml.load(read('app/electron-builder.yml')) as Record<string, any>;
    // electron-builder writes this into LSMinimumSystemVersion, so the OS refuses to launch below it.
    expect(String(config.mac.minimumSystemVersion)).toBe(MINIMUM_MACOS);
  });

  test('packaging is the ONLY place that declares the floor, so there is nothing to drift from', () => {
    // This used to cross-check `native/BimaxComputerUseKit/Package.swift`, which declared the same
    // floor for the Computer Use target. That target left with Computer Use, so the test read a
    // path that no longer exists and failed on ENOENT — reporting a missing file as a runtime
    // violation.
    //
    // Deleting it outright would leave the cross-check silently unreplaced, so the assertion is
    // inverted instead: the second declaration site must be ABSENT. If a native target ever comes
    // back, this fails and says exactly what to restore, rather than letting two floors drift apart
    // unwatched. A `existsSync(...) ? assert : return` would have been the worst option available —
    // a test that can never fail again.
    const nativeManifest = path.join(repo, 'native/BimaxComputerUseKit/Package.swift');
    expect(fs.existsSync(nativeManifest)).toBe(false);
  });

  test('Terminal is untouched by the Desktop runtime upgrade', () => {
    // The slice must not smuggle Electron, CU services or Mac permissions into the Terminal product.
    const terminalPkg = JSON.parse(read('package.json')) as {
      dependencies?: Record<string, string>; devDependencies?: Record<string, string>;
    };
    const all = { ...terminalPkg.dependencies, ...terminalPkg.devDependencies };
    expect(Object.keys(all).filter((d) => /^electron/.test(d))).toEqual([]);
  });
});

describe('renderer is constructed with the sandbox contract', () => {
  test('every hardening flag is explicit, not inherited from an Electron default', () => {
    expect(REQUIRED_WEB_PREFERENCES).toEqual({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
    });
  });

  test('the main process actually applies the contract when it creates the window', () => {
    const main = read('app/src/main/index.ts');
    expect(main).toContain('...REQUIRED_WEB_PREFERENCES');
    // A literal re-declaration beside the spread would let one flag drift back on.
    expect(main).not.toMatch(/webPreferences:\s*\{[^}]*\bnodeIntegration:\s*true/);
  });

  test('CSP denies remote script, network, plugins, framing and form posts', () => {
    expect(RENDERER_CSP).toContain("default-src 'self'");
    expect(RENDERER_CSP).toContain("script-src 'self'");
    expect(RENDERER_CSP).toContain("connect-src 'self'");
    expect(RENDERER_CSP).toContain("object-src 'none'");
    expect(RENDERER_CSP).toContain("frame-src 'none'");
    expect(RENDERER_CSP).toContain("base-uri 'none'");
    expect(RENDERER_CSP).toContain("form-action 'none'");
    // The renderer must never be allowed to run injected script; 'unsafe-inline' is style-only.
    expect(RENDERER_CSP).not.toMatch(/script-src[^;]*unsafe-(inline|eval)/);
  });

  test('the CSP is sent as a response header, not only as a renderer-editable meta tag', () => {
    const main = read('app/src/main/index.ts');
    expect(main).toContain('onHeadersReceived');
    expect(main).toContain("'Content-Security-Policy'");
  });

  test('the window denies every Chromium permission request', () => {
    expect(isAllowedPermission()).toBe(false);
    const main = read('app/src/main/index.ts');
    expect(main).toContain('setPermissionRequestHandler');
    expect(main).toContain('setPermissionCheckHandler');
  });
});

describe('sender identity gates every privileged channel', () => {
  const trusted = { webContentsId: 7, devServerUrl: undefined };
  const ownFrame = { senderId: 7, frameUrl: 'file:///Applications/Bimax.app/renderer/index.html', isMainFrame: true };

  test('the app\'s own top frame is accepted', () => {
    expect(isTrustedSender(ownFrame, trusted)).toBe(true);
  });

  test('another webContents is refused even with a plausible URL', () => {
    expect(isTrustedSender({ ...ownFrame, senderId: 8 }, trusted)).toBe(false);
  });

  test('a subframe never speaks for the app', () => {
    expect(isTrustedSender({ ...ownFrame, isMainFrame: false }, trusted)).toBe(false);
  });

  test('a remote origin is refused', () => {
    expect(isTrustedSender({ ...ownFrame, frameUrl: 'https://evil.example/x' }, trusted)).toBe(false);
  });

  test('a data: or about:blank document is refused', () => {
    expect(isTrustedSender({ ...ownFrame, frameUrl: 'data:text/html,<script>1</script>' }, trusted)).toBe(false);
    expect(isTrustedSender({ ...ownFrame, frameUrl: 'about:blank' }, trusted)).toBe(false);
  });

  test('a destroyed frame with no URL is refused', () => {
    expect(isTrustedSender({ ...ownFrame, frameUrl: undefined }, trusted)).toBe(false);
  });

  test('messages arriving after the window is gone are refused', () => {
    expect(isTrustedSender(ownFrame, { webContentsId: null })).toBe(false);
  });

  test('the dev server is trusted only when it is actually configured', () => {
    const devUrl = 'http://localhost:5173';
    expect(isTrustedRendererUrl(`${devUrl}/index.html`, devUrl)).toBe(true);
    // Same URL, no dev server running: a packaged app must not trust localhost.
    expect(isTrustedRendererUrl(`${devUrl}/index.html`, undefined)).toBe(false);
  });

  test('no privileged channel is registered outside the guarded helpers', () => {
    const main = read('app/src/main/index.ts');
    const raw = [...main.matchAll(/ipcMain\.(handle|on)\(/g)];
    // The only ipcMain.handle/ipcMain.on call sites are the two inside secureHandle/secureOn.
    expect(raw).toHaveLength(2);
    for (const channel of [
      'engine:send', 'engine:restart', 'app:pick-folder', 'app:pick-files', 'app:open-project',
      'supervisor:action', 'git:diff', 'files:read', 'files:write', 'files:reveal',
      'pty:create', 'pty:input', 'pty:kill', 'app:renderer-ready',
    ]) {
      expect(main).toMatch(new RegExp(`secure(Handle|On)(<[^>]*>)?\\(\\s*'${channel}'`));
    }
  });
});

describe('navigation cannot leave the app document', () => {
  const trusted = { webContentsId: 1, devServerUrl: undefined };

  test('the packaged renderer document is allowed', () => {
    expect(isAllowedNavigation('file:///Applications/Bimax.app/renderer/index.html', trusted)).toBe(true);
  });

  test('http, data and blob targets are blocked', () => {
    expect(isAllowedNavigation('https://evil.example', trusted)).toBe(false);
    expect(isAllowedNavigation('data:text/html,<script>1</script>', trusted)).toBe(false);
    expect(isAllowedNavigation('blob:file:///x', trusted)).toBe(false);
  });

  test('the main process installs the navigation and webview guards', () => {
    const main = read('app/src/main/index.ts');
    expect(main).toContain("'will-navigate'");
    expect(main).toContain("'will-attach-webview'");
    expect(main).toContain('setWindowOpenHandler');
  });
});

describe('renderer payloads are validated, not coerced', () => {
  test('integers must actually be integers in range', () => {
    expect(asBoundedInt(24, 2, 1000, 'rows')).toBe(24);
    // The old code did Number(x) || fallback, which silently accepted all of these.
    expect(() => asBoundedInt('24', 2, 1000, 'rows')).toThrow(InvalidPayloadError);
    expect(() => asBoundedInt(NaN, 2, 1000, 'rows')).toThrow(InvalidPayloadError);
    expect(() => asBoundedInt(Infinity, 2, 1000, 'rows')).toThrow(InvalidPayloadError);
    expect(() => asBoundedInt(1.5, 2, 1000, 'rows')).toThrow(InvalidPayloadError);
    expect(() => asBoundedInt(1_000_000, 2, 1000, 'rows')).toThrow(InvalidPayloadError);
    expect(() => asBoundedInt(null, 2, 1000, 'rows')).toThrow(InvalidPayloadError);
  });

  test('strings are bounded, so one IPC message cannot exhaust main-process memory', () => {
    expect(asBoundedString('ok', 8, 'x')).toBe('ok');
    expect(() => asBoundedString('x'.repeat(9), 8, 'x')).toThrow(InvalidPayloadError);
    expect(() => asPtyInput('x'.repeat(64 * 1024 + 1))).toThrow(InvalidPayloadError);
    expect(() => asFileContent('x'.repeat(8 * 1024 * 1024 + 1))).toThrow(InvalidPayloadError);
    expect(() => asPtyInput(123)).toThrow(InvalidPayloadError);
  });

  test('the supervisor accepts only its five named levers', () => {
    for (const action of SUPERVISOR_ACTIONS) {
      expect(asSupervisorAction({ action })).toEqual({ action });
    }
    expect(asSupervisorAction({ action: 'stop', sessionId: 'abc' })).toEqual({ action: 'stop', sessionId: 'abc' });
    expect(() => asSupervisorAction({ action: 'exec' })).toThrow(InvalidPayloadError);
    expect(() => asSupervisorAction({ action: '__proto__' })).toThrow(InvalidPayloadError);
    expect(() => asSupervisorAction('stop')).toThrow(InvalidPayloadError);
    expect(() => asSupervisorAction(null)).toThrow(InvalidPayloadError);
  });

  test('engine frames must be tagged objects', () => {
    expect(isProtocolFrame({ t: 'prompt', text: 'hi' })).toBe(true);
    expect(isProtocolFrame({})).toBe(false);
    expect(isProtocolFrame([{ t: 'prompt' }])).toBe(false);
    expect(isProtocolFrame('prompt')).toBe(false);
    expect(isProtocolFrame(null)).toBe(false);
    expect(isProtocolFrame({ t: 'x'.repeat(65) })).toBe(false);
  });
});

describe('project containment', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-contain-'));
    fs.writeFileSync(path.join(root, 'inside.txt'), 'inside');
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  test('paths inside the project resolve', () => {
    expect(resolveWithinRoot(root, 'inside.txt')).toBe(path.join(root, 'inside.txt'));
    expect(resolveWithinRoot(root, '')).toBe(path.resolve(root));
    expect(resolveWithinRoot(root, './a/../inside.txt')).toBe(path.join(root, 'inside.txt'));
  });

  test('traversal and absolute paths are refused', () => {
    expect(() => resolveWithinRoot(root, '../../etc/passwd')).toThrow(InvalidPayloadError);
    expect(() => resolveWithinRoot(root, '/etc/passwd')).toThrow(InvalidPayloadError);
    expect(() => resolveWithinRoot(root, `${root}/../escape`)).toThrow(InvalidPayloadError);
  });

  test('a sibling directory sharing the root prefix is not inside the project', () => {
    // The classic startsWith bug: "/p/proj-evil" starts with "/p/proj".
    expect(() => resolveWithinRoot('/p/proj', '../proj-evil/x')).toThrow(InvalidPayloadError);
  });

  test('NUL bytes are refused before any syscall sees a truncated path', () => {
    expect(() => resolveWithinRoot(root, 'inside.txt\0.png')).toThrow(InvalidPayloadError);
  });

  test('with NO project open the resolver fails closed', () => {
    // Regression: the previous guard compared against `'' + path.sep`, so every absolute path on
    // the machine looked contained and files:read/files:write reached the whole filesystem.
    expect(() => resolveWithinRoot('', '/etc/passwd')).toThrow(InvalidPayloadError);
    expect(() => resolveWithinRoot('', 'anything')).toThrow(InvalidPayloadError);
    expect(() => resolveWithinRoot('relative/root', 'x')).toThrow(InvalidPayloadError);
  });

  test('the file IPC surface refuses to read or write outside the project', async () => {
    await expect(readFilePreview(root, 'inside.txt')).resolves.toMatchObject({ content: 'inside' });
    await expect(readFilePreview(root, '../../etc/passwd')).rejects.toThrow(InvalidPayloadError);
    await expect(listDir(root, '..')).rejects.toThrow(InvalidPayloadError);
    await expect(writeFileContent(root, '../pwned.txt', 'x')).rejects.toThrow(InvalidPayloadError);
    expect(fs.existsSync(path.join(path.dirname(root), 'pwned.txt'))).toBe(false);
  });

  test('the file IPC surface refuses everything while no project is open', async () => {
    await expect(readFilePreview('', '/etc/hosts')).rejects.toThrow(InvalidPayloadError);
    await expect(writeFileContent('', '/tmp/bimax-should-not-exist', 'x')).rejects.toThrow(InvalidPayloadError);
    expect(fs.existsSync('/tmp/bimax-should-not-exist')).toBe(false);
  });

  test('git pathspecs are contained before git runs', () => {
    expect(asGitPathspec(root, 'inside.txt')).toBe('./inside.txt');
    expect(() => asGitPathspec(root, '/etc/passwd')).toThrow(InvalidPayloadError);
    expect(() => asGitPathspec(root, '../../etc/passwd')).toThrow(InvalidPayloadError);
    // A value that would otherwise be read as an option rather than a path.
    expect(asGitPathspec(root, '--output=/tmp/x')).toBe('./--output=/tmp/x');
  });

  test('git diff --no-index cannot be aimed at a file outside the project', async () => {
    // This is the concrete escape: --no-index treats its operands as filesystem paths, so an
    // absolute path used to return the contents of any file on the disk.
    await expect(gitDiff(root, '/etc/passwd', true)).rejects.toThrow(InvalidPayloadError);
    await expect(gitDiff(root, '../../../etc/passwd', true)).rejects.toThrow(InvalidPayloadError);
    await expect(gitDiff('', '/etc/passwd', true)).rejects.toThrow(InvalidPayloadError);
  });
});

/**
 * The other half of a hardening change: proving the working path still works. A guard that refuses
 * everything would pass every containment test above, so these exercise the real Desktop coding
 * subsystems — file tree, editor read/write, git diff — against a real repository on disk, with no
 * Computer Use permission involved at any point.
 */
describe('a normal Desktop coding task still works, with zero Computer Use permissions', () => {
  let root: string;

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-coding-')));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const answer = 41;\n');
    fs.writeFileSync(path.join(root, 'README.md'), '# demo\n');
    const git = (args: string[]): void => {
      require('node:child_process').execFileSync('git', args, {
        cwd: root,
        env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e' },
      });
    };
    git(['init', '-q', '-b', 'main']);
    git(['add', '.']);
    git(['commit', '-qm', 'init']);
  });
  afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

  test('the file tree lists the project', async () => {
    const entries = await listDir(root, '');
    expect(entries.map((e) => e.name)).toEqual(expect.arrayContaining(['README.md', 'src']));
    expect(entries.find((e) => e.name === 'src')?.dir).toBe(true);
    // .git is filtered out of the tree.
    expect(entries.map((e) => e.name)).not.toContain('.git');
  });

  test('the editor reads a source file', async () => {
    const file = await readFilePreview(root, 'src/app.ts');
    expect(file.content).toBe('export const answer = 41;\n');
    expect(file.binary).toBe(false);
    expect(file.truncated).toBe(false);
  });

  test('the editor saves an edit and git reports it', async () => {
    await writeFileContent(root, 'src/app.ts', 'export const answer = 42;\n');
    expect(fs.readFileSync(path.join(root, 'src', 'app.ts'), 'utf8')).toBe('export const answer = 42;\n');

    const diff = await gitDiff(root, 'src/app.ts', false);
    expect(diff).toContain('-export const answer = 41;');
    expect(diff).toContain('+export const answer = 42;');
  });

  test('git diffs a new untracked file through the --no-index path', async () => {
    fs.writeFileSync(path.join(root, 'src', 'added.ts'), 'export const added = true;\n');
    const diff = await gitDiff(root, 'src/added.ts', true);
    expect(diff).toContain('+export const added = true;');
  });

  test('none of that required a Computer Use permission', () => {
    // The modules exercised above are the Desktop coding surfaces. If any of them started reaching
    // for Accessibility, Screen Recording or the CU bridge it would show up in their code — so the
    // check runs against code with comments stripped, because prose explaining why a permission is
    // denied is documentation, not a capability.
    const codeOnly = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const module of ['app/src/main/files.ts', 'app/src/main/git.ts', 'app/src/main/security.ts']) {
      const code = codeOnly(read(module));
      expect(code).not.toMatch(/AXIsProcessTrusted|CGPreflight|ScreenCapture|cu-bridge|BIMAX_CU|bimaxCuService/i);
      // No import reaches the CU runtime, the native bridge or the focus broker either.
      expect(code).not.toMatch(/from\s+'\.\/(engine|focus-broker)'/);
      expect(code).not.toMatch(/require\(['"].*computer/i);
    }
  });
});

describe('pasted clipboard content cannot choose where it lands', () => {
  test('a plain filename with an expected extension is accepted', () => {
    expect(asPastedFileName('Pasted image 2026-09-07 040506.png')).toBe('Pasted image 2026-09-07 040506.png');
    expect(asPastedFileName('Pasted text 2026-09-07 040506.txt')).toBe('Pasted text 2026-09-07 040506.txt');
  });

  test('a name that could steer the write is refused', () => {
    // The renderer proposes the name. If any of these got through, a paste would decide the
    // directory rather than only the filename.
    for (const name of [
      '../../escape.png', 'nested/deep.png', 'back\\slash.png', 'nul\0byte.png',
      '.hidden.png', '.', '..', '',
    ]) {
      expect(() => asPastedFileName(name)).toThrow(InvalidPayloadError);
    }
    expect(() => asPastedFileName('x'.repeat(201) + '.png')).toThrow(InvalidPayloadError);
    expect(() => asPastedFileName(42)).toThrow(InvalidPayloadError);
  });

  test('only clipboard-shaped file types are written, never something executable', () => {
    for (const name of ['run.command', 'lib.dylib', 'x.sh', 'script.js', 'page.html', 'noextension']) {
      expect(() => asPastedFileName(name)).toThrow(InvalidPayloadError);
    }
  });

  test('the payload has to be bounded bytes', () => {
    expect(asPastedBytes(new Uint8Array([1, 2, 3]))).toEqual(new Uint8Array([1, 2, 3]));
    expect(asPastedBytes(new Uint8Array([7]).buffer)).toEqual(new Uint8Array([7]));
    expect(() => asPastedBytes('not bytes')).toThrow(InvalidPayloadError);
    expect(() => asPastedBytes(null)).toThrow(InvalidPayloadError);
    expect(() => asPastedBytes(new Uint8Array(0))).toThrow(InvalidPayloadError);
    expect(() => asPastedBytes(new Uint8Array(25 * 1024 * 1024 + 1))).toThrow(InvalidPayloadError);
  });
});

describe('the security boundary stays Desktop-only', () => {
  test('the policy module imports nothing from Electron, so it is testable and reusable', () => {
    const source = read('app/src/main/security.ts');
    expect(source).not.toMatch(/from\s+'electron'/);
  });

  test('no Computer Use capability is introduced by this slice', () => {
    const source = read('app/src/main/security.ts');
    // The renderer gets no Accessibility/Screen Recording/CU surface out of the IPC hardening.
    expect(source).not.toMatch(/AXIsProcessTrusted|CGPreflightScreenCapture|BIMAX_CU_/);
  });
});
