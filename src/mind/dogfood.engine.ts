import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
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
    this.outDir = path.join(projectRoot, '.bimax', 'dogfood');
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

  /** Site probe: load the built site in Puppeteer's managed browser, collect console errors. */
  private async probeSite(): Promise<ProbeResult | null> {
    const persona = 'visitor loading the landing page';
    const distIndex = ['site/dist/index.html', 'dist/index.html', 'build/index.html']
      .find(p => this.has(p));
    if (!distIndex) return null;
    let server: http.Server | null = null;
    let browser: Awaited<ReturnType<(typeof import('puppeteer'))['launch']>> | null = null;
    try {
      const puppeteer = await import('puppeteer');
      const siteRoot = path.dirname(path.join(this.projectRoot, distIndex));
      server = http.createServer((req, res) => {
        try {
          const pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
          const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
          const file = path.resolve(siteRoot, requested);
          if (file !== siteRoot && !file.startsWith(siteRoot + path.sep)) {
            res.writeHead(403).end('Forbidden');
            return;
          }
          const ext = path.extname(file).toLowerCase();
          const mime: Record<string, string> = {
            '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
            '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
            '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
            '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2',
          };
          const body = fs.readFileSync(file);
          res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' }).end(body);
        } catch {
          res.writeHead(404).end('Not found');
        }
      });
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('static preview server did not bind');

      browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-gpu'],
      });
      {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on('console', (m: any) => { if (m.type() === 'error') errors.push(m.text()); });
        page.on('pageerror', (e: any) => errors.push(String(e?.message || e)));
        await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'networkidle0', timeout: 45_000 });
        await new Promise(r => setTimeout(r, 2500)); // let animations/3D mount
        fs.mkdirSync(this.outDir, { recursive: true });
        const shot = path.join(this.outDir, `site-${Date.now()}.png`);
        await page.screenshot({ path: shot as `${string}.png` });
        const bodyText = await page.evaluate(() => document.body?.innerText?.length || 0);
        const passed = errors.length === 0 && bodyText > 50;
        return {
          id: 'site-load', persona, ran: true, passed,
          summary: passed ? `page loads clean (screenshot: ${path.relative(this.projectRoot, shot)})`
            : errors.length ? `${errors.length} console error(s) on load` : 'page rendered no visible content',
          evidence: errors.slice(0, 5).join('\n') || undefined,
        };
      }
    } catch (e: any) {
      return { id: 'site-load', persona, ran: false, summary: `browser unavailable: ${e?.message}` };
    } finally {
      if (browser) await browser.close().catch(() => undefined);
      if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    }
  }

  /** Which probes apply here — used by /dogfood to explain itself before running. */
  applicableProbes(): string[] {
    const probes: string[] = [];
    if (this.has('build/bimax') || this.has('tui/bimax-tui')) probes.push('tui-smoke');
    if (this.has('build/bimax') || this.has('dist/index.js') || !!this.pkg()?.bin) probes.push('cli-help');
    if (['site/dist/index.html', 'dist/index.html', 'build/index.html'].some(p => this.has(p))) probes.push('site-load');
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
    const site = await this.probeSite();
    if (site) { log('info', 'Dogfood: loading the site as a visitor…'); results.push(site); }

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
