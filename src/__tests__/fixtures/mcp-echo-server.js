#!/usr/bin/env node
// Minimal stdio MCP server fixture for the A3 client test. Exposes one tool, `echo`, that
// returns "echo: <text>". Uses the SDK's low-level Server API (stable across versions).
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const server = new Server({ name: 'echo-server', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'echo',
    description: 'Echo back the provided text',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  }],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === 'echo') {
    if (args && args.text === '__error__') return { content: [{ type: 'text', text: 'fixture refused operation' }], isError: true };
    if (args && args.text === '__hang__') return new Promise(() => {});
    return { content: [{ type: 'text', text: 'echo: ' + (args && args.text != null ? args.text : '') }] };
  }
  return { content: [{ type: 'text', text: 'unknown tool: ' + name }], isError: true };
});

server.connect(new StdioServerTransport()).catch((e) => {
  process.stderr.write('fixture server failed: ' + e.message + '\n');
  process.exit(1);
});
