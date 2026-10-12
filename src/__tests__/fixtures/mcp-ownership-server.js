#!/usr/bin/env node
// Real SDK/process fixture: resource-only negotiation, remote cancellation, and hung discovery.
const fs = require('node:fs');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const [mode, marker] = process.argv.slice(2);
const server = new Server({ name: 'ownership-fixture', version: '1.0.0' }, {
  capabilities: mode === 'catalog-hang' ? { tools: {} } : { resources: {} },
});
if (mode === 'catalog-hang') {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    fs.writeFileSync(marker, String(process.pid));
    return new Promise(() => {});
  });
} else {
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: 'memo://one', name: 'owned memo', mimeType: 'text/plain' }],
  }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
    if (request.params.uri === 'memo://hang') {
      fs.writeFileSync(marker, 'started');
      extra.signal.addEventListener('abort', () => fs.writeFileSync(marker, 'cancelled'), { once: true });
      return new Promise(() => {});
    }
    return { contents: [{ uri: request.params.uri, text: 'resource-only content', mimeType: 'text/plain' }] };
  });
}
server.connect(new StdioServerTransport()).catch(error => { process.stderr.write(error.message); process.exit(1); });
