import * as path from 'path';
import { mineTraces } from './trace.miner';

// Explicit offline entry point. Bound must be supplied from a corpus census or memory budget.
const [root, bound] = process.argv.slice(2);
if (!root || !bound) {
  console.error('Usage: bun src/mind/trace.mine.cli.ts <project-root> <max-spans-per-trace>');
  process.exitCode = 1;
} else {
  mineTraces(path.resolve(root), { asOfMs: Date.now(), maxTraceSpans: Number(bound) })
    .then(report => console.log(JSON.stringify(report, null, 2)))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
