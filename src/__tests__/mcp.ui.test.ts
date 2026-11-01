import path from 'node:path';
import { registerMcpTools } from '../mcp/client';
import { ToolRegistry } from '../tools/tool.registry';
import { requestMcpUi } from '../mcp/ui.grants';
import type { IGovernor } from '../core/interfaces';
test('actual MCP UI retains bytes and calls only its declared tool through the Governor', async () => {
  const approve = jest.fn(async () => {}),
    registry = new ToolRegistry();
  const connections = await registerMcpTools(
    [{ name: 'ui', command: process.execPath, args: [path.join(__dirname, 'fixtures/mcp-ui-server.js')] }],
    registry,
    { approveTaskExecution: approve } as unknown as IGovernor,
  );
  try {
    let outcome: any;
    const text = await registry.getTool('mcp__ui__counter')!.execute(
      { value: 1 },
      {
        reportOutcome: (v: any) => {
          outcome = v;
        },
      },
    );
    expect(text).toContain('Count 1');
    const app = outcome.presentation.find((p: any) => p.kind === 'mcp-app');
    expect(app.id).not.toBe('app');
    const resource = await requestMcpUi({ grant: app.id, operation: 'read' });
    expect(resource).toMatchObject({
      html: '<button>Counter fixture</button>',
      input: { value: 1 },
      result: { structuredContent: { value: 1 } },
    });
    const before = approve.mock.calls.length;
    await expect(requestMcpUi({ grant: app.id, operation: 'call', name: 'other', args: {} })).rejects.toThrow(
      'not available',
    );
    expect(approve.mock.calls).toHaveLength(before);
    expect(
      await requestMcpUi({ grant: app.id, operation: 'call', name: 'counter', args: { value: 2 } }),
    ).toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining('Count 2') }],
      structuredContent: { value: 2 },
      isError: false,
    });
    expect(approve.mock.calls).toHaveLength(before + 1);
    await connections[0].client.close();
    await expect(requestMcpUi({ grant: app.id, operation: 'read' })).rejects.toThrow('expired');
  } finally {
    await connections[0]?.client.close();
  }
}, 20_000);
