import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface LintResult {
  success: boolean;
  output: string;
  errors: string[];
}

async function run(cmd: string): Promise<LintResult> {
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: 60000 });
    return { success: true, output: stdout, errors: [] };
  } catch (e: any) {
    const output = (e.stdout || '') + '\n' + (e.stderr || '');
    const lines = output.split('\n').filter((l: string) => l.includes('error') || l.includes('Error') || l.includes('ERROR'));
    return { success: false, output, errors: lines.slice(0, 20) };
  }
}

export async function runTypeCheck(projectRoot: string): Promise<LintResult> {
  return run('npx tsc --noEmit 2>&1');
}

export async function runLint(projectRoot: string): Promise<LintResult> {
  return run('npx eslint "src/**/*.ts" 2>&1');
}

export function formatErrors(result: LintResult): string {
  if (result.success) return '✅ All checks passed';
  return result.errors.slice(0, 10).join('\n');
}
