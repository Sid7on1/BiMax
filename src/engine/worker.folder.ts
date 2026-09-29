import * as nodePath from 'node:path';
// DEFAULT imports on purpose: they are the mutable module objects in both the bundled ESM engine and CommonJS
// tests. `import * as fs` is a frozen module namespace in the bundle ("Cannot assign to property 'access'"),
// which is how the first run of this in a real worker failed while every unit test passed.
import nodeFs from 'node:fs';
import nodeChildProcess from 'node:child_process';
import { isMainThread, workerData } from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
// Type-only: erased from the bundle, so this stays the first module the engine evaluates.
import type { EngineWorkerData } from './api';

/**
 * A working folder of its own for an engine running as a worker thread (record 64, M1).
 *
 * In the monolith each Bimax Thread's engine is a worker thread inside the app's process. A worker cannot
 * `process.chdir()` (Node: "not available in Worker threads"), and the process has ONE working folder, shared by the
 * app and every engine. Measured before this existed: the engine's `@`-file suggestions came back empty because it was
 * silently reading the app's folder instead of the task's.
 *
 * So each engine worker gets a virtual one, installed before any engine module loads (this is the first import of
 * src/index.ts):
 *   • `process.cwd()` answers the worker's folder, and `process.chdir()` moves it (validated like the real one);
 *   • `fs` functions resolve a RELATIVE path against it — the OS would otherwise resolve it against the app's folder;
 *   • `child_process` calls that name no `cwd` run in it, not in the app's folder.
 * A symlink's TARGET stays as written (a relative target is relative to the link, by definition), and calls that
 * take a file descriptor are untouched.
 *
 * It installs only in a worker whose `workerData.bimaxEngineRoot` names the folder, so the engine hosted any other way
 * — a utilityProcess, a child process, a test — runs exactly as before.
 */

export interface WorkerFolderModules {
  process: { cwd: () => string; chdir: (dir: string) => void };
  fs: Record<string, unknown> & { promises: Record<string, unknown>; statSync: typeof nodeFs.statSync };
  childProcess: Record<string, unknown>;
}

/** Functions whose first TWO arguments are paths. */
const TWO_PATHS = new Set(['rename', 'renameSync', 'copyFile', 'copyFileSync', 'link', 'linkSync', 'cp', 'cpSync']);
/** Functions whose SECOND argument is the path and whose first is a symlink target, left as written. */
const SECOND_PATH_ONLY = new Set(['symlink', 'symlinkSync']);
/** Functions whose first argument is a file descriptor or data, never a path. */
const NOT_A_PATH = /^(f[a-z]+|write|writeSync|read|readSync|close|closeSync|writev|writevSync|readv|readvSync|openAsBlob|constants|promises|glob|globSync)$/;
/** Pattern-taking functions: a relative pattern stays relative, and the search starts in the worker's folder. */
const GLOBS = ['glob', 'globSync'];
const SPAWNERS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];

/**
 * Wrap `original` so `transform` rewrites its arguments first, keeping every own property it had — including
 * non-enumerable symbols. `util.promisify.custom` (on `exec`, `execFile`, `fs.exists`) is wrapped with the same
 * transform: `promisify(exec)` calls that custom form directly, so copying it unwrapped let promisified calls skip the
 * folder entirely (caught by the test that promisifies exec).
 */
function wrapFunction(original: (...a: unknown[]) => unknown, name: string, transform: (args: unknown[]) => void): (...a: unknown[]) => unknown {
  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    transform(args);
    return original.apply(this, args);
  };
  for (const key of Reflect.ownKeys(original)) {
    if (key === 'length' || key === 'name' || key === 'prototype' || key === 'arguments' || key === 'caller') continue;
    const descriptor = Object.getOwnPropertyDescriptor(original, key);
    if (!descriptor) continue;
    if (key === promisify.custom && typeof descriptor.value === 'function') {
      // A promisified function names itself as its own custom form (that is how promisify stays idempotent), so a
      // self-reference points at the new wrapper instead of recursing.
      descriptor.value = descriptor.value === original
        ? wrapped
        : wrapFunction(descriptor.value as (...a: unknown[]) => unknown, `${name}Promisified`, transform);
    }
    Object.defineProperty(wrapped, key, descriptor);
  }
  Object.defineProperty(wrapped, 'name', { value: name });
  return wrapped;
}

