import { BudgetVeto } from './budget.veto';
import { FileSystemVeto } from './fs.veto';
import { Logger } from '../utils';
import { GovernorVetoError } from '../core/errors';
import { IGovernor, IEventBus } from '../core/interfaces';
import { GlobalPrompter } from '../cli/prompter';
import { YoloClassifier } from '../security/yolo.classifier';
import { cliEvents } from '../cli/events';
import { BashStaticAnalyzer } from './bash.analyzer';
import * as fsp from 'fs/promises';
import { isReadOnlyShellCommand } from '../tools/shell.readonly';
import { enforceThreadScope } from '../tools/thread.scope';
import { approvalCard, deletesOutsideBin, planFileChange } from '../tools/thread.changes';
import { recordBeforeChange } from '../tools/thread.journal';
import { taintRestriction } from '../mind/taint';

/** Why a thread refuses a delete it cannot send to the Bin, and how to delete so the user can undo it. */
const THREAD_DELETE_GUIDANCE = 'In a Bimax thread, deletes go to the Bin so the user can undo them. Delete with a plain `rm <path>…` (optionally after `cd <folder> &&`; same-folder wildcards are fine) or DeleteTool — not find -delete, a pipeline or a chain of commands. Nothing was deleted.';

/**
 * REPAIR NOTE (2026-08-18): the 2026-08-15 corruption-recovery commit (f7caa05) silently
 * dropped this file's entire Computer Use safety machinery — the sensitive-target hard floor,
 * COMPUTER_CONTROL handling in plan-block/Layer-4, the high-impact exemption from blanket allow
 * rules, and the session-grant API. COMPUTER_CONTROL approvals then passed UNPROMPTED in every
 * mode except strict. Restored verbatim from 398f5b8 (pre-regression); the safety suite
 * (computer.use.safety.test.ts) pins each piece. The Desktop's consent channel is literally
 * named 'engine-governor' — this floor is what stands between the model and mac_control.
 */

export type SessionPermissionMode = 'interactive' | 'plan' | 'auto' | 'strict' | 'bypass';

export interface ToolPermissionRule {
  tool: string;
  pattern?: string;
  effect: 'allow' | 'deny';
  persistent: boolean;
}

/**
 * Targets computer control must never touch, regardless of grants, rules, or mode: credential
 * stores, OS security surfaces, and asset wallets. Matched against the app/window name a desktop
 * action names (and the browser host when one obviously identifies a credential manager). The
 * list is deliberately short and high-confidence — everything else still faces the normal
 * approval ladder.
 */
const SENSITIVE_COMPUTER_TARGETS: RegExp[] = [
  /keychain/i,
  /1password|lastpass|bitwarden|dashlane|keepass|keeper/i,
  /system settings|system preferences/i,
  /passwords?\.app/i,
  /\bwallet\b|metamask|ledger live|trezor/i,
];

