import * as os from 'os';
import { globalCommandRegistry } from './registry';
import { globalMcpManager } from '../../mcp/manager';
import { missingPathArgs, loadMcpServers } from '../../mcp/config';

function healthReport(statuses: Awaited<ReturnType<typeof globalMcpManager.diagnose>>): string {
  if (!statuses.length) return 'No MCP servers configured.';
  return statuses.map(s => {
    const glyph = s.state === 'connected' ? '✓' : s.state === 'disabled' ? '○' : s.state === 'connecting' ? '…' : '✗';
    const detail = s.state === 'connected'
      ? `${s.toolCount} tool(s)`
      : s.missingPaths?.length
        ? `missing path(s): ${s.missingPaths.join(', ')}`
        : s.error || s.state;
    const usage = s.calls > 0 ? ` · ${s.calls} call(s), avg ${s.avgMs}ms${s.callErrors ? `, ${s.callErrors} error(s)` : ''}` : '';
    return `${glyph} ${s.name} · ${s.transport} · ${detail}${usage}`;
  }).join('\n');
}

// Interactive MCP server management. The agent has its own (Governor-gated) McpManageTool;
// this is the human-facing equivalent in the settings/command surface.
globalCommandRegistry.register({
  name: '/mcp',
  description: 'Manage, diagnose, and reconnect MCP integrations',
  category: 'Configuration',
  execute: async (args, context) => {
    const registry = context.options?.toolRegistry;
    const governor = context.options?.governor;
    const sub = (args[0] || '').toLowerCase();

    if (!sub) {
      const configured = globalMcpManager.configuredNames();
      const connected = globalMcpManager.list();
      const options = configured.map(n => {
        const conn = globalMcpManager.get(n);
        const disabled = globalMcpManager.isDisabled(n);
        const desc = disabled ? 'disabled · won\'t start' : conn ? `connected · ${conn.toolNames.length} tools` : 'configured · not connected';
        return { label: `${disabled ? '○' : conn ? '●' : '◌'} ${n}`, value: `/mcp server ${n}`, desc };
      });
      options.push({ label: '+ Add a server', value: '/mcp add', desc: 'Register & connect a new MCP server' } as any);
      options.push({ label: '♡ Integration doctor', value: '/mcp doctor', desc: 'Probe connectors and explain failures' } as any);
      if (configured.length) {
        options.push({ label: '🗑  Remove ALL servers', value: '/mcp remove all', desc: 'Disconnect & delete every server' } as any);
      }
      return {
        type: 'menu',
        title: connected.length || configured.length ? 'MCP servers — select one to manage' : 'No MCP servers yet',
        options,
        onSelect: (opt: any) => context.executeCommand(opt.value),
      };
    }

    // Per-server action menu: test / enable-disable / remove.
    if (sub === 'server') {
      const name = args[1];
      if (!name) return { type: 'message', level: 'error', content: 'Usage: /mcp server <name>' };
      const disabled = globalMcpManager.isDisabled(name);
      const conn = globalMcpManager.get(name);
      const options: any[] = [];
      if (conn) options.push({ label: 'Show tools', value: `/mcp test ${name}`, desc: `${conn.toolNames.length} tool(s)` });
      if (!disabled) options.push({ label: '↻  Reconnect', value: `/mcp reconnect ${name}`, desc: 'Refresh tools and connection safely' });
      options.push(
        disabled
          ? { label: '▶  Enable', value: `/mcp enable ${name}`, desc: 'Allow this server to start' }
          : { label: '⏸  Disable', value: `/mcp disable ${name}`, desc: "Keep it but don't start it" },
      );
      options.push({ label: '🗑  Remove', value: `/mcp remove ${name}`, desc: 'Disconnect & delete' });
      return {
        type: 'menu',
        title: `${name} — ${disabled ? 'disabled' : conn ? 'connected' : 'not connected'}`,
        options,
        onSelect: (opt: any) => context.executeCommand(opt.value),
      };
    }

    if (sub === 'enable' || sub === 'disable') {
      const name = args[1];
      if (!name) return { type: 'message', level: 'error', content: `Usage: /mcp ${sub} <name>` };
      const enabled = sub === 'enable';
      // MCP settings are global by default. Passing the project cwd here made a server visible in
      // the menu but impossible to enable/disable unless the project happened to own the config.
      const ok = await globalMcpManager.setEnabled(name, enabled, registry);
      if (!ok) return { type: 'message', level: 'info', content: `No server named '${name}' in config.` };
      if (enabled && registry && governor) {
        // Connect it right now so it's usable without a restart.
        const full = loadMcpServers(os.homedir()).find(s => s.name === name);
        if (full) {
          const conn = await globalMcpManager.connectSpec(full, registry, governor);
          return {
            type: 'message',
            level: conn ? 'success' : 'error',
            content: conn
              ? `Enabled & connected '${name}' (${conn.toolNames.length} tools).`
              : `Enabled '${name}', but it failed to start.${globalMcpManager.lastError ? ' Reason: ' + globalMcpManager.lastError : ''}`,
          };
        }
      }
      return { type: 'message', level: 'success', content: enabled ? `Enabled '${name}'.` : `Disabled '${name}' — it won't start until re-enabled.` };
    }

    if (sub === 'doctor') {
      const statuses = await globalMcpManager.diagnose();
      const broken = statuses.filter(s => s.state === 'error' || s.state === 'disconnected');
      return {
        type: 'message',
        level: broken.length ? 'error' : 'success',
        content: `MCP integration doctor\n${healthReport(statuses)}` +
          (broken.length ? '\n\nFix the reported cause, then run /mcp reconnect <name>.' : '\n\nAll active integrations answered their health probe.'),
      };
    }

    if (sub === 'reconnect') {
      const name = args[1];
      if (!name) return { type: 'message', level: 'error', content: 'Usage: /mcp reconnect <name>' };
      if (!registry || !governor) return { type: 'message', level: 'error', content: 'Tool registry unavailable in this context.' };
      const conn = await globalMcpManager.reconnect(name, registry, governor);
      return {
        type: 'message',
        level: conn ? 'success' : 'error',
        content: conn
          ? `Reconnected '${name}' — ${conn.toolNames.length} tool(s) are live.`
          : `Could not reconnect '${name}'. ${globalMcpManager.lastErrorFor(name) || globalMcpManager.lastError || 'Unknown error.'}`,
      };
    }

    if (sub === 'add') {
      const name = args[1];
      const target = args[2];
      if (!name || !target) {
        return {
          type: 'message',
          level: 'info',
          content:
            'Usage:\n' +
            '  /mcp add <name> <command> [args…]   (local)\n' +
            '  /mcp add <name> <https://…/mcp>      (remote URL)\n' +
            'Examples:\n' +
            '  /mcp add fs npx -y @modelcontextprotocol/server-filesystem .\n' +
            '  /mcp add magic https://link.mcpmarket.com/…/mcp',
        };
      }
      const isUrl = /^https?:\/\//i.test(target);
      const cmdArgs = args.slice(3);
      const spec = isUrl ? { name, url: target } : { name, command: target, args: cmdArgs };
      if (!registry || !governor) {
        return { type: 'message', level: 'error', content: 'Tool registry unavailable in this context.' };
      }
      if (!isUrl) {
        const missing = missingPathArgs(cmdArgs);
        if (missing.length) {
          return {
            type: 'message',
            level: 'error',
            content: `Did not add '${name}': these path arguments don't exist:\n${missing.map(m => '  - ' + m).join('\n')}\nReplace the placeholders with real folders, e.g. ${context.cwd}.`,
          };
        }
      }
      globalMcpManager.addToConfig(spec);
      const conn = await globalMcpManager.connectSpec(spec, registry, governor);
      if (!conn) {
        const reason = globalMcpManager.lastError ? ` Reason: ${globalMcpManager.lastError}.` : '';
        const hint = isUrl ? 'The URL may be unreachable or need auth headers.' : 'Check the command/package name and that any path arguments point at folders that actually exist.';
        return { type: 'message', level: 'error', content: `Saved '${name}' to .bimax/mcp.json but it failed to start.${reason} ${hint}` };
      }
      return { type: 'message', level: 'success', content: `Connected '${name}' — ${conn.toolNames.length} tool(s) registered (mcp__${name}__*).` };
    }

    if (sub === 'remove' || sub === 'rm') {
      const name = args[1];

      // Remove every server.
      if (name && (name.toLowerCase() === 'all' || name === '*')) {
        const configured = globalMcpManager.configuredNames();
        const live = globalMcpManager.list().map(c => c.name);
        const all = Array.from(new Set([...configured, ...live]));
        if (!all.length) return { type: 'message', level: 'info', content: 'No MCP servers to remove.' };
        for (const n of all) {
          await globalMcpManager.disconnect(n, registry);
          globalMcpManager.removeFromConfig(n);
        }
        return { type: 'message', level: 'success', content: `Removed all MCP servers (${all.length}): ${all.join(', ')}.` };
      }

      // No name → show a picker of configured servers.
      if (!name) {
        const configured = globalMcpManager.configuredNames();
        if (!configured.length) return { type: 'message', level: 'info', content: 'No MCP servers configured.' };
        const options = configured.map(n => ({ label: n, value: `/mcp remove ${n}`, desc: 'Disconnect & delete' }));
        options.push({ label: '🗑  Remove ALL', value: '/mcp remove all', desc: 'Delete every server' } as any);
        return {
          type: 'menu',
          title: 'Remove which MCP server?',
          options,
          onSelect: (opt: any) => context.executeCommand(opt.value),
        };
      }

      await globalMcpManager.disconnect(name, registry);
      const removed = globalMcpManager.removeFromConfig(name);
      return {
        type: 'message',
        level: removed ? 'success' : 'info',
        content: removed ? `Removed MCP server '${name}'.` : `No server named '${name}' in config.`,
      };
    }

    if (sub === 'test') {
      const name = args[1];
      const conn = name ? globalMcpManager.get(name) : undefined;
      if (!conn) return { type: 'message', level: 'info', content: `'${name}' is not connected. Try /mcp add ${name} … first.` };
      return { type: 'message', level: 'info', content: `${name} tools:\n${conn.toolNames.map(t => '- ' + t).join('\n') || '(none)'}` };
    }

    if (sub === 'remove-all') {
      const configured = globalMcpManager.configuredNames();
      const live = globalMcpManager.list().map(c => c.name);
      const all = Array.from(new Set([...configured, ...live]));
      if (!all.length) return { type: 'message', level: 'info', content: 'No MCP servers to remove.' };
      for (const n of all) {
        await globalMcpManager.disconnect(n, registry);
        globalMcpManager.removeFromConfig(n);
      }
      return { type: 'message', level: 'success', content: `Removed all MCP servers (${all.length}): ${all.join(', ')}.` };
    }

    return { type: 'message', level: 'error', content: 'Usage: /mcp [doctor|reconnect|add|remove|remove all|test] …' };
  },
});
