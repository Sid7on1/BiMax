import assert from 'node:assert/strict';
import { HistoryService, LiveConversations } from 'desktop-responder';
import { HistoryClient } from 'phone-history';
import { LiveConversationClient, applyConversationUpdate } from 'phone-live';
import { transcriptOperation, wireState } from 'phone-renderer-bridge';
let context:{peer:string;session:object}|null={peer:'phone',session:{}};
let snapshot:any={sessionId:'selected',title:'Live chat',status:'idle',messages:[{id:'saved',role:'assistant',content:'Saved α history '.repeat(3000)}],streaming:'',thinking:'',updatedAt:1,revision:1};
let serial=0,reads=0;const updates:any[]=[],seen:any[]=[],errors:any[]=[],sent:any[]=[];
const historyClient=new HistoryClient(()=>`history-${++serial}`);
const client=new LiveConversationClient(historyClient,()=>`watch-${++serial}`);
const live=new LiveConversations({context:()=>context,authorize:async()=>{assert.ok(context);},read:async()=>{reads++;return snapshot;},send:e=>{updates.push(e);client.update(e);}});
const history=new HistoryService({context:()=>context,title:async id=>id==='selected'?'Live chat':null,authorize:async()=>{assert.ok(context);},read:async()=>{reads++;return snapshot;},capture:(id,s,c)=>live.capture(id,s,c)});
const send=(kind:string,body:any)=>{sent.push({kind,body});void (async()=>{if(kind==='session_watch'){const ack=await live.request(body,'phone');if(ack)client.status(ack);}else{const chunk=await history.handle(body,'phone');if(chunk)historyClient.handle(chunk);}})().catch(e=>errors.push(e));};
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const wait=async(test:()=>boolean)=>{const until=Date.now()+2500;while(!test()){if(Date.now()>until)throw Error('Live end state timed out');await sleep(10);}};
const checks:string[]=[];
async function main(){
 const stop=client.watch('selected',send,s=>seen.push(s),e=>errors.push(e));await wait(()=>seen.length===1);
 assert.deepEqual(seen[0],snapshot);checks.push('paginated exact baseline starts one authenticated selected subscription');
 const initialReads=reads,initialRequests=sent.filter(s=>s.kind==='session_history_request').length;
 snapshot={...snapshot,status:'working',streaming:'Live α',thinking:'Thoughts',revision:2};live.changed('selected');await wait(()=>seen.at(-1)?.revision===2);assert.equal(seen.at(-1).streaming,'Live α');assert.equal(seen.at(-1).thinking,'Thoughts');checks.push('work begun on Mac pushes content and thinking without a phone request');
 for(let i=3;i<=12;i++){snapshot={...snapshot,streaming:'Live α '+i,revision:i};live.changed('selected');}
 await wait(()=>seen.at(-1)?.revision===12);assert.equal(updates.length,2);assert.equal(reads,initialReads+2);assert.equal(sent.filter(s=>s.kind==='session_history_request').length,initialRequests);checks.push('burst changes coalesce into bounded live patches without history polling');
 snapshot={...snapshot,status:'idle',messages:[...snapshot.messages,{id:'final',role:'assistant',content:'Final **answer**',reasoning:'Thoughts'}],streaming:'',thinking:'',revision:13};live.changed('selected');await wait(()=>seen.at(-1)?.revision===13);assert.equal(seen.at(-1).messages.at(-1).content,'Final **answer**');assert.equal(seen.at(-1).streaming,'');checks.push('final answer atomically replaces streaming state');
 const before=seen.length;client.update(updates.at(-1));client.update({...updates.at(-1),watchId:'foreign'});client.update({...updates.at(-1),sessionId:'other'});await sleep(130);assert.equal(seen.length,before);checks.push('duplicates and foreign subscription/conversation updates cannot append content');
 snapshot={...snapshot,revision:14,streaming:'Only selected'};live.changed('other');await sleep(130);assert.equal(seen.length,before);live.changed('selected');await wait(()=>seen.at(-1)?.revision===14);checks.push('unselected conversation changes disclose nothing');
 snapshot={...snapshot,revision:15,messages:[...snapshot.messages,{id:'large',role:'assistant',content:'large α '.repeat(6000)}],streaming:''};live.changed('selected');await wait(()=>seen.at(-1)?.revision===15);assert.equal(seen.at(-1).messages.at(-1).content,snapshot.messages.at(-1).content);assert.ok(updates.some(u=>u.resync));assert.ok(updates.every(u=>Buffer.byteLength(JSON.stringify(u))<=24*1024));checks.push('oversized final content resynchronizes by bounded immutable chunks');
 snapshot={...snapshot,revision:16,streaming:'After gap'};client.update({...updates.at(-1),watchId:sent.filter(s=>s.kind==='session_watch'&&s.body.action==='start').at(-1).body.watchId,resync:undefined,baseRevision:999,revision:1000,patch:{title:'bad',status:'idle',updatedAt:0}});await wait(()=>seen.at(-1)?.revision===16);assert.equal(seen.at(-1).title,'Live chat');checks.push('revision gap establishes a fresh exact baseline rather than applying a wrong patch');
 const oldWatch=sent.filter(s=>s.kind==='session_watch'&&s.body.action==='start').at(-1).body.watchId;
 context={peer:'phone',session:{}};assert.throws(()=>live.capture(oldWatch,snapshot,context!),/baseline/);checks.push('baseline cannot cross a changed secure-session identity');
 stop();const count=seen.length;snapshot={...snapshot,revision:17,streaming:'must not arrive'};live.changed('selected');await sleep(130);assert.equal(seen.length,count);checks.push('leaving the view cancels subscription and ignores late events');
 const props:any={conversationKey:'selected',messages:Array.from({length:1000},(_,i)=>({id:String(i),role:'assistant',content:'x'.repeat(1000)})),onRetry:()=>{}};
 const first=wireState(props);assert.equal('onRetry' in first,false);structuredClone(first);
 const next={...first,messages:[...first.messages.slice(0,-1),{...first.messages.at(-1)!,content:first.messages.at(-1)!.content+'α'}]};
 const op=transcriptOperation(first,next);assert.equal(op.type,'patch');assert.ok(JSON.stringify(op).length<500);checks.push('native/WebView streaming bridge sends a tiny delta over megabyte history and excludes callback functions');
 assert.throws(()=>applyConversationUpdate(snapshot,{watchId:'w',sessionId:'selected',baseRevision:1,revision:2,patch:{title:'bad',status:'idle',updatedAt:0}}),/resynchronizing/);assert.deepEqual(errors,[]);checks.push('no dropped-update exceptions or hidden background failures');
 console.log(JSON.stringify({passed:checks.length,checks},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{client.clear();historyClient.clear();live.clear();history.clear();});
