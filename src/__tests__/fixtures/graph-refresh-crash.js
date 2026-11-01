// Owned fixture: stop after graph COMMIT, immediately before publishing its source hashes.
const { SqliteGraphStore } = require('../../graph/sqlite.graph.store');
const { StaticAnalyzer } = require('../../graph/static.analyzer');
const { CodebaseIndexer } = require('../../graph/indexer');
(async () => {
  const [root, dbPath] = process.argv.slice(2);
  const store = new SqliteGraphStore(dbPath);
  await store.loadFromDisk();
  store.recordFileHashes = () => {
    process.send({ at: 'before-hash-publication' }, () => process.kill(process.pid, 'SIGSTOP'));
    return 0;
  };
  await new CodebaseIndexer(root, store, new StaticAnalyzer(root, store), {}).refreshStale();
})().catch(error => { process.stderr.write(String(error)); process.exit(1); });
