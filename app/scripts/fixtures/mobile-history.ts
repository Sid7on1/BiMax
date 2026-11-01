import assert from 'node:assert/strict';
import { HistoryService, MAX_HISTORY_BYTES } from 'desktop-responder';
import { HistoryClient } from 'phone-history';
import { dispatchIncomingEnvelope } from 'phone-incoming';
let context: {peer:string;session:object}|null={peer:'phone',session:{}};
let approvals=0,reads=0,request=0;
const original={sessionId:'selected',title:'Selected conversation',status:'idle',messages:[{id:'m1',role:'assistant',content:'α📱 **same bytes**\n'.repeat(6000),reasoning:'private reasoning'}],streaming:'',thinking:'',updatedAt:1};
let value=structuredClone(original);
const server=new HistoryService({context:()=>context,title:async id=>id==='selected'?'Selected conversation':null,authorize:async()=>{approvals++;},read:async()=>{reads++;return value as any;}});
const client=new HistoryClient(()=>`request-${++request}`);
const sentTimes:number[]=[];
async function roundtrip() { return client.read('selected',req=>{sentTimes.push(Date.now());void server.handle(req,'phone').then(c=>{if(c)client.handle(c);});}); }
const checks:string[]=[];
const check=(name:string)=>checks.push(name);
async function main(){
 const result=await roundtrip();assert.deepEqual(result,original);assert.equal(approvals,1);assert.equal(reads,1);check('multi-chunk UTF-8 snapshot roundtrip preserves exact Markdown and reasoning');
 assert.ok(sentTimes.length>3);for(let i=2;i<sentTimes.length;i++)assert.ok(sentTimes[i]-sentTimes[i-1]>=100,'history continuation respects shared transport budget');check('large history continuation is paced below relay frame limits');
 const wait=()=>new Promise(r=>setTimeout(r,110));
 await wait();await roundtrip();assert.equal(approvals,1);check('same selected conversation reuses only current Noise-session grant');
 await wait();const first=await server.handle({requestId:'first',sessionId:'selected'},'phone');assert.ok(first?.nextCursor);value.messages[0].content='mutated after first chunk';
 let body=Buffer.from(first.data!,'base64');let cursor=first.nextCursor;
 while(cursor){const c=await server.handle({requestId:'first',sessionId:'selected',cursor},'phone');assert.ok(c?.ok);body=Buffer.concat([body,Buffer.from(c.data!,'base64')]);cursor=c.nextCursor;}
 assert.deepEqual(JSON.parse(body.toString()),original);check('cursor serves immutable bytes while engine changes');
 for(const [name,peer,id] of [['foreign peer','other','selected'],['foreign conversation','phone','other']]){
 const denied=await server.handle({requestId:'attack',sessionId:id,cursor:first.nextCursor},peer);assert.equal(denied?.ok,false);check(`cursor rejects ${name}`);}
 context={peer:'phone',session:{}};assert.equal((await server.handle({requestId:'attack',sessionId:'selected',cursor:first.nextCursor},'phone'))?.ok,false);check('cursor cannot cross secure reconnect');
 await wait();await roundtrip();assert.equal(approvals,2);check('secure reconnect rechecks paired-host authorization');
 const before=reads;await wait();assert.equal((await server.handle({requestId:'absent',sessionId:'absent'},'phone'))?.ok,false);assert.equal(reads,before);check('unlisted conversation never reaches engine read');
 await wait();value={...original,messages:[{id:'huge',role:'assistant',content:'x'.repeat(MAX_HISTORY_BYTES+1),reasoning:''}]};assert.equal((await server.handle({requestId:'large',sessionId:'selected'},'phone'))?.ok,false);check('oversized engine snapshot fails closed');
 let grant!:()=>void;let lateReads=0;
 const delayed=new HistoryService({context:()=>context,title:async()=> 'title',authorize:()=>new Promise(r=>{grant=r;}),read:async()=>{lateReads++;return original as any;}});
 const pending=delayed.handle({requestId:'late',sessionId:'selected'},'phone');await new Promise(setImmediate);delayed.clear();grant();assert.equal((await pending)?.ok,false);assert.equal(lateReads,0);check('Stop during host authorization fences late grants and engine reads');
 const deny=new HistoryService({context:()=>context,title:async()=> 'title',authorize:async()=>{throw Error('denied');},read:async()=>{assert.fail('denied engine read');}});
 assert.equal((await deny.handle({requestId:'denied',sessionId:'selected'},'phone'))?.ok,false);check('denied host authorization discloses no history');
 const abort=new AbortController();let req:any;const cancelled=client.read('selected',r=>{req=r;},abort.signal);abort.abort();await assert.rejects(cancelled,/cancelled/);client.handle({...first,requestId:req.requestId});check('cancelled view ignores late chunks');
 for(const delta of [{sessionId:'other'},{offset:1},{totalBytes:MAX_HISTORY_BYTES+1},{data:'%%%bad'},{snapshotId:'bad'}]){
  const p=client.read('selected',r=>{req=r;});client.handle({...first,requestId:req.requestId,...delta});await assert.rejects(p);}
 check('client rejects wrong conversation, out-of-order, oversized and malformed chunks');
 const p=client.read('selected',r=>{req=r;});client.handle({...first,requestId:req.requestId});client.handle({...first,requestId:req.requestId});await assert.rejects(p);check('duplicate chunk cannot append or loop');
 const disconnected=client.read('selected',()=>{});client.clear();await assert.rejects(disconnected,/interrupted/);check('disconnect clears outstanding history');
 assert.equal(await server.handle({requestId:'../bad',sessionId:'selected'},'phone'),null);check('malformed request rejected before allocation');
 let delivered=0; const incoming={owner:'account',isActiveAccount:(o:string)=>o==='account',deviceId:'phone',trustedDesktopId:'mac',onHistoryChunk:()=>delivered++};
 const env={v:2,id:'frame',ts:1,from:'mac',to:'phone',kind:'session_history_chunk',payload:{}};
 dispatchIncomingEnvelope(env,incoming,false);dispatchIncomingEnvelope({...env,from:'attacker'},incoming,true);dispatchIncomingEnvelope({...env,to:'other'},incoming,true);dispatchIncomingEnvelope(env,{...incoming,owner:'signed-out'},true);assert.equal(delivered,0);dispatchIncomingEnvelope(env,incoming,true);assert.equal(delivered,1);check('history dispatch rejects plaintext, foreign sender, wrong recipient and signed-out account');
 console.log(JSON.stringify({passed:checks.length,checks},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;client.clear();});
