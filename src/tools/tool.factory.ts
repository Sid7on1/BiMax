import { IGovernor } from '../core/interfaces';
import { Logger } from '../utils/logger';
import { engineEvents } from '../engine/events';
import { runPreHooks, runPostHooks } from './hooks';
import { isTypedOutcome, outcomeBlocked, outcomeError, TypedOutcome } from './outcome';
import { recordGuard } from './guard.timing';
import { activeTaskGuard } from '../evidence/task.guard';
import { reportCapability } from '../core/capability.status';
import { enforceThreadScope } from './thread.scope';
import { resolvePath } from './path.util';
import { noEffects } from '../evidence/schema';

export interface ToolDef<TArgs = any> {
  name: string;
  description: string;
  schema: any;
  isDestructive?: boolean;
  /** Explicit opt-in to bounded read-only workflows; concurrency safety alone is insufficient. */
  workflowReadOnly?: boolean;
  /**
   * Whether a call may overlap with its siblings in one turn. A boolean declares it for the whole
   * tool; a PREDICATE decides per call, from the arguments the model actually sent.
   *
   * The per-call form is deepseek-harness's `isConcurrencySafe(args)`
   * (`packages/core/tools/src/schema.ts`) and it exists because the static form is wrong for every
   * tool with a verb argument: `BashTool` is a barrier as a whole, yet `git status` and `rg foo` are
   * as safe as `ReadFileTool`, and declaring the tool exclusive makes a turn of five lookups run
   * five times slower than it needs to. Fail-closed: an omitted predicate, a thrown predicate, or a
   * non-`true` return all mean exclusive.
   */
  isConcurrencySafe?: boolean | ((args: any) => boolean);
  /** The implementation performs a richer, resolved-target Governor check before mutation. */
  approvalHandledInternally?: boolean;
  execute: (args: TArgs, context?: any) => Promise<any>;
}

export interface BuiltTool {
  name: string;
  description: string;
  schema: any;
  isDestructive: boolean;
  workflowReadOnly?: boolean;
  /** True only when EVERY call of this tool may overlap; a per-call tool reports false here. */
  isConcurrencySafe: boolean;
  /**
   * Whether THIS call may overlap with its siblings. Always prefer it over the static flag.
   * Optional because `BuiltTool` is a structural type outside callers (bridges, test doubles) also
   * construct; every tool from {@link buildTool} supplies it, and an absent one means "use the
   * static flag", which is the pre-existing behaviour.
   */
  concurrencySafeFor?: (args: any) => boolean;
  execute: (args: any, context?: any) => Promise<any>;
}

const TASK_TYPE_MAP: Record<string, string> = {
  BashTool: 'OS_COMMAND',
  WriteFileTool: 'FILE_WRITE',
  // Edits are writes: they must pass the same workspace/path vetting.
  EditFileTool: 'FILE_WRITE',
  // SymbolEditTool is a single-file write that previously called the governor NOWHERE (it relied on
  // its own workspaceWriteBlock + opt-in diff approval), so in interactive mode it wrote without the
  // permission prompt EditFileTool gets. Map it to FILE_WRITE so buildTool gives it the same
  // fs-veto + interactive gate; its internal checks become belt-and-braces. (WS5 step 3.)
  SymbolEditTool: 'FILE_WRITE',
  // Deletes were previously unmapped (generic TOOL_EXECUTION), which skipped
  // both the filesystem veto and the interactive permission prompt.
  DeleteTool: 'FILE_DELETE',
  CreateDirectoryTool: 'FILE_WRITE',
  DocumentTool: 'FILE_WRITE',
  // NOTE: MultiEditTool is intentionally ABSENT — it is multi-FILE, so buildTool's single
  // args.path can't gate it. It calls governor.approveTaskExecution('FILE_WRITE') per distinct
  // file itself (multiedit.tool.ts), before any write, keeping the batch atomic.
};

/**
 * Factory that enforces fail-closed defaults, Governor permission checks,
 * and automatic telemetry without boilerplate inside the tool logic.
 */
