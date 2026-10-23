import { globalCommandRegistry } from './registry';
import { globalMcpManager } from '../../mcp/manager';
import { globalSkillService } from '../../skills/skill.service';
import { getCustomRules } from '../agentRouter';
import { globalWatcherManager } from '../watchers';

// Plugin Hub (`/plugins`) — one browsable view of BiMax's whole integration ecosystem: MCP servers,
// Agent Skills, routing rules, background watchers, and the command surface. It's the "crazy
// integration" surfacing from docs/TUI_GRAND_UPGRADE.md: power that used to be invisible (scattered
// across /mcp, /skills, /routes, /watch) becomes one categorized overview. Each row Enters into the
// relevant subsystem command, so the hub composes the existing tools rather than duplicating them.
// Read-only + registry-derived → also appears automatically in the Ctrl+G palette.
globalCommandRegistry.register({
  name: '/plugins',
  aliases: ['/hub', '/integrations'],
  category: 'Configuration',
  description: 'Integration hub — MCP servers, skills, routes & watchers in one view',
  execute: async (_args, context) => {
    const options: { label: string; value: string; desc: string; category: string }[] = [];

    // --- MCP servers (connected first, then configured-but-not-connected) ---
    const connected = globalMcpManager.list();
    const configured = globalMcpManager.configuredNames();
    if (connected.length === 0 && configured.length === 0) {
      options.push({ label: '(none)', value: '/mcp', desc: 'Enter to add an MCP server', category: 'MCP Servers' });
    } else {
      for (const c of connected) {
        options.push({ label: c.name, value: '/mcp', desc: `${c.toolNames.length} tool(s) · connected`, category: 'MCP Servers' });
      }
      for (const n of configured) {
        if (connected.some(c => c.name === n)) continue;
        options.push({ label: n, value: '/mcp', desc: globalMcpManager.isDisabled(n) ? 'disabled' : 'not connected', category: 'MCP Servers' });
      }
    }

    // --- Agent Skills ---
    try { globalSkillService.load(context.cwd); } catch { /* best-effort rescan */ }
    const skills = globalSkillService.list();
    if (skills.length === 0) {
      options.push({ label: '(none)', value: '/skills', desc: 'Enter to create a skill', category: 'Agent Skills' });
    } else {
      for (const s of skills) options.push({ label: s.name, value: '/skills', desc: s.source, category: 'Agent Skills' });
    }

    // --- Routing rules ---
    const rules = getCustomRules();
    if (rules.length === 0) {
      options.push({ label: '(none)', value: '/routes', desc: 'Enter to add a routing rule', category: 'Routing Rules' });
    } else {
      for (const [pattern, agent] of rules) options.push({ label: pattern, value: '/routes', desc: `→ ${agent}`, category: 'Routing Rules' });
    }

    // --- Background watchers ---
    const watchers = globalWatcherManager.list();
    if (watchers.length === 0) {
      options.push({ label: '(none)', value: '/watch', desc: 'Enter to add a file/cron watcher', category: 'Watchers' });
    } else {
      for (const w of watchers) {
        options.push({
          label: `${w.kind}: ${w.spec}`,
          value: '/watch',
          desc: `→ ${w.action} · ${w.fires}/${w.maxFires}${w.enabled ? '' : ' (off)'}`,
          category: 'Watchers',
        });
      }
    }

    // --- Command surface (registry-derived) ---
    options.push({
      label: `${globalCommandRegistry.getAllCommands().length} commands`,
      value: '/help',
      desc: 'Press Ctrl+G for the fuzzy command palette',
      category: 'Commands',
    });

    return {
      type: 'menu',
      title: 'Plugin Hub — your integration ecosystem (type to search, Enter opens a subsystem)',
      options,
      onSelect: (opt: any) => context.executeCommand(opt.value),
    };
  },
});
