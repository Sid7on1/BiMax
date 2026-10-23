import { ToolRegistry } from '../tools/tool.registry';
import { BuiltTool } from '../tools/tool.factory';
import { checkToolArgs } from '../tools/args.validate';
import { TypedOutcome } from '../tools/outcome';
import { maxParallelToolCalls } from './tool.schedule';
import { EvidenceSnapshot, evidenceIsCurrent, WorkflowEvidence } from './workflow.evidence';
import { createHash } from 'crypto';

export interface WorkflowBinding {
  step: string;
  /** JSON Pointer into a JSON result; omitted returns the complete text. */
  pointer?: string;
  /** Zero-based line of text, selected after the optional JSON Pointer. */
  line?: number;
}
export interface WorkflowStep {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  dependsOn?: string[];
  bindings?: Record<string, WorkflowBinding>;
}
export interface WorkflowResult {
  id: string;
  tool: string;
  status: 'ok' | 'error' | 'skipped' | 'cancelled';
  output: string;
  durationMs: number;
  truncated: boolean;
  freshness?: 'current' | 'stale' | 'incomplete';
  checkedAt?: string;
  inputCount?: number;
  evidenceDigest?: string;
  evidenceGaps?: string[];
  reused?: boolean;
}

export interface WorkflowStepState {
  tool: BuiltTool;
  args: string;
  raw?: string;
  output: string;
  evidence: EvidenceSnapshot;
}
export interface WorkflowRunOptions {
  previous?: Map<string, WorkflowStepState>;
  save?: (state: Map<string, WorkflowStepState>) => void;
}

const MAX_STEPS = 32;
const MAX_RESULT_BYTES = 64 * 1024;
const PREVIEW_CHARS = 2000;
const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
const own = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);

function select(binding: WorkflowBinding, text: string): unknown {
  let value: unknown = text;
  if (binding.pointer !== undefined) {
    value = JSON.parse(text);
    if (binding.pointer !== '') {
      if (!binding.pointer.startsWith('/') || /~(?![01])/u.test(binding.pointer)) {
        throw new Error('Invalid JSON Pointer');
      }
      for (const token of binding.pointer.slice(1).split('/')) {
        const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
        if (forbidden.has(key) || value === null || typeof value !== 'object' || !own(value, key)) {
          throw new Error(`Result pointer does not resolve: ${binding.pointer}`);
        }
        value = (value as Record<string, unknown>)[key];
      }
    }
  }
  if (binding.line !== undefined) {
    if (typeof value !== 'string') throw new Error('Line selection requires text');
    const lines = value.split(/\r?\n/);
    if (binding.line >= lines.length) throw new Error('Result line does not exist');
    value = lines[binding.line];
  }
  return value;
}

