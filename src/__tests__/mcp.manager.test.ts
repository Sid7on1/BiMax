import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { McpManager } from '../mcp/manager';
import { loadMcpServers, normalizeArgs, missingPathArgs } from '../mcp/config';
import { ToolRegistry } from '../tools/tool.registry';
import { IGovernor } from '../core/interfaces';
import { engineEvents } from '../engine/events';

const governor = { approveTaskExecution: jest.fn().mockResolvedValue(undefined) } as unknown as IGovernor;
const FIXTURE = path.join(__dirname, 'fixtures', 'mcp-echo-server.js');

describe('McpManager config persistence', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgw-mcpmgr-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('missingPathArgs flags non-existent path args but ignores flags/packages and real paths', () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'bgw-real-'));
    try {
      const args = ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/allowed/folder/one', real];
      expect(missingPathArgs(args)).toEqual(['/path/to/allowed/folder/one']);
      // Flags and package names are never treated as paths.
      expect(missingPathArgs(['-y', '@scope/pkg'])).toEqual([]);
    } finally {
      fs.rmSync(real, { recursive: true, force: true });
    }
  });

  it('setEnabled toggles the disabled flag in config and isDisabled reflects it', async () => {
    const mgr = new McpManager();
    mgr.addToConfig({ name: 'seq', command: 'node', args: [FIXTURE] }, dir);
    expect(mgr.isDisabled('seq', dir)).toBe(false);

    expect(await mgr.setEnabled('seq', false, undefined, dir)).toBe(true);
    expect(mgr.isDisabled('seq', dir)).toBe(true);
    expect(loadMcpServers(dir)[0].disabled).toBe(true);

    expect(await mgr.setEnabled('seq', true, undefined, dir)).toBe(true);
    expect(mgr.isDisabled('seq', dir)).toBe(false);

    expect(await mgr.setEnabled('nope', false, undefined, dir)).toBe(false);
  });

  it('setEnabled emits mcp_changed so the UI/token-meter refreshes', async () => {
    const mgr = new McpManager();
    mgr.addToConfig({ name: 'seq', command: 'node', args: [FIXTURE] }, dir);

    const changed = jest.fn();
    engineEvents.on('mcp_changed', changed);
    try {
      await mgr.setEnabled('seq', false, undefined, dir);
      expect(changed).toHaveBeenCalledTimes(1);
      await mgr.setEnabled('seq', true, undefined, dir);
      expect(changed).toHaveBeenCalledTimes(2);
      // An unknown server makes no change and emits nothing.
      await mgr.setEnabled('nope', false, undefined, dir);
      expect(changed).toHaveBeenCalledTimes(2);
    } finally {
      engineEvents.off('mcp_changed', changed);
    }
  });

  it('addToConfig then removeFromConfig round-trips .bimax/mcp.json', () => {
    const mgr = new McpManager();
    mgr.addToConfig({ name: 'echo', command: 'node', args: [FIXTURE] }, dir);
    expect(loadMcpServers(dir)).toEqual([{ name: 'echo', command: 'node', args: [FIXTURE], env: undefined }]);
    expect(mgr.configuredNames(dir)).toContain('echo');

    expect(mgr.removeFromConfig('echo', dir)).toBe(true);
    expect(loadMcpServers(dir)).toEqual([]);
    expect(mgr.removeFromConfig('echo', dir)).toBe(false); // already gone
  });

  it('persists and loads a remote URL server (no command)', () => {
    const mgr = new McpManager();
    mgr.addToConfig({ name: 'magic', url: 'https://link.mcpmarket.com/x/mcp', headers: { Authorization: 'Bearer test' } }, dir);
    expect(loadMcpServers(dir)).toEqual([{
      name: 'magic',
      url: 'https://link.mcpmarket.com/x/mcp',
      headers: { Authorization: 'Bearer test' },
    }]);
    expect(mgr.configuredNames(dir)).toContain('magic');
  });

  it('loads Claude-style { mcpServers: { name: { url } } } remote shape', () => {
    fs.mkdirSync(path.join(dir, '.bimax'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.bimax', 'mcp.json'),
      JSON.stringify({ mcpServers: { magic: { url: 'https://example.com/mcp', type: 'sse' } } }),
    );
    const specs = loadMcpServers(dir);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ name: 'magic', url: 'https://example.com/mcp', type: 'sse' });
  });

  it('coerces a JSON-string args field back into an array (corrupt-config tolerance)', () => {
    fs.mkdirSync(path.join(dir, '.bimax'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.bimax', 'mcp.json'),
      JSON.stringify({ servers: [{ name: 'gh', command: 'npx', args: '["-y", "@modelcontextprotocol/server-github"]' }] }),
    );
    const specs = loadMcpServers(dir);
    expect(specs[0].args).toEqual(['-y', '@modelcontextprotocol/server-github']);
  });

  it('coerces a single-quoted (Python/JS-literal) args string into an array', () => {
    expect(normalizeArgs("['-y', '@modelcontextprotocol/server-sequential-thinking']"))
      .toEqual(['-y', '@modelcontextprotocol/server-sequential-thinking']);
    expect(normalizeArgs('-y some-package')).toEqual(['-y', 'some-package']);
    expect(normalizeArgs(['-y', 'pkg'])).toEqual(['-y', 'pkg']);
    expect(normalizeArgs(undefined)).toBeUndefined();
  });

  it('drops a spec that has neither command nor url', () => {
    fs.mkdirSync(path.join(dir, '.bimax'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.bimax', 'mcp.json'), JSON.stringify({ servers: [{ name: 'broken' }] }));
    expect(loadMcpServers(dir)).toEqual([]);
  });

  it('addToConfig stores a clean array even when given a JSON-string args (model mistake)', () => {
    const mgr = new McpManager();
    mgr.addToConfig({ name: 'seq', command: 'npx', args: '["-y", "@modelcontextprotocol/server-sequential-thinking"]' as any }, dir);
    expect(loadMcpServers(dir)[0].args).toEqual(['-y', '@modelcontextprotocol/server-sequential-thinking']);
  });

  it('addToConfig replaces an existing server of the same name (no duplicates)', () => {
    const mgr = new McpManager();
    mgr.addToConfig({ name: 'echo', command: 'node', args: ['a.js'] }, dir);
    mgr.addToConfig({ name: 'echo', command: 'node', args: ['b.js'] }, dir);
    const specs = loadMcpServers(dir);
    expect(specs).toHaveLength(1);
    expect(specs[0].args).toEqual(['b.js']);
  });
});

describe('McpManager runtime connection', () => {
  it('connects a stdio server, retains it, then disconnects + unregisters its tools', async () => {
    const mgr = new McpManager();
    const registry = new ToolRegistry();
    const conn = await mgr.connectSpec({ name: 'echo', command: 'node', args: [FIXTURE] }, registry, governor);

    expect(conn).not.toBeNull();
    expect(mgr.list().map(c => c.name)).toContain('echo');
    expect(registry.getTool('mcp__echo__echo')).toBeDefined();
    expect(mgr.toolNames()).toContain('mcp__echo__echo');

    await mgr.disconnect('echo', registry);
    expect(mgr.get('echo')).toBeUndefined();
    expect(registry.getTool('mcp__echo__echo')).toBeUndefined();
  }, 20000);

  it('actively diagnoses a live connector and reports its transport and tools', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgw-mcp-health-'));
    const mgr = new McpManager();
    const registry = new ToolRegistry();
    mgr.addToConfig({ name: 'echo', command: 'node', args: [FIXTURE] }, dir);
    try {
      await mgr.connectSpec({ name: 'echo', command: 'node', args: [FIXTURE] }, registry, governor);
      const [health] = await mgr.diagnose(dir);
      expect(health).toMatchObject({ name: 'echo', state: 'connected', transport: 'stdio', toolCount: 1 });
    } finally {
      await mgr.disconnect('echo', registry);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  it('keeps a working connection and its tools when a replacement fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgw-mcp-reconnect-'));
    const mgr = new McpManager();
    const registry = new ToolRegistry();
    mgr.addToConfig({ name: 'echo', command: 'node', args: [FIXTURE] }, dir);
    try {
      const original = await mgr.connectSpec({ name: 'echo', command: 'node', args: [FIXTURE] }, registry, governor);
      expect(original).not.toBeNull();

      mgr.addToConfig({ name: 'echo', command: 'node', args: ['/no/such/file.js'] }, dir);
      expect(await mgr.reconnect('echo', registry, governor, dir)).toBeNull();
      expect(mgr.get('echo')).toBe(original);
      expect(registry.getTool('mcp__echo__echo')).toBeDefined();
      expect(mgr.lastErrorFor('echo')).toContain('Connection closed');
      expect(mgr.health(dir)[0].state).toBe('error');
    } finally {
      await mgr.disconnect('echo', registry);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  it('self-heals a dead connection mid-call: reconnects and retries transparently', async () => {
    const mgr = new McpManager();
    const registry = new ToolRegistry();
    const conn = await mgr.connectSpec({ name: 'echo', command: 'node', args: [FIXTURE] }, registry, governor);
    expect(conn).not.toBeNull();
    // Simulate a crashed server: kill the transport underneath the live tools.
    await conn!.client.close();

    const tool = registry.getTool('mcp__echo__echo');
    const out = await tool!.execute({ text: 'revive' }, {});
    expect(out).toContain('echo: revive');
    expect(mgr.get('echo')).not.toBe(conn); // a fresh connection replaced the dead one
    await mgr.disconnect('echo', registry);
  }, 20000);

  it('watchdog probes in the background and auto-heals a dead connector', async () => {
    const mgr = new McpManager();
    const registry = new ToolRegistry();
    const conn = await mgr.connectSpec({ name: 'echo', command: 'node', args: [FIXTURE] }, registry, governor);
    await conn!.client.close();
    mgr.startWatchdog(registry, governor, 100);
    try {
      // Give the sweep a moment to notice the dead probe and reconnect.
      const deadline = Date.now() + 8000;
      while (mgr.get('echo') === conn && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 100));
      }
      const fresh = mgr.get('echo');
      expect(fresh).toBeDefined();
      expect(fresh).not.toBe(conn);
      const tool = registry.getTool('mcp__echo__echo');
      await expect(tool!.execute({ text: 'alive' }, {})).resolves.toContain('echo: alive');
    } finally {
      mgr.stopWatchdog();
      await mgr.disconnect('echo', registry);
    }
  }, 20000);

  it('surfaces per-tool call telemetry (count + latency) in health()', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgw-mcp-stats-'));
    const mgr = new McpManager();
    const registry = new ToolRegistry();
    mgr.addToConfig({ name: 'echo', command: 'node', args: [FIXTURE] }, dir);
    try {
      await mgr.connectSpec({ name: 'echo', command: 'node', args: [FIXTURE] }, registry, governor);
      await registry.getTool('mcp__echo__echo')!.execute({ text: 'measured' }, {});
      const echo = mgr.health(dir).find(s => s.name === 'echo')!;
      expect(echo.calls).toBeGreaterThanOrEqual(1);
      expect(echo.avgMs).toBeGreaterThanOrEqual(0);
      expect(echo.callErrors).toBe(0);
    } finally {
      await mgr.disconnect('echo', registry);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  it('closes the old client after a successful live reconnect', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgw-mcp-replace-'));
    const mgr = new McpManager();
    const registry = new ToolRegistry();
    mgr.addToConfig({ name: 'echo', command: 'node', args: [FIXTURE] }, dir);
    try {
      const original = await mgr.connectSpec({ name: 'echo', command: 'node', args: [FIXTURE] }, registry, governor);
      const close = jest.spyOn(original!.client, 'close');
      const replacement = await mgr.reconnect('echo', registry, governor, dir);
      expect(replacement).not.toBeNull();
      expect(replacement).not.toBe(original);
      expect(close).toHaveBeenCalledTimes(1);
      expect(registry.getTool('mcp__echo__echo')).toBeDefined();
    } finally {
      await mgr.disconnect('echo', registry);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
});
