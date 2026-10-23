import { Command, globalCommandRegistry } from './registry';
import { engineEvents } from '../events';
import { getConfig } from '../config';
import { setBlastGateEnabled, isBlastGateEnabled } from '../blastGate';
import { setVerifyEnabled, isVerifyEnabled } from '../../sandbox/verify.loop';
import { setSandboxEnabled, isSandboxEnabled, sandboxAvailable } from '../../sandbox/exec.sandbox';
import { isGitAutoCommitEnabled } from '../../tools/git.autocommit';
import { isDiffApprovalEnabled } from '../diffApproval';
import { isSelfCriticEnabled } from '../selfCritic';
import { setAdversarialVerifyEnabled, isAdversarialVerifyEnabled } from '../adversarialVerifier';

globalCommandRegistry.register({
  name: '/governor',
  description: 'Toggle Governor Mode',
  category: 'Configuration',
  execute: async (args, context) => {
    // /governor sandbox [on|off] — run BashTool under the OS sandbox (sandbox-exec on macOS, bwrap on
    // Linux); writes restricted to the workspace + temp.
    if ((args[0] || '').toLowerCase() === 'sandbox') {
      const sub = (args[1] || '').toLowerCase();
      if (sub === 'on' || sub === 'off') {
        const on = sub === 'on';
        setSandboxEnabled(on);
        await context.saveConfig({ sandboxBash: on });
        const note = on && !sandboxAvailable() ? ' (note: no OS sandbox backend here — need sandbox-exec on macOS or bwrap on Linux; commands run unsandboxed)' : '';
        return { type: 'message', level: 'success', content: `Bash sandbox is ${on ? 'ON — shell writes restricted to the workspace + temp' : 'OFF'}.${note}` };
      }
      return {
        type: 'menu',
        title: `Bash sandbox (currently ${isSandboxEnabled() ? 'ON' : 'OFF'}${sandboxAvailable() ? '' : ', unavailable on this OS'})`,
        options: [
          { label: '[ ON ]', value: '/governor sandbox on', desc: 'Restrict shell file-writes to the workspace + temp' },
          { label: '[ OFF ]', value: '/governor sandbox off', desc: 'Run shell commands without isolation' },
        ],
        initialIndex: isSandboxEnabled() ? 0 : 1,
        onSelect: (opt: any) => context.executeCommand(opt.value),
      };
    }

    // /governor verify [on|off] — typecheck after edits and feed errors back for self-repair.
    if ((args[0] || '').toLowerCase() === 'verify') {
      const sub = (args[1] || '').toLowerCase();
      if (sub === 'on' || sub === 'off') {
        const on = sub === 'on';
        setVerifyEnabled(on);
        await context.saveConfig({ autoVerify: on });
        return { type: 'message', level: 'success', content: `Auto-verify is ${on ? 'ON — edits are typechecked and failures fed back for one repair pass' : 'OFF'}.` };
      }
      return {
        type: 'menu',
        title: `Auto-verify after edits (currently ${isVerifyEnabled() ? 'ON' : 'OFF'})`,
        options: [
          { label: '[ ON ]', value: '/governor verify on', desc: 'Typecheck edited files; feed errors back to the agent' },
          { label: '[ OFF ]', value: '/governor verify off', desc: 'No automatic typecheck after edits' },
        ],
        initialIndex: isVerifyEnabled() ? 0 : 1,
        onSelect: (opt: any) => context.executeCommand(opt.value),
      };
    }

    // /governor redteam [on|off] — adversarial red-team verification pass after self-critic.
    if ((args[0] || '').toLowerCase() === 'redteam') {
      const sub = (args[1] || '').toLowerCase();
      if (sub === 'on' || sub === 'off') {
        const on = sub === 'on';
        setAdversarialVerifyEnabled(on);
        await context.saveConfig({ adversarialVerify: on });
        return { type: 'message', level: 'success', content: `Red-team adversarial verifier is ${on ? 'ON — full-model red-team pass runs after self-critic on code turns' : 'OFF'}.` };
      }
      return {
        type: 'menu',
        title: `Adversarial red-team verifier (currently ${isAdversarialVerifyEnabled() ? 'ON' : 'OFF'})`,
        options: [
          { label: '[ ON ]', value: '/governor redteam on', desc: 'Full-model red-team pass after self-critic; finds bugs/edge cases the agent missed' },
          { label: '[ OFF ]', value: '/governor redteam off', desc: 'Skip adversarial verification (faster, fewer tokens)' },
        ],
        initialIndex: isAdversarialVerifyEnabled() ? 0 : 1,
        onSelect: (opt: any) => context.executeCommand(opt.value),
      };
    }

    // /governor blast-gate [on|off] — confirm edits that touch HIGH/CRITICAL graph symbols.
    if ((args[0] || '').toLowerCase() === 'blast-gate') {
      const sub = (args[1] || '').toLowerCase();
      if (sub === 'on' || sub === 'off') {
        const on = sub === 'on';
        setBlastGateEnabled(on);
        await context.saveConfig({ blastGate: on });
        return { type: 'message', level: 'success', content: `Blast-radius edit gate is ${on ? 'ON — edits touching HIGH/CRITICAL symbols will ask for confirmation' : 'OFF'}.` };
      }
      return {
        type: 'menu',
        title: `Blast-radius edit gate (currently ${isBlastGateEnabled() ? 'ON' : 'OFF'})`,
        options: [
          { label: '[ ON ]', value: '/governor blast-gate on', desc: 'Confirm edits to HIGH/CRITICAL symbols, showing downstream impact' },
          { label: '[ OFF ]', value: '/governor blast-gate off', desc: 'Apply edits without the blast-radius check' },
        ],
        initialIndex: isBlastGateEnabled() ? 0 : 1,
        onSelect: (opt: any) => context.executeCommand(opt.value),
      };
    }
    if (args.length === 0) {
      const isOn = context.options.governor.mode !== 'bypass';
      return {
        type: 'menu',
        title: `Governor is currently ${isOn ? 'ON' : 'OFF'}`,
        options: [
          // Values are full commands so selecting one in the TUI actually toggles (a bare "on"/"off"
          // got dispatched as a chat message and silently did nothing).
          { label: '[ ON ] Active', value: '/governor on', desc: 'Constraints, vetoes, and the daily budget cap apply' },
          { label: '[ OFF ] Bypass', value: '/governor off', desc: 'Auto-approve everything and lift the budget cap' },
        ],
        initialIndex: isOn ? 0 : 1,
        onSelect: (opt: any) => context.executeCommand(opt.value),
      };
    } else if (args[0] === 'off') {
      context.options.governor.mode = 'bypass';
      return { type: 'message', level: 'success', content: 'Governor bypassed. All actions will be auto-approved.' };
    } else if (args[0] === 'on') {
      context.options.governor.mode = 'interactive';
      return { type: 'message', level: 'success', content: 'Governor is active. Constraints and vetoes will apply.' };
    } else {
      return { type: 'message', level: 'error', content: 'Usage: /governor on | /governor off' };
    }
  }
});

