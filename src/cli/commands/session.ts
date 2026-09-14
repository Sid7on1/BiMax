import { globalCommandRegistry } from './registry';
import { getProviders, setProvider, getCurrentProvider, buildKeyPool } from '../provider';
import { saveApiKeyToEnv } from '../env.loader';
import { SessionStore, messageEntriesToLLM } from '../session';
import { getSessionRecorder } from '../session.recorder';
import { listSessionMeta } from '../../db/session.meta';
import { cliEvents } from '../events';

/** "2026-06-17_02-30-15.jsonl" → "2026-06-17 02:30:15" for display. */
function prettySessionName(file: string): string {
  const m = file.replace(/\.jsonl$/, '').match(/^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})$/);
  return m ? `${m[1]} ${m[2]}:${m[3]}:${m[4]}` : file.replace(/\.jsonl$/, '');
}

/** Print a read-only preview of a saved session into the transcript. */
async function previewSession(file: string, context: any): Promise<void> {
  const msgs = await new SessionStore().loadSession(file);
  if (msgs.length === 0) { context.addSystemMessage('info', `Session ${prettySessionName(file)} is empty or unreadable.`); return; }
  context.addSystemMessage('info', `--- Session ${prettySessionName(file)} · ${msgs.length} message(s) (preview) ---`);
  for (const m of msgs.slice(-30)) {
    const who = m.role === 'user' ? 'You' : m.role === 'assistant' ? 'BiMax' : 'System';
    const text = typeof m.content === 'string' ? m.content : '';
    const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (snippet) context.addSystemMessage('info', `${who}: ${snippet}`);
  }
}

/**
 * True resume: restore a saved thread end-to-end.
 *  - LLM context: entries are converted through messageEntriesToLLM (tool lines folded into
 *    readable notes, UI shapes stripped) and the last 40 turns become the live history — raw
 *    MessageEntry injection sent providers malformed payloads.
 *  - Front-end transcript: a `session_restore` event carries the raw entries so graphical
 *    front-ends rebuild their scrollback instead of showing an invisible-context one-liner.
 *  - Thread continuation: the recorder switches to the resumed session's file, so new turns
 *    append to the SAME thread instead of forking a parallel one.
 */
async function resumeSession(file: string, context: any, store: SessionStore): Promise<void> {
  const entries = await store.loadSession(file);
  const failed = (reason: string): void => { cliEvents.emit('session_restore_failed', { id: file.replace(/\.jsonl$/, ''), reason }); };
  if (entries.length === 0) {
    failed('the saved conversation is empty or unreadable');
    context.addSystemMessage('error', `Session ${prettySessionName(file)} is empty or unreadable.`);
    return;
  }
  if (!context.restoreMessages) {
    failed('this engine cannot restore conversations');
    context.addSystemMessage('error', 'Session restore is not available in this context. Use /resume from the main terminal.');
    return;
  }
  const llm = messageEntriesToLLM(entries).slice(-40);
  if (context.restoreMessages(llm) === false) { failed('the task was busy'); return; } // busy — the session already surfaced why
  const id = file.replace(/\.jsonl$/, '');
  const firstUser = entries.find((m: any) => m.role === 'user' && typeof m.content === 'string') as any;
  const chatCount = entries.filter((m: any) => m.role === 'user' || m.role === 'assistant').length;
  try { getSessionRecorder()?.switchTo(id, chatCount, firstUser?.content); } catch { /* recorder optional */ }
  // Replay the transcript for graphical front-ends (capped: a day-long thread stays renderable).
  cliEvents.emit('session_restore', { id, entries: entries.slice(-400) });
  context.addSystemMessage('success', `Resumed "${prettySessionName(file)}" · ${llm.length} turn(s) restored — continuing this thread.`);

  // Inject GoalManager continuation prompt so the model picks up the active goal
  try {
    const { getGoalManager } = require('../../memory/goal.manager');
    const activeGoals = getGoalManager().getActiveGoals();
    if (activeGoals.length > 0) {
      const g = activeGoals[0];
      context.addSystemMessage('info', `[GoalManager] Resuming with active goal: "${g.title}"${g.description ? ` — ${g.description}` : ''}. Pick up where you left off.`);
    }
  } catch { /* goals are best-effort */ }
}

// Apply a provider selection live: switch the active provider, persist the choice, and tell
// the user which key env var it needs. Shared by the picker's onSelect and `/provider <name>`.
function applyProvider(name: string, context: any) {
  const found = setProvider(name);
  if (!found) {
    context.addSystemMessage('error', `Unknown provider: ${name}. Open /provider to pick from the list.`);
    return;
  }
  try { saveApiKeyToEnv('BGW_PROVIDER', name); } catch { /* persistence optional */ }
  const hasKey = !!process.env[found.apiKeyEnv];
  context.addSystemMessage('success', `Provider switched to ${found.name} (${found.baseURL})`);
  if (!hasKey) context.addSystemMessage('info', `No ${found.apiKeyEnv} set yet — open /keys to add the API key.`);
}

