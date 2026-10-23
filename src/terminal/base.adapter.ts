import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { Logger } from '../utils';
import { engineEvents } from '../engine/events';

/**
 * Base adapter that all CLI tool adapters must extend.
 * Upgraded to use real child_process spawning and deadlock guards.
 */
export abstract class BaseAdapter {
  protected id: string;
  protected toolName: string;
  public isBusy: boolean = false;
  
  protected child: ChildProcessWithoutNullStreams | null = null;
  protected readonly EXECUTION_TIMEOUT_MS = parseInt(process.env.TERMINAL_TIMEOUT_MS || '30000', 10);

  constructor(id: string, toolName: string) {
    this.id = id;
    this.toolName = toolName;
  }

  getId(): string {
    return this.id;
  }

  getToolName(): string {
    return this.toolName;
  }

  isSessionBusy(): boolean {
    return this.isBusy;
  }

  /**
   * Spawns a real, isolated background bash process.
   */
  async spawnSession(): Promise<void> {
    Logger.info(`[${this.toolName}-${this.id}] Booting isolated background shell process...`);
    
    // Spawn a generic bash shell
    this.child = spawn('bash', [], {
      env: process.env
    });
    
    // Wait for boot
    await new Promise(r => setTimeout(r, 200));
  }

  /**
   * Executes a command within the spawned session with deadlock protection.
   */
  async execute(command: string): Promise<string> {
    if (!this.child) throw new Error("Child process not spawned");
    this.isBusy = true;
    Logger.info(`[${this.toolName}-${this.id}] Executing: ${command}`);

    const delimiter = `__CMD_DONE_${Date.now()}__`;
    let outputBuffer = "";

    return new Promise((resolve) => {
      // Handle stderr to prevent buffer deadlocks and show errors live
      const onStdErr = (data: Buffer) => {
        const text = data.toString().trimEnd();
        if (text) {
          engineEvents.emit('log', `\x1b[31m[${this.toolName} ERROR]\x1b[0m ${text}`);
        }
      };

      // 1. Setup deadlock timeout guard
      const timeoutGuard = setTimeout(async () => {
        Logger.error(`[${this.toolName}-${this.id}] ❌ DEADLOCK DETECTED! Command hung for >${this.EXECUTION_TIMEOUT_MS}ms. Sending SIGKILL.`);
        if (this.child) {
          this.child.stderr.removeListener('data', onStdErr);
        }
        await this.killSession();
        await this.spawnSession(); // Resurrection
        this.isBusy = false;
        resolve(`[TIMEOUT_ERROR] Command aborted due to deadlock.`);
      }, this.EXECUTION_TIMEOUT_MS);

      // 2. Setup stdout listener
      const onData = (data: Buffer) => {
        const text = data.toString();
        outputBuffer += text;
        
        if (outputBuffer.includes(delimiter)) {
          clearTimeout(timeoutGuard);
          this.child!.stdout.removeListener('data', onData);
          this.child!.stderr.removeListener('data', onStdErr);
          
          const cleanOutput = outputBuffer.replace(delimiter, '').trim();
          this.isBusy = false;
          resolve(cleanOutput);
        } else {
          // Stream live output to UI
          engineEvents.emit('log', `\x1b[90m[${this.toolName}]\x1b[0m ${text.trimEnd()}`);
        }
      };

      this.child!.stdout.on('data', onData);
      this.child!.stderr.on('data', onStdErr);

      // 3. Inject command via stdin (Mitigated TERM-001 by base64 wrapping). Decode portably: GNU
      // base64 uses -d, BSD/macOS uses -D — try -d, fall back to -D, re-feeding fresh input to each
      // branch (base64 is single-quote-safe, so the literal can't break out of the quoting).
      const b64Cmd = Buffer.from(command).toString('base64');
      this.child!.stdin.write(`eval "$(printf %s '${b64Cmd}' | base64 -d 2>/dev/null || printf %s '${b64Cmd}' | base64 -D)"\n`);
      this.child!.stdin.write(`echo ${delimiter}\n`);
    });
  }

  /**
   * Brutally kills the active session.
   */
  async killSession(): Promise<void> {
    if (this.child) {
       Logger.warn(`[${this.toolName}-${this.id}] SIGKILL dispatched to child process.`);
       this.child.kill('SIGKILL');
       this.child = null;
    }
    this.isBusy = false;
  }
}