globalCommandRegistry.register({
  name: '/config',
  description: 'Show/set config',
  category: 'Configuration',
  execute: async (args, context) => {
    // Live config flags (default ON when unset), used by the hub labels and toggle submenus.
    const cfgFlag = (k: 'showMapPanel' | 'showTokenMeter') => {
      try { return (getConfig() as any)[k] !== false; } catch { return true; }
    };
    const ctxMode = (() => { try { return getConfig().contextMode || 'smart'; } catch { return 'smart'; } })();
    if (args.length === 0) {
      // Reflect live state in every label so the hub is a true control panel (no hardcoding).
      const onOff = (v: boolean) => (v ? 'ON' : 'OFF');
      // Live graph build-status so "is the map even built?" is answered inline.
      let mapNodes = 0, aiBuilt = false;
      try {
        const g = (context as any).graphStore?.getGraph();
        if (g) {
          mapNodes = g.nodes.size;
          for (const n of g.nodes.values()) {
            if (n.criticality || n.purpose || n.riskScore != null) { aiBuilt = true; break; }
          }
        }
      } catch { /* graph unavailable — show as not built */ }
      return {
        type: 'menu',
        title: 'Settings — type to search, ↑/↓ to move, Enter to open',
        options: [
          // — Models & access —
          { label: 'Work model', value: '/model', desc: `Does the real work — ${context.options.model || 'default'}`, category: 'Models & Access' },
          { label: 'Quick model', value: '/model lite', desc: `Instant small replies — ${(() => { try { return getConfig().liteModel || 'uses work model'; } catch { return 'uses work model'; } })()}`, category: 'Models & Access' },
          { label: 'Provider', value: '/provider', desc: 'Switch AI provider', category: 'Models & Access' },
          { label: 'API Keys', value: '/keys', desc: 'Add / replace API keys', category: 'Models & Access' },
          { label: 'Agent persona', value: '/agents', desc: `Active: ${context.options.agent || 'default'} — switch persona`, category: 'Models & Access' },
          { label: 'Routing rules', value: '/routes', desc: 'Route tasks to providers/models by rule', category: 'Models & Access' },

          // — Codebase intelligence (the graph) —
          { label: 'Build map graph', value: '/index', desc: mapNodes > 0 ? `Built ✓ — ${mapNodes} nodes. Re-run to refresh the AST index` : 'Not built — AST index so the agent navigates to exact symbols', category: 'Codebase Intelligence' },
          { label: 'Build AI graph', value: '/index-ai', desc: aiBuilt ? 'Built ✓ — semantic layer present. Re-run to refresh' : 'Not built — adds purpose + risk per symbol (costs credits)', category: 'Codebase Intelligence' },
          { label: 'Codebase map panel', value: '/config mapPanel', desc: `Pinned map overview above input — ${onOff(cfgFlag('showMapPanel'))}`, category: 'Codebase Intelligence' },
          { label: 'Live token meter', value: '/config tokenMeter', desc: `Show tokens that will be sent — ${onOff(cfgFlag('showTokenMeter'))}`, category: 'Codebase Intelligence' },
          { label: 'How tools are sent', value: '/context-mode', desc: `${ctxMode === 'full' ? 'Full — every tool sent every turn (heavier)' : 'Smart — only tools needed now are sent; rest load on request (faster)'}`, category: 'Codebase Intelligence' },
          { label: 'Memory limit (context window)', value: '/context-window', desc: `${(() => { try { const w = getConfig().contextWindowTokens; return w > 0 ? w.toLocaleString() + ' tokens' : '128k tokens (default)'; } catch { return '128k tokens (default)'; } })()} — how much the model can hold before history is trimmed`, category: 'Codebase Intelligence' },
          { label: 'History trimming (compaction)', value: '/context-mode', desc: `${ctxMode === 'full' ? 'Off until full — trims only when the model says it ran out of room' : 'On — auto-shrinks old tool output & summarizes old chat so you never run out'} (follows "How tools are sent")`, category: 'Codebase Intelligence' },
          { label: 'Reasoning effort', value: '/reasoning', desc: `${(() => { try { return getConfig().reasoningEffort || 'off'; } catch { return 'off'; } })()} — lower = faster replies after tool calls`, category: 'Models & Access' },
          { label: 'Parallel tool calls', value: '/config parallel', desc: `Batch independent tool calls per turn — ${onOff((() => { try { return getConfig().parallelToolCalls !== false; } catch { return true; } })())}`, category: 'Models & Access' },
          { label: 'Re-run onboarding', value: '/config onboard', desc: 'Offer the map-graph / AI-graph setup again', category: 'Codebase Intelligence' },

          // — Extensions —
          { label: 'MCP servers', value: '/mcp', desc: 'Add / remove external MCP tool servers', category: 'Extensions' },
          { label: 'Agent skills', value: '/skills', desc: 'Model-invoked SKILL.md capability packs', category: 'Extensions' },

          // — Permissions & safety —
          { label: 'Governor (permissions)', value: '/governor', desc: `Currently ${context.options.governor?.mode === 'bypass' ? 'OFF (auto-approve)' : 'ON (approvals)'}`, category: 'Permissions & Safety' },
          { label: 'Blast-radius gate', value: '/governor blast-gate', desc: `Confirm edits to critical symbols — ${onOff(isBlastGateEnabled())}`, category: 'Permissions & Safety' },
          { label: 'Auto-verify edits', value: '/governor verify', desc: `Typecheck + self-repair after edits — ${onOff(isVerifyEnabled())}`, category: 'Permissions & Safety' },
          { label: 'Bash sandbox', value: '/governor sandbox', desc: `Restrict shell writes to workspace — ${onOff(isSandboxEnabled())}`, category: 'Permissions & Safety' },
          { label: 'Diff approval', value: '/diff-approval', desc: `Review edits before they apply — ${onOff(isDiffApprovalEnabled())}`, category: 'Permissions & Safety' },
          { label: 'Auto-commit', value: '/autocommit', desc: `Commit after each agent edit — ${onOff(isGitAutoCommitEnabled())}`, category: 'Permissions & Safety' },
          { label: 'Self-critic', value: '/self-critic', desc: `Agent reviews its own work — ${onOff(isSelfCriticEnabled())}`, category: 'Permissions & Safety' },
          { label: 'Auto agent decisions', value: '/agent-decisions', desc: `Let the agent auto-resolve ambiguities — ${onOff(!!context.options.autoAgentDecisions)}`, category: 'Permissions & Safety' },

          // — Interface —
          { label: 'Theme', value: '/config theme', desc: `Current: ${context.options.theme || 'auto'}`, category: 'Interface' },
          { label: 'Verbose logging', value: '/config verbose', desc: `Detailed logs — ${onOff(!!context.options.verbose)}`, category: 'Interface' },
          { label: 'Notification bell', value: '/config notify', desc: `Terminal bell on turn end — ${onOff(!!context.options.notificationBell)}`, category: 'Interface' },
        ],
        onSelect: (opt: any) => context.executeCommand(opt.value),
      };
    }

    // Re-run the first-launch onboarding flow (the TUI listens and re-offers the graph build).
    if (args[0] === 'onboard' && args.length === 1) {
      await context.saveConfig({ onboardingComplete: false });
      engineEvents.emit('config_changed');
      engineEvents.emit('rerun_onboarding');
      return { type: 'message', level: 'info', content: 'Re-running onboarding — choose whether to rebuild the map graph, then the AI graph.' };
    }

    // /config mapPanel | /config tokenMeter — boolean toggles for the UI panels.
    if ((args[0] === 'mapPanel' || args[0] === 'tokenMeter') && args.length === 1) {
      const key = args[0] === 'mapPanel' ? 'showMapPanel' : 'showTokenMeter';
      const cur = cfgFlag(key);
      return {
        type: 'menu',
        title: `${args[0] === 'mapPanel' ? 'Codebase map panel' : 'Live token meter'} (currently ${cur ? 'ON' : 'OFF'})`,
        options: [
          { label: '[ ON ]', value: `/config set ${key} true`, desc: args[0] === 'mapPanel' ? 'Show the pinned map overview' : 'Show the pre-send token estimate' },
          { label: '[ OFF ]', value: `/config set ${key} false`, desc: 'Hide it' },
        ],
        initialIndex: cur ? 0 : 1,
        onSelect: (opt: any) => context.executeCommand(opt.value),
      };
    }

    // /config parallel — toggle batched (parallel) tool calls.
    if (args[0] === 'parallel' && args.length === 1) {
      const cur = (() => { try { return getConfig().parallelToolCalls !== false; } catch { return true; } })();
      return {
        type: 'menu',
        title: `Parallel tool calls (currently ${cur ? 'ON' : 'OFF'})`,
        options: [
          { label: '[ ON ]', value: '/config set parallelTools true', desc: 'Model can batch independent reads/greps in one turn (faster)' },
          { label: '[ OFF ]', value: '/config set parallelTools false', desc: 'One tool call per turn (for backends like NVIDIA NIM that reject batches)' },
        ],
        initialIndex: cur ? 0 : 1,
        onSelect: (opt: any) => context.executeCommand(opt.value),
      };
    }

    // /config verbose | /config notify — boolean toggles, menu-driven like the governor flags.
    if ((args[0] === 'verbose' || args[0] === 'notify') && args.length === 1) {
      const isVerbose = args[0] === 'verbose';
      const cur = isVerbose ? !!context.options.verbose : !!context.options.notificationBell;
      const cmd = isVerbose ? '/config set verbose' : '/config set notificationBell';
      return {
        type: 'menu',
        title: `${isVerbose ? 'Verbose logging' : 'Notification bell'} (currently ${cur ? 'ON' : 'OFF'})`,
        options: [
          { label: '[ ON ]', value: `${cmd} true`, desc: isVerbose ? 'Show detailed internal logs' : 'Ring the terminal bell when a turn finishes' },
          { label: '[ OFF ]', value: `${cmd} false`, desc: isVerbose ? 'Quieter output' : 'No bell' },
        ],
        initialIndex: cur ? 0 : 1,
        onSelect: (opt: any) => context.executeCommand(opt.value),
      };
    }

    if (args[0] === 'theme' && args.length === 1) {
      return {
        type: 'menu',
        title: 'Select theme',
        options: [
          { label: 'Auto (match terminal)', value: '/config set theme auto' },
          { label: 'Dark', value: '/config set theme dark' },
          { label: 'Light', value: '/config set theme light' },
          { label: 'Dark ANSI', value: '/config set theme dark-ansi' },
          { label: 'Light ANSI', value: '/config set theme light-ansi' },
        ],
        onSelect: (opt: any) => context.executeCommand(opt.value),
      };
    }

    if (args[0] === 'set' && args.length >= 3) {
      const key = args[1];
      const val = args.slice(2).join(' ');
      const updates: any = {};
      
      if (key === 'theme' && ['dark', 'light', 'auto', 'dark-ansi', 'light-ansi', 'dark-daltonized', 'light-daltonized', 'ansi', 'daltonized'].includes(val)) {
        updates.theme = val;
      } else if (key === 'verbose') {
        updates.verbose = val === 'true';
      } else if (key === 'skipPerms') {
        context.options.governor.mode = val === 'true' ? 'bypass' : 'interactive';
      } else if (key === 'model') {
        updates.model = val;
        try { context.options.llmAdapter?.applyConfig({ model: val }); } catch { /* adapter optional */ }
      } else if (key === 'liteModel') {
        updates.liteModel = val;
        try { context.options.llmAdapter?.applyConfig({ liteModel: val }); } catch { /* adapter optional */ }
      } else if (key === 'notificationBell') {
        updates.notificationBell = val === 'true' || val === 'on';
      } else if (key === 'maxToolIterations') {
        updates.maxToolIterations = parseInt(val) || 15;
      } else if (key === 'showMapPanel' || key === 'showTokenMeter' || key === 'onboardingComplete') {
        updates[key] = val === 'true' || val === 'on';
      } else if (key === 'contextMode') {
        if (val !== 'smart' && val !== 'full') {
          return { type: 'message', level: 'error', content: `contextMode must be 'smart' or 'full'.` };
        }
        updates.contextMode = val;
      } else if (key === 'parallelTools' || key === 'parallelToolCalls') {
        const on = val === 'true' || val === 'on';
        updates.parallelToolCalls = on;
        try { context.options.llmAdapter?.applyConfig({ parallelToolCalls: on }); } catch { /* adapter optional */ }
      } else if (key === 'contextWindowTokens') {
        const n = parseInt(val, 10);
        if (isNaN(n) || n < 0) {
          return { type: 'message', level: 'error', content: `contextWindowTokens must be a non-negative integer (0 = use the 128k default).` };
        }
        updates.contextWindowTokens = n;
      } else if (key === 'reasoningEffort') {
        const v = (val || '').toLowerCase();
        if (!['off', 'low', 'medium', 'high'].includes(v)) {
          return { type: 'message', level: 'error', content: `reasoningEffort must be off | low | medium | high.` };
        }
        updates.reasoningEffort = v === 'off' ? '' : v;
        // Apply live so the very next turn is faster/slower without a restart.
        try { context.options.llmAdapter?.applyConfig({ reasoningEffort: updates.reasoningEffort }); } catch { /* adapter optional */ }
      } else {
        return { type: 'message', level: 'error', content: `Unknown key: ${key}. Keys: theme, verbose, skipPerms, model, notificationBell, maxToolIterations, showMapPanel, showTokenMeter, contextMode, contextWindowTokens, reasoningEffort` };
      }

      // Mirror into the running session so the change takes effect immediately (and the
      // settings hub reflects it without a restart), then persist.
      Object.assign(context.options, updates);
      await context.saveConfig(updates);
      // Live-refresh the UI panels (the FullScreen listener re-reads these flags).
      engineEvents.emit('config_changed');
      return { type: 'message', level: 'success', content: `Config saved: ${key}=${val}` };
    }
    
    return { 
      type: 'message', 
      level: 'info', 
      content: `Config: agent=${context.options.agent} model=${context.options.model || 'default'} theme=${context.options.theme} verbose=${context.options.verbose} skipPerms=${context.options.governor.mode === 'bypass'}` 
    };
  }
});

