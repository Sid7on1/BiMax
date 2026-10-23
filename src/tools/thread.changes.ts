import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isReadOnlyShellCommand } from './shell.readonly';
import { MappedOperation, mapToolCall } from '../evidence/operation.map';

/**
 * What a file change in a Bimax thread will do, in words a person can check before allowing it — and in enough
 * detail for the thread's undo journal (thread.journal.ts) to put everything back.
 *
 * Only shapes that can be described AND reversed exactly are parsed: `mv`, `rm`, `rmdir`, `cp`, `mkdir` and
 * `touch` with literal paths or same-folder wildcards, optionally after `cd <folder> &&`. Anything else is
 * described honestly as "a command that can change files" and marked as not undoable.
 *
 * Measured 2026-09-13: the approval for `cd /Users/…/Desktop && mv "DEV" "2026-09-13_DEV"` showed only the raw
 * command, and it was allowed in under four seconds. The card now reads "Rename folder “DEV” to “2026-09-13_DEV”".
 */

export type ChangeKind = 'move' | 'trash' | 'copy' | 'create' | 'write' | 'command';

export interface ChangePlan {
  kind: ChangeKind;
  /** One sentence for the approval card, e.g. Rename folder “DEV” to “2026-09-13_DEV”. */
  title: string;
  /** One line per affected item, relative to the thread's folder. */
  preview: string[];
  /** Whether the undo journal can reverse this exactly. */
  undoable: boolean;
  moves: Array<{ from: string; to: string }>;
  trash: string[];
  creates: string[];
  overwrites: string[];
}

const PREVIEW_LIMIT = 200;
const quote = (name: string): string => `“${name}”`;
const exists = (p: string): boolean => { try { fs.lstatSync(p); return true; } catch { return false; } };
const isDir = (p: string): boolean => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const kindOf = (p: string): 'folder' | 'file' => (isDir(p) ? 'folder' : 'file');
const count = (n: number, noun = 'item'): string => `${n} ${noun}${n === 1 ? '' : 's'}`;
const slash = (p: string): string => (isDir(p) ? '/' : '');
const expandHome = (p: string): string => (p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
const blank = (): Pick<ChangePlan, 'moves' | 'trash' | 'creates' | 'overwrites'> => ({ moves: [], trash: [], creates: [], overwrites: [] });

function display(root: string, p: string): string {
  const rel = path.relative(root, p);
  if (!rel) return '.';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return p.startsWith(os.homedir()) ? `~${p.slice(os.homedir().length)}` : p;
  return rel;
}

interface Word { text: string; glob: boolean }

/** Split a command on `&&`, refusing anything else that makes it more than simple commands in sequence. */
function segments(command: string): string[] | null {
  const parts: string[] = [];
  let current = '';
  let quoteChar: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quoteChar) {
      if (quoteChar === '"' && (c === '$' || c === '`')) return null; // expansion inside double quotes
      if (c === '\\' && quoteChar === '"') { current += c + (command[i + 1] ?? ''); i++; continue; }
      if (c === quoteChar) quoteChar = null;
      current += c;
      continue;
    }
    if (c === "'" || c === '"') { quoteChar = c; current += c; continue; }
    if (c === '\\') { current += c + (command[i + 1] ?? ''); i++; continue; }
    if (c === '&' && command[i + 1] === '&') { parts.push(current.trim()); current = ''; i++; continue; }
    if (';|<>`$(){}&\n\r'.includes(c)) return null;
    current += c;
  }
  if (quoteChar) return null;
  parts.push(current.trim());
  return parts.every(Boolean) ? parts : null;
}