globalCommandRegistry.register({
  name: '/provider',
  description: 'Switch provider',
  category: 'Configuration',
  execute: async (args, context) => {
    if (args.length >= 1) {
      applyProvider(args[0], context);
      return { type: 'none' };
    }
    const current = getCurrentProvider();
    return {
      type: 'menu',
      title: `Select provider (current: ${current.name})`,
      options: getProviders().map(p => ({
        label: p.name,
        value: p.name,
        desc: `${p.baseURL}${process.env[p.apiKeyEnv] ? ' · key set' : ' · no key'}`,
      })),
      onSelect: (opt: any) => applyProvider(opt.value, context),
    };
  }
});

// Prompt for and store a provider's API key (manual entry, masked). Reused by the picker.
function promptForKey(providerName: string, context: any) {
  const match = getProviders().find(p => p.name === providerName);
  if (!match) return;
  context.setActivePrompt({
    title: `Enter API key for ${match.name} (${match.apiKeyEnv})`,
    isMasked: true,
    onResolve: (keyStr: string) => {
      const key = (keyStr || '').trim();
      if (!key) { context.addSystemMessage('info', 'No key entered — nothing changed.'); return; }
      try {
        saveApiKeyToEnv(match.apiKeyEnv, key);
        process.env[match.apiKeyEnv] = key;
        context.addSystemMessage('success', `${match.apiKeyEnv} saved to ~/.breakglass/.env`);
        // Make the key LIVE now, not on next restart: rebuild the adapter's key pool (clears the
        // client + live-models caches too), then open the model picker — it fetches the provider's
        // real /models list with the fresh key, so the catalog appears the moment a key lands.
        try { context.options?.llmAdapter?.setKeys?.(buildKeyPool()); } catch { /* adapter optional */ }
        context.executeCommand?.('/model');
      } catch (e: any) {
        context.addSystemMessage('error', `Failed to save key: ${e.message}`);
      }
    },
  });
}

globalCommandRegistry.register({
  name: '/keys',
  description: 'Show/add API keys',
  category: 'Configuration',
  execute: async (args, context) => {
    const providers = getProviders();
    if (args[0]) {
      const requested = providers.find(provider => provider.name === args[0]);
      if (!requested) return { type: 'message', level: 'error', content: `Unknown provider: ${args[0]}` };
      promptForKey(requested.name, context);
      return { type: 'none' };
    }

    // WS1.5: live pool health from the adapter's key manager (ok/fail counts, cooldowns).
    // Rendered as an informational category above the provider picker.
    let poolOptions: any[] = [];
    try {
      const states = context.options?.llmAdapter?.getKeyStates?.() ?? [];
      poolOptions = states.map((s: any) => ({
        label: `${s.onCooldown ? '⏸' : '●'} ${s.label}`,
        value: s.label,
        desc: [
          s.model !== 'default' ? s.model : null,
          `${s.ok} ok / ${s.fail} fail`,
          s.firstTokenMs > 0 ? `~${(s.firstTokenMs / 1000).toFixed(1)}s to first token` : null,
          s.hangs > 0 ? `${s.hangs} hang${s.hangs > 1 ? 's' : ''}` : null,
          s.onCooldown ? `cooldown ${Math.ceil(s.cooldownSecs)}s` : null,
        ].filter(Boolean).join(' · '),
        category: 'Pool health (this session)',
      }));
    } catch { /* adapter optional — key pool UI degrades to provider list only */ }

    return {
      type: 'menu',
      title: 'Select a provider to add / replace its API key',
      options: [
        ...providers.map(p => ({
          label: p.name,
          value: p.name,
          desc: process.env[p.apiKeyEnv] ? `${p.apiKeyEnv} · configured` : `${p.apiKeyEnv} · missing`,
          category: 'Add / replace key',
        })),
        ...poolOptions,
      ],
      onSelect: (opt: any) => {
        // Pool-health rows are informational; only provider rows open the key prompt.
        if (providers.some(p => p.name === opt.value)) promptForKey(opt.value, context);
      },
    };
  }
});

globalCommandRegistry.register({
  name: '/sessions',
  description: 'Browse saved sessions — pick one to preview or resume',
  category: 'Session & Context',
  execute: async (_args, context) => {
    const store = new SessionStore();
    const files = await store.listSessions();
    if (files.length === 0) {
      return { type: 'message', level: 'info', content: 'No saved sessions yet (.breakglass/sessions). They accrue as you chat.' };
    }

    // Enrich with metadata where available (title, cwd, message count, goal)
    const metaMap = new Map(listSessionMeta(80).map(m => [m.id, m]));

    const options = files.slice(0, 40).map(f => {
      const id = f.replace(/\.jsonl$/, '');
      const meta = metaMap.get(id);
      const label = meta?.title && meta.title !== '(no messages yet)'
        ? meta.title.slice(0, 60)
        : prettySessionName(f);
      const descParts: string[] = [prettySessionName(f)];
      if (meta?.cwd) descParts.push(meta.cwd.split('/').slice(-2).join('/'));
      if (meta?.messageCount) descParts.push(`${meta.messageCount} msgs`);
      if (meta?.goalTitle) descParts.push(`goal: ${meta.goalTitle.slice(0, 30)}`);
      return { label, value: f, desc: descParts.join(' · '), category: 'Sessions' };
    });

    return {
      type: 'menu',
      title: 'Saved sessions — pick one to resume (newest first)',
      options,
      onSelect: (opt: any) => { void resumeSession(opt.value, context, store); },
    };
  }
});