globalCommandRegistry.register({
  name: '/agent-decisions',
  description: 'Toggle Auto Agent Decisions',
  category: 'Configuration',
  execute: async (args, context) => {
    const stateArg = args[0]?.toLowerCase();
    if (stateArg === 'on') {
      context.options.autoAgentDecisions = true;
      await context.saveConfig({ autoAgentDecisions: true });
      return { type: 'message', level: 'success', content: 'Auto Agent Decisions ENABLED.' };
    } else if (stateArg === 'off') {
      context.options.autoAgentDecisions = false;
      await context.saveConfig({ autoAgentDecisions: false });
      return { type: 'message', level: 'success', content: 'Auto Agent Decisions DISABLED.' };
    } else {
      return {
        type: 'menu',
        title: `Auto Agent Decisions (Currently: ${context.options.autoAgentDecisions ? 'ON' : 'OFF'})`,
        options: [
          { label: '[ ON ]', value: '/agent-decisions on', desc: 'Let the LLM auto-resolve ambiguities' },
          { label: '[ OFF ]', value: '/agent-decisions off', desc: 'Require human input' }
        ],
        initialIndex: context.options.autoAgentDecisions ? 0 : 1,
        onSelect: (opt: any) => context.executeCommand(opt.value),
      };
    }
  }
});