/** The words of one simple command, with quotes and backslashes resolved; `glob` marks unquoted wildcards. */
function words(segment: string): Word[] | null {
  const out: Word[] = [];
  let text = '';
  let glob = false;
  let started = false;
  let quoteChar: string | null = null;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (quoteChar) {
      if (c === quoteChar) { quoteChar = null; continue; }
      if (c === '\\' && quoteChar === '"' && i + 1 < segment.length && '"\\'.includes(segment[i + 1])) { text += segment[++i]; continue; }
      text += c;
      continue;
    }
    if (c === "'" || c === '"') { quoteChar = c; started = true; continue; }
    if (c === '\\') { if (i + 1 < segment.length) { text += segment[++i]; started = true; } continue; }
    if (/\s/.test(c)) { if (started) out.push({ text, glob }); text = ''; glob = false; started = false; continue; }
    if (c === '*' || c === '?' || c === '[') glob = true;
    text += c;
    started = true;
  }
  if (quoteChar) return null;
  if (started) out.push({ text, glob });
  return out;
}

function globRegex(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 2);
      if (end === -1) { source += '\\['; continue; }
      let body = pattern.slice(i + 1, end);
      if (body.startsWith('!')) body = `^${body.slice(1)}`;
      source += `[${body.replace(/\\/g, '\\\\')}]`;
      i = end;
    } else source += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/** Paths a word names: itself, or — for an unquoted same-folder wildcard — every match, as the shell would. */
function expand(word: Word, cwd: string): string[] {
  const full = path.resolve(cwd, expandHome(word.text));
  if (!word.glob) return [full];
  const dir = path.dirname(full);
  const pattern = path.basename(full);
  if (/[*?[]/.test(dir)) return [full];
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return [full]; }
  const matcher = globRegex(pattern);
  const hits = names.filter((name) => (pattern.startsWith('.') || !name.startsWith('.')) && matcher.test(name)).sort();
  return hits.length ? hits.map((name) => path.join(dir, name)) : [full];
}

function operands(ws: Word[], flags: RegExp): Word[] | null {
  const out: Word[] = [];
  let flagsDone = false;
  for (const w of ws) {
    if (!flagsDone && w.text === '--') { flagsDone = true; continue; }
    if (!flagsDone && w.text.length > 1 && w.text.startsWith('-')) {
      if (!flags.test(w.text)) return null;
      continue;
    }
    out.push(w);
  }
  return out;
}

/** The first folder a creation brings into existence (`mkdir -p a/b/c` in an empty folder creates `a`). */
function topMissing(target: string): string | null {
  if (exists(target)) return null;
  let current = target;
  while (path.dirname(current) !== current && !exists(path.dirname(current))) current = path.dirname(current);
  return current;
}

function moveTitle(moves: Array<{ from: string; to: string }>): string {
  if (moves.length === 1) {
    const { from, to } = moves[0];
    const kind = kindOf(from);
    if (path.dirname(from) === path.dirname(to)) return `Rename ${kind} ${quote(path.basename(from))} to ${quote(path.basename(to))}`;
    if (path.basename(from) === path.basename(to)) return `Move ${kind} ${quote(path.basename(from))} to ${quote(path.basename(path.dirname(to)))}`;
    return `Move ${kind} ${quote(path.basename(from))} to ${quote(path.basename(path.dirname(to)))} as ${quote(path.basename(to))}`;
  }
  const folders = new Set(moves.map((m) => path.dirname(m.to)));
  return folders.size === 1 ? `Move ${count(moves.length)} to ${quote(path.basename([...folders][0]))}` : `Move ${count(moves.length)}`;
}

function trashTitle(paths: string[]): string {
  return paths.length === 1 ? `Move ${kindOf(paths[0])} ${quote(path.basename(paths[0]))} to the Bin` : `Move ${count(paths.length)} to the Bin`;
}

function copyTitle(sources: string[], targets: string[], replaced: number): string {
  const tail = replaced ? `, replacing ${replaced === 1 ? 'an existing item' : `${replaced} existing items`}` : '';
  const where = quote(path.basename(path.dirname(targets[0])));
  if (sources.length === 1) {
    const renamed = path.basename(targets[0]) !== path.basename(sources[0]) ? ` as ${quote(path.basename(targets[0]))}` : '';
    return `Copy ${kindOf(sources[0])} ${quote(path.basename(sources[0]))} to ${where}${renamed}${tail}`;
  }
  return `Copy ${count(sources.length)} to ${where}${tail}`;
}

