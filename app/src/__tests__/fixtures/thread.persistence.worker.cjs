// Actual process-exit fixture; only the engine port is replaced by a synthetic disk effect.
const fs = require('node:fs');
const path = require('node:path');
const { ThreadManager } = require('../../main/thread.manager.ts');
const { ThreadStorage } = require('../../main/thread.storage.ts');
const [root, mode] = process.argv.slice(2);
const storage = new ThreadStorage(path.join(root, 'threads'));
const manager = new ThreadManager({
  engine: () => ({ openProject() {}, dispose() {}, sendFromRenderer(msg) {
    if (msg.t === 'input') fs.appendFileSync(path.join(root, 'effects.log'), 'effect\n');
  } }),
  save: v => storage.save(v), saveNow: v => storage.saveNow(v),
  changed() {}, selected() {}, message() {}, approval() {},
}, storage.load());
if (mode === 'fail') {
  const id = manager.create('/fixture'); manager.start(id);
  manager.receive(id, { t: 'ready', protocol: 3 });
  storage.saveNow(manager.get(id));
  const actual = fs.writeFileSync;
  fs.writeFileSync = (...args) => {
    if (typeof args[1] === 'string' && args[1].includes('"state":"sent"')) throw new Error('ENOSPC injected before dispatch');
    return actual(...args);
  };
  manager.submit(id, 'execute exactly once');
} else {
  const id = manager.list()[0].id;
  manager.start(id); manager.receive(id, { t: 'ready', protocol: 3 });
}
// Do not run the 500ms snapshot retry or the normal app quit path.
process.exit(0);
