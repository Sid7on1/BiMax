/**
 * Provisioning a private Python environment, extracted so more than one thing can have one.
 *
 * `memory/headroomProxy.ts` already proved the shape on this machine: find a system python3, build
 * a venv under `vendor/<name>/venv` (gitignored), pip-install into it on FIRST USE rather than at
 * install time, and degrade silently to whatever the product did before when python is absent. That
 * is the whole reason the compressor could ship an ONNX model without making Python a hard
 * dependency of the CLI.
 *
 * What was missing is that the logic lived inside the compressor. Two more consumers need it —
 * document conversion and visual retrieval, both of which are Python-only ecosystems — and copying
 * three hundred lines twice is how the two copies drift. So the environment is a value here, and the
 * things that need one own the parts that differ: what to install, and how to invoke it.
 *
 * Deliberately NOT here: process lifecycle. A resident model server and a batch converter want
 * opposite things (a port, a lock and a health probe vs. a subprocess per document), and pretending
 * they are one abstraction is how a converter ends up holding a port it never uses.
 */

import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils';

export interface ProcessResult {
  /** Exit code, or -1 when the process could not be spawned at all. */
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run a command to completion without ever blocking the engine's event loop.
 *
 * `execFileSync` would be shorter and would freeze the protocol host for the length of a pip
 * install, which on a cold machine is minutes.
 */
export function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child: ChildProcess;
    let settled = false;
    const finish = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: options.cwd,
        env: options.env,
      });
    } catch (error) {
      finish({ status: -1, stdout, stderr: (error as Error).message });
      return;
    }
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL');
          finish({ status: -1, stdout, stderr: `timed out after ${options.timeoutMs}ms` });
        }, options.timeoutMs)
      : null;
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', (error) => { if (timer) clearTimeout(timer); finish({ status: -1, stdout, stderr: error.message }); });
    child.once('close', (status) => { if (timer) clearTimeout(timer); finish({ status, stdout, stderr }); });
  });
}

/**
 * A usable system python3 to bootstrap a venv from, or null.
 *
 * Run it rather than asking the shell where it is: `command -v` is a builtin and answers "absent"
 * through execFile on machines that have the binary — the same trap `ocr.ts` documents for swiftc.
 */
export async function findSystemPython(): Promise<string | null> {
  for (const candidate of ['python3', 'python']) {
    const result = await runProcess(candidate, ['-c', 'import sys; print(sys.version_info[0])'], { timeoutMs: 15_000 });
    if (result.status === 0 && result.stdout.trim().startsWith('3')) return candidate;
  }
  return null;
}

/** Where vendored environments live. `vendor/` is gitignored in full. */
export function vendorRoot(): string {
  // dist/sidecar/python.env.js -> ../.. ; src/sidecar/python.env.ts -> ../.. . Both land on the
  // package root, which is the same resolution headroomProxy uses.
  return path.resolve(__dirname, '..', '..', 'vendor');
}

export interface VenvSpec {
  /** Directory name under `vendor/`, and the label in log lines. */
  name: string;
  /** pip requirement strings, installed together so pip can solve them as one set. */
  packages: string[];
  /**
   * Modules that must import cleanly for the venv to count as provisioned.
   *
   * Checking imports rather than a marker file is the difference between "we ran pip once" and "it
   * works": a half-finished install, a wheel that failed to build, or an interpreter upgrade that
   * orphaned the venv all leave the marker in place and the import broken.
   */
  imports: string[];
}

export class PythonVenv {
  constructor(private readonly spec: VenvSpec) {}

  get home(): string {
    return path.join(vendorRoot(), this.spec.name);
  }

  get dir(): string {
    return path.join(this.home, 'venv');
  }

  /** Path to an executable inside the venv, Windows layout included. */
  bin(name: string): string {
    const isWindows = process.platform === 'win32';
    return path.join(this.dir, isWindows ? 'Scripts' : 'bin', isWindows ? `${name}.exe` : name);
  }

  get python(): string {
    return this.bin('python');
  }

  /** True when the venv exists AND every declared module imports. */
  async provisioned(): Promise<boolean> {
    if (!fs.existsSync(this.python)) return false;
    const probe = this.spec.imports.map((m) => `import ${m}`).join('; ');
    const result = await runProcess(this.python, ['-c', probe], { timeoutMs: 60_000 });
    return result.status === 0;
  }

  /**
   * Create the venv and install the packages. Slow on first run and silent about it afterwards.
   *
   * Returns false rather than throwing: every caller has a documented way to work without Python,
   * and turning "no interpreter on this box" into an exception would take the whole feature down
   * instead of the optional half of it.
   */
  async provision(): Promise<boolean> {
    const system = await findSystemPython();
    if (!system) {
      Logger.warn(`[${this.spec.name}] no python3 found — this capability stays unavailable.`);
      return false;
    }
    fs.mkdirSync(this.home, { recursive: true });
    if (!fs.existsSync(this.python)) {
      Logger.info(`[${this.spec.name}] creating Python venv (vendor/${this.spec.name}/venv)…`);
      const created = await runProcess(system, ['-m', 'venv', this.dir], { timeoutMs: 300_000 });
      if (created.status !== 0) {
        Logger.warn(`[${this.spec.name}] venv creation failed: ${created.stderr || created.stdout}`);
        return false;
      }
    }
    Logger.info(`[${this.spec.name}] installing ${this.spec.packages.join(' ')} (one-time, large)…`);
    // pip's own version is upgraded first because older pips cannot read the wheel metadata some of
    // these publish. A failure here is a warning, not a stop: the install may still succeed.
    const bootstrap = await runProcess(this.python, ['-m', 'pip', 'install', '-q', '--upgrade', 'pip'], { timeoutMs: 300_000 });
    if (bootstrap.status !== 0) Logger.warn(`[${this.spec.name}] pip self-upgrade warning: ${bootstrap.stderr}`);

    const installed = await runProcess(
      this.python,
      ['-m', 'pip', 'install', '-q', ...this.spec.packages],
      // Model downloads are separate; this is wheels only, but torch wheels are enormous.
      { timeoutMs: 3_600_000, env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1' } },
    );
    if (installed.status !== 0) {
      Logger.warn(`[${this.spec.name}] pip install failed: ${installed.stderr || installed.stdout}`);
      return false;
    }
    Logger.info(`[${this.spec.name}] dependencies installed.`);
    return true;
  }

  /** Provision only if needed. Idempotent, and safe to call on every use. */
  async ensure(): Promise<boolean> {
    if (await this.provisioned()) return true;
    if (!(await this.provision())) return false;
    // Verify rather than assume: pip exiting 0 and the import working are different claims, and
    // the gap between them is exactly where a broken wheel hides.
    return this.provisioned();
  }
}