function commandPlan(text: string, root: string): ChangePlan {
  return { ...blank(), kind: 'command', title: `Run a command that can change files in ${quote(path.basename(root) || root)}`, preview: [text], undoable: false };
}

function planSimple(ws: Word[], cwd: string, root: string): ChangePlan | null {
  const [head, ...rest] = ws;
  switch (head.text) {
    case 'mv': {
      const ops = operands(rest, /^-[fnv]+$/);
      if (!ops || ops.length < 2 || ops[ops.length - 1].glob) return null;
      const dest = path.resolve(cwd, expandHome(ops[ops.length - 1].text));
      const sources = ops.slice(0, -1).flatMap((w) => expand(w, cwd));
      const destIsDir = isDir(dest);
      if (sources.length > 1 && !destIsDir) return null;
      const moves = sources.map((from) => ({ from, to: destIsDir ? path.join(dest, path.basename(from)) : dest }));
      return { ...blank(), kind: 'move', title: moveTitle(moves), preview: moves.map((m) => `${display(root, m.from)}${slash(m.from)} → ${display(root, m.to)}`), undoable: true, moves };
    }
    case 'rm':
    case 'rmdir': {
      const ops = operands(rest, head.text === 'rm' ? /^(-[rRfvd]+|--(recursive|force|verbose|dir))$/ : /^-v$/);
      if (!ops || ops.length === 0) return null;
      const trash = [...new Set(ops.flatMap((w) => expand(w, cwd)))];
      return { ...blank(), kind: 'trash', title: trashTitle(trash), preview: trash.map((p) => `${display(root, p)}${slash(p)}`), undoable: true, trash };
    }
    case 'cp': {
      const ops = operands(rest, /^-[rRpfvan]+$/);
      if (!ops || ops.length < 2 || ops[ops.length - 1].glob) return null;
      const dest = path.resolve(cwd, expandHome(ops[ops.length - 1].text));
      const sources = ops.slice(0, -1).flatMap((w) => expand(w, cwd));
      const destIsDir = isDir(dest);
      if (sources.length > 1 && !destIsDir) return null;
      const targets = sources.map((src) => (destIsDir ? path.join(dest, path.basename(src)) : dest));
      // Copying a folder onto an existing folder merges them, which cannot be reversed item by item.
      if (targets.some((target, i) => isDir(target) && isDir(sources[i]))) return null;
      const overwrites = targets.filter(exists);
      const creates = targets.filter((target) => !exists(target));
      return {
        ...blank(), kind: 'copy', title: copyTitle(sources, targets, overwrites.length), undoable: true, creates, overwrites,
        preview: sources.map((src, i) => `${display(root, src)}${slash(src)} → ${display(root, targets[i])}${exists(targets[i]) ? '  (replaces the existing one)' : ''}`),
      };
    }
    case 'mkdir': {
      const ops = operands(rest, /^-[pv]+$/);
      if (!ops || ops.length === 0 || ops.some((w) => w.glob)) return null;
      const creates = [...new Set(ops.map((w) => topMissing(path.resolve(cwd, expandHome(w.text)))).filter((p): p is string => !!p))];
      if (!creates.length) return null;
      return { ...blank(), kind: 'create', title: creates.length === 1 ? `Create folder ${quote(path.basename(creates[0]))}` : `Create ${count(creates.length, 'folder')}`, preview: creates.map((p) => `${display(root, p)}/`), undoable: true, creates };
    }
    case 'touch': {
      const ops = operands(rest, /^$/);
      if (!ops || ops.length === 0 || ops.some((w) => w.glob)) return null;
      const files = ops.map((w) => path.resolve(cwd, expandHome(w.text)));
      const creates = files.filter((file) => !exists(file));
      const title = creates.length === 1 ? `Create file ${quote(path.basename(creates[0]))}`
        : creates.length ? `Create ${count(creates.length, 'file')}` : `Update the modified time of ${count(files.length, 'file')}`;
      return { ...blank(), kind: 'create', title, preview: files.map((file) => display(root, file)), undoable: true, creates };
    }
    default:
      return null;
  }
}

