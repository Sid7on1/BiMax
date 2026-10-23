import { HOST_CAPABILITIES_ENV, loadHostCapabilityServers } from '../mcp/config';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('embedding-host capability contract', () => {
  it('connects host capabilities before the engine can report protocol readiness', () => {
    const container = fs.readFileSync(path.join(__dirname, '..', 'core', 'container.ts'), 'utf8');
    const readyBoundary = container.indexOf("reportBootPhase('loading_tools', 'background services scheduled')");
    const hostConnect = container.indexOf('await globalMcpManager.connectHostCapabilities');
    expect(hostConnect).toBeGreaterThan(0);
    expect(hostConnect).toBeLessThan(readyBoundary);
  });
  test('accepts only a bounded local stdio provider and forces the safe lifecycle policy', () => {
    const servers = loadHostCapabilityServers(JSON.stringify({
      servers: [{ name: 'host-tools', command: '/opt/bimax/provider', args: ['--stdio'], env: { MODE: 'safe' } }],
    }));
    expect(servers).toEqual([expect.objectContaining({
      name: 'host-tools', command: '/opt/bimax/provider', args: ['--stdio'], env: { MODE: 'safe' },
      type: 'stdio', eager: true, forceScrubEnv: true,
    })]);
  });

  test('fails closed for remote, relative, duplicate, malformed, or oversized declarations', () => {
    const raw = JSON.stringify({ servers: [
      { name: 'remote', url: 'https://example.test/mcp' },
      { name: 'relative', command: './provider' },
      { name: 'valid', command: '/opt/one' },
      { name: 'valid', command: '/opt/two' },
      { name: 'bad-env', command: '/opt/three', env: { ok: 1 } },
      ...Array.from({ length: 12 }, (_, i) => ({ name: `extra-${i}`, command: `/opt/${i}` })),
    ] });
    const servers = loadHostCapabilityServers(raw);
    expect(servers.map(server => server.name)).toEqual(['valid', 'bad-env', 'extra-0', 'extra-1', 'extra-2']);
    expect(servers.find(server => server.name === 'bad-env')?.env).toEqual({});
    expect(servers).toHaveLength(5);
  });

  test('returns no providers for invalid JSON and uses one generic environment key', () => {
    expect(loadHostCapabilityServers('{broken')).toEqual([]);
    expect(HOST_CAPABILITIES_ENV).toBe('BIMAX_HOST_CAPABILITIES_JSON');
  });
});
