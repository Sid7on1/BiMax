// Mutate only recovery hints, then require behavioural failures (compile errors never count). Restore exact bytes.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../../../..');
const file = path.join(root, 'app/src/main/computer/look.suggestions.ts');
const original = fs.readFileSync(file, 'utf8');
const mutants = [
  ['no hints', "  const fold =", "  if (Date.now() > 0) return '';\n  const fold ="],
  ['no action filter', "    if (action === 'type' && !e.editable || action === 'press' && !e.pressable || action === 'pick' && !e.pickable) return false;", ''],
  ['password labels included', "e.role === 'AXSecureTextField' || ", ''],
  ['no relevance ranking', 'b.score - a.score || a.index - b.index', 'a.index - b.index'],
  ['duplicates included', 'if (seen.has(key)) return false;', ''],
  ['unbounded names', 'e.label.slice(0, 300)', 'e.label'],
];
const results = [];
try {
  for (const [name, from, to] of mutants) {
    if (original.split(from).length !== 2) throw new Error(`Unmatched mutant: ${name}`);
    fs.writeFileSync(file, original.replace(from, to));
    const run = spawnSync('npx', ['jest', '--runInBand', '--coverage=false', '--runTestsByPath', 'app/src/__tests__/computer.press.test.ts', '-t', 'missing names'], { cwd: root, encoding: 'utf8' });
    fs.writeFileSync(file, original);
    const output = run.stdout + run.stderr;
    const failed = Number(/Tests:\s+(\d+) failed/.exec(output)?.[1] ?? 0);
    const caught = run.status !== 0 && failed > 0 && !output.includes('Test suite failed to run');
    results.push({ name, caught, failed, exit: run.status });
    console.log(JSON.stringify(results.at(-1)));
    if (!caught) console.log(output);
  }
} finally { fs.writeFileSync(file, original); }
if (fs.readFileSync(file, 'utf8') !== original) throw new Error('Source not restored');
console.log(JSON.stringify({ caught: results.filter(r => r.caught).length, total: results.length, restored: true }));
process.exit(results.every(r => r.caught) ? 0 : 1);
