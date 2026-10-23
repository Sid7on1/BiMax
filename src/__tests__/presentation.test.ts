import { presentationParts } from '../protocol/presentation';
import { mcpPresentation } from '../mcp/presentation';
import { grantMcpUi, requestMcpUi, revokeMcpUi } from '../mcp/ui.grants';
test('preserves structured MCP data, raster bytes, resource metadata and tool UI without changing fallback text', () => {
  const result = {
    structuredContent: { rows: [{ n: 3 }] },
    content: [
      { type: 'image', mimeType: 'image/png', data: 'YWJj' },
      { type: 'resource_link', uri: 'https://example.com/report', name: 'Report', mimeType: 'text/plain' },
    ],
    _meta: { private: 'ui' },
  };
  const parts = mcpPresentation(
    'fixture',
    { name: 'tool', _meta: { ui: { resourceUri: 'ui://fixture' } } },
    { q: 'hello' },
    result,
  );
  expect(parts.map((p) => p.kind)).toEqual(['data', 'image', 'resource', 'mcp-app']);
  expect(parts[0]).toMatchObject({ value: result.structuredContent });
  expect(parts[3]).toMatchObject({ input: { q: 'hello' }, result: { _meta: { private: 'ui' } } });
});
test('refuses active image formats, malformed resources and oversized content', () => {
  expect(
    presentationParts([
      { kind: 'image', id: 'x', mimeType: 'image/svg+xml', data: 'YWJj' },
      { kind: 'image', id: 'bad', mimeType: 'image/png', data: '<html>' },
    ]),
  ).toEqual([]);
  expect(presentationParts([{ kind: 'data', id: 'huge', value: 'x'.repeat(3_000_000) }])).toEqual([]);
  expect(
    presentationParts([
      { kind: 'mcp-app', id: 'bad', server: 'x', tool: 'x', resourceUri: 'file:///private' },
    ]),
  ).toEqual([]);
});
test('UI capability is scoped to one live connection; retirement revokes it', async () => {
  const owner = {},
    call = jest.fn(async () => ({ content: [] }));
  const part = grantMcpUi(
    { kind: 'mcp-app', id: 'app', server: 'x', tool: 'tool', resourceUri: 'ui://x', input: {}, result: {} },
    { owner, alive: () => true, read: async () => ({ html: '<p>UI</p>' }), call },
  );
  expect(await requestMcpUi({ grant: part.id, operation: 'read' })).toEqual({ html: '<p>UI</p>' });
  await requestMcpUi({ grant: part.id, operation: 'call', name: 'tool', args: {} });
  expect(call).toHaveBeenCalledTimes(1);
  revokeMcpUi(owner);
  await expect(requestMcpUi({ grant: part.id, operation: 'call', name: 'tool', args: {} })).rejects.toThrow(
    'expired',
  );
  expect(call).toHaveBeenCalledTimes(1);
});

test('the real cost estimator emits one settings notice per unpriced route without task progress', () => {
  const { LlmAdapter } = require('../core/llm.adapter');
  const { engineEvents } = require('../engine/events');
  const previous = process.env.BIMAX_MODEL_PRICING_JSON;
  delete process.env.BIMAX_MODEL_PRICING_JSON;
  const notices = jest.fn(),
    progress = jest.fn();
  engineEvents.on('engine_notice', notices);
  engineEvents.on('status', progress);
  try {
    const adapter = new LlmAdapter({});
    expect(adapter.cost({ provider: 'fixture-unpriced' }, 'model', 1000, 1000)).toBe(0.004);
    adapter.cost({ provider: 'fixture-unpriced' }, 'model', 1, 1);
    expect(notices).toHaveBeenCalledTimes(1);
    expect(notices.mock.calls[0][0]).toMatchObject({
      category: 'pricing',
      id: 'pricing:fixture-unpriced:model',
    });
    expect(progress).not.toHaveBeenCalled();
  } finally {
    engineEvents.off('engine_notice', notices);
    engineEvents.off('status', progress);
    if (previous === undefined) delete process.env.BIMAX_MODEL_PRICING_JSON;
    else process.env.BIMAX_MODEL_PRICING_JSON = previous;
  }
});
