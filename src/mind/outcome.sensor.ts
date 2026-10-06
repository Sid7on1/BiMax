import * as path from 'path';
import { Span } from '../telemetry/trace';
import { getEpistemicLedger, isEvidenceCommand, isRepoWideEvidenceCommand, outputFilePaths, coverageExecutedPaths, commandPathTokens } from './epistemic.ledger';
import { getEventLedger } from './event.ledger';
import { mindSingletonRoot } from './self.model';

/** Canonical project-relative identity, not a basename or a suffix guess. */
export function claimPath(file: string | undefined, cwd: string, root = mindSingletonRoot()): string | undefined {
  if (!file) return undefined;
  const relative = path.relative(root, path.resolve(cwd, file)).split(path.sep).join('/');
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return undefined;
  return relative;
}

/** BashTool transports stdout/stderr as JSON. Decode before extracting diagnostic paths. */
export function commandOutput(result: string): string {
  try {
    const value = JSON.parse(result);
    if (value && (typeof value.stdout === 'string' || typeof value.stderr === 'string')) {
      return [value.stdout, value.stderr].filter(v => typeof v === 'string').join('\n');
    }
  } catch { /* ordinary textual output */ }
  return result;
}

export function observeClaim(span: Span, tool: string, domain: string, confidence: number, file: string | undefined, cwd: string): void {
  const canonical = claimPath(file, cwd);
  const ledger = getEpistemicLedger();
  const before = ledger.stats();
  const claimId = ledger.openClaim(domain, confidence, canonical ?? file);
  ledger.saveNow();
  span.setAttribute('bimax.claim.id', claimId);
  span.setAttribute('bimax.claim.confidence', confidence);
  if (canonical) span.setAttribute('bimax.claim.file', canonical);
  getEventLedger().append('claim', {
    ...span.context, claimId, tool, domain, file: canonical ?? file, confidence, before, after: ledger.stats(),
  });
}

/**
 * Reachable from AgentLoop's completed-tool observer, never from replay. Admission
 * needs a completed foreground command and a numeric exit code. Background launch,
 * timeout, refusal and status/command-name guesses cannot become verification.
 */
export function observeCommandOutcome(span: Span, args: {
  command: string; result: string; exitCode?: number; background: boolean; cwd: string;
}) {
  if (!isEvidenceCommand(args.command) || args.background || !Number.isInteger(args.exitCode) || args.exitCode! < 0) return null;
  const root = mindSingletonRoot();
  // A check launched elsewhere cannot verify this project's files. A subfolder
  // check can settle only canonical paths within its explicit scope.
  if (!claimPath(path.join(args.cwd, '.scope'), root, root)) return null;
  const output = commandOutput(args.result);
  const files = [...new Set(outputFilePaths(output).map(f => claimPath(f, args.cwd)).filter((f): f is string => !!f))];
  const ok = args.exitCode === 0;
  span.setAttributes({
    'bimax.evidence.exit_code': args.exitCode!,
    'bimax.evidence.ok': ok,
    'bimax.evidence.output_files': files,
    // A path mentioned by successful output is not necessarily checked. Only RED
    // diagnostics implement exact-file attribution today. Green scope stays absent.
    'bimax.evidence.files': ok ? [] : files,
  });
  const ledger = getEpistemicLedger();
  const before = ledger.stats();
  const wholeProject = path.resolve(args.cwd) === path.resolve(root) && isRepoWideEvidenceCommand(args.command);
  // For a scoped green runner, path arguments and success text express intent only.
  // Accept executed LCOV paths, or the exact inputs of a simple successful tsc check.
  const directCompiler = /^(?:npx )?tsc(?:\s+(?:--noEmit|[A-Za-z0-9_./-]+\.tsx?))+$/.test(args.command.trim());
  const checked = ok ? coverageExecutedPaths(output).concat(directCompiler ? commandPathTokens(args.command) : []) : outputFilePaths(output);
  const exactFiles = [...new Set(checked.map(f => claimPath(f, args.cwd, root)).filter((f): f is string => !!f))];
  const resolution = ledger.resolveDetailed(ok, { command: args.command, output,
    ...(!wholeProject ? { exactFiles } : {}) });
  ledger.saveNow();
  span.setAttribute('bimax.evidence.settled', resolution.settled);
  getEventLedger().append('evidence', {
    ...span.context, command: args.command, exitCode: args.exitCode, ok,
    outputFiles: files, ...resolution, before, after: ledger.stats(),
  });
  return { ...resolution, ok };
}