/** Declarative data flow, never eval. All graph/authority errors reject before any dispatch. */
export async function runToolWorkflow(
  steps: WorkflowStep[], registry: ToolRegistry, context: any = {}, options: WorkflowRunOptions = {},
): Promise<{ ok: boolean; steps: WorkflowResult[] }> {
  if (!Array.isArray(steps) || !steps.length || steps.length > MAX_STEPS) {
    throw new Error(`Workflow must contain 1–${MAX_STEPS} steps`);
  }
  const nodes = new Map<string, { step: WorkflowStep; tool: BuiltTool; deps: Set<string> }>();
  for (const step of steps) {
    if (!step || typeof step.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(step.id) || nodes.has(step.id)) {
      throw new Error('Step IDs must be unique, 1–64 letters, digits, underscores or hyphens');
    }
    // Exact identity only: model aliases must not select a different capability inside a graph.
    const tool = typeof step.tool === 'string' ? registry.getTool(step.tool) : undefined;
    if (!tool || tool.name !== step.tool || tool.workflowReadOnly !== true || tool.isDestructive) {
      throw new Error(`Tool is not eligible for read-only workflows: ${step.tool}`);
    }
    if (!step.args || typeof step.args !== 'object' || Array.isArray(step.args)) throw new Error('Step args must be an object');
    if (step.dependsOn !== undefined && (!Array.isArray(step.dependsOn) || step.dependsOn.some(d => typeof d !== 'string'))) {
      throw new Error('dependsOn must be an array of step IDs');
    }
    if (step.bindings !== undefined && (!step.bindings || typeof step.bindings !== 'object' || Array.isArray(step.bindings))) {
      throw new Error('bindings must be an object');
    }
    const deps = new Set(step.dependsOn ?? []);
    for (const [key, binding] of Object.entries(step.bindings ?? {})) {
      if (forbidden.has(key) || own(step.args, key)) throw new Error(`Conflicting or unsafe binding: ${key}`);
      if (!binding || typeof binding.step !== 'string'
        || (binding.pointer !== undefined && typeof binding.pointer !== 'string')
        || (binding.line !== undefined && (!Number.isInteger(binding.line) || binding.line < 0))) {
        throw new Error(`Invalid binding: ${key}`);
      }
      deps.add(binding.step);
    }
    if (!Object.keys(step.bindings ?? {}).length) {
      const check = checkToolArgs(tool.schema, step.args);
      if (check.violations.length) throw new Error(`${step.id}: ${check.violations.join('; ')}`);
    }
    nodes.set(step.id, { step, tool, deps });
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    const node = nodes.get(id);
    if (!node) throw new Error(`Unknown dependency: ${id}`);
    if (visiting.has(id)) throw new Error(`Dependency cycle at ${id}`);
    visiting.add(id);
    node.deps.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  };
  nodes.forEach((_, id) => visit(id));

  const results = new Map<string, WorkflowResult>();
  const outputs = new Map<string, string>();
  const running = new Map<string, Promise<void>>();
  const states = new Map<string, WorkflowStepState>();
  const limit = Math.min(8, maxParallelToolCalls());
  let exclusive = false;
  const record = (step: WorkflowStep, status: WorkflowResult['status'], output: string, started: number): void => {
    results.set(step.id, {
      id: step.id, tool: step.tool, status, output: output.slice(0, PREVIEW_CHARS),
      durationMs: Date.now() - started, truncated: output.length > PREVIEW_CHARS,
    });
  };
  const execute = async (step: WorkflowStep, tool: BuiltTool, args: unknown): Promise<void> => {
    const started = Date.now();
    let outcome: TypedOutcome | undefined;
    const collector = new WorkflowEvidence(context.signal);
    let evidence: EvidenceSnapshot | undefined;
    let rawResult: unknown;
    let reused = false;
    const argsKey = () => JSON.stringify(args);
    try {
      // Recheck ancestors immediately before binding use; a human edit can occur mid-workflow.
      const ancestors = new Set<string>();
      const collect = (id: string): void => { for (const dep of nodes.get(id)!.deps) if (!ancestors.has(dep)) { ancestors.add(dep); collect(dep); } };
      collect(step.id);
      for (const id of ancestors) {
        const state = states.get(id);
        if (state?.evidence.complete && !await evidenceIsCurrent(state.evidence, context.signal)) {
          results.get(id)!.freshness = 'stale';
          record(step, 'skipped', `Prerequisite ${id} changed after observation. Refresh the workflow.`, started);
          return;
        }
      }
      const raw = await tool.execute(args, {
        ...context,
        workflowEvidence: collector,
        workflowRawResult: (value: unknown) => { rawResult = value; },
        workflowReuse: async () => {
          const previous = options.previous?.get(step.id);
          if (!previous || previous.tool !== tool || previous.args !== argsKey() || previous.raw === undefined) return undefined;
          if ([...nodes.get(step.id)!.deps].some(id => results.get(id)?.reused !== true
            || outputs.get(id) !== options.previous?.get(id)?.output)) return undefined;
          if (!await evidenceIsCurrent(previous.evidence, context.signal)) return undefined;
          evidence = previous.evidence;
          reused = true;
          return previous.raw;
        },
        // Child outcomes must not overwrite the parent's aggregate outcome.
        reportOutcome: (o: TypedOutcome) => { outcome = o; },
      });
      const output = typeof raw === 'string' ? raw : JSON.stringify(raw);
      if (typeof output !== 'string') throw new Error('Tool returned no serializable output');
      if (context.signal?.aborted) {
        record(step, 'cancelled', 'Interrupted while running; result not used.', started);
      } else if (outcome && outcome.status !== 'ok') {
        record(step, 'error', output, started);
      } else if (Buffer.byteLength(output, 'utf8') > MAX_RESULT_BYTES) {
        record(step, 'error', 'Result exceeds 64 KiB. Narrow the source query or line range.', started);
      } else {
        evidence ??= collector.snapshot();
        if (reused && collector.gaps().length) evidence = { ...evidence, complete: false, reasons: collector.gaps() };
        if ([...nodes.get(step.id)!.deps].some(id => !states.get(id)?.evidence.complete)) {
          evidence = { ...evidence, complete: false, reasons: [...evidence.reasons, 'Prerequisite evidence is incomplete'] };
        }
        states.set(step.id, {
          tool, args: argsKey(),
          raw: typeof rawResult === 'string' && Buffer.byteLength(rawResult) <= MAX_RESULT_BYTES ? rawResult : undefined,
          output, evidence,
        });
        outputs.set(step.id, output);
        record(step, 'ok', output, started);
        Object.assign(results.get(step.id)!, {
          freshness: evidence.complete ? 'current' : 'incomplete',
          inputCount: evidence.inputs.length, evidenceGaps: evidence.reasons,
          evidenceDigest: createHash('sha256').update(JSON.stringify(evidence.inputs)).digest('hex'), reused,
        });
      }
    } catch (error) {
      record(step, context.signal?.aborted ? 'cancelled' : 'error', error instanceof Error ? error.message : String(error), started);
    }
  };

  while (results.size < nodes.size) {
    for (const { step, tool, deps } of nodes.values()) {
      if (results.has(step.id) || running.has(step.id)) continue;
      if (context.signal?.aborted) {
        record(step, 'cancelled', 'Interrupted before dispatch.', Date.now());
        continue;
      }
      if ([...deps].some(d => results.has(d) && results.get(d)!.status !== 'ok')) {
        record(step, 'skipped', 'A prerequisite did not succeed.', Date.now());
        continue;
      }
      if ([...deps].some(d => !results.has(d)) || exclusive || running.size >= limit) continue;
      try {
        const args = { ...step.args };
        for (const [key, binding] of Object.entries(step.bindings ?? {})) args[key] = select(binding, outputs.get(binding.step)!);
        const check = checkToolArgs(tool.schema, args);
        if (check.violations.length) throw new Error(check.violations.join('; '));
        let safe = false;
        try { safe = (tool.concurrencySafeFor?.(check.args) ?? tool.isConcurrencySafe) === true; } catch { /* exclusive */ }
        if (!safe && running.size) continue;
        exclusive = !safe;
        const work = execute(step, tool, check.args).finally(() => {
          running.delete(step.id);
          if (!safe) exclusive = false;
        });
        running.set(step.id, work);
      } catch (error) {
        record(step, 'error', error instanceof Error ? error.message : String(error), Date.now());
      }
    }
    // Drain started operations even on abort; never return while a nested operation is still live.
    if (running.size) await Promise.race(running.values());
  }
  await Promise.all(running.values());
  // A last check catches changes during sibling work or post-hooks. No claim of an atomic FS snapshot.
  for (const [id, state] of states) {
    if (context.signal?.aborted) break;
    try {
      if (state.evidence.complete && !await evidenceIsCurrent(state.evidence, context.signal)) results.get(id)!.freshness = 'stale';
    } catch (error) { if (context.signal?.aborted) break; throw error; }
  }
  for (let pass = 0; pass < steps.length; pass++) {
    for (const { step, deps } of nodes.values()) {
      if ([...deps].some(id => results.get(id)?.freshness === 'stale')) results.get(step.id)!.freshness = 'stale';
    }
  }
  for (const result of results.values()) {
    result.checkedAt = new Date().toISOString();
    if (context.signal?.aborted && result.status === 'ok') { result.status = 'cancelled'; result.freshness = 'stale'; }
    if (result.freshness === 'stale' || result.status !== 'ok') states.delete(result.id);
  }
  options.save?.(states);
  return { ok: [...results.values()].every(r => r.status === 'ok' && r.freshness !== 'stale'), steps: steps.map(s => results.get(s.id)!) };
}
