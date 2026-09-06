/**
 * Is one shell command safe to run CONCURRENTLY with its sibling tool calls in the same turn?
 *
 * deepseek-harness classifies concurrency per CALL rather than per tool
 * (`isConcurrencySafe(args)` in `packages/core/tools/src/schema.ts`), and BashTool is the tool that
 * proves why: as a whole it is a barrier, but a turn of `git status`, `rg TODO`, `wc -l src/*.ts`
 * is three read-only lookups that have no reason to run one after another.
 *
 * The bar here is deliberately much higher than "probably harmless". Getting this wrong does not
 * mean a slow turn, it means two mutations racing, so every ambiguity resolves to EXCLUSIVE:
 * an unrecognized binary, any redirect, any command substitution, any separator that could chain a
 * second command, any flag that turns a reader into a writer. A false "exclusive" costs a few
 * hundred milliseconds; a false "parallel" corrupts the workspace.
 */

/** Binaries that only read. Anything absent from this set makes the command exclusive. */
const READ_ONLY_BINARIES = new Set<string>([
  'ls', 'cat', 'head', 'tail', 'wc', 'nl', 'file', 'stat', 'du', 'df', 'pwd',
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack',
  'sort', 'uniq', 'cut', 'tr', 'column', 'rev', 'fold', 'comm', 'diff', 'cmp',
  'basename', 'dirname', 'realpath', 'readlink', 'which', 'type', 'command',
  'echo', 'printf', 'date', 'env', 'printenv', 'uname', 'hostname', 'whoami', 'id',
  'jq', 'yq', 'true', 'false', 'seq', 'expr', 'tee',
  'find', 'sed', 'git', 'node', 'python3', 'npm', 'npx', 'pnpm', 'yarn',
]);

/**
 * Binaries in the set above that are read-only ONLY for some arguments. Each entry returns whether
 * THIS invocation is read-only; the guard treats a missing entry as unconditionally read-only and
 * anything not in {@link READ_ONLY_BINARIES} as exclusive regardless.
 */
const CONDITIONAL: Record<string, (args: string[]) => boolean> = {
  // `-i` edits in place; `w`/`W` commands write files from inside the script.
  sed: args => !args.some(a => a === '-i' || a.startsWith('-i') || /(^|;)\s*[wW]\s/.test(a)),
  // `-delete`, `-exec`, `-fprint` and friends turn a search into an arbitrary mutation.
  find: args => !args.some(a => /^-(delete|exec|execdir|ok|okdir|fls|fprint|fprintf|fprint0)$/.test(a)),
  // `tee` writes by definition; it is only in the list so `| tee` reads as a known binary, and it
  // is never read-only.
  tee: () => false,
  // Only the reporting subcommands. Everything else (commit, checkout, fetch, gc, …) mutates the
  // repository or the index, and two of those racing is exactly the corruption to avoid.
  git: args => {
    const sub = args.find(a => !a.startsWith('-'));
    return sub !== undefined && ['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files',
      'ls-tree', 'blame', 'describe', 'shortlog', 'cat-file', 'symbolic-ref'].includes(sub);
  },
  // Only the version/inspection verbs; anything that resolves or installs touches node_modules.
  node: args => args.every(a => a === '--version' || a === '-v'),
  python3: args => args.every(a => a === '--version' || a === '-V'),
  npm: args => args.length > 0 && ['ls', 'list', 'view', 'info', 'outdated', 'config', 'root', 'bin', 'why'].includes(args[0]),
  pnpm: args => args.length > 0 && ['ls', 'list', 'view', 'info', 'outdated', 'why', 'root'].includes(args[0]),
  yarn: args => args.length > 0 && ['list', 'info', 'why'].includes(args[0]),
  // `npx` runs an arbitrary package. There is no read-only form worth guessing at.
  npx: () => false,
};

/** Shell metacharacters that can chain, redirect, background, or substitute another command. */
const UNSAFE_SHELL = /[;&<>`\n\r]|\$\(|\$\{|\|\||&&|>>/;

/**
 * Split a pipeline on `|`, ignoring `|` inside single or double quotes. Returns null when the
 * quoting is unbalanced, which is itself a reason to refuse.
 */
function splitPipeline(command: string): string[] | null {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === '\\' && quote === '"') { current += c + (command[++i] ?? ''); continue; }
      if (c === quote) quote = null;
      current += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; current += c; continue; }
    if (c === '|') { segments.push(current); current = ''; continue; }
    current += c;
  }
  if (quote) return null;
  segments.push(current);
  return segments;
}

/** Naive whitespace tokenization, with surrounding quotes stripped from each token. */
function tokenize(segment: string): string[] {
  const tokens = segment.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return tokens.map(t => t.replace(/^["']|["']$/g, ''));
}

/**
 * Whether `command` may overlap with sibling tool calls. Fail-closed on every ambiguity.
 *
 * Note this is a CONCURRENCY question, not a permission one: the Governor, the sandbox, and the
 * task guard all still run for the call. Answering `true` only means the call does not need to
 * hold the turn's barrier.
 */
export function isReadOnlyShellCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  const trimmed = command.trim();
  // An empty command does nothing, but it also has nothing to gain from overlapping.
  if (!trimmed || trimmed.length > 2000) return false;
  // One `|`-only pipeline of readers. Redirects, chains, substitutions and backgrounding are out:
  // `echo x > f` and `a && rm -rf b` both begin with a binary from the read-only set.
  if (UNSAFE_SHELL.test(trimmed)) return false;

  const segments = splitPipeline(trimmed);
  if (!segments || segments.length === 0) return false;

  for (const segment of segments) {
    const tokens = tokenize(segment);
    if (tokens.length === 0) return false;
    // `VAR=x cmd` assigns into the command's environment; the assignment itself is harmless, but
    // it is not worth the parse, so it stays exclusive.
    let binary = tokens[0];
    if (binary.includes('=')) return false;
    // A path-qualified binary (`/bin/ls`, `./script.sh`) is judged by its basename only when it is
    // an absolute system path; a relative one is a project script we know nothing about.
    if (binary.startsWith('./') || binary.startsWith('../')) return false;
    if (binary.includes('/')) binary = binary.slice(binary.lastIndexOf('/') + 1);
    if (!READ_ONLY_BINARIES.has(binary)) return false;
    const check = CONDITIONAL[binary];
    if (check && !check(tokens.slice(1))) return false;
  }
  return true;
}