globalCommandRegistry.register({
  name: '/resume',
  aliases: ['/session'],
  description: 'Resume a past session by injecting its messages into the current context',
  category: 'Session & Context',
  execute: async (args, context) => {
    const store = new SessionStore();
    if (args[0]) {
      const files = await store.listSessions();
      // Prefer an exact match; only fall back to prefix when it's unambiguous. A short prefix like
      // "2026" otherwise silently resumed whichever session happened to sort first.
      const exact = files.find(f => f === args[0] || f === `${args[0]}.jsonl`);
      let match = exact;
      if (!match) {
        const prefixed = files.filter(f => f.startsWith(args[0]));
        if (prefixed.length === 1) {
          match = prefixed[0];
        } else if (prefixed.length > 1) {
          cliEvents.emit('session_restore_failed', { id: args[0], reason: `more than one saved conversation starts with "${args[0]}"` });
          return { type: 'message', level: 'error', content: `"${args[0]}" matches ${prefixed.length} sessions (${prefixed.slice(0, 5).join(', ')}…). Be more specific or open /sessions.` };
        }
      }
      if (!match) {
        cliEvents.emit('session_restore_failed', { id: args[0], reason: 'no saved conversation has that id' });
        return { type: 'message', level: 'error', content: `No session matching "${args[0]}". Open /sessions to browse.` };
      }
      await resumeSession(match, context, store);
      return { type: 'none' };
    }
    return { type: 'redirect', command: '/sessions' };
  }
});

globalCommandRegistry.register({
  name: '/branch',
  description: 'Fork the current session into a named branch, or switch to a saved one',
  category: 'Session & Context',
  execute: async (args, context) => {
    const store = new SessionStore();

    // /branch create <name> — save current conversation as a named branch
    if (args[0] === 'create' || args[0] === 'save') {
      const name = args.slice(1).join('_').replace(/\s+/g, '_') || '';
      if (!name) return { type: 'message', level: 'error', content: 'Usage: /branch create <name>   (name the fork)' };
      const msgs = context.getMessages?.() || [];
      if (msgs.length === 0) return { type: 'message', level: 'info', content: 'Nothing to branch — conversation is empty.' };
      await store.saveBranch(name, msgs);
      return { type: 'message', level: 'success', content: `Branch "${name}" saved (${msgs.length} message(s)). Resume it later with /branch switch ${name}` };
    }

    // /branch delete <name>
    if (args[0] === 'delete' || args[0] === 'rm') {
      const name = args.slice(1).join('_') || '';
      if (!name) return { type: 'message', level: 'error', content: 'Usage: /branch delete <name>' };
      const ok = await store.deleteBranch(name);
      return ok
        ? { type: 'message', level: 'success', content: `Branch "${name}" deleted.` }
        : { type: 'message', level: 'error', content: `No branch named "${name}".` };
    }

    // /branch switch <name> or /branch list (default)
    const branches = await store.listBranches();

    if (args[0] === 'switch' || args[0] === 'load') {
      const name = args.slice(1).join('_') || '';
      if (!name) return { type: 'message', level: 'error', content: 'Usage: /branch switch <name>' };
      const msgs = await store.loadBranch(name);
      if (msgs.length === 0) return { type: 'message', level: 'error', content: `Branch "${name}" not found or empty. Use /branch list.` };
      if (!context.restoreMessages) {
        return { type: 'message', level: 'error', content: 'Branch restore is not available in this context.' };
      }
      const tail = messageEntriesToLLM(msgs).slice(-40);
      if (context.restoreMessages(tail) === false) return { type: 'none' };
      cliEvents.emit('session_restore', { id: `branch:${name}`, entries: msgs.slice(-400) });
      return { type: 'message', level: 'success', content: `Switched to branch "${name}" · ${tail.length} turn(s) loaded.` };
    }

    // List branches
    if (branches.length === 0) {
      return { type: 'message', level: 'info', content: 'No branches yet. Create one with /branch create <name>' };
    }
    return {
      type: 'menu',
      title: 'Saved branches — pick one to switch to',
      options: branches.map(b => ({ label: b, value: b, desc: `switch to branch "${b}"`, category: 'Branches' })),
      onSelect: async (opt: any) => {
        const msgs = await store.loadBranch(opt.value);
        const tail = messageEntriesToLLM(msgs).slice(-40);
        if (context.restoreMessages) {
          if (context.restoreMessages(tail) === false) return;
          cliEvents.emit('session_restore', { id: `branch:${opt.value}`, entries: msgs.slice(-400) });
          context.addSystemMessage('success', `Switched to branch "${opt.value}" · ${tail.length} turn(s) loaded.`);
        } else {
          context.addSystemMessage('error', 'Branch restore not available.');
        }
      },
    };
  }
});