globalCommandRegistry.register({
  name: '/context-mode',
  aliases: ['/context-sending'],
  description: 'Choose how much tool context is sent each turn (smart vs full)',
  category: 'Configuration',
  execute: async (args, context) => {
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'smart' || sub === 'full') {
      await context.saveConfig({ contextMode: sub });
      (context.options as any).contextMode = sub;
      engineEvents.emit('config_changed');
      return {
        type: 'message',
        level: 'success',
        content: sub === 'full'
          ? 'Context sending: FULL — every tool description is sent to the model each turn.'
          : 'Context sending: SMART — only the core tools are sent; rare/heavy and MCP tools load on demand via ToolSearchTool.',
      };
    }
    let cur = 'smart';
    try { cur = getConfig().contextMode || 'smart'; } catch { /* default */ }
    return {
      type: 'menu',
      title: `Context sending (currently ${cur.toUpperCase()})`,
      options: [
        { label: 'Smart (recommended)', value: '/context-mode smart', desc: 'Send only core tools; defer the rest + all MCP tools, loaded on demand. Smaller, faster context.' },
        { label: 'Full', value: '/context-mode full', desc: 'Send every tool description every turn. The model always sees the whole toolbox; heavier context.' },
      ],
      onSelect: (opt: any) => context.executeCommand(opt.value),
    };
  }
});