export function isSensitiveComputerTarget(target: string): boolean {
  const t = (target || '').trim();
  if (!t) return false;
  return SENSITIVE_COMPUTER_TARGETS.some(pattern => pattern.test(t));
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
  // Session-scoped computer-control grants ("this browser domain" / "this desktop app"), never
  // persisted — a fresh session always starts with zero standing computer-control permissions.
  private sessionGrants = new Set<string>();

  /** Scope key a COMPUTER_CONTROL payload can be granted under: browser domain or desktop app. */
  public static computerGrantKey(payload: any): string | null {
    const host = String(payload?.host || '').trim().toLowerCase();
    if (host) return `domain:${host}`;
    const app = String(payload?.app || '').trim().toLowerCase();
    if (app) return `app:${app}`;
    return null;
  }

  public computerGrants(): string[] { return Array.from(this.sessionGrants).sort(); }

  public revokeComputerGrants(): number {
    const n = this.sessionGrants.size;
    this.sessionGrants.clear();
    return n;
  }

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
      if (taskType === 'OS_COMMAND') routine = isReadOnlyShellCommand(payload.command);
      if (taskType === 'FILE_WRITE' && typeof payload.targetPath === 'string') {
        try { await fsp.lstat(payload.targetPath); routine = false; }
        catch (error: any) { if (error.code === 'ENOENT') routine = true; else throw error; }
      }
      // Say what will happen in words, list every affected item, and say whether it can be undone. The raw
      // command is still on the card, but it is no longer the whole question.
      const change = planFileChange(taskType, payload, threadCwd);
      if (!routine) {
        const card = approvalCard(change, taskType, payload);
        const answer = await GlobalPrompter.ask(card.question, ['Allow', 'Deny'], { body: card.body });
        if (answer !== 'Allow') throw new GovernorVetoError('Action declined. No permission was granted.');
      }
      // Recorded once the change is allowed (or routine) and before it runs, so "↶ Undo" can reverse it.
      if (change) {
        await recordBeforeChange(change, String(payload.tool || taskType)).catch((error: any) => {
          Logger.warn(`[Governor] Could not record undo for "${change.title}": ${error?.message ?? error}`);
        });
      }
      return;
    }

    // Hard floor for computer control: credential stores, OS security surfaces, and wallets are
    // denied outright — before bypass, before rules, before grants. A prompt-injected page or a
    // blanket "always allow" must never be able to steer clicks into a password manager.
    if (taskType === 'COMPUTER_CONTROL') {
      const target = `${payload?.app || ''} ${payload?.host || ''}`.trim();
      if (isSensitiveComputerTarget(target)) {
        throw new GovernorVetoError(
          `Computer control is not allowed on sensitive targets (credential managers, system security settings, wallets): ${target}. Do it manually if it is genuinely needed.`
        );
      }
    }

    // Workspace containment is a hard floor, including persistent allow rules and bypass mode.
    if (taskType === 'FILE_WRITE' || taskType === 'FILE_DELETE') {
      await this.fs.checkVeto(payload.targetPath);
    }

    if (this.mode === 'bypass') {
      Logger.info(`[Governor] ⚠️ Bypassed completely for task: ${taskType}`);
      cliEvents.emit('status', `Approved (Bypassed): ${taskType}`);
      return;
    }

    // Layer 0: Plan Mode — research only. Block every mutating action so the agent
    // can read, search, and reason but cannot touch the workspace until the plan
    // is approved and the session is switched out of 'plan' mode.
    if (this.mode === 'plan') {
      const blocked =
        taskType === 'FILE_WRITE' ||
        taskType === 'FILE_DELETE' ||
        (taskType === 'OS_COMMAND' && this.bashAnalyzer.analyze(payload.command || '').category !== 'read') ||
        (payload.isDestructive !== false && (taskType === 'TOOL_EXECUTION' || taskType === 'COMPUTER_CONTROL'));

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
      cliEvents.emit('status', `Approved (Plan/read-only): ${taskType}`);
      return;
    }

    // Taint capability narrowing (v2 D3) — computed BEFORE the rule shortcut so a persistent
    // "Always Allow" created in a clean session can never waive it: once untrusted content
    // (web/MCP output) is in the conversation, network-capable commands are hard-blocked in
    // auto mode and always face the human elsewhere.
    const taintCut: { action: 'block' | 'ask'; reason: string } | null =
      taskType === 'OS_COMMAND' ? taintRestriction(payload.command || '', this.mode) : null;
    if (taintCut?.action === 'block') {
      throw new GovernorVetoError(`Blocked: ${taintCut.reason}`);
    }

    // Layer 1: Persistent Rules Check
    const matchingRule = this.rules.find(r => r.tool === taskType); // Simplistic matching
    if (matchingRule) {
      if (matchingRule.effect === 'deny') {
        throw new GovernorVetoError(`Rule explicitly denied task: ${taskType}`);
      }
      // High-impact computer control (uploads, sends, purchases) never rides a blanket allow —
      // each occurrence faces the human individually.
      if (matchingRule.effect === 'allow' && !taintCut && !(taskType === 'COMPUTER_CONTROL' && payload.highImpact)) {
        cliEvents.emit('status', `Approved (Rule): ${taskType}`);
        return;
      }
    }

    // Layer 1.5: session-scoped computer-control grants. A grant covers routine interaction
    // (click/type/press/select) within ONE browser domain or ONE desktop app for THIS session
    // only; high-impact actions and tainted contexts still prompt.
    const computerGrantKey = taskType === 'COMPUTER_CONTROL' ? Governor.computerGrantKey(payload) : null;
    if (computerGrantKey && !payload.highImpact && !taintCut && this.sessionGrants.has(computerGrantKey)) {
      cliEvents.emit('status', `Approved (session grant ${computerGrantKey}): ${payload.action || taskType}`);
      return;
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
        if (analysis.category === 'read' && analysis.risk === 'none' && this.mode !== 'strict' && !taintCut) {
          // Auto-approve read-only safe commands
          Logger.info(`[Governor] Auto-approved safe read command: ${payload.command}`);
          cliEvents.emit('status', `Approved (Static Analysis): ${taskType}`);
          return;
        }

        // Fallback: Layer 3 ML Classifier (only if auto mode or interactive).
        // Never lets a tainted network command through — that's the human's call.
        if (this.yolo && this.mode === 'auto' && !taintCut) {
          const isSafe = await this.yolo.evaluateAction(payload.command, payload.context);
          if (isSafe) {
             cliEvents.emit('status', `Approved (ML Classifier): ${taskType}`);
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
    // Generic and computer-control tools used to be marked destructive by buildTool but silently
    // skipped the prompt because only file/shell task types were considered here. That made browser
    // clicks and external MCP actions effectively ungated in interactive mode. Honor the tool's
    // fail-closed declaration for these task classes as well.
    const isDestructiveTask = payload.isDestructive !== false && (
      taskType === 'FILE_WRITE' || taskType === 'OS_COMMAND' || taskType === 'FILE_DELETE'
      || taskType === 'TOOL_EXECUTION' || taskType === 'COMPUTER_CONTROL'
    );
    const shouldAsk = isDestructiveTask || this.mode === 'strict';

    if (shouldAsk) {
      const computerScope = String(payload.host || payload.app || '').trim();
      const label = taskType === 'FILE_WRITE' ? `Write ${payload.targetPath || payload.path || 'file'}`
        : taskType === 'OS_COMMAND' ? `Run: ${(payload.command || '').slice(0, 60)}`
        : taskType === 'COMPUTER_CONTROL' ? `${payload.highImpact ? '⚡ HIGH-IMPACT — ' : ''}${payload.action || 'Act'} in ${payload.tool || 'computer control'}${computerScope ? ` @ ${computerScope}` : ''}`
        : taskType === 'TOOL_EXECUTION' && payload.tool ? `Run ${payload.tool}`
        : `${taskType}`;

      // A taint-narrowed command asks with the taint source in view — the human decides knowingly.
      const question = taintCut ? `⚠ TAINTED CONTEXT — ${taintCut.reason}\nAllow anyway? ${label}` : `Allow? ${label}`;
      // Computer control never offers the blanket "Always Allow" — its widest shortcut is a
      // session-scoped grant for one domain/app, and high-impact actions get plain Yes/No.
      const grantOption = computerGrantKey && !payload.highImpact && !taintCut
        ? `Allow ${computerGrantKey.replace(':', ' ')} for this session` : null;
      const options = taskType === 'COMPUTER_CONTROL'
        ? ['Yes', 'No', ...(grantOption ? [grantOption] : [])]
        : ['Yes', 'No', 'Always Allow This Tool'];
      const answer = await GlobalPrompter.ask(question, options);

      if (answer === 'No') {
        throw new GovernorVetoError("User explicitly denied this action.");
      }

      if (answer === 'Always Allow This Tool' && taskType !== 'COMPUTER_CONTROL') {
        this.addRule({ tool: taskType, effect: 'allow', persistent: true });
        Logger.info(`[Governor] Added persistent allow rule for ${taskType}`);
      }

      if (grantOption && answer === grantOption && computerGrantKey) {
        this.sessionGrants.add(computerGrantKey);
        Logger.info(`[Governor] Session computer-control grant added: ${computerGrantKey}`);
      }
    }

    Logger.info(`[Governor] ✅ Veto cleared. Task approved.`);
    cliEvents.emit('status', `Approved: ${taskType}`);
  }
}
