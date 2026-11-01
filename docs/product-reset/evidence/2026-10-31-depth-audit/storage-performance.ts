import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { ThreadStorage } from '../../../../app/src/main/thread.storage';
import { initialEngineState } from '../../../../app/src/renderer/src/engine.state';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-audit-save-cost-'));
const results: any[] = [];
try {
  const storage = new ThreadStorage(dir);
  for (const contentBytes of [65536, 1048576, 8388608, 16777216]) {
    const value = { summary: { id: 'perf', title: 'Synthetic only', root: '/fixture', updatedAt: 1, status: 'idle', peers: [] },
      state: { ...initialEngineState, items: [{kind:'msg', msg: { id:'m', role:'assistant', content:'x'.repeat(contentBytes), timestamp:'2026-10-31T00:00:00Z'}}] } } as any;
    storage.saveNow(value);
    const samples: number[] = [];
    for (let i = 0; i < 7; i++) { const t = performance.now(); storage.saveNow(value); samples.push(performance.now() - t); }
    results.push({ contentBytes, samplesMs:samples, medianMs: samples.slice().sort((a,b)=>a-b)[3] });
  }
} finally { fs.rmSync(dir, { recursive:true,force:true }); }
const report = {scope:'Current ThreadStorage.saveNow on synthetic ASCII histories; serialize + synchronous write + rename in Node 24 on this Mac; warm temporary filesystem, not installed end-to-end lag',node:process.version,arch:process.arch,results};
fs.writeFileSync(path.join(__dirname,'storage-performance.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
