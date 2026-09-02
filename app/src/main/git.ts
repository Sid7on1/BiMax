import { execFile } from 'node:child_process';
import { asGitPathspec } from './security';

/**
 * Electron-native git reader for the Review panel — status/diff/branches/log only, exactly like
 * competitor shells poll git from their main process. All WRITES (commit, checkout) go through
 * the engine's /git command instead, so the ledger and attribution pipeline see them.
 */

export interface GitFile {
  path: string;
  status: string;      // one letter: M A D R C ? (worktree state wins over index)
  staged: boolean;     // true when the index has changes for this path
  insertions: number;
  deletions: number;
}

export interface GitStatusResult {
  branch: string;
  ahead: number;
  behind: number;
  files: GitFile[];
}

function run(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) reject(err);
      else resolve(stdout);
    });
  });
}

async function numstat(cwd: string, staged: boolean): Promise<Map<string, { ins: number; del: number }>> {
  const map = new Map<string, { ins: number; del: number }>();
  try {
    const out = await run(cwd, staged ? ['diff', '--cached', '--numstat'] : ['diff', '--numstat']);
    for (const line of out.split('\n')) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!m) continue;
      const prev = map.get(m[3]) ?? { ins: 0, del: 0 };
      map.set(m[3], {
        ins: prev.ins + (m[1] === '-' ? 0 : Number(m[1])),
        del: prev.del + (m[2] === '-' ? 0 : Number(m[2])),
      });
    }
  } catch { /* not a repo / no HEAD yet */ }
  return map;
}

export async function gitStatus(cwd: string): Promise<GitStatusResult | null> {
  let out: string;
  try {
    out = await run(cwd, ['status', '--porcelain=v2', '--branch']);
  } catch {
    return null; // not a git repository
  }

  const res: GitStatusResult = { branch: '', ahead: 0, behind: 0, files: [] };
  const [unstagedCounts, stagedCounts] = await Promise.all([numstat(cwd, false), numstat(cwd, true)]);
  const counts = (p: string): { insertions: number; deletions: number } => {
    const a = unstagedCounts.get(p);
    const b = stagedCounts.get(p);
    return { insertions: (a?.ins ?? 0) + (b?.ins ?? 0), deletions: (a?.del ?? 0) + (b?.del ?? 0) };
  };

  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.head ')) { res.branch = line.slice(14).trim(); continue; }
    if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) { res.ahead = Number(m[1]); res.behind = Number(m[2]); }
      continue;
    }
    // 1 = ordinary change, 2 = rename/copy ("newPath\toldPath"), ? = untracked
    if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const parts = line.split(' ');
      const xy = parts[1]; // e.g. ".M", "M.", "MM", "R."
      const pathField = parts.slice(line.startsWith('2 ') ? 9 : 8).join(' ');
      const p = pathField.split('\t')[0];
      const worktree = xy[1] !== '.' ? xy[1] : '';
      const index = xy[0] !== '.' ? xy[0] : '';
      res.files.push({
        path: p,
        status: worktree || index || 'M',
        staged: index !== '',
        ...counts(p),
      });
    } else if (line.startsWith('? ')) {
      res.files.push({ path: line.slice(2), status: '?', staged: false, insertions: 0, deletions: 0 });
    }
  }
  res.files.sort((a, b) => a.path.localeCompare(b.path));
  return res;
}

/** Full pending change for one file (staged + unstaged vs HEAD); untracked diffs against /dev/null. */
/**
 * Diff one path. The pathspec is contained against `cwd` HERE rather than at the caller, because
 * `diff --no-index` does not treat its operands as repository pathspecs — it reads them as plain
 * filesystem paths, so an absolute or `../`-prefixed value would read any file on the disk. A path
 * that escapes the project (or a request with no project open) throws InvalidPayloadError.
 */
export async function gitDiff(cwd: string, file: unknown, untracked: boolean): Promise<string> {
  const pathspec = asGitPathspec(cwd, file);
  try {
    if (untracked) {
      // --no-index exits 1 when files differ — that's the success path here.
      return await run(cwd, ['diff', '--no-index', '--', '/dev/null', pathspec]);
    }
    return await run(cwd, ['diff', 'HEAD', '--', pathspec]);
  } catch {
    try { return await run(cwd, ['diff', '--', pathspec]); } catch { return ''; }
  }
}

export async function gitBranches(cwd: string): Promise<{ current: string; all: string[] }> {
  try {
    const [cur, list] = await Promise.all([
      run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
      run(cwd, ['branch', '--format=%(refname:short)']),
    ]);
    return { current: cur.trim(), all: list.split('\n').map((s) => s.trim()).filter(Boolean) };
  } catch {
    return { current: '', all: [] };
  }
}

