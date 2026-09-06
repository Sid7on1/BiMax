import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadMcpServers } from '../mcp/config';
import {
  approvalHandledByAppOwnedProvider,
  listAllMcpTools,
  mcpToolCallRequest,
  registerMcpTools,
} from '../mcp/client';
import { ToolRegistry } from '../tools/tool.registry';
import { IGovernor } from '../core/interfaces';

const governor = { approveTaskExecution: jest.fn().mockResolvedValue(undefined) } as unknown as IGovernor;
const FIXTURE = path.join(__dirname, 'fixtures', 'mcp-echo-server.js');

describe('loadMcpServers (A3, config)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgw-mcp-')); fs.mkdirSync(path.join(dir, '.bimax')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads the { servers: [...] } shape', () => {
    fs.writeFileSync(path.join(dir, '.bimax', 'mcp.json'), JSON.stringify({ servers: [{ name: 'echo', command: 'node', args: [FIXTURE] }] }));
    expect(loadMcpServers(dir)).toEqual([{ name: 'echo', command: 'node', args: [FIXTURE] }]);
  });

  it('reads the Claude-style { mcpServers: {...} } shape', () => {
    fs.writeFileSync(path.join(dir, '.bimax', 'mcp.json'), JSON.stringify({ mcpServers: { echo: { command: 'node', args: [FIXTURE] } } }));
    expect(loadMcpServers(dir)).toEqual([{ name: 'echo', command: 'node', args: [FIXTURE], env: undefined }]);
  });

  it('absent config returns []', () => {
    expect(loadMcpServers(dir)).toEqual([]);
  });
});

describe('registerMcpTools (A3, integration)', () => {
  it('connects to a stdio MCP server, registers its tool, and calls it', async () => {
    const registry = new ToolRegistry();
    const connected = await registerMcpTools(
      [{ name: 'echo', command: 'node', args: [FIXTURE] }],
      registry,
      governor
    );

    expect(connected).toHaveLength(1);
    expect(connected[0].toolNames).toContain('mcp__echo__echo');

    const tool = registry.getTool('mcp__echo__echo');
    expect(tool).toBeDefined();

    const result = await tool!.execute({ text: 'hello' }, {});
    expect(result).toBe('echo: hello');

    // Clean up the spawned subprocess.
    await connected[0].client.close();
  }, 20000);

  it('skips a server that fails to start without throwing', async () => {
    const registry = new ToolRegistry();
    const connected = await registerMcpTools(
      [{ name: 'broken', command: 'node', args: ['/no/such/file.js'] }],
      registry,
      governor
    );
    expect(connected).toHaveLength(0);
  }, 20000);

  it('bounds a hung MCP tool call instead of hanging the agent forever', async () => {
    const previous = process.env.BIMAX_MCP_CALL_TIMEOUT_MS;
    process.env.BIMAX_MCP_CALL_TIMEOUT_MS = '1000';
    const registry = new ToolRegistry();
    const connected = await registerMcpTools(
      [{ name: 'echo-timeout', command: 'node', args: [FIXTURE] }],
      registry,
      governor,
    );
    try {
      const tool = registry.getTool('mcp__echo-timeout__echo');
      await expect(tool!.execute({ text: '__hang__' }, {})).rejects.toThrow(
        "MCP tool 'echo-timeout/echo' timed out after 1000ms",
      );
    } finally {
      if (previous === undefined) delete process.env.BIMAX_MCP_CALL_TIMEOUT_MS;
      else process.env.BIMAX_MCP_CALL_TIMEOUT_MS = previous;
      await connected[0]?.client.close();
    }
  }, 20000);
});

