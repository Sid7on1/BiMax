#!/usr/bin/env python3
"""Check performance/correctness source faults and restore exact working-tree bytes."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
ROOT = Path(__file__).resolve().parents[1]
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--output', type=Path, default=ROOT/'docs/product-reset/evidence/2026-10-13-performance/mutations')
OUT=p.parse_args().output; OUT.mkdir(parents=True,exist_ok=True)
JEST=['node','node_modules/jest/bin/jest.js','--runInBand','--coverage=false','src/__tests__/performance.sprint.test.ts']
FAULTS=[
 ('repeated-adjacency', 'src/graph/sqlite.graph.store.ts', 'this.removeNodes(toRemove);', 'for (const id of toRemove) this.removeNode(id);', 'SQLite file invalidation'),
 ('dangling-incoming', 'src/graph/graph.store.ts', '!removed.has(e.sourceId) && !removed.has(e.targetId)', '!removed.has(e.sourceId)', 'bulk graph removal'),
 ('missing-adjacency', 'src/graph/graph.store.ts', 'this.data.edges = this.data.edges.filter(e => !removed.has(e.sourceId) && !removed.has(e.targetId));\n    this.rebuildIndices();', 'this.data.edges = this.data.edges.filter(e => !removed.has(e.sourceId) && !removed.has(e.targetId));', 'bulk graph removal'),
 ('stale-revision', 'src/graph/graph.store.ts', 'if (removed.size === 0) return;\n    this.revision++;', 'if (removed.size === 0) return;', 'bulk graph removal'),
 ('wrong-bfs-order', 'src/graph/impact.engine.ts', 'for (const edge of edges) {\n        const nextId', 'for (const edge of [...edges].reverse()) {\n        const nextId', 'frontier traversal'),
 ('duplicate-cycle', 'src/graph/impact.engine.ts', '          visited.add(nextId);', '          // fault: never mark a discovered node', 'cycles and parallel'),
 ('retained-consumed-ids', 'src/graph/impact.engine.ts', "queue[head++] = '';", 'head++;', 'FIFO compaction clears'),
 ('wrong-depth', 'src/graph/impact.engine.ts', 'if (depth >= maxDepth) break;', 'if (depth > maxDepth) break;', 'frontier traversal'),
]
results=[]
for name,rel,before,after,test in FAULTS:
 file=ROOT/rel;original=file.read_bytes();source=original.decode()
 if source.count(before)!=1:raise RuntimeError(f'{name}: source marker count {source.count(before)}')
 try:
  file.write_text(source.replace(before,after))
  run=subprocess.run(JEST+['-t',test],cwd=ROOT,capture_output=True,text=True,timeout=35)
  log=run.stdout+run.stderr;(OUT/f'{name}.log').write_text(log)
  assertion='expect(received)' in log or 'expect(jest.fn())' in log
  invalid=any(s in log for s in ['Test suite failed to run','Exceeded timeout','Cannot find module','FATAL ERROR'])
  result={'fault':name,'exit_code':run.returncode,'assertion_caught':run.returncode!=0 and assertion and not invalid}
 finally:file.write_bytes(original)
 result.update(exact_restoration=file.read_bytes()==original,restored_sha256=hashlib.sha256(file.read_bytes()).hexdigest());results.append(result);print(json.dumps(result),flush=True)
run=subprocess.run(JEST,cwd=ROOT,capture_output=True,text=True,timeout=35)
(OUT/'restored-baseline.log').write_text(run.stdout+run.stderr)
(OUT/'results.json').write_text(json.dumps({'faults':results,'restored_exit':run.returncode},indent=2)+'\n')
raise SystemExit(0 if run.returncode==0 and all(r['assertion_caught'] and r['exact_restoration'] for r in results) else 1)