export async function gitLog(cwd: string, n: number): Promise<{ hash: string; subject: string; when: string }[]> {
  try {
    const out = await run(cwd, ['log', `-${Math.max(1, Math.min(n, 100))}`, '--format=%h%x09%s%x09%cr']);
    return out.split('\n').filter(Boolean).map((line) => {
      const [hash, subject, when] = line.split('\t');
      return { hash, subject: subject ?? '', when: when ?? '' };
    });
  } catch {
    return [];
  }
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────
 * GitHub lane — remote state plus the three network verbs the USER drives from the IDE.
 *
 * The engine's GitTool deliberately never pushes ("outward-facing actions stay manual"): an AGENT
 * must not publish on its own. That rule is about autonomy, not about the person sitting at the
 * keyboard — these run only from an explicit click, exactly like typing the command in a terminal.
 *
 * Nothing here takes a credential. Push/pull reuse whatever git already has (credential helper,
 * SSH agent, gh auth), so Bimax never sees, stores, or forwards a GitHub token. A repo with no
 * usable credential fails with git's own message, which is the honest outcome.
 * ───────────────────────────────────────────────────────────────────────────────────────────── */

export interface GitRemoteInfo {
  /** false when the folder is not a git repository at all. */
  isRepo: boolean;
  branch: string;
  /** The push remote's URL, normalised to https for display. Empty when there is no remote. */
  remoteUrl: string;
  remoteName: string;
  /** "owner/repo" when the remote is recognisably GitHub, else ''. */
  slug: string;
  /** Whether this branch has an upstream to pull from / push to. */
  hasUpstream: boolean;
  upstream: string;
  ahead: number;
  behind: number;
  /** Uncommitted worktree/index changes — a pull with these present is likely to conflict. */
  dirty: number;
  lastFetch: string;
}

/** Strip credentials and the .git suffix; turn SSH form into the https form a human recognises. */
function displayRemote(raw: string): { url: string; slug: string } {
  const url = raw.trim();
  if (!url) return { url: '', slug: '' };
  const ssh = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (ssh) return { url: `https://${ssh[1]}/${ssh[2]}`, slug: /github\.com$/i.test(ssh[1]) ? ssh[2] : '' };
  const https = url.match(/^https?:\/\/(?:[^@/]*@)?([^/]+)\/(.+?)(?:\.git)?$/);
  if (https) return { url: `https://${https[1]}/${https[2]}`, slug: /github\.com$/i.test(https[1]) ? https[2] : '' };
  return { url, slug: '' };
}

export async function gitRemoteInfo(cwd: string): Promise<GitRemoteInfo> {
  const empty: GitRemoteInfo = {
    isRepo: false, branch: '', remoteUrl: '', remoteName: '', slug: '',
    hasUpstream: false, upstream: '', ahead: 0, behind: 0, dirty: 0, lastFetch: '',
  };
  try {
    await run(cwd, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    return empty;
  }

  const one = async (args: string[]): Promise<string> => {
    try { return (await run(cwd, args)).trim(); } catch { return ''; }
  };

  const branch = await one(['rev-parse', '--abbrev-ref', 'HEAD']);
  const remoteName = (await one(['remote'])).split('\n')[0]?.trim() ?? '';
  const raw = remoteName ? await one(['remote', 'get-url', remoteName]) : '';
  const { url, slug } = displayRemote(raw);
  const upstream = await one(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);

  let ahead = 0, behind = 0;
  if (upstream) {
    // `--count --left-right` prints "<behind>\t<ahead>" for upstream...HEAD.
    const counts = await one(['rev-list', '--left-right', '--count', `${upstream}...HEAD`]);
    const m = counts.match(/^(\d+)\s+(\d+)$/);
    if (m) { behind = Number(m[1]); ahead = Number(m[2]); }
  }

  const porcelain = await one(['status', '--porcelain']);
  const dirty = porcelain ? porcelain.split('\n').filter(Boolean).length : 0;

  return {
    isRepo: true, branch, remoteUrl: url, remoteName, slug,
    hasUpstream: !!upstream, upstream, ahead, behind, dirty,
    lastFetch: '',
  };
}

export interface GitOpResult { ok: boolean; output: string }

/**
 * Run one network verb and report git's own words verbatim.
 *
 * `--no-rebase` and `--ff-only` are deliberate: a pull that silently rebases or creates a merge
 * commit is a surprising write. `--ff-only` fails loudly when the histories diverged, which is the
 * point at which a person should decide, not a button.
 */
async function networkVerb(cwd: string, args: string[]): Promise<GitOpResult> {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120_000,
      // Never let git stop on an interactive credential prompt inside a GUI app: with no TTY it
      // would hang forever with no way to answer. Failing fast surfaces "authentication required".
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (err, stdout, stderr) => {
      const output = `${stdout || ''}${stderr || ''}`.trim();
      resolve({ ok: !err, output: output || (err ? String(err.message) : 'done') });
    });
  });
}

export function gitFetch(cwd: string): Promise<GitOpResult> {
  return networkVerb(cwd, ['fetch', '--prune']);
}

export function gitPull(cwd: string): Promise<GitOpResult> {
  return networkVerb(cwd, ['pull', '--ff-only']);
}

/** Push the current branch. Sets upstream on first push so the next one needs no argument. */
export async function gitPush(cwd: string, setUpstream: boolean): Promise<GitOpResult> {
  const branch = (await (async () => { try { return (await run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(); } catch { return ''; } })());
  if (!branch || branch === 'HEAD') return { ok: false, output: 'Detached HEAD — check out a branch before pushing.' };
  const remote = (await (async () => { try { return (await run(cwd, ['remote'])).split('\n')[0]?.trim() ?? ''; } catch { return ''; } })());
  if (!remote) return { ok: false, output: 'This repository has no remote configured.' };
  return networkVerb(cwd, setUpstream ? ['push', '--set-upstream', remote, branch] : ['push']);
}
