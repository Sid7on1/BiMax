#!/usr/bin/env node
// Stdio MCP server fixture exercising what the plain echo fixture cannot: a tool list that changes
// after the handshake (tools/list_changed), resources, and a server→client roots/list request.
// Low-level Server API, like mcp-echo-server.js, so it is stable across SDK versions.
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const server = new Server(
  { name: 'rich-server', version: '1.0.0' },
  { capabilities: { tools: { listChanged: true }, resources: {} } },
);

let unlocked = false;
const tool = (name, description) => ({ name, description, inputSchema: { type: 'object', properties: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: unlocked
    ? [tool('unlock', 'Unlock more tools'), tool('roots', 'Report the client roots'), tool('secret', 'Only after unlock')]
    : [tool('unlock', 'Unlock more tools'), tool('roots', 'Report the client roots'), tool('temporary', 'Removed by unlock')],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name } = req.params;
  if (name === 'unlock') {
    unlocked = true;
    await server.sendToolListChanged();
    return { content: [{ type: 'text', text: 'unlocked' }] };
  }
  if (name === 'roots') {
    const { roots } = await server.listRoots();
    return { content: [{ type: 'text', text: roots.map((r) => r.uri).join(',') }] };
  }
  if (name === 'secret') return { content: [{ type: 'text', text: 'the secret tool ran' }] };
  return { content: [{ type: 'text', text: 'unknown tool: ' + name }], isError: true };
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [{ uri: 'memo://readme', name: 'Readme', mimeType: 'text/plain', description: 'A note' }],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => ({
  contents: req.params.uri === 'memo://readme'
    ? [{ uri: 'memo://readme', mimeType: 'text/plain', text: 'Hello from a resource' }]
    : [],
}));

server.connect(new StdioServerTransport()).catch((e) => {
  process.stderr.write('fixture server failed: ' + e.message + '\n');
  process.exit(1);
});
