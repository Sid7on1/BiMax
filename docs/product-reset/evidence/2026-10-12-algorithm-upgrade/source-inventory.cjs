// From repository root: node .../source-inventory.cjs > .../inventory-after.json
// Structural inventory only. AST functions and heuristic signals do NOT mean semantic review.
const fs = require('node:fs');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const ts = require('typescript');
const roots = ['src','app/src','app/native','native','scripts','app/scripts','benchmarks'];
const families = {
 retrieval:/bm25|reciprocal|rerank|embedding|cosine|quantiz|semanticSearch/i,
 graph:/pageRank|criticalPath|topological|breadth|depth.first|adjacency|dependency/i,
 retry:/backoff|retryAfter|circuit.?breaker|jitter|hedg/i,
 cache:/cache|LRU|TTL|memoiz|WeakMap/i,
 scheduling:/semaphore|concurrency|queue|scheduling|capacity|hysteresis|thermal/i,
 statistics:/reservoir|percentile|ewma|exponential.*aver|isotonic|bandit|beta|confidence/i,
 persistence:/journal|appendFile|atomic|transaction|checkpoint|WAL/i,
 security:/sha256|hmac|constant.time|timingSafeEqual|redact|secret|approval|permission/i,
 streaming:/backpressure|highWaterMark|ReadableStream|chunk|AbortSignal|deadline/i,
 context:/tokenBudget|token.budget|compaction|compact|summariz/i,
 parsing:/tree.sitter|createSourceFile|parseDocument|OCR|parseInt/i,
};
const paths = execFileSync('rg',['--files',...roots,'-g','!**/__tests__/**','-g','!**/results/**','-g','!**/evidence/**','-g','!**/dist/**','-g','!**/node_modules/**'],{encoding:'utf8'}).trim().split('\n')
 .filter(p=>/\.(ts|tsx|js|mjs|cjs|py|swift|c|h|sh|go|rs|cpp)$/.test(p) && !/\/vendor\//i.test(p) && !/\.test\.[^.]+$/.test(p)).sort();
const files = paths.map(path=>{
 const source=fs.readFileSync(path,'utf8');
 const functions=[],sites=[];
 if(/\.[cm]?[jt]sx?$/.test(path)){
  const ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true);
  const line=node=>ast.getLineAndCharacterOfPosition(node.getStart(ast)).line+1;
  function visit(node){
   if(ts.isFunctionLike(node)&&node.body){
    let name=node.name?.getText(ast);
    if(!name&&ts.isVariableDeclaration(node.parent))name=node.parent.name.getText(ast);
    if(!name&&ts.isPropertyAssignment(node.parent))name=node.parent.name.getText(ast);
    functions.push({name:name||'<anonymous>',line:line(node),endLine:ast.getLineAndCharacterOfPosition(node.end).line+1});
   }
   if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&['sort','shift','unshift','splice','filter','slice'].includes(node.expression.name.text))sites.push({operation:node.expression.name.text,line:line(node)});
   ts.forEachChild(node,visit);
  }
  visit(ast);
 }
 const scope=/computer|cua|cu\.|\.cu|at-cu|at\.cu/i.test(path)?'CU-read-only':/renderer|preload|floating-bar|floating\.bar|app\/native\/notch/.test(path)?'UI-read-only':/benchmarks|scripts/.test(path)?'tooling':'engine-and-host';
 return {path,scope,sha256:crypto.createHash('sha256').update(source).digest('hex'),lines:source.split('\n').length,functions,sites,hints:Object.entries(families).filter(([,pattern])=>pattern.test(source)).map(([family])=>family),reviewStatus:'Inventory only. See record 88 for specific manual review and implementation scope.'};
});
console.log(JSON.stringify({schema:1,roots,exclusions:['tests','vendor (case-insensitive)','dependencies','build outputs','evidence','results','archive','reference checkouts','non-source assets/configuration'],summary:{files:files.length,lines:files.reduce((sum,f)=>sum+f.lines,0),functions:files.reduce((sum,f)=>sum+f.functions.length,0),scopes:files.reduce((out,f)=>(out[f.scope]=(out[f.scope]||0)+1,out),{})},files},null,2));
