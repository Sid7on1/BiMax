import { AppState, appStore } from '../../state/app.state';
import { IGovernor } from '../../core/interfaces';

export type CommandCategory = 'Configuration' | 'Code & Intelligence' | 'Source Control' | 'General' | 'Session & Context';

export type CommandResult = 
  | { type: 'message'; content: string; level: 'info' | 'success' | 'error' }
  | { type: 'menu'; title: string; options: any[]; onSelect?: (val: any) => void | Promise<void> }
  | { type: 'prompt'; title: string; onResolve: (val: string) => void; isMasked?: boolean }
  | { type: 'redirect'; command: string }
  // A rich front-end panel (HelpDashboard / StatsDashboard / DataTableDashboard) forwarded to the
  // TUI as a message carrying a uiComponent + payload.
  | { type: 'dashboard'; uiComponent: string; payload: any }
  | { type: 'none' }; // Handled externally

export interface CommandContext {
  cwd: string;
  options: any; // The global cli options
  codebaseIndexer?: any; // To support /index commands
  graphStore?: any; // Dependency graph, for /impact and /ask
  saveConfig: (updates: any) => Promise<any>;
  addSystemMessage: (level: 'info' | 'success' | 'error', msg: string) => void;
  setActiveMenu: (menu: any) => void;
  setActivePrompt: (prompt: any) => void;
  executeCommand: (cmd: string) => void;
  /**
   * Replace the live conversation with LLM-ready messages (session/branch resume — convert UI
   * entries through messageEntriesToLLM first). Returns false when refused (e.g. mid-turn).
   */
  restoreMessages?: (messages: any[]) => boolean | void;
  /** Return the current live conversation messages (for branching). */
  getMessages?: () => any[];
  /**
   * The active session/task id, when this run has one (see headless.session.ts, which supplies it
   * from the session recorder). Commands that drive the desktop use it to route to that task's own
   * computer session instead of a single shared one — see `isSessionRoutableDesktopRuntime`.
   */
  sessionId?: string;
  /** The evidence inspector's plain-language report for the active conversation (see src/context/inspector.ts). */
  contextReport?: () => string | null;
}

export interface Command {
  name: string;
  aliases?: string[];
  description: string;
  category: CommandCategory;
  /** Demote from the palette + `/` autocomplete (still runnable when typed in full). See PALETTE_HIDDEN. */
  hidden?: boolean;
  isEnabled?: (context: Partial<CommandContext>) => { enabled: boolean; reason?: string };
  execute(args: string[], context: CommandContext): Promise<CommandResult>;
}

// Surface triage (identity/runtime plan, Phase D): the engine registers ~70 commands, but showing
// all of them dilutes discoverability. These are demoted from the palette + `/` autocomplete — they
// remain fully registered and runnable when typed in full (hidden aliases), and their capability is
// reachable through a smaller set of primary verbs + the Ctrl+X mind HUD. Tune freely; nothing here
// deletes a command. Grouped by where the capability now lives:
export const PALETTE_HIDDEN = new Set<string>([
  // Mind layer → the Ctrl+X mind HUD (panels, not commands you type).
  'mind', 'self', 'drives', 'habits', 'dogfood', 'claims', 'ledger', 'taint',
  'exemplars', 'episodes', 'impact', 'replay', 'dream', 'calibration', 'harness', 'journal',
  // Multi-agent variants → /swarm and /beast.
  'speculate', 'evolve', 'council', 'orchestrate', 'heal', 'scout',
  // Time-travel → /rewind.
  'undo', 'checkpoint', 'backups', 'tx',
  // Model / routing internals → /model. ('route' explains a routing decision — a diagnostic
  // readout, not a verb you reach for; it stays runnable when typed in full.)
  'provider', 'tier', 'reasoning', 'routes', 'arms', 'route', 'slot',
  // Variants of a primary verb → the primary (e.g. /context, /diff, /index).
  'context-mode', 'context-window', 'diff-approval', 'diff-file', 'self-critic',
  'a11y', 'agent-decisions', 'index-ai', // 'index-ai' → /index (semantic variant)
  // File-op tools the agent invokes directly — rarely typed as a slash command.
  'edit', 'write',
  // Session resume folds into /sessions (which lists + resumes); output format into /config.
  'resume', 'output',
  // Niche / advanced — reachable when typed, off the browsable surface.
  'agents', 'ask', 'autocommit', 'branch', 'check', 'keys', 'lint', 'log', 'changelog', 'watch',
  // Phase 3 utility readouts — advisory, not primary verbs (run when typed in full).
  'update', 'upgrade', 'power',
  // Already represented by primary product surfaces: Map panel and Security settings/status.
  'map', 'governor',
  'pipelines', 'recipe', 'selection', 'shortcuts', 'headroom',
  // Diagnostic readouts → demoted on the same rule that demoted 'route' above: a thing you run to
  // CHECK the product is not a verb you reach for to DO work. All three stay runnable when typed.
  //   retrieval — "prove semantic search is live: one real embedding call, with the margin"
  //   trace     — recent OTel GenAI spans + where they exported to
  //   sidecars  — optional Python-backed capabilities, i.e. configuring infrastructure
  // The surface had drifted to 33 against a documented ceiling of 30; these are the three least
  // verb-like on it. /evidence and /compliance were the other candidates and are deliberately KEPT —
  // "what the model was shown" and "check documents against a rule set" are things a user wants to
  // find by browsing, not diagnostics.
  'retrieval', 'trace', 'sidecars',
]);

