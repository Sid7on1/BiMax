import { BudgetVeto } from './budget.veto';
import { FileSystemVeto } from './fs.veto';
import { Logger } from '../utils';
import { GovernorVetoError } from '../core/errors';
import { IGovernor, IEventBus } from '../core/interfaces';
import { GlobalPrompter } from '../engine/prompter';
import { YoloClassifier } from '../security/yolo.classifier';
import { engineEvents } from '../engine/events';
import { BashStaticAnalyzer } from './bash.analyzer';
import * as fsp from 'fs/promises';
import { isApprovalReadOnlyShellCommand } from '../tools/shell.readonly';
import { enforceThreadScope } from '../tools/thread.scope';
import { approvalCard, deletesOutsideBin, planFileChange } from '../tools/thread.changes';
import { recordBeforeChange } from '../tools/thread.journal';
import { grantFor, taskGrants } from './task.grants';
import { protectedPaths, protectedRefusal, protectedTouchedBy } from '../tools/thread.rules';
import { taintRestriction } from '../mind/taint';

/** Why a thread refuses a delete it cannot send to the Bin, and how to delete so the user can undo it. */
/** The approval-card choice that allows a described change for the rest of the task (N13). */
export const TASK_GRANT_OPTION = 'Allow for this task';
const THREAD_DELETE_GUIDANCE = 'In a Bimax thread, deletes go to the Bin so the user can undo them. Delete with a plain `rm <path>…` (optionally after `cd <folder> &&`; same-folder wildcards are fine) or DeleteTool — not find -delete, a pipeline or a chain of commands. Nothing was deleted.';

/**
 * `unattended` (backlog FL5, night shift): nobody is there to answer, so what would be asked is decided instead.
 * Work inside the workspace goes ahead without a prompt, but every floor still holds — workspace containment, the
 * sensitive-target refusals, the spend cap (unlike `bypass`, which lifts it) and the taint block, which turns into a
 * refusal because nobody can knowingly allow it. Computer control is refused outright.
 */
export type SessionPermissionMode = 'interactive' | 'plan' | 'auto' | 'strict' | 'bypass' | 'unattended';

export interface ToolPermissionRule {
  tool: string;
  pattern?: string;
  effect: 'allow' | 'deny';
  persistent: boolean;
}

export class Governor implements IGovernor {
  public budget: BudgetVeto;
  public fs: FileSystemVeto;
  private _mode: SessionPermissionMode = 'interactive';
  private bashAnalyzer = new BashStaticAnalyzer();
  private readonly analyzerWarmup: Promise<void>;

  // mode is assigned directly in many places (index.ts, /governor, /plan, …). Route those writes
  // through a setter so disabling the governor (bypass) ALSO lifts the budget veto, which the LLM
  // adapter holds directly — otherwise "/governor off" left the daily cap blocking every response.
  public get mode(): SessionPermissionMode { return this._mode; }
  public set mode(m: SessionPermissionMode) {
    this._mode = m;
    if (this.budget) this.budget.enabled = m !== 'bypass';
  }
  public rules: ToolPermissionRule[] = [];
  constructor(private eventBus: IEventBus, private yolo?: YoloClassifier) {
    this.budget = new BudgetVeto();
    this.fs = new FileSystemVeto();
    // Pre-load the grammar in the long-lived application. Unit tests construct many short-lived
    // governors; their fire-and-forget WASM loads can outlive Jest environments, so those tests use
    // the deterministic regex path unless they explicitly await BashStaticAnalyzer.warmUp().
    this.analyzerWarmup = process.env.NODE_ENV === 'test'
      ? Promise.resolve()
      : this.bashAnalyzer.warmUp();
    Logger.info('[Governor] Initialized Multi-Layer Permission Engine.');
  }

  /** Lets lifecycle-aware hosts await the optional AST safety-parser warm-up. */
  public async ready(): Promise<void> { await this.analyzerWarmup; }

  public addRule(rule: ToolPermissionRule) {
    this.rules.push(rule);
  }

