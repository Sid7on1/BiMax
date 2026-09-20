import { minimatch } from 'minimatch';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Which deterministic check grades a change to THIS file?
 *
 * WHY. `src/engine/model.router.ts` compared seven routing architectures and rejected option 5 —
 * "optimistic Quick with escalation" — because escalation was triggered by *the model flailing*,
 * which is late, expensive and quality-unsafe. The judgement was right. But it rules out only one
 * trigger, not the idea: a weak model is safe exactly where something deterministic can catch it,
 * and escalation triggered by a GATE is cheap and certain rather than late and probabilistic.
 *
 * This module answers the prerequisite question, which nothing in the engine could answer before:
 * **given the files a turn would touch, is there a check that would catch a mistake?**
 *
 * It is NOT the Test-Dependency Map. `src/substrate/tdm.ts` maps *test files* to the *source files*
 * they cover, with tiered confidence, and answers "did this test exercise that code?". This maps
 * *areas of the repo* to the *project-level command* that grades them — a contrast checker, a token
 * generator, a typecheck. The two are complementary and a full answer wants both: TDM for "which
 * tests touch this", gates for "which project check would refuse this".
 *
 * DELIBERATELY DECLARATIVE. Gates are read from the project, never inferred from a script's name.
 * A script called `check:everything` might check nothing, and guessing what a command covers is
 * precisely the "we inferred this is not the sensor said this" mistake recorded in
 * bimax-evidence-basis-vs-completeness. A gate exists when someone declared what it covers.
 */

export interface ChangeGate {
  /** Stable id, e.g. `glass-contrast`. */
  id: string;
  /** Shell command that grades the change. MUST exit non-zero on failure. */
  command: string;
  /** Globs, repo-relative and POSIX-separated, that this gate grades. */
  covers: string[];
  /** Globs carved OUT of `covers` — a subtree the gate does not actually grade. */
  excludes?: string[];
  /** Plain language: what a failure of this gate means. Shown to the user and to the model. */
  meaning: string;
  /** Working directory for `command`, repo-relative. Defaults to the repo root. */
  cwd?: string;
}

export interface GateCoverage {
  /** Files that at least one gate grades, with the gates that grade them. */
  covered: Array<{ file: string; gates: string[] }>;
  /** Files no gate grades. These are what makes a change unsafe for a weak model. */
  unguarded: string[];
  /** The distinct gates to run, in declaration order. */
  gates: ChangeGate[];
}

