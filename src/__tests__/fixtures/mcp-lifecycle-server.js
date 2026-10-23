const fs = require('node:fs');
const { once } = require('node:events');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const [mode, file] = process.argv.slice(2);
if (mode === 'hang-start') {
  fs.writeFileSync(file, String(process.pid));
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
  setInterval(() => {}, 1000);
} else {
  const server = new Server({ name: 'lifecycle', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: 'mutate', inputSchema: { type: 'object' } },
    { name: 'hang', inputSchema: { type: 'object' } },
    { name: 'task', inputSchema: { type: 'object' } },
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    if (request.params.name === 'mutate') {
      fs.appendFileSync(file, 'effect\n');
      process.exit(0); // the mutation happened; its result never reached the client
    }
    if (request.params.name === 'hang') return new Promise(() => {});
    return { task: { taskId: 'job', status: 'working' } };
  });
  (async () => {
    if (mode === 'noisy-start') {
      const block = Buffer.alloc(8192, 'x');
      for (let i = 0; i < 256; i++) {
        if (!process.stderr.write(block)) await once(process.stderr, 'drain');
      }
      process.stderr.write('\nstartup diagnostics drained\n');
    }
    await server.connect(new StdioServerTransport());
  })().catch(error => { process.stderr.write(error.message); process.exit(1); });
}