globalCommandRegistry.register({
  name: '/reasoning',
  aliases: ['/effort', '/think'],
  description: 'Set the thinking depth of reasoning models (off/low/medium/high) — lower = faster replies',
  category: 'Configuration',
  execute: async (args, context) => {
    const sub = (args[0] || '').toLowerCase();
    if (['off', 'low', 'medium', 'high'].includes(sub)) {
      return context.executeCommand(`/config set reasoningEffort ${sub}`) as any;
    }
    let cur = 'off';
    try { cur = getConfig().reasoningEffort || 'off'; } catch { /* default */ }
    return {
      type: 'menu',
      title: `Reasoning effort (currently ${cur.toUpperCase()}) — lower is faster, esp. after tool calls`,
      options: [
        { label: 'Low (fastest)', value: '/reasoning low', desc: 'Minimal hidden thinking — snappiest replies. Best for chat + simple tasks.' },
        { label: 'Medium', value: '/reasoning medium', desc: 'Balanced thinking vs speed.' },
        { label: 'High', value: '/reasoning high', desc: 'Deepest reasoning — slowest. For hard problems.' },
        { label: 'Off (model default)', value: '/reasoning off', desc: 'Send no cap — the model thinks as much as it wants (can be very slow after tool calls).' },
      ],
      onSelect: (opt: any) => context.executeCommand(opt.value),
    };
  }
});

globalCommandRegistry.register({
  name: '/context-window',
  aliases: ['/ctxwindow', '/window'],
  description: "Set the active model's context window in tokens (drives when compaction fires)",
  category: 'Configuration',
  execute: async (args, context) => {
    if (args[0]) {
      return context.executeCommand(`/config set contextWindowTokens ${args[0]}`) as any;
    }
    let cur = 0;
    try { cur = getConfig().contextWindowTokens || 0; } catch { /* default */ }
    const curLabel = cur > 0 ? `${cur.toLocaleString()} tok` : '128,000 tok (default)';
    return {
      type: 'menu',
      title: `Context window — currently ${curLabel}. Pick YOUR model's real window:`,
      options: [
        { label: '32k', value: '/context-window 32768', desc: 'Small-context models (older/local).' },
        { label: '128k (safe default)', value: '/context-window 0', desc: 'Most modern models. 0 = use the built-in 128k default.' },
        { label: '200k', value: '/context-window 200000', desc: 'Claude-class / large-context models.' },
        { label: '1M', value: '/context-window 1000000', desc: 'Very large context (some MiniMax/Gemini tiers).' },
      ],
      onSelect: (opt: any) => context.executeCommand(opt.value),
    };
  }
});
