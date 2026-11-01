const fs=require('node:fs'),ts=require('typescript'),assert=require('node:assert/strict');
const exportsObject={};new Function('exports',ts.transpileModule(fs.readFileSync(__dirname+'/candidate.bounded.top.k.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(exportsObject);
const Selector=exportsObject.BoundedTopK,cmp=(a,b)=>b.score-a.score;let prefixes=0;
for(const k of [0,1,2,3,64,Infinity])for(const scores of [
Array.from({length:300},(_,i)=>i),Array.from({length:300},(_,i)=>300-i),Array.from({length:300},(_,i)=>i<150?i:300-i),
Array.from({length:300},(_,i)=>i%11),Array.from({length:300},(_,i)=>Math.floor(i/4)),Array.from({length:300},(_,i)=>i<260?i:(i*31)%257)]){
const h=new Selector(k,cmp),seen=[];scores.forEach((score,ordinal)=>{const value={score,ordinal};seen.push(value);h.add(value);assert.ok(h.size<=k);assert.deepEqual(h.sorted(),[...seen].sort(cmp).slice(0,k));prefixes++;});}
for(const improving of [true,false]){let comparisons=0;const h=new Selector(64,(a,b)=>{comparisons++;return b-a;});for(let i=0;i<20000;i++)h.add(improving?i:-i);assert.equal(h.size,64);assert.ok(comparisons<21000);const out=h.sorted(),copy=h.sorted();copy.pop();assert.deepEqual(h.sorted(),out);assert.deepEqual(out,improving?Array.from({length:64},(_,i)=>19999-i):Array.from({length:64},(_,i)=>-i));}
console.log(JSON.stringify({prefixes_checked:prefixes,exact:true,capacity_bound:true,monotonic_comparison_bound:true,candidate_status:'rejected by performance tradeoffs despite passing correctness'}));