/** Replace `m`'s path-taking functions with ones that resolve a relative string path against `folder()`. */
function resolveRelativePaths(m: Record<string, unknown>, folder: () => string): void {
  const absolute = (p: unknown): unknown => (typeof p === 'string' && p !== '' && !nodePath.isAbsolute(p) ? nodePath.resolve(folder(), p) : p);
  for (const name of Object.keys(m)) {
    const original = m[name];
    if (typeof original !== 'function' || /^[A-Z_]/.test(name) || NOT_A_PATH.test(name)) continue;
    const wrapped = wrapFunction(original as (...a: unknown[]) => unknown, name, (args) => {
      if (SECOND_PATH_ONLY.has(name)) args[1] = absolute(args[1]);
      else {
        args[0] = absolute(args[0]);
        if (TWO_PATHS.has(name)) args[1] = absolute(args[1]);
      }
    });
    // realpath and realpathSync carry a `.native` variant that takes a path as well.
    const native = (original as { native?: unknown }).native;
    if (typeof native === 'function') {
      Object.defineProperty(wrapped, 'native', {
        value: wrapFunction(native as (...a: unknown[]) => unknown, 'native', (args) => { args[0] = absolute(args[0]); }),
        enumerable: true, configurable: true, writable: true,
      });
    }
    m[name] = wrapped;
  }
}

/** Give `fs.glob` calls that name no `cwd` the worker's folder. */
function defaultGlobFolder(m: Record<string, unknown>, folder: () => string): void {
  for (const name of GLOBS) {
    const original = m[name];
    if (typeof original !== 'function') continue;
    m[name] = wrapFunction(original as (...a: unknown[]) => unknown, name, (args) => {
      const options = args[1];
      if (options !== null && typeof options === 'object') {
        if ((options as { cwd?: unknown }).cwd === undefined) args[1] = { ...(options as object), cwd: folder() };
      } else {
        args.splice(1, 0, { cwd: folder() }); // (pattern, callback) or (pattern)
      }
    });
  }
}

/** Give `child_process` calls that name no `cwd` the worker's folder. */
function defaultChildFolder(m: Record<string, unknown>, folder: () => string): void {
  for (const name of SPAWNERS) {
    const original = m[name];
    if (typeof original !== 'function') continue;
    m[name] = wrapFunction(original as (...a: unknown[]) => unknown, name, (args) => {
      const at = args.findIndex((a) => a !== null && typeof a === 'object' && !Array.isArray(a));
      if (at >= 0) {
        const options = args[at] as { cwd?: unknown };
        if (options.cwd === undefined) args[at] = { ...options, cwd: folder() };
      } else {
        // No options object: it goes after the command and its argument list, before any callback.
        const insertAt = Array.isArray(args[1]) ? 2 : 1;
        args.splice(insertAt, 0, { cwd: folder() });
      }
    });
  }
}

/** Install the virtual working folder on the given modules (the real ones by default). Returns the folder reader. */
export function installWorkerFolder(root: string, modules?: WorkerFolderModules): () => string {
  const target: WorkerFolderModules = modules ?? {
    process: process as unknown as WorkerFolderModules['process'],
    fs: nodeFs as unknown as WorkerFolderModules['fs'],
    childProcess: nodeChildProcess as unknown as Record<string, unknown>,
  };
  let folder = nodePath.resolve(root);
  const read = (): string => folder;
  target.process.cwd = read;
  target.process.chdir = (dir: string): void => {
    const next = nodePath.resolve(folder, String(dir));
    // Same failures as the real chdir: a missing path throws ENOENT (from statSync), a file throws ENOTDIR.
    if (!target.fs.statSync(next).isDirectory()) {
      throw Object.assign(new Error(`ENOTDIR: not a directory, chdir '${next}'`), { code: 'ENOTDIR', path: next });
    }
    folder = next;
  };
  resolveRelativePaths(target.fs, read);
  resolveRelativePaths(target.fs.promises, read);
  defaultGlobFolder(target.fs, read);
  defaultGlobFolder(target.fs.promises, read);
  defaultChildFolder(target.childProcess, read);
  if (!modules) syncBuiltinESMExports(); // ESM named imports of fs/child_process see the wrapped functions too
  return read;
}

/** The folder a hosting app gave this engine worker, or null when this is not an engine worker. */
export function engineWorkerRoot(): string | null {
  if (isMainThread) return null;
  const root = (workerData as Partial<EngineWorkerData> | null)?.bimaxEngineRoot;
  return typeof root === 'string' && root ? root : null;
}

// Runs on import. It must be the first import of src/index.ts so nothing reads the folder before it is right.
const root = engineWorkerRoot();
if (root) installWorkerFolder(root);
