import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import { IGovernor } from '../../core/interfaces';
import { buildTool } from '../tool.factory';
import { sandboxArgv, sandboxBin, floorRoot, floorArgv, floorChildEnv, floorBlockedReason, sovereignShellBlockedReason } from '../../sandbox/exec.sandbox';
import { outcomeOk, classifiedError } from '../outcome';
import { guiAutomationRefusal } from '../gui.automation.guard';
import { isReadOnlyShellCommand } from '../shell.readonly';
import { planShellChange } from '../thread.changes';
import { moveToBin } from '../thread.bin';
import { recordTrash } from '../thread.journal';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const MAX_OUTPUT_CHARS = 50_000;

/**
 * Names this build's desktop-control capability, if it has one.
 *
 * Resolved per call, never captured at construction: the Mac provider's tools are registered
 * asynchronously after eligibility is decided, so a value snapshotted when BashTool is built would
 * be undefined for the entire session and the guard would never engage.
 */
function desktopCapabilityToolName(resolveToolNames?: () => readonly string[]): string | undefined {
  try {
    const names = resolveToolNames?.() ?? [];
    return names.find(name => name === 'mcp__bimax-mac__mac_control'
      || name === 'mac_control' || name === 'ComputerTool');
  } catch {
    return undefined;
  }
}