  public async approveTaskExecution(taskType: string, payload: any): Promise<void> {
    // Retired capability: refuse even stale plugins, bypass mode, and saved allow rules before any shortcut.
    if (taskType === 'COMPUTER_CONTROL') {
      throw new GovernorVetoError('Computer Use has been removed from Bimax.');
    }

    // Taint capability narrowing (v2 D3) — computed BEFORE the rule shortcut so a persistent
    // "Always Allow" created in a clean session can never waive it: once untrusted content
    // (file/web/MCP output) is in the conversation, network-capable commands are hard-blocked in
    // auto mode and always face the human elsewhere.
    const taintCut: { action: 'block' | 'ask'; reason: string } | null =
      taskType === 'OS_COMMAND' ? taintRestriction(payload.command || '', this.mode) : null;
    if (taintCut?.action === 'block') {
      throw new GovernorVetoError(`Blocked: ${taintCut.reason}`);
    }

    // Folder-bound Bimax threads (BIMAX_THREAD_ROOT) cannot inherit bypass or persistent blanket grants.
    // Creating a new file inside the thread's folder and proven read-only commands are routine; a
    // replacement, a delete, a shell mutation or any other destructive action needs one fresh answer for
    // that exact action, which the app shows in the thread's approval popup.
    if (process.env.BIMAX_THREAD_ROOT && taskType !== 'API_CALL') {
      await enforceThreadScope(payload, payload.context?.cwd || process.cwd());
      // The workspace floor (forbidden paths, sensitive names and extensions) still applies inside the
      // thread's own folder — thread engines run with WORKSPACE_ROOT set to that folder.
      if ((taskType === 'FILE_WRITE' || taskType === 'FILE_DELETE') && typeof payload.targetPath === 'string') {
        await this.fs.checkVeto(payload.targetPath);
      }
      if (this.mode === 'plan' && payload.isDestructive !== false) throw new GovernorVetoError('Plan mode: approve the plan before changing files.');
      const threadCwd = payload.context?.cwd || process.cwd();
      // A delete the thread cannot send to the Bin would be permanent and impossible to undo: refuse it before
      // asking, and say how to delete so it can be undone.
      if (taskType === 'OS_COMMAND' && deletesOutsideBin(String(payload.command || ''), threadCwd)) {
        throw new GovernorVetoError(THREAD_DELETE_GUIDANCE);
      }
      let routine = payload.isDestructive === false;
      if (taskType === 'OS_COMMAND') routine = isApprovalReadOnlyShellCommand(payload.command) && !taintCut;
      if (taskType === 'FILE_WRITE' && typeof payload.targetPath === 'string') {
        try { await fsp.lstat(payload.targetPath); routine = false; }
        catch (error: any) { if (error.code === 'ENOENT') routine = true; else throw error; }
      }
      // Say what will happen in words, list every affected item, and say whether it can be undone. The raw
      // command is still on the card, but it is no longer the whole question.
      const change = planFileChange(taskType, payload, threadCwd);
      // The user's folder rules protect some items outright: refused before any card, so no approval can override them.
      const guarded = protectedTouchedBy(change, taskType === 'OS_COMMAND' ? String(payload.command || '') : '', protectedPaths(), process.env.BIMAX_THREAD_ROOT);
      if (guarded) throw new GovernorVetoError(protectedRefusal(guarded));
      if (!routine) {
        // N13: every floor above has already run. A change the user allowed for this task — the same file, the same
        // command, or an undoable change inside the folder — is not asked about again; anything else is.
        const grant = grantFor(taskType, change, payload, process.env.BIMAX_THREAD_ROOT, threadCwd);
        const granted = grant && !taintCut ? taskGrants.use(grant.key) : null;
        if (granted) {
          engineEvents.emit('status', `Allowed for this task: ${granted.label}`);
        } else {
          const card = approvalCard(change, taskType, payload);
          const options = grant && !taintCut ? ['Allow', TASK_GRANT_OPTION, 'Deny'] : ['Allow', 'Deny'];
          const body = grant && !taintCut ? `${card.body}\n\n“${TASK_GRANT_OPTION}” also allows ${grant.label} until this task ends, without asking again.` : card.body;
          const answer = await GlobalPrompter.ask(taintCut ? `TAINTED CONTEXT — ${taintCut.reason}\n${card.question}` : card.question, options, { body });
          if (answer === TASK_GRANT_OPTION && grant && !taintCut) {
            taskGrants.add(grant);
            engineEvents.emit('message', { id: `grant-${Date.now()}`, role: 'system', level: 'info', content: `For the rest of this task Bimax will not ask again about ${grant.label}. Run /grants clear to be asked again.`, timestamp: new Date() });
          } else if (answer !== 'Allow') {
            throw new GovernorVetoError('Action declined. No permission was granted.');
          }
        }
      }
      // Recorded once the change is allowed (or routine) and before it runs, so "↶ Undo" can reverse it.
      if (change) {
        await recordBeforeChange(change, String(payload.tool || taskType)).catch((error: any) => {
          Logger.warn(`[Governor] Could not record undo for "${change.title}": ${error?.message ?? error}`);
        });
      }
      return;
    }

    // Workspace containment is a hard floor, including persistent allow rules and bypass mode.
    if (taskType === 'FILE_WRITE' || taskType === 'FILE_DELETE') {
      await this.fs.checkVeto(payload.targetPath);
    }

    if (this.mode === 'bypass' && !taintCut) {
      Logger.info(`[Governor] ⚠️ Bypassed completely for task: ${taskType}`);
      engineEvents.emit('status', `Approved (Bypassed): ${taskType}`);
      return;
    }

    // Layer 0: Plan Mode — research only. Block every mutating action so the agent
    // can read, search, and reason but cannot touch the workspace until the plan
    // is approved and the session is switched out of 'plan' mode.
    if (this.mode === 'plan') {
      const blocked =
        taskType === 'FILE_WRITE' ||
        taskType === 'FILE_DELETE' ||
        (taskType === 'OS_COMMAND' && !isApprovalReadOnlyShellCommand(payload.command || '')) ||
        (payload.isDestructive !== false && taskType === 'TOOL_EXECUTION');

      if (blocked) {
        const label = taskType === 'OS_COMMAND'
          ? `run "${String(payload.command || '').slice(0, 60)}"`
          : taskType === 'FILE_WRITE' ? `write ${payload.targetPath || payload.path || 'a file'}`
          : `delete ${payload.targetPath || payload.path || 'a file'}`;
        throw new GovernorVetoError(
          `Plan mode is active — cannot ${label}. Present your plan to the user; they can approve and exit plan mode (/plan off) to let you execute.`
        );
      }
      // Read-only work is allowed through; fall past the destructive prompt below.
      engineEvents.emit('status', `Approved (Plan/read-only): ${taskType}`);
      return;
    }

    // Unattended (a night shift): a tainted network command was already refused above — taintRestriction blocks
    // rather than asks when nobody is watching — so what reaches here is decided without a prompt.
    if (this.mode === 'unattended') {
      engineEvents.emit('status', `Approved (unattended): ${taskType}`);
      return;
    }

    // Layer 1: Persistent Rules Check
    const matchingRule = this.rules.find(r => r.tool === taskType && (
      taskType !== 'OS_COMMAND' || r.effect === 'deny' || (r.pattern !== undefined && r.pattern === payload.command)
    ));
    if (matchingRule) {
      if (matchingRule.effect === 'deny') {
        throw new GovernorVetoError(`Rule explicitly denied task: ${taskType}`);
      }
      if (matchingRule.effect === 'allow' && !taintCut) {
        engineEvents.emit('status', `Approved (Rule): ${taskType}`);
        return;
      }
    }

    try {
      
      if (taskType === 'API_CALL') {
        await this.budget.checkVeto(payload.estimatedCost);
      }

      // Layer 2: Static Analysis for Bash Commands
      if (taskType === 'OS_COMMAND') {
        const analysis = this.bashAnalyzer.analyze(payload.command);

        // Taint-narrowed commands (computed above) keep none of the fast paths below —
        // they fall through to the human prompt with the taint source named. Read-only
        // auto-approve is unaffected for untainted-restricted commands (ls can't exfil).
        if (analysis.category === 'read' && analysis.risk === 'none' && isApprovalReadOnlyShellCommand(payload.command) && this.mode !== 'strict' && !taintCut) {
          // Auto-approve read-only safe commands
          Logger.info(`[Governor] Auto-approved safe read command: ${payload.command}`);
          engineEvents.emit('status', `Approved (Static Analysis): ${taskType}`);
          return;
        }

        // Fallback: Layer 3 ML Classifier (only if auto mode or interactive).
        // Never lets a tainted network command through — that's the human's call.
        if (this.yolo && this.mode === 'auto' && !taintCut) {
          const isSafe = await this.yolo.evaluateAction(payload.command, payload.context);
          if (isSafe) {
             engineEvents.emit('status', `Approved (ML Classifier): ${taskType}`);
             return;
          }
        }
      }
    } catch (e: any) {
      if (e instanceof GovernorVetoError) {
        Logger.error(`[Governor] 🚨 SEVERE VIOLATION DETECTED. BROADCASTING EMERGENCY HALT. 🚨`);
        this.eventBus.emit('EMERGENCY_HALT', { reason: e.message });
      }
      throw e;
    }

    // Layer 4: Interactive Fallback
    // Honor the fail-closed destructive declaration of generic tools as well as file/shell tasks.
    const isDestructiveTask = payload.isDestructive !== false && (
      taskType === 'FILE_WRITE' || taskType === 'OS_COMMAND' || taskType === 'FILE_DELETE'
      || taskType === 'TOOL_EXECUTION'
    );
    const shouldAsk = isDestructiveTask || this.mode === 'strict' || !!taintCut;

    if (shouldAsk) {
      const label = taskType === 'FILE_WRITE' ? `Write ${payload.targetPath || payload.path || 'file'}`
        : taskType === 'OS_COMMAND' ? `Run: ${(payload.command || '').slice(0, 60)}`
        : taskType === 'TOOL_EXECUTION' && payload.tool ? `Run ${payload.tool}`
        : `${taskType}`;

      // A taint-narrowed command asks with the taint source in view — the human decides knowingly.
      const question = taintCut ? `⚠ TAINTED CONTEXT — ${taintCut.reason}\nAllow anyway? ${label}` : `Allow? ${label}`;
      const always = taskType === 'OS_COMMAND' ? 'Always Allow This Command' : 'Always Allow This Tool';
      const options = taintCut ? ['Yes', 'No'] : ['Yes', 'No', always];
      const answer = await GlobalPrompter.ask(question, options);

      if (answer !== 'Yes' && (taintCut || answer !== always)) {
        throw new GovernorVetoError("User explicitly denied this action.");
      }

      if (answer === always && !taintCut) {
        this.addRule({ tool: taskType, effect: 'allow', persistent: true, ...(taskType === 'OS_COMMAND' ? { pattern: String(payload.command) } : {}) });
        Logger.info(`[Governor] Added persistent allow rule for ${taskType}`);
      }


    }

    Logger.info(`[Governor] ✅ Veto cleared. Task approved.`);
    engineEvents.emit('status', `Approved: ${taskType}`);
  }
}