export function buildTool(def: ToolDef, governor: IGovernor): BuiltTool {
  const isDestructive = def.isDestructive ?? true;
  const declaredConcurrency = def.isConcurrencySafe ?? false;
  // The static flag stays the whole-tool answer (used where no arguments exist yet, e.g. schema
  // assembly); a predicate tool is only ever safe for a specific call, so it reports false here.
  const isConcurrencySafe = declaredConcurrency === true;
  const concurrencySafeFor = (args: any): boolean => {
    if (typeof declaredConcurrency !== 'function') return declaredConcurrency === true;
    // Fail closed: a classifier that throws on a malformed argument object must not upgrade the
    // call to parallel — an exclusive call is always a correct (just slower) answer.
    try { return declaredConcurrency(args ?? {}) === true; } catch { return false; }
  };
  const taskType = TASK_TYPE_MAP[def.name] || 'TOOL_EXECUTION';

  return {
    name: def.name,
    description: def.description,
    schema: def.schema,
    isDestructive,
    workflowReadOnly: def.workflowReadOnly === true && !isDestructive,
    isConcurrencySafe,
    concurrencySafeFor,
    execute: async (args: any, context?: any) => {
      const failure = (reason: string) => reportCapability({ id: `tool:${def.name}`, label: def.name,
        state: 'unavailable', reason, impact: 'This operation did not complete successfully.',
        action: 'Inspect the tool result before continuing.' });
      try {
        context?.signal?.throwIfAborted();
        await enforceThreadScope(args, context?.cwd || process.cwd());
        const payload = taskType === 'OS_COMMAND'
          ? { tool: def.name, command: args.command, context, isDestructive }
          : { tool: def.name, ...args, targetPath: typeof args.path === 'string' ? resolvePath(args.path, context?.cwd || process.cwd()) : args.path, isDestructive };

        // WS5 step 3: time each guard phase so a slow guard is visible before it's blamed (see /perf).
        if (!def.approvalHandledInternally) {
          const tApprove = Date.now();
          await governor.approveTaskExecution(taskType, payload);
          recordGuard('governor:approve', Date.now() - tApprove);
          context?.signal?.throwIfAborted();
        }

        // Task Guard (owner section 28, tier S28-0): bind this call to the approved task boundary and
        // record it as causal evidence. The guard is installed per session and absent by default, so
        // an engine with no guard behaves exactly as it did before.
        //
        // It refuses only at `block` — the deterministic Layer A/B floors. `require-approval` is left
        // to the Governor above, which already owns the user prompt; adding a second one here would
        // ask the same question twice. Refusal stops the Bimax-owned operation and nothing else, which
        // is the S28-A exit condition.
        const guard = activeTaskGuard();
        const tGuard = Date.now();
        const verdict = guard?.review(def.name, args ?? {}, context?.cwd || process.cwd());
        if (verdict) recordGuard('taskguard:review', Date.now() - tGuard);
        if (verdict && verdict.decision.disposition === 'block') {
          Logger.warn(`[Tool:${def.name}] ⛔ ${verdict.summary}`);
          const text = `${def.name} was blocked before running — ${verdict.summary}`;
          context?.reportOutcome?.(outcomeBlocked(text));
          failure('The operation was blocked before execution.');
          return text;
        }

        // PreToolUse hooks (A2): may block the call, surfaced to the model like a veto.
        const tPre = Date.now();
        const pre = await runPreHooks(def.name, args, context);
        recordGuard('hooks:pre', Date.now() - tPre);
        if (pre && pre.block) {
          const reason = pre.reason || 'declined by a PreToolUse hook';
          Logger.warn(`[Tool:${def.name}] ⛔ blocked by hook: ${reason}`);
          const text = `${def.name} was blocked before running: ${reason}`;
          context?.reportOutcome?.(outcomeBlocked(text));
          failure('The operation was blocked before execution.');
          return text;
        }

        const restoreScope = verdict && guard ? guard.enter(verdict.operation.id) : null;
        try {
          // Show which tool is running, but do NOT emit 'idle' when it finishes — the TURN is still
          // active (more tools / more text may follow, and tools run in parallel). Only runTurn's
          // finally emits 'idle'. Emitting idle per-tool flipped the front-end's busy flag off between
          // tools, which killed the "working" indicator AND the esc-to-interrupt gate mid-turn.
          engineEvents.emit('spinner_state', 'executing', `${def.name}...`);
          // Reuse is offered only by the workflow runtime, after all current guards/pre-hooks ran.
          // Cache raw implementation output so post-hooks still execute exactly once on every call.
          const reused = def.workflowReadOnly === true ? await context?.workflowReuse?.() : undefined;
          const implementationResult = reused === undefined ? await def.execute(args, context) : reused;
          // Legacy tools still return explicit Error: prose. Preserve it but do not paint success.
          const raw = typeof implementationResult === 'string' && /^Error:/i.test(implementationResult.trim())
            ? { ...outcomeError('unknown', implementationResult), confidence: 'low' as const } : implementationResult;
          if (def.workflowReadOnly === true) context?.workflowRawResult?.(raw);
          // Typed outcome (v2 Phase 0): a tool that declares what happened reports it on the
          // context side-channel; every caller keeps receiving the plain text it always did.
          let result: any = raw;
          if (isTypedOutcome(raw)) {
            context?.reportOutcome?.(raw as TypedOutcome);
            result = raw.text;
            if (raw.status !== 'ok') failure(`Operation ${raw.status}${raw.errorClass ? ` (${raw.errorClass})` : ''}.`);
            else reportCapability({ id: `tool:${def.name}`, label: def.name, state: 'ready',
              reason: 'A subsequent operation completed successfully.', impact: '', action: '' });
          }
          // PostToolUse hooks (A2): react to the result and optionally append to it (e.g. the
          // B2 verify loop feeds typecheck errors back so the model self-corrects). Non-fatal.
          const tPost = Date.now();
          const appended = await runPostHooks(def.name, args, result, context);
          if (appended) context?.workflowEvidence?.incomplete('Post-hook output has no input evidence');
          recordGuard('hooks:post', Date.now() - tPost);
          // The receipt half of tier S28-0. What a Terminal tool can honestly report is what it
          // declared plus the fact that it completed; the observed-effects sensor that would tighten
          // this is S28-D, and it is entitlement-gated. Recording the declared effects as observed
          // would be a lie, so the receipt carries them unchanged and the observation keeps whatever
          // completeness gap the proposal stage attached.
          if (verdict && guard) {
            guard.observe(verdict.operation.id, def.name, isTypedOutcome(raw) && raw.status !== 'ok' ? 'failed' : 'applied',
              isTypedOutcome(raw) && raw.status !== 'ok' ? noEffects() : verdict.operation.declared, 'the tool returned an outcome');
          }
          if (appended && typeof result === 'string') return `${result}\n\n${appended}`;
          return result;
        } catch (error: any) {
          if (verdict && guard) {
            guard.observe(verdict.operation.id, def.name, 'failed', noEffects(), error?.message || 'the tool threw');
          }
          Logger.error(`[Tool:${def.name}] ❌ ${error.message}`);
          throw error;
        } finally {
          restoreScope?.();
        }
      } catch (error: any) {
        failure(error?.name === 'GovernorVetoError' ? 'Workspace or permission policy rejected the operation.' : 'The operation threw an error.');
        throw error;
      }
    }
  };
}
