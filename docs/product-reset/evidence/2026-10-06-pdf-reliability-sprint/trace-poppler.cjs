const util = require('util');
const fs = require('fs');
const path = require('path');
const output = path.resolve('docs/product-reset/evidence/2026-10-06-pdf-reliability-sprint/layout-process-trace.json');
const original = util.promisify;
const trace = [];
jest.spyOn(util, 'promisify').mockImplementation(fn => {
  const invoke = original(fn);
  return (...args) => {
    const promise = invoke(...args);
    if (!promise?.child) return promise;
    const started = Date.now(); const item = { command: args[0], pid: promise.child.pid, events: [] }; trace.push(item);
    promise.child.on('exit', (code, signal) => item.events.push({ event: 'exit', code, signal, ms: Date.now() - started }));
    promise.child.on('close', (code, signal) => item.events.push({ event: 'close', code, signal, ms: Date.now() - started }));
    promise.child.stdout?.on('data', chunk => item.events.push({ event: 'stdout', bytes: chunk.length, ms: Date.now() - started }));
    promise.child.stderr?.on('data', chunk => item.events.push({ event: 'stderr', bytes: chunk.length, ms: Date.now() - started }));
    promise.then(() => item.events.push({ event: 'settled', ms: Date.now() - started }), error => item.events.push({ event: 'rejected', code: error.code, ms: Date.now() - started }));
    return promise;
  };
});
afterEach(() => fs.writeFileSync(output, JSON.stringify(trace, null, 2) + '\n'));