/** The change a shell command makes; null for a read-only command, which needs no card and no journal entry. */
export function planShellChange(command: string, cwd: string, root = process.env.BIMAX_THREAD_ROOT || cwd): ChangePlan | null {
  const text = String(command || '').trim();
  if (!text || isReadOnlyShellCommand(text)) return null;
  const parts = segments(text);
  if (parts) {
    let dir = cwd;
    for (let i = 0; i < parts.length; i++) {
      const ws = words(parts[i]);
      if (!ws || ws.length === 0) break;
      if (i < parts.length - 1) {
        if (ws[0].text !== 'cd' || ws.length !== 2 || ws[1].glob) break;
        dir = path.resolve(dir, expandHome(ws[1].text));
        continue;
      }
      const plan = planSimple(ws, dir, root);
      if (plan) return plan;
    }
  }
  return commandPlan(text, root);
}

/** The change a governed tool call makes: a Bash command, a file write or edit, a new folder, or a delete. */
export function planFileChange(taskType: string, payload: any, cwd: string, root = process.env.BIMAX_THREAD_ROOT || cwd): ChangePlan | null {
  if (taskType === 'OS_COMMAND') return planShellChange(String(payload?.command ?? ''), cwd, root);
  const target = typeof payload?.targetPath === 'string' ? payload.targetPath
    : typeof payload?.path === 'string' ? path.resolve(cwd, expandHome(payload.path)) : null;
  if (!target) return null;
  const name = quote(path.basename(target));
  if (taskType === 'FILE_DELETE') {
    return { ...blank(), kind: 'trash', title: `Move ${kindOf(target)} ${name} to the Bin`, preview: [`${display(root, target)}${slash(target)}`], undoable: true, trash: [target] };
  }
  if (taskType !== 'FILE_WRITE') return null;
  if (payload?.tool === 'CreateDirectoryTool') {
    const top = topMissing(target);
    return top ? { ...blank(), kind: 'create', title: `Create folder ${quote(path.basename(top))}`, preview: [`${display(root, top)}/`], undoable: true, creates: [top] } : null;
  }
  if (exists(target)) {
    if (isDir(target)) return null;
    const verb = ['EditFileTool', 'SymbolEditTool', 'MultiEditTool'].includes(payload?.tool) ? 'Edit' : 'Replace the contents of';
    return { ...blank(), kind: 'write', title: `${verb} ${name}`, preview: [display(root, target)], undoable: true, overwrites: [target] };
  }
  return { ...blank(), kind: 'create', title: `Create file ${name}`, preview: [display(root, target)], undoable: true, creates: [topMissing(target) ?? target] };
}

/**
 * A delete the thread cannot send to the Bin — `find -delete`, `rm` inside a pipeline or chain, `git clean`,
 * `unlink`. It would be permanent and impossible to undo, so threads refuse it and say how to delete instead.
 */