function norm(p: string): string {
  return (p || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Validate a declared gate. Returns the reason it is unusable, or null when it is fine.
 *
 * Strict on purpose: a malformed gate that is silently dropped would make a change look unguarded
 * (safe direction), but a malformed gate that is silently *kept* would make a change look guarded
 * when nothing grades it — which is the direction that ships a bad edit. So every field is checked
 * and the reason is reported rather than swallowed.
 */
export function gateProblem(g: unknown): string | null {
  if (!g || typeof g !== 'object') return 'not an object';
  const gate = g as Partial<ChangeGate>;
  if (!gate.id || typeof gate.id !== 'string') return 'missing `id`';
  if (!gate.command || typeof gate.command !== 'string') return `gate \`${gate.id}\` has no \`command\``;
  if (!Array.isArray(gate.covers) || gate.covers.length === 0) return `gate \`${gate.id}\` covers nothing`;
  if (gate.covers.some((c) => typeof c !== 'string' || !c.trim())) return `gate \`${gate.id}\` has an empty glob`;
  if (gate.excludes && !Array.isArray(gate.excludes)) return `gate \`${gate.id}\` has a non-array \`excludes\``;
  if (!gate.meaning || typeof gate.meaning !== 'string') return `gate \`${gate.id}\` does not say what failing MEANS`;
  return null;
}

/** Read and validate a gate list (typically `.bimax/gates.json`). Invalid entries are reported, not thrown. */
export function parseGates(raw: unknown): { gates: ChangeGate[]; problems: string[] } {
  const list = Array.isArray(raw) ? raw : (raw as { gates?: unknown })?.gates;
  if (!Array.isArray(list)) return { gates: [], problems: ['expected an array of gates, or { "gates": [...] }'] };
  const gates: ChangeGate[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const problem = gateProblem(entry);
    if (problem) { problems.push(problem); continue; }
    const gate = entry as ChangeGate;
    if (seen.has(gate.id)) { problems.push(`duplicate gate id \`${gate.id}\``); continue; }
    seen.add(gate.id);
    gates.push(gate);
  }
  return { gates, problems };
}

/**
 * Where a project declares its gates.
 *
 * Read from the PROJECT, not from `stateDir()`: this is configuration a person writes and commits,
 * the same category as `.bimax/hooks.json` and `mcp.json`, not engine-written state that a ⌘2
 * thread should redirect into app data (see src/utils/state.dir.ts).
 */
export const GATES_FILE = path.join('.bimax', 'gates.json');

export function loadGates(projectRoot: string): { gates: ChangeGate[]; problems: string[]; declared: boolean } {
  let text: string;
  try {
    text = fs.readFileSync(path.join(projectRoot, GATES_FILE), 'utf8');
  } catch {
    // Absent is the normal case for most projects, and it is not a problem — it just means every
    // change is unguarded, which `verdictFor` already handles by refusing the cheap model.
    return { gates: [], problems: [], declared: false };
  }
  try {
    const parsed = parseGates(JSON.parse(text));
    return { ...parsed, declared: true };
  } catch (e) {
    return { gates: [], problems: [`${GATES_FILE} is not valid JSON: ${(e as Error).message}`], declared: true };
  }
}

/** Does this gate grade this file? */
export function gateCovers(gate: ChangeGate, file: string): boolean {
  const f = norm(file);
  if (gate.excludes?.some((g) => minimatch(f, norm(g), { dot: true }))) return false;
  return gate.covers.some((g) => minimatch(f, norm(g), { dot: true }));
}

/**
 * Which gates grade this change, and what is left unguarded.
 *
 * A file matched by no gate is `unguarded`, and that is the load-bearing output: it is the reason a
 * change must NOT be handed to a weak model. The failure direction is deliberate — a file we cannot
 * classify counts as unguarded, never as covered.
 */
export function coverageFor(gates: ChangeGate[], files: string[]): GateCoverage {
  const covered: GateCoverage['covered'] = [];
  const unguarded: string[] = [];
  const used = new Map<string, ChangeGate>();

  for (const file of files.map(norm).filter(Boolean)) {
    const matching = gates.filter((g) => gateCovers(g, file));
    if (matching.length === 0) { unguarded.push(file); continue; }
    covered.push({ file, gates: matching.map((g) => g.id) });
    for (const g of matching) used.set(g.id, g);
  }

  return {
    covered,
    unguarded,
    // Declaration order, so a cheap gate declared first runs first.
    gates: gates.filter((g) => used.has(g.id)),
  };
}

export type RouteClass = 'gate-covered' | 'partially-covered' | 'unguarded' | 'no-files';

export interface GateVerdict {
  routeClass: RouteClass;
  /** Whether a weaker model is a defensible choice for this change. */
  cheapModelEligible: boolean;
  /** One sentence, for the log and for the user. Never a bare boolean. */
  reason: string;
  coverage: GateCoverage;
}

/**
 * The routing judgement. PURE — this decides nothing by itself and runs no command; the caller owns
 * the consequence.
 *
 * The rule is intentionally strict: **every** touched file must be graded by some gate, or the
 * cheap model is not eligible. Not "most", not "the important ones". The UI failures this codebase
 * has actually shipped were invisible in a diff — a `var()` resolving to the wrong theme inside a
 * subtree, an Euler step eating 39% of a spring's overshoot, a Radix ref null on first commit. A
 * partially-graded change is one where the ungraded half is exactly where that class of bug lives.
 */
export function verdictFor(gates: ChangeGate[], files: string[]): GateVerdict {
  const coverage = coverageFor(gates, files);
  const touched = coverage.covered.length + coverage.unguarded.length;

  if (touched === 0) {
    return {
      routeClass: 'no-files', cheapModelEligible: false, coverage,
      reason: 'No files named, so nothing can be graded in advance.',
    };
  }
  if (coverage.unguarded.length === 0) {
    const ids = coverage.gates.map((g) => g.id).join(', ');
    return {
      routeClass: 'gate-covered', cheapModelEligible: true, coverage,
      reason: `Every touched file is graded by a deterministic check (${ids}), so a mistake is caught rather than shipped.`,
    };
  }
  if (coverage.covered.length === 0) {
    return {
      routeClass: 'unguarded', cheapModelEligible: false, coverage,
      reason: `No check grades ${coverage.unguarded.length === 1 ? 'this file' : 'these files'}: ${coverage.unguarded.join(', ')}.`,
    };
  }
  return {
    routeClass: 'partially-covered', cheapModelEligible: false, coverage,
    reason: `${coverage.unguarded.length} of ${touched} touched files are graded by nothing (${coverage.unguarded.join(', ')}) — the ungraded half is where an invisible defect would land.`,
  };
}

/**
 * What to do once the gates have actually RUN.
 *
 * `failed` is the ids of gates that exited non-zero. Escalation is warranted only when a cheap
 * model produced the change AND a gate refused it — which is the trigger the router's rejected
 * option 5 lacked. A failure from the strong model is not an escalation, it is a bug to report.
 */
export function escalationDecision(
  servedBy: 'lite' | 'heavy',
  failed: string[],
): { escalate: boolean; reason: string } {
  if (failed.length === 0) {
    return { escalate: false, reason: 'Every gate passed.' };
  }
  if (servedBy === 'heavy') {
    return {
      escalate: false,
      reason: `${failed.join(', ')} failed on the work model. There is nothing stronger to escalate to — report the failure rather than retrying.`,
    };
  }
  return {
    escalate: true,
    reason: `${failed.join(', ')} refused the quick model's change. Re-running on the work model with the gate output as evidence.`,
  };
}
