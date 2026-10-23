import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { WorkspaceManager } from '../core/workspace.manager';

function mkRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

/**
 * A repo reached through a symlink is the SAME repo.
 *
 * `path.resolve` normalises `..` but does not follow symlinks, so the registry keyed one checkout
 * under two identities. Found live: workspace.json listed both ~/Bimax and ~/Desktop/Bimax (a
 * symlink to it) as separate write-scope repos, so everything iterating repos did it twice.
 *
 * The second half of this file is the direction that matters more: closing a containment hole must
 * not start refusing writes that were always legitimate.
 */
describe('a symlinked repo is one repo, not two', () => {
  let root: string;
  let primary: string;

  beforeEach(() => {
    // realpath the tmpdir itself: on macOS /var is a symlink to /private/var, which would otherwise
    // make every path in this suite "canonicalised" by accident and prove nothing.
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-wslink-')));
    primary = mkRepo(path.join(root, 'primary'));
  });

  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('registering the same repo twice through an alias yields ONE entry', () => {
    const alias = path.join(root, 'alias-to-primary');
    fs.symlinkSync(primary, alias);

    const ws = new WorkspaceManager(primary);
    ws.refresh();                       // registers `primary`
    ws.register(alias, { scope: 'write' });

    const paths = ws.active().map((r) => r.path);
    expect(paths).toHaveLength(1);
    expect(fs.realpathSync(paths[0])).toBe(primary);
  });

  it('find() locates a repo by its alias', () => {
    const other = mkRepo(path.join(root, 'reference'));
    const alias = path.join(root, 'alias-to-reference');
    fs.symlinkSync(other, alias);

    const ws = new WorkspaceManager(primary);
    ws.register(other, { scope: 'read' });
    expect(ws.find(alias)).toBeDefined();
    expect(ws.find(alias)!.scope).toBe('read');
  });

  it('a read-only repo cannot be written through an alias — the hole this closes', () => {
    const reference = mkRepo(path.join(root, 'reference'));
    fs.writeFileSync(path.join(reference, 'pattern.ts'), 'export const a = 1;\n');
    const alias = path.join(root, 'alias-to-reference');
    fs.symlinkSync(reference, alias);

    const ws = new WorkspaceManager(primary);
    ws.refresh();
    ws.register(reference, { scope: 'read' });

    expect(ws.checkWrite(path.join(reference, 'pattern.ts')).allowed).toBe(false);
    // Same file, reached by the alias. This used to match no registered root and be allowed.
    expect(ws.checkWrite(path.join(alias, 'pattern.ts')).allowed).toBe(false);
  });

  it('a file that does not exist yet is still scoped through an alias', () => {
    const reference = mkRepo(path.join(root, 'reference'));
    const alias = path.join(root, 'alias-to-reference');
    fs.symlinkSync(reference, alias);

    const ws = new WorkspaceManager(primary);
    ws.refresh();
    ws.register(reference, { scope: 'read' });

    // realpath cannot resolve a file that is not there; the directory is canonicalised instead.
    expect(ws.checkWrite(path.join(alias, 'brand-new-file.ts')).allowed).toBe(false);
  });

  // ---- the over-refusing direction -------------------------------------------------------

  it('the primary repo stays writable, by its own path and through an alias', () => {
    const alias = path.join(root, 'alias-to-primary');
    fs.symlinkSync(primary, alias);

    const ws = new WorkspaceManager(primary);
    ws.refresh();
    expect(ws.checkWrite(path.join(primary, 'src', 'x.ts')).allowed).toBe(true);
    expect(ws.checkWrite(path.join(alias, 'src', 'x.ts')).allowed).toBe(true);
  });

  it('a path outside every registered repo is still allowed — this layer stays additive', () => {
    const ws = new WorkspaceManager(primary);
    ws.refresh();
    expect(ws.checkWrite(path.join(root, 'loose-file.txt')).allowed).toBe(true);
    expect(ws.checkWrite('/tmp/somewhere-else/file.ts').allowed).toBe(true);
  });

  it('the innermost repo still governs: a read-only clone nested in the primary wins', () => {
    const nested = mkRepo(path.join(primary, 'vendor', 'dep'));
    const ws = new WorkspaceManager(primary);
    ws.refresh();
    ws.register(nested, { scope: 'read' });

    expect(ws.checkWrite(path.join(primary, 'src', 'x.ts')).allowed).toBe(true);
    expect(ws.checkWrite(path.join(nested, 'index.ts')).allowed).toBe(false);
  });
});

describe('an existing manifest with aliased duplicates heals itself', () => {
  let root: string;
  let primary: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-wsheal-')));
    primary = mkRepo(path.join(root, 'primary'));
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('collapses on load, keeping the real path over the alias', () => {
    const alias = path.join(root, 'alias-to-primary');
    fs.symlinkSync(primary, alias);

    // A manifest written before aliases were understood — exactly the shape found on this machine.
    const stateDir = path.join(primary, '.bimax');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'workspace.json'), JSON.stringify({
      version: 1,
      repos: [
        { path: alias, name: 'Bimax', scope: 'write', registeredAt: '2026-07-06T00:00:00.000Z' },
        { path: primary, name: 'Bimax', scope: 'write', registeredAt: '2026-09-18T00:00:00.000Z' },
      ],
    }));

    const ws = new WorkspaceManager(primary);
    const active = ws.active();
    expect(active).toHaveLength(1);
    expect(active[0].path).toBe(primary);       // the real location, not the symlink
  });
});