describe('host-provider catalog contract', () => {
  test('only the app-owned Mac entrypoint skips the duplicate generic governor prompt', () => {
    expect(approvalHandledByAppOwnedProvider('bimax-mac', 'mac_control')).toBe(true);
    expect(approvalHandledByAppOwnedProvider('bimax-mac', 'other_tool')).toBe(false);
    expect(approvalHandledByAppOwnedProvider('third-party', 'mac_control')).toBe(false);
  });

  test('a tool call request carries no Computer Use plan envelope', () => {
    // The signed `_meta.bimaxTrustedPlan` envelope went with the code-only reset — see
    // archive/computer-use/. A request is now name + arguments and nothing else.
    expect(mcpToolCallRequest('bimax-mac', 'mac_control', { action: 'open' }))
      .toEqual({ name: 'mac_control', arguments: { action: 'open' } });
  });

  test('collects every page and returns a deterministic tool order', async () => {
    const client = { listTools: jest.fn(async (request?: { cursor?: string }) => {
      if (!request?.cursor) return { tools: [{ name: 'zeta' }, { name: 'alpha' }], nextCursor: 'two' };
      return { tools: [{ name: 'middle' }] };
    }) };
    await expect(listAllMcpTools(client)).resolves.toEqual([
      { name: 'alpha' }, { name: 'middle' }, { name: 'zeta' },
    ]);
    expect(client.listTools).toHaveBeenNthCalledWith(1, undefined);
    expect(client.listTools).toHaveBeenNthCalledWith(2, { cursor: 'two' });
  });

  test('fails closed when a provider exceeds page or tool bounds', async () => {
    const endless = { listTools: jest.fn(async () => ({ tools: [], nextCursor: 'again' })) };
    await expect(listAllMcpTools(endless, 2)).rejects.toThrow(/exceeds 2 pages/);
    const oversized = { listTools: jest.fn(async () => ({ tools: [{ name: 'a' }, { name: 'b' }] })) };
    await expect(listAllMcpTools(oversized, 2, 1)).rejects.toThrow(/exceeds 1 entries/);
  });
});

/**
 * Measured 2026-08-14 in a live Bimax CU run: every `mac_control` result reached the model TWICE.
 *
 * MCP lets a server answer in both `content[].text` and `structuredContent`, and the spec encourages
 * mirroring the structured payload into text for clients that cannot read the structured field. Our
 * own provider does that, so an observe carrying 40+ elements, its guidance prose and its screenshot
 * metadata was billed to the context window twice — in the very turn a small model has to plan the
 * next action from.
 */
describe('contentToString — a mirrored payload is not two payloads', () => {
  const { contentToString } = require('../mcp/client');
  const payload = { ok: true, action: 'open', elements: [{ element_index: 1, label: 'ConversationAvatar' }] };

  it('emits one copy when the text block is the same payload in different formatting', () => {
    const out = contentToString({
      content: [{ type: 'text', text: JSON.stringify(payload) }], // server's own compact formatting
      structuredContent: payload,
    });

    expect(JSON.parse(out)).toEqual(payload);
    expect(out.indexOf('ConversationAvatar')).toBe(out.lastIndexOf('ConversationAvatar'));
  });

  it('keeps both when the text is a real summary rather than a mirror', () => {
    const out = contentToString({
      content: [{ type: 'text', text: 'opened Messages as pid 91942' }],
      structuredContent: payload,
    });

    expect(out).toContain('opened Messages as pid 91942');
    expect(out).toContain('ConversationAvatar');
  });

  it('keeps both when the JSON differs, even slightly', () => {
    const out = contentToString({
      content: [{ type: 'text', text: JSON.stringify({ ...payload, ok: false }) }],
      structuredContent: payload,
    });

    expect(out).toContain('"ok": true');
    expect(out).toContain('"ok":false');
  });

  it('still returns the structured payload when there is no text block at all', () => {
    expect(JSON.parse(contentToString({ content: [], structuredContent: payload }))).toEqual(payload);
  });

  it('leaves a plain text result untouched when there is no structured payload', () => {
    expect(contentToString({ content: [{ type: 'text', text: 'done' }] })).toBe('done');
  });
});