export function deletesOutsideBin(command: string, cwd: string): boolean {
  const text = String(command || '');
  if (!/(^|[\s;&|(`])(rm|rmdir|unlink|shred|srm)(\s|$)|\s-delete(\s|$)|\bgit\s+clean\b/.test(text)) return false;
  const plan = planShellChange(text, cwd);
  return !plan || plan.kind === 'command';
}

/** The approval card: a sentence, every affected item, whether it can be undone, and the command for reference. */
/**
 * What an operation DECLARES beyond the files it touches — the part a file-change plan cannot see.
 *
 * `planFileChange` above is file-shaped by design: it exists so a move or a delete can be described
 * and reversed. But `src/evidence/operation.map.ts` already derives more from the same tool call —
 * the network hosts named in it, whether it installs dependencies, and crucially whether the effects
 * were READ FROM TEXT rather than observed. That mapping runs on every tool call (task.guard.ts
 * calls it) and is used to block; until now none of it reached the person being asked to approve.
 *
 * So an approval for `curl https://example.com/x.sh | sh` showed the command and nothing else: no
 * "this contacts example.com", and no "these effects were read statically, so this list may be
 * incomplete." Both are exactly what someone needs in the two seconds they spend on the card.
 *
 * Restrained on purpose. Processes are NOT listed: the raw command is already on the card, so
 * repeating its first words adds noise without adding a fact. Paths are not repeated either — the
 * plan above already lists every affected item, better. This adds only what is genuinely missing.
 */
export function declaredEffectLines(mapped: MappedOperation): string[] {
  const lines: string[] = [];
  const hosts = mapped.effects.hosts ?? [];
  if (hosts.length) {
    lines.push(`🌐 Contacts ${hosts.length === 1 ? 'the host' : 'hosts'}: ${hosts.join(', ')}`);
  }
  if (mapped.effects.installsDependencies) {
    lines.push('📦 Installs dependencies — this can change what later commands run.');
  }
  // The honesty line. A static reading cannot tell a read from a write, so a card built on one must
  // never imply the list above is complete (see operation.map.ts, and the `declared` provenance in
  // task.guard.ts that stops a declaration ever certifying an end state).
  //
  // Suppressed when the mapping is confident the command only inspects AND there is nothing else to
  // qualify. Measured on the real cards: `ls -la` carried the same warning as `./deploy.sh --prod`,
  // and a caveat that appears on everything is one people learn to click past — which would cost
  // exactly the case it exists for. If there IS a host or an install to qualify, it stays, because
  // then the list genuinely might be missing something.
  const nothingToQualify = mapped.effects.readOnly === true && lines.length === 0;
  if (mapped.staticReading && !nothingToQualify) {
    lines.push(`⚠ ${mapped.staticReading} — anything above may be incomplete.`);
  }
  return lines;
}

export function approvalCard(plan: ChangePlan | null, taskType: string, payload: any): { question: string; body: string } {
  const command = taskType === 'OS_COMMAND' ? String(payload?.command ?? '').trim() : '';
  // Pure and side-effect free, so computing it before the approval costs nothing and cannot fail
  // the call. Wrapped anyway: a card that throws would block work the user is watching.
  let declared: string[] = [];
  try {
    const cwd = payload?.context?.cwd || process.cwd();
    declared = declaredEffectLines(mapToolCall(String(payload?.tool || ''), payload ?? {}, cwd));
  } catch { /* the card is still worth showing without this */ }

  if (!plan) {
    const target = typeof payload?.targetPath === 'string' ? payload.targetPath : typeof payload?.path === 'string' ? payload.path : '';
    const what = String(payload?.tool || 'this action');
    const body = [command ? `Command: ${command}` : '', ...declared].filter(Boolean).join('\n\n');
    return { question: target ? `Allow ${what} on ${quote(path.basename(target))}?` : `Allow ${what}?`, body };
  }
  const lines = plan.preview.slice(0, PREVIEW_LIMIT);
  if (plan.preview.length > PREVIEW_LIMIT) lines.push(`…and ${plan.preview.length - PREVIEW_LIMIT} more`);
  const sections = [lines.join('\n'), plan.undoable ? '↶ You can undo this from the thread in Bimax.' : '⚠ This can’t be undone.'];
  if (command && plan.kind !== 'command') sections.push(`Command: ${command}`);
  if (declared.length) sections.push(declared.join('\n'));
  return { question: plan.title, body: sections.join('\n\n') };
}
