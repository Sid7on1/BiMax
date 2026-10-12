// Local operation-count fixture. Run from any directory with Node; no HTTP/model calls.
const ts = require('typescript');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const root = path.resolve(__dirname, '../../../..');
const before = fs.readFileSync(path.join(__dirname, 'hedged.request.before.ts'), 'utf8');
const after = fs.readFileSync(path.join(root, 'src/core/hedged.request.ts'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function probe(source) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText, {exports, setTimeout, clearTimeout, AbortController, Date, Promise, Error});
  let keyReady, primaryReady, selectionStarted;
  const key = new Promise(resolve => { keyReady = resolve; });
  const primary = new Promise(resolve => { primaryReady = resolve; });
  const selecting = new Promise(resolve => { selectionStarted = resolve; });
  const calls = [];
  let available = false;
  const run = exports.hedgedRequest({first:'A',budgetMs:1000,hedgeAfterMs:1,
    nextKey:() => { selectionStarted(); return key; },
    start:name => { calls.push(name); return {promise:name === 'A' ? primary : Promise.resolve('backup'),abort(){}}; },
  }).then(value => { available = true; return value; });
  await selecting;
  primaryReady('primary');
  await tick();
  const responseAvailableWhileLookupPending = available;
  keyReady('B');
  const result = await run;
  await tick();
  return {source_sha256:crypto.createHash('sha256').update(source).digest('hex'), responseAvailableWhileLookupPending, requests:calls, winner:result.key};
}
(async () => {
  const results = {fixture:'primary resolves while backup-key lookup remains pending; lookup then yields B', before:await probe(before), after:await probe(after)};
  if (results.before.requests.length !== 2 || results.before.responseAvailableWhileLookupPending || results.after.requests.length !== 1 || !results.after.responseAvailableWhileLookupPending) throw Error('unexpected request-count end state');
  process.stdout.write(JSON.stringify(results,null,2) + '\n');
})().catch(error => { console.error(error); process.exitCode = 1; });
