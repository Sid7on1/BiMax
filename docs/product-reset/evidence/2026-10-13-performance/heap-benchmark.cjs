const fs=require('node:fs'),ts=require('typescript'),assert=require('node:assert/strict'),{performance}=require('node:perf_hooks'),os=require('node:os'),crypto=require('node:crypto');
function load(file){const exports={};new Function('exports',ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(exports);return exports.BoundedTopK;}
const Before=load(__dirname+'/baseline/src/utils/bounded.top.k.ts'),After=load(__dirname+'/candidate.bounded.top.k.ts');
function rng(seed){return()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};}
const results=[];
for(const n of [100,1000,10000,100000]){
 const random=rng(16),input=Array.from({length:n},(_,i)=>({id:`d${i}`,score:random(),used:i%3}));
 const cmp=(a,b)=>b.score-a.score||b.used-a.used||a.id.localeCompare(b.id);
 for(const order of ['random','ascending','descending','tied']){
  const values=order==='ascending'?[...input].sort((a,b)=>a.score-b.score):order==='descending'?[...input].sort(cmp):order==='tied'?input.map(v=>({...v,score:1})):input;
  const run=Type=>{const h=new Type(64,cmp);for(const v of values)h.add(v);assert.ok(h.size<=64);return h.sorted();};
  const expected=[...values].sort(cmp).slice(0,64);assert.deepEqual(run(Before),expected);assert.deepEqual(run(After),expected);
  for(let i=0;i<4;i++){run(Before);run(After);[...values].sort(cmp).slice(0,64);}
  const samples={before:[],after:[],full_sort:[]};
  for(let i=0;i<11;i++)for(const side of i%2?['full_sort','after','before']:['before','after','full_sort']){
   global.gc?.();const start=performance.now();const out=side==='full_sort'?[...values].sort(cmp).slice(0,64):run(side==='before'?Before:After);samples[side].push(performance.now()-start);assert.deepEqual(out,expected);
  }
  const stat=a=>{const s=[...a].sort((a,b)=>a-b);return{p50_ms:s[5],p95_ms:s[10],raw_ms:a};};
  results.push({n,k:64,order,repetitions:11,discard_count:0,before:stat(samples.before),after:stat(samples.after),full_sort:stat(samples.full_sort),correctness_sha256:crypto.createHash('sha256').update(JSON.stringify(expected)).digest('hex')});
 }
}
console.log(JSON.stringify({kind:'paired offline component timings; no installed-app, RSS, energy or quality claim',node:process.version,machine:{arch:os.arch(),cpu:os.cpus()[0].model,cores:os.cpus().length,ram_bytes:os.totalmem()},warmups:4,order:'ABC/CBA alternating, explicit GC before every timing, no parallel tests',results},null,2));