export const createBashTool = (
  governor: IGovernor,
  /** Live view of the registered tools. Omitted (workers, tests) → the guard stays inert. */
  resolveToolNames?: () => readonly string[],
) => buildTool({
  name: 'BashTool',
  description: `Executes a bash command and returns stdout/stderr.

Runs in the agent's current working directory (changeable via ChangeDirectoryTool).
Prefer dedicated tools over BashTool: ReadFileTool for reading, WriteFileTool for writing.
Reserve BashTool for actual shell operations (installs, builds, git, processes, deleting files or folders with rm, moving files with mv).

# Directory Creation & Verification Rules:
- When asked to create a directory, ALWAYS use \`mkdir -p\`. 
- If \`mkdir\` fails with "File exists", it means a FILE (not a folder) with that name already exists. DO NOT tell the user "the folder already exists". Instead, use \`ls -la\` to inspect the conflicting file, and ask the user if they want to delete/rename it.
- Before creating a deeply nested directory (e.g., \`mkdir -p foo/bar/baz\`), use \`ls\` on the parent to verify you are in the correct location.

- Chain dependent commands with \`&&\`. Each call is a fresh subshell.
- NEVER run interactive commands — they produce no output and hang until the timeout kills them: no \`git rebase -i\`, no editors (vim/nano), no commands that prompt for input. Use non-interactive flags (\`-y\`, \`--no-edit\`, \`CI=1\`).
- LONG-RUNNING work (a build, a full test suite, a dev server, anything over ~30s): set \`background: true\`. The command becomes a tracked background task — you get a task id immediately, the user sees it in the task panel, and its output/result arrive via the task system (inspect with the TasksTool or /tasks). Do NOT run watch modes or servers in the foreground.
- Output is truncated after 50,000 characters — pipe noisy commands through \`tail\`/\`head\`/\`grep\` to keep the part you need.
- Use \`~\` for home directory — it will be resolved.
- Quote paths with spaces using double quotes.
- Git: never force-push or reset --hard unless explicitly asked; never commit unless asked.`,
  isDestructive: true,
  /**
   * Per-call, not per-tool. BashTool as a whole is a barrier, but a turn of `git status`, `rg TODO`,
   * `wc -l` is three read-only lookups with no reason to serialize. Only a strictly read-only
   * FOREGROUND command overlaps; `isReadOnlyShellCommand` fails closed on every ambiguity, and the
   * Governor, sandbox and task guard still run for the call either way.
   */
  isConcurrencySafe: (args: any) => args?.background !== true && isReadOnlyShellCommand(args?.command),
  schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The bash command to execute' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default: 30000)' },
      background: { type: 'boolean', description: 'Run as a tracked background task (long builds, test suites, servers). Returns a task id immediately.' }
    },
    required: ['command']
  },
  execute: async (args: { command: string, timeout?: number, background?: boolean }, context?: any) => {
    // Coerce the model-supplied timeout. LLMs frequently emit it as a string,
    // a float, or an out-of-range value, which makes Node's exec throw
    // ERR_OUT_OF_RANGE ("timeout ... must be an unsigned integer") and derails
    // the whole task. Clamp to a finite integer in [0, 600000]ms.
    // Shell is not a Computer Use channel. Refused BEFORE the sandbox, the governor, or any
    // execution, so a GUI-automation command never reaches the window server by this path.
    const guiRefusal = guiAutomationRefusal(args.command, desktopCapabilityToolName(resolveToolNames));
    if (guiRefusal.refused) {
      throw classifiedError(`Command blocked: ${guiRefusal.reason}`, 'permission', 'blocked');
    }
    // In a desktop thread a plain `rm`/`rmdir` sends the items to the Bin through the Bimax app instead of deleting
    // them, and records where each one went so the thread can undo it (thread.changes.ts, thread.journal.ts).
    if (process.env.BIMAX_THREAD_ROOT) {
      const change = planShellChange(args.command, context?.cwd || process.cwd());
      if (change?.kind === 'trash') {
        const { moved, error } = await moveToBin(change.trash, context?.signal);
        await recordTrash(change.title, 'BashTool', moved);
        if (error) throw classifiedError(`Moved ${moved.length} of ${change.trash.length} item(s) to the Bin, then stopped: ${error}`, 'external');
        return outcomeOk(`Moved to the Bin (the user can undo this from the thread in Bimax):\n${moved.map((m) => m.path).join('\n')}`, { exitCode: 0 });
      }
    }
    const rawTimeout = Number(args.timeout);
    const timeoutMs = Number.isFinite(rawTimeout)
      ? Math.min(Math.max(0, Math.floor(rawTimeout)), 600_000)
      : 30_000;
    try {
      const currentCwd = context?.cwd || process.cwd();
      const cmd = args.command.replace(/^~(?=\/|$)/, os.homedir());
      // Sandbox FLOOR (autonomous episodes): mandatory — no toggle lowers it. If the floor
      // can't be enforced on this platform, Bash is blocked rather than run with ambient
      // authority (BIMAX_SANDBOX_FLOOR_SOFT=1 is the explicit opt-out).
      const blocked = floorBlockedReason();
      if (blocked) throw classifiedError(`Command blocked: ${blocked}`, 'permission', 'blocked');
      // Sovereign mode: a subprocess is outside the in-process egress perimeter, so the kernel has
      // to deny it the network. Where the OS cannot, the shell is refused rather than run with
      // isolation we cannot demonstrate.
      const sovereignBlocked = sovereignShellBlockedReason();
      if (sovereignBlocked) throw classifiedError(`Command blocked: ${sovereignBlocked}`, 'permission', 'blocked');
      // Background promotion: long-running work becomes a tracked task workspace instead of a
      // blocking foreground exec (task registry + execution ledger; honest pause via SIGSTOP).
      // Not available under the sandbox floor — the floored argv path must stay foreground where
      // the sandbox profile wraps it.
      if (args.background && !floorRoot() && !sandboxArgv(cmd, currentCwd)) {
        const { startShellTask } = require('../../core/shell.tasks');
        const { task, summary } = startShellTask(cmd, { cwd: currentCwd, timeoutMs: timeoutMs > 30_000 ? timeoutMs : 0, learningOrigin: context?.learningTrace });
        return outcomeOk(JSON.stringify({ taskId: task.id, state: task.state, note: summary }, null, 2), { exitCode: 0 });
      }
      const flArgv = floorArgv(cmd);
      // When sandboxing is on (B3), run the command under the OS sandbox binary (sandbox-exec on
      // macOS, bwrap on Linux) via execFile so the profile + the command pass as discrete argv (no
      // shell re-quoting). Otherwise run it through the shell exactly as before.
      const sbArgv = flArgv ?? sandboxArgv(cmd, currentCwd);
      const sbBin = sbArgv ? sandboxBin() : null;
      // signal: when the user hits esc mid-turn, the agent loop aborts it and Node kills this child
      // process immediately instead of waiting out the command / its timeout.
      const execOpts = {
        cwd: currentCwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024,
        signal: context?.signal as AbortSignal | undefined,
        // Floored episodes (even soft-bypassed ones) never expose the parent env to children.
        ...((floorRoot() || process.env.BIMAX_THREAD_ROOT) ? { env: floorChildEnv() } : {}),
      };
      const { stdout, stderr } = sbArgv && sbBin
        ? await execFileAsync(sbBin, sbArgv, execOpts)
        : await execAsync(cmd, execOpts);
      const out = stdout.trim();
      const err = stderr.trim();
      // Workspace: a successful `git clone` makes the new repo an ask-once registration
      // candidate (multi-repo awareness, workspace.manager.ts). Best-effort, never blocks.
      if (/git\s+clone\s/.test(cmd)) {
        try { require('../../core/workspace.manager').tryGetWorkspace()?.noticeCommand(cmd, currentCwd); } catch { /* best-effort */ }
      }
      const payload = {
        stdout: out.length > MAX_OUTPUT_CHARS ? out.slice(0, MAX_OUTPUT_CHARS) + '\n...[truncated]' : out,
        stderr: err.length > MAX_OUTPUT_CHARS ? err.slice(0, MAX_OUTPUT_CHARS) + '\n...[truncated]' : err,
      };
      // Typed outcome: text matches the old JSON.stringify wire format exactly; exitCode 0 is
      // ground truth for the epistemic ledger's green evidence flag.
      return outcomeOk(JSON.stringify(payload, null, 2), { exitCode: 0 });
    } catch (e: any) {
      // Interrupted by esc (signal abort) — also sets e.killed, so check it BEFORE the timeout case.
      if (e?.name === 'AbortError' || e?.code === 'ABORT_ERR' || context?.signal?.aborted) {
        throw classifiedError(`Command interrupted: ${args.command}`, 'interrupted');
      }
      if (e.killed) {
        throw classifiedError(`Command timed out after ${timeoutMs}ms: ${args.command}`, 'timeout');
      }
      // A NON-ZERO exit is normal and useful for many commands — `tsc` with type errors, a failing
      // `npm test`, `grep` with no match. Node's exec rejects in that case but attaches the captured
      // output (e.stdout / e.stderr) and exit code. Return THAT instead of discarding it as a bare
      // "Command failed", so the model sees the actual errors and can act — no more redirecting to a
      // temp file just to read tsc/test output.
      const out = String(e.stdout || '').trim();
      const err = String(e.stderr || '').trim();
      if (out || err) {
        const tag = e.code != null ? `\n[command exited with code ${e.code}]` : '';
        const payload = {
          stdout: out.length > MAX_OUTPUT_CHARS ? out.slice(0, MAX_OUTPUT_CHARS) + '\n...[truncated]' : out,
          stderr: ((err + tag).length > MAX_OUTPUT_CHARS ? (err + tag).slice(0, MAX_OUTPUT_CHARS) + '\n...[truncated]' : (err + tag)),
        };
        // Still status 'ok' — a failing tsc/test run is a useful result, not a tool failure —
        // but the non-zero exitCode makes the ledger's red evidence flag exact.
        return outcomeOk(JSON.stringify(payload, null, 2), { exitCode: typeof e.code === 'number' ? e.code : 1 });
      }
      const wrapped: any = classifiedError(`Bash execution failed: ${e.message}`, 'external');
      wrapped.cause = e;
      throw wrapped;
    }
  }
}, governor);
