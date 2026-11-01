// CPU observations for evidence assembly; hosted-model accuracy is measured separately.
const fs=require('fs'),path=require('path'),os=require('os'),Module=require('module');
const {performance}=require('perf_hooks');
const root=path.resolve(__dirname,'..'),out=path.join(root,'docs/product-reset/evidence/2026-10-14-rag-evidence');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'bimax-evidence-resource-'));
process.env.BIMAX_STATE_DIR=path.join(temp,'state');process.env.BIMAX_BREAKGLASS_DIR=path.join(temp,'breakglass');
const recalls={};
for(const arm of ['baseline','current']){
 const name=path.join(root,'dist/memory/recall.js');const mod=new Module(name);mod.filename=name;mod.paths=Module._nodeModulePaths(path.dirname(name));
 mod._compile(fs.readFileSync(path.join(out,'compiled',`recall-${arm}.js`),'utf8'),name);recalls[arm]=mod.exports.recallForTurn;
}
const doc=(id,bodies)=>{const chunks=bodies.map((text,i)=>({id:`${id}#${i}`,text}));return {id,metadata:{tags:[],content:bodies.join('\n')},chunks,matchedChunks:chunks};};
const shapes=[
 {name:'ordinary-short-notes',query:'quartz retry checksum approval',maxChars:1800,iterations:1000,
  docs:[doc('retry',['quartz retry limit is 7.']),doc('checksum',['quartz checksum is SHA-256.']),doc('approval',['quartz approval is required.'])]},
 {name:'complete-matched-chunks-equal-allowance',query:'copper silver gold attendance',maxChars:6000,iterations:100,
  docs:[doc('course',['copper','silver','gold'].map((name,i)=>`${name} attendance is ${21+i}. ${'Ordinary course administration. '.repeat(25)}`.trim()))]},
 {name:'long-line-50000-equal-allowance',query:'indigo observatory access phrase',maxChars:1800,iterations:5,
  docs:[doc('long',[`${'Unrelated ordinary logistics. '.repeat(1700)}The indigo observatory access phrase is KESTREL-83.`])]},
];
const median=xs=>{const s=[...xs].sort((a,b)=>a-b);return (s[(s.length-1)>>1]+s[s.length>>1])/2;};
(async()=>{
 const results=[];
 for(const shape of shapes){
  const samples={baseline:[],current:[]},outputs={};
  for(const arm of ['baseline','current']){
   const store={semanticSearch:async()=>shape.docs};
   const call=()=>recalls[arm](store,shape.query,{maxChars:shape.maxChars});
   for(let i=0;i<100;i++)await call();outputs[arm]=await call();
  }
  for(let run=0;run<2;run++)for(let group=0;group<9;group++)for(const arm of group%2?['current','baseline','baseline','current']:['baseline','current','current','baseline']){
   const store={semanticSearch:async()=>shape.docs};const start=performance.now();
   for(let i=0;i<shape.iterations;i++)await recalls[arm](store,shape.query,{maxChars:shape.maxChars});
   samples[arm].push((performance.now()-start)/shape.iterations);
  }
  // observedAt is a real per-observation timestamp, not part of text/identity equivalence.
  const stable=value=>({...value,evidence:value.evidence.map(({observedAt,...span})=>span)});
  const equal=JSON.stringify(stable(outputs.baseline))===JSON.stringify(stable(outputs.current));
  if(shape.name!=='long-line-50000-equal-allowance'&&!equal)throw new Error('Control output changed');
  results.push({fixture:shape.name,maxChars:shape.maxChars,inputChars:shape.docs.reduce((n,d)=>n+d.metadata.content.length,0),
   sameOutput:equal,baselineMedianMs:median(samples.baseline),currentMedianMs:median(samples.current),samples,
   literalFactPresent:{baseline:outputs.baseline.text.includes('KESTREL-83'),current:outputs.current.text.includes('KESTREL-83')}});
 }
 const result={runtime:process.version,machine:{platform:process.platform,arch:process.arch,cpuCount:os.cpus().length},
  method:'100 warmups per arm/shape, two9-group alternating ABBA runs,36 normalized samples/arm/shape,zero discards. Compiler excluded; shared evaluation machine. Exact prompt/IDs/source identity/locator/text checks exclude only the per-observation observedAt timestamp.',
  limitation:'Component CPU observations only. The long-line outputs differ intentionally; its timing ratio cannot establish a correctness-preserving speedup. No installed energy/RSS claim.',results};
 fs.writeFileSync(path.join(out,'assembly-resources.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify(results.map(({samples,...r})=>r),null,2));
 fs.rmSync(temp,{recursive:true,force:true});
})().catch(error=>{console.error(error);process.exitCode=1;});
