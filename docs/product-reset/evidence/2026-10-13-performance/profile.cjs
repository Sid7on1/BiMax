const fs=require('node:fs'),path=require('node:path'),ts=require('typescript'),{performance}=require('node:perf_hooks'),{DatabaseSync}=require('node:sqlite');
const dir=__dirname+'/baseline';
function load(rel,deps={}){const exports={};const js=ts.transpileModule(fs.readFileSync(dir+'/'+rel,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;new Function('exports','require',js)(exports,id=>id in deps?deps[id]:require(id));return exports;}
const logger={Logger:{info(){},warn(){},error(){}}};
const Graph=load('src/graph/graph.store.ts',{'../utils':logger}).GraphStore;
const Sqlite=load('src/graph/sqlite.graph.store.ts',{'./graph.store':{GraphStore:Graph},'../utils':logger,'../utils/state.dir':{stateDir(){throw Error('unused factory')}},'../core/sqlite':{openSqlite:()=>new DatabaseSync(':memory:')}}).SqliteGraphStore;
const Impact=load('src/graph/impact.engine.ts').ImpactEngine;
const results=[];
for(const n of [1000,10000,50000]){
 const g=new Graph(':memory:');for(let i=0;i<n;i++)g.addNode({id:String(i),name:String(i),type:'FUNCTION',filePath:`f${i}.ts`});for(let i=1;i<n;i++)g.addEdge({sourceId:'0',targetId:String(i),type:'CALLS'});
 const impact=new Impact(g);let start=performance.now();const out=impact.getForwardDependencies('0',3);results.push({operation:'wide BFS',n,ms:performance.now()-start,output_count:out.length});
}
for(const [n,remove] of [[1000,100],[4000,1000]]){
 const g=new Sqlite(':memory:');for(let i=0;i<n;i++)g.addNode({id:`func:${i<remove?'large.ts':'other.ts'}:${i}`,name:String(i),type:'FUNCTION',filePath:i<remove?'large.ts':'other.ts'});const ids=[...g.getGraph().nodes.keys()];for(let i=1;i<n;i++){g.addEdge({sourceId:ids[i-1],targetId:ids[i],type:'CALLS'});g.addEdge({sourceId:ids[i],targetId:ids[0],type:'IMPORTS'});}
 let rebuilds=0;const rebuild=g.rebuildIndices.bind(g);g.rebuildIndices=()=>{rebuilds++;return rebuild();};const start=performance.now();const count=g.removeFileNodes('large.ts');results.push({operation:'file graph removal',n,remove,ms:performance.now()-start,removed:count,adjacency_rebuilds:rebuilds});g.close();
}
console.log(JSON.stringify({node:process.version,kind:'exploratory baseline component profile; not repeated qualification',results},null,2));
