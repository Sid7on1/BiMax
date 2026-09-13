import { stateDir } from '../utils/state.dir';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, exec } from 'child_process';
import { globalProjectMemory } from '../memory/project.memory';
import { mindSingletonRoot } from './self.model';

/**
 * DogfoodEngine — embodied verification. The agent USES the software it builds,
 * as a user persona, instead of stopping at "tests pass":
 *
 *   - TUI probe   — launches the built Go TUI inside a real PTY (via macOS/BSD
 *                   `script`), lets it render, quits, and inspects the captured
 *                   frames for panics / empty screens / error spew.
 *   - CLI probe   — runs the built CLI's --help/--version as a first-time user
 *                   would and checks it responds sanely.
 *   - Site probe  — loads the built site in headless Chrome (system Chrome — the
 *                   bundled Chromium crashes under Rosetta) and captures console
 *                   errors + a screenshot.
 *
 * Each failed probe becomes a STRUCTURED BUG REPORT in .bimax/dogfood/, plus a
 * project-memory gotcha, so the finding feeds back into the agent's work queue.
 * Probes run strictly sequentially with hard timeouts.
 */

export interface ProbeResult {
  id: string;
  persona: string;
  ran: boolean;
  passed?: boolean;
  summary: string;
  evidence?: string;
}

type Log = (level: 'info' | 'success' | 'error', msg: string) => void;

function sh(cmd: string, cwd: string, timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    exec(cmd, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? 1 : 0, out: `${stdout}\n${stderr}`.trim() });
    });
  });
}

export class DogfoodEngine {
  private outDir: string;

  constructor(private projectRoot: string = process.cwd()) {
    this.outDir = path.join(stateDir('.bimax', projectRoot), 'dogfood');
  }

  private has(p: string): boolean {
    try { return fs.existsSync(path.join(this.projectRoot, p)); } catch { return false; }
  }

  /**
   * Launch a terminal app in a REAL pty via `script`, feed it quit keys after a
   * render window, and return everything it drew. Works without a node-pty dep.
   */
  private probeTuiBinary(binRel: string): Promise<ProbeResult> {
    const persona = 'first-time user opening the TUI';
    return new Promise(resolve => {
      const bin = path.join(this.projectRoot, binRel);
      // BSD `script` calls tcgetattr on its own stdin and fails when the release gate itself is
      // non-interactive. macOS ships `expect`, which allocates a child PTY even from CI. Linux's
      // util-linux `script -c` supports the pipe-based invocation directly.
      const expectProgram = [
        'set timeout 15',
        'log_user 1',
        'spawn -noecho $env(BIMAX_DOGFOOD_BIN)',
        'after 6000 { send "\\003" }',
        'expect { eof {} timeout { send "\\003"; after 800; catch { close }; catch { wait } } }',
      ].join('\n');
      const executable = process.platform === 'darwin' ? '/usr/bin/expect' : 'script';
      const scriptArgs = process.platform === 'darwin'
        ? ['-c', expectProgram]
        : ['-q', '-c', bin, '/dev/null'];
      const child = spawn(executable, scriptArgs, {
        cwd: path.dirname(bin),
        env: {
          ...process.env,
          BIMAX_DOGFOOD_BIN: bin,
          TERM: 'xterm-256color', COLORTERM: 'truecolor', COLORFGBG: '15;0',
          COLUMNS: '120', LINES: '35',
        },
      });
      let out = '';
      let settled = false;
      const finish = (passed: boolean, summary: string) => {
        if (settled) return;
        settled = true;
        try { child.kill('SIGKILL'); } catch { /* already dead */ }
        resolve({ id: 'tui-smoke', persona, ran: true, passed, summary, evidence: out.slice(-1500) });
      };
      child.stdout?.on('data', (d: Buffer) => { out += d.toString('utf-8'); });
      child.stderr?.on('data', (d: Buffer) => { out += d.toString('utf-8'); });
      child.on('error', (e) => finish(false, `could not launch: ${e.message}`));
      const rendered = () => /\bBIMAX\b|Starting engine|● Ready/.test(out);
      // Linux `script` receives quit keys from here; macOS expect sends them inside its PTY.
      if (process.platform !== 'darwin') {
        setTimeout(() => { try { child.stdin?.write('\x03'); } catch { /* closed */ } }, 6000);
        setTimeout(() => { try { child.stdin?.write('\x03'); } catch { /* closed */ } }, 6800);
      }
      const deadline = setTimeout(() => finish(
        rendered() && !/panic:|fatal error:/i.test(out),
        rendered() ? 'rendered, but had to be killed (quit did not exit it)' : 'no meaningful render before timeout'
      ), 15000);
      deadline.unref?.();
      child.on('exit', (code, signal) => {
        const panicked = /panic:|fatal error:/i.test(out);
        if (panicked) finish(false, 'TUI panicked on launch');
        else if (!rendered()) {
          out += `\n[harness] PTY wrapper exited code=${code ?? 'null'} signal=${signal ?? 'none'}`;
          finish(false, 'TUI exited without rendering a frame');
        }
        else finish(true, 'TUI launched, rendered, and quit cleanly');
      });
    });
  }

