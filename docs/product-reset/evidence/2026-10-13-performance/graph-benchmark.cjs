const fs=require('node:fs'),path=require('node:path'),ts=require('typescript'),assert=require('node:assert/strict'),{performance}=require('node:perf_hooks'),os=require('node:os'),crypto=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const started=new Date().toISOString();
function modules(root){
 const load=(rel,deps={})=>{const exports={};new Function('exports','require',ts.transpileModule(fs.readFileSync(path.join(root,rel),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(exports,id=>id in deps?deps[id]:require(id));return exports;};
 const logger={Logger:{info(){},warn(){},error(){}}};const Graph=load('src/graph/graph.store.ts',{'../utils':logger}).GraphStore;
 const Sqlite=load('src/graph/sqlite.graph.store.ts',{'./graph.store':{GraphStore:Graph},'../utils':logger,'../utils/state.dir':{stateDir(){throw Error('unused factory')}},'../core/sqlite':{openSqlite:()=>new DatabaseSync(':memory:')}}).SqliteGraphStore;
 return{Graph,Sqlite,Impact:load('src/graph/impact.engine.ts').ImpactEngine};
}
const before=modules(__dirname+'/baseline'),after=modules(process.cwd()),results=[];
function graph(Type,n,shape,remove=0){const g=new Type(':memory:');for(let i=0;i<n;i++)g.addNode({id:String(i),name:String(i),type:'FUNCTION',filePath:i<remove?'remove.ts':'keep.ts'});for(let i=1;i<n;i++){g.addEdge({sourceId:shape==='wide'?'0':String(i-1),targetId:String(i),type:'CALLS'});if(shape==='cycle')g.addEdge({sourceId:String(i),targetId:'0',type:'IMPORTS'});}return g;}
function fixture(module,kind,n,shape,remove){
 const g=graph(kind==='remove'?module.Sqlite:module.Graph,n,shape,remove);let rebuilds=0;const rebuild=g.rebuildIndices.bind(g);g.rebuildIndices=()=>{rebuilds++;return rebuild();};
 return{run:()=>kind==='remove'?g.removeFileNodes('remove.ts'):new module.Impact(g).getForwardDependencies('0',Infinity),output:value=>kind==='remove'?{removed:value,nodes:[...g.getGraph().nodes],edges:g.getGraph().edges,rebuilds}:value.map(n=>n.id),close:()=>g.close?.()};
}
for(const [kind,n,shape,remove] of [['bfs',1000,'wide',0],['bfs',10000,'wide',0],['bfs',50000,'wide',0],['bfs',1000,'chain',0],['bfs',10000,'chain',0],['bfs',10000,'cycle',0],['remove',1000,'cycle',100],['remove',4000,'cycle',1000]]){
 let expected,operationCounts;const times={before:[],after:[]};
 for(let i=-4;i<11;i++)for(const side of i%2?['after','before']:['before','after']){
  const f=fixture(side==='before'?before:after,kind,n,shape,remove);let output;
  try{global.gc?.();const start=performance.now();const result=f.run();const elapsed=performance.now()-start;output=f.output(result);if(kind==='remove'){operationCounts??={};operationCounts[side]=output.rebuilds;delete output.rebuilds;}
   if(expected===undefined)expected=output;else assert.deepEqual(output,expected);if(i>=0)times[side].push(elapsed);
  }finally{f.close();}
 }
 const stat=a=>{const s=[...a].sort((a,b)=>a-b);return{p50_ms:s[5],p95_ms:s[10],raw_ms:a};};results.push({kind,n,shape,remove,warmups:4,repetitions:11,discard_count:0,before:stat(times.before),after:stat(times.after),operation_counts:operationCounts,correctness_sha256:crypto.createHash('sha256').update(JSON.stringify(expected)).digest('hex')});
}
console.log(JSON.stringify({schema:1,started_at:started,ended_at:new Date().toISOString(),scope:'Offline graph operations, fixture creation and assertions excluded from timed intervals; no installed latency, peak RSS or energy claim',ordering:'AB/BA paired, explicit GC, no parallel tests/builds',machine:{arch:os.arch(),cpu:os.cpus()[0].model,cores:os.cpus().length,ram_bytes:os.totalmem(),node:process.version},results},null,2));