/** Is this command demoted from the browsable palette / autocomplete? (names may carry a leading /) */
export function isHiddenCommand(c: Command): boolean {
  const bare = c.name.toLowerCase().replace(/^\//, '');
  return c.hidden === true || PALETTE_HIDDEN.has(bare);
}

export class CommandRegistry {
  private commands = new Map<string, Command>();
  
  register(command: Command) {
    this.commands.set(command.name.toLowerCase(), command);
    command.aliases?.forEach(a => this.commands.set(a.toLowerCase(), command));
  }
  
  async execute(input: string, context: CommandContext): Promise<CommandResult> {
    const [name, ...args] = input.trim().split(/\s+/);
    const command = this.commands.get(name.toLowerCase());
    
    if (!command) {
      throw new Error(`Unknown command: ${name}`);
    }
    
    return command.execute(args, context);
  }
  
  getSuggestions(partial: string): string[] {
    const matches = new Set<string>();
    for (const [key, cmd] of this.commands.entries()) {
      if (key.startsWith(partial.toLowerCase())) {
        matches.add(`${cmd.name} — ${cmd.description}`);
      }
    }
    return Array.from(matches);
  }

  getAllCommands(): Command[] {
    const uniqueCommands = new Set<Command>();
    for (const cmd of this.commands.values()) {
      uniqueCommands.add(cmd);
    }
    return Array.from(uniqueCommands);
  }

  /**
   * Palette rows for the Ctrl+K command palette: one entry per registered command (deduped by
   * object identity, so aliases don't double-list), sorted by category then name. This is the
   * SINGLE SOURCE OF TRUTH for "what commands exist" — the palette derives from the live registry
   * (built-ins + user `.bimax/commands/*.md`), so it can never drift from reality the way a
   * hardcoded list does.
   */
  getPaletteOptions(store?: any): { label: string; value: string; desc: string; category: string; disabled?: boolean; disabledReason?: string }[] {
    const ctx: Partial<CommandContext> = { graphStore: store };
    return this.getAllCommands()
      .filter(c => !isHiddenCommand(c)) // curated surface — hidden commands still run when typed
      .map(c => {
        let disabled = false;
        let disabledReason: string | undefined;
        if (c.isEnabled) {
          const res = c.isEnabled(ctx);
          disabled = !res.enabled;
          disabledReason = res.reason;
        }
        return { label: c.name, value: c.name, desc: c.description, category: c.category, disabled, disabledReason };
      })
      .sort((a, b) => a.category.localeCompare(b.category) || a.label.localeCompare(b.label));
  }
}

export const globalCommandRegistry = new CommandRegistry();