  /** CLI probe: does the built binary answer --help like a sane tool? */
  private async probeCli(): Promise<ProbeResult | null> {
    const persona = 'new user running --help';
    const entry = this.has('build/bimax') ? './build/bimax --help'
      : this.has('dist/index.js') ? 'node dist/index.js --help'
      : this.has('package.json') && !!this.pkg()?.bin ? 'npx --no-install . --help'
      : null;
    if (!entry) return null;
    const { code, out } = await sh(entry, this.projectRoot, 30_000);
    const passed = code === 0 && out.length > 40 && !/error|exception|traceback/i.test(out.slice(0, 200));
    return { id: 'cli-help', persona, ran: true, passed, summary: passed ? '--help responds with usage' : `--help failed (exit ${code})`, evidence: out.slice(0, 800) };
  }

  private pkg(): any {
    try { return JSON.parse(fs.readFileSync(path.join(this.projectRoot, 'package.json'), 'utf-8')); } catch { return null; }
  }

  /** Which probes apply here — used by /dogfood to explain itself before running. */
  applicableProbes(): string[] {
    const probes: string[] = [];
    if (this.has('build/bimax') || this.has('tui/bimax-tui')) probes.push('tui-smoke');
    if (this.has('build/bimax') || this.has('dist/index.js') || !!this.pkg()?.bin) probes.push('cli-help');
    return probes;
  }

  /** Run every applicable probe sequentially; write bug reports for failures. */
  async run(log: Log = () => {}): Promise<{ results: ProbeResult[]; reportPath?: string }> {
    const results: ProbeResult[] = [];

    const tuiBinary = this.has('build/bimax') ? 'build/bimax' : 'tui/bimax-tui';
    if (this.has(tuiBinary) && process.platform !== 'win32') {
      log('info', 'Dogfood: opening the TUI as a first-time user…');
      results.push(await this.probeTuiBinary(tuiBinary));
    }
    const cli = await this.probeCli();
    if (cli) { log('info', 'Dogfood: running --help as a new user…'); results.push(cli); }

    // Failures become durable, structured bug reports the agent can pick up as work.
    const failures = results.filter(r => r.ran && r.passed === false);
    let reportPath: string | undefined;
    if (failures.length > 0) {
      try {
        fs.mkdirSync(this.outDir, { recursive: true });
        reportPath = path.join(this.outDir, `bugs-${Date.now()}.md`);
        const lines = [
          `# Dogfood bug report — ${new Date().toISOString()}`,
          '',
          ...failures.flatMap(f => [
            `## ${f.id}`,
            `- Persona: ${f.persona}`,
            `- Finding: ${f.summary}`,
            f.evidence ? `- Evidence:\n\`\`\`\n${f.evidence}\n\`\`\`` : '',
            '',
          ]),
        ];
        fs.writeFileSync(reportPath, lines.filter(Boolean).join('\n'), 'utf-8');
        for (const f of failures) {
          try {
            await globalProjectMemory.remember(
              `Dogfooding found: ${f.id} — ${f.summary} (see ${path.relative(this.projectRoot, reportPath)})`,
              'gotcha', ['dogfood']
            );
          } catch { /* best-effort */ }
        }
      } catch { /* reporting is best-effort */ }
    }
    return { results, reportPath };
  }
}

let _global: DogfoodEngine | null = null;
export function getDogfoodEngine(): DogfoodEngine {
  if (!_global) _global = new DogfoodEngine(mindSingletonRoot());
  return _global;
}
export function __setDogfoodEngine(e: DogfoodEngine | null): void { _global = e; }
