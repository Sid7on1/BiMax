const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const root=path.resolve(__dirname,'..');
const source=process.env.BIMAX_PASSAGE_TEST_SOURCE||path.join(root,'docs/product-reset/evidence/2026-10-14-rag-passage/candidate/recall.ts');
const filename=path.join(root,'dist/memory/recall.prototype.js'),loaded=new Module(filename);
loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename));
loaded._compile(ts.transpileModule(fs.readFileSync(source,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText,filename);
const {recallForTurn,answeringExcerpt,recallQuery}=loaded.exports;
const {versionOfText}=require('../dist/context/evidence');
function document(id,bodies,header=''){
 const chunks=bodies.map((text,i)=>({id:`${id}#${i}`,text}));
 return {id,metadata:{content:[header,...bodies].filter(Boolean).join('\n'),tags:[]},chunks,matchedChunks:chunks};
}
const seam=docs=>({semanticSearch:async()=>docs});
function exact(result,docs,budget){
 assert.ok(result);assert.ok(result.text.split('\n').slice(1).join('\n').length<=budget);
 for(const span of result.evidence){const doc=docs.find(d=>d.id===span.locator.documentId);assert.ok(result.text.includes(span.text));assert.ok(doc.metadata.content.includes(span.text));assert.equal(span.sourceVersion,versionOfText(doc.metadata.content));}
}
function relational(){return ['Orchid launch approval decisions require checking the complete eligibility statement.',
 'Ordinary operational background. '.repeat(27),
 'Only initiatives CEDAR and LINDEN satisfy the combined conditions; every other initiative is excluded.'].join('\n');}
test('a complete best passage retains its final relational restriction before extra fragments',async()=>{
 const core=relational();assert.ok(core.length>500&&core.length<1400);
 const doc=document('rules',[core,...['alpha','beta','gamma'].map(n=>`${n} unrelated context. `.repeat(55))]);
 const result=await recallForTurn(seam([doc]),'List Orchid launch approval decisions.',{maxChars:2000});
 assert.ok(result.text.includes(core),'Complete qualifying relation must survive, not just its query-bearing heading');
 assert.ok(result.evidence.some(s=>s.text===core));exact(result,[doc],2000);
});
test('complete best passage survives the ordinary three-source default allowance',async()=>{
 const core=relational(),first=document('rule',[core,...['one','two','three'].map(n=>`${n} unrelated details. `.repeat(65))]);
 const docs=[first,document('side',['Short secondary note.']),document('other',['Short tertiary note.'])];
 const result=await recallForTurn(seam(docs),'List Orchid launch approval decisions.');
 assert.ok(result.text.includes(core));assert.deepEqual(result.ids,['rule','side','other']);exact(result,docs,6000);
});
test('when no chunk fits completely, fair excerpts retain multiple independent facts',async()=>{
 const doc=document('course',['copper','silver','gold'].map((n,i)=>`The ${n} course attendance total is ${23+i}. ${'Background course administration. '.repeat(45)}`));
 doc.matchedChunks=[doc.chunks[2],doc.chunks[0],doc.chunks[1]];
 const result=await recallForTurn(seam([doc]),'What were the copper, silver and gold course attendance totals?',{maxChars:900});
 for(const n of ['23','24','25'])assert.ok(result.text.includes(n));assert.ok(result.text.indexOf('copper')<result.text.indexOf('silver'));assert.ok(result.text.indexOf('silver')<result.text.indexOf('gold'));exact(result,[doc],900);
});
test('keeping a whole passage cannot consume a later match’s minimum useful room',async()=>{
 const doc=document('reserve',['bronze','platinum'].map((n,i)=>`The ${n} course attendance total is ${23+i}.\n${'ordinary administration details. '.repeat(24)}`));
 assert.ok(doc.chunks[0].text.length+28<900&&doc.chunks[0].text.length+28>752);
 const result=await recallForTurn(seam([doc]),'What are bronze and platinum course attendance totals?',{maxChars:900});
 assert.ok(result.text.includes('23'));assert.ok(result.text.includes('24'));exact(result,[doc],900);
});
test('three sources retain their own late facts under the same1800-character ceiling',async()=>{
 const docs=['crane','ibis','tern'].map((n,i)=>document(n,[`${n} maintenance history ${'ordinary background '.repeat(100)}. ${n} launch credential is BIRD-${81+i}.`]));
 const result=await recallForTurn(seam(docs),'What are the crane, ibis and tern launch credentials?',{maxChars:1800});
 for(const n of ['BIRD-81','BIRD-82','BIRD-83'])assert.ok(result.text.includes(n));exact(result,docs,1800);
});
test('a later source keeps a complete multi-part constraint rather than a tiny heading',async()=>{
 const tail=`The pelican credential procedure is ID-P61, then ${'read the independent instruction carefully '.repeat(5)} TOKEN-P62, and finally CHECK-P63.`;
 const docs=[document('first',['Routine launch reference. '.repeat(100)]),document('second',[`${'Unrelated historical details. '.repeat(100)}${tail}`])];
 const result=await recallForTurn(seam(docs),'What is the pelican credential procedure?',{maxChars:1800});
 for(const fact of ['ID-P61','TOKEN-P62','CHECK-P63'])assert.ok(result.text.includes(fact));exact(result,docs,1800);
});
test('an oversized line preserves an exact window around its late query-bearing clause',()=>{
 const text=`${'Routine unrelated logistics detail. '.repeat(100)}The indigo launch code is KESTREL-83. Please keep the complete code.`;
 const shown=answeringExcerpt(text,'What is the indigo launch code?',160);assert.ok(shown.includes('indigo launch code is KESTREL-83'));assert.ok(shown.length<=160);assert.ok(text.includes(shown));
});
test('Unicode whole words cannot be displaced by a substring decoy',()=>{
 const text=`${'A codependence discussion has no answer. '.repeat(100)}नील कमल पासवर्ड = VIOLET-28. This is the saved password.`;
 const shown=answeringExcerpt(text,'नील कमल पासवर्ड',120);assert.ok(shown.includes('VIOLET-28'));assert.ok(text.includes(shown));
});
test('actual source dates are shown without inventing semantic validity',async()=>{
 const doc=document('visit',['user: I visited the observatory yesterday.'],'Session date: 2026/04/17 (Fri) 12:30');
 const result=await recallForTurn(seam([doc]),'On which date did I visit the observatory?',{maxChars:500});
 assert.ok(result.text.includes('Session date: 2026/04/17 (Fri) 12:30'));assert.ok(result.evidence.some(s=>s.text.includes('Session date:')));assert.ok(result.evidence.every(s=>s.validFrom===undefined));exact(result,[doc],500);
});
test('tiny budgets retain partial exact evidence and never turn recency into a date',async()=>{
 const doc={...document('plain',['marigold '.repeat(100)]),lastUsedAt:1780000000000};
 const result=await recallForTurn(seam([doc]),'marigold',{maxChars:100});assert.equal(result.evidence[0].locator.partial,true);assert.ok(!result.text.includes('1780000000000'));exact(result,[doc],100);
});
test('unmatched queries keep their old head fallback and short notes stay complete',async()=>{
 const text='A short ordinary passage. '.repeat(40);assert.equal(answeringExcerpt(text,'zebra quokka',100),text.slice(0,100).trimEnd());
 const doc=document('small',['The amber retry limit is 8.']);const result=await recallForTurn(seam([doc]),'amber retry limit');assert.ok(result.text.includes(doc.metadata.content));exact(result,[doc],6000);
});
test('exact duplicate text retains its first ranked locator',async()=>{
 const doc=document('duplicate',['The cyan launch token is LARK-19.','The cyan launch token is LARK-19.']);const result=await recallForTurn(seam([doc]),'cyan launch token');assert.equal(result.evidence.length,1);assert.equal(result.evidence[0].locator.part,1);assert.equal(result.evidence[0].locator.parts,2);
});
test('all complete short chunks fit the bounded default allowance',async()=>{
 const doc=document('complete',['violet','scarlet','ochre'].map(n=>`${n} ${'precise operational details '.repeat(32)}`.trimEnd()));const result=await recallForTurn(seam([doc]),'violet scarlet ochre operational details');for(const c of doc.chunks)assert.ok(result.text.includes(c.text));exact(result,[doc],6000);
});
test('ordinary admission and cancellation retain the production contracts',async()=>{
 assert.equal(recallQuery('user','continue',new Set()),null);assert.equal(recallQuery('assistant','Explain the orchard launch requirements.',new Set()),null);
 const controller=new AbortController();controller.abort();let calls=0;await assert.rejects(recallForTurn({semanticSearch:async()=>{calls++;return [];}},'Explain the orchard launch requirements.',{signal:controller.signal}));assert.equal(calls,0);
});
