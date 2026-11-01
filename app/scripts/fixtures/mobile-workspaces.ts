import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,realpathSync,rmSync } from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {ThreadManager} from '../../src/main/thread.manager';
import {RealEngineAdapter} from '../../src/main/responder/adapter';
import {SessionCreation} from 'workspace-service';
import {IdempotencyLog} from 'workspace-journal';
import {SessionCreateClient} from 'phone-session-create';
async function main(){
 const scratch=mkdtempSync(path.join(tmpdir(),'bimax-workspaces-'));let started=0;
 const roots=['one/project','two/project'].map(name=>{const root=path.join(scratch,name);mkdirSync(root,{recursive:true});return realpathSync(root);});
 const threads=new ThreadManager({engine:()=>{started++;return{openProject(){},dispose(){},sendFromRenderer(){}};},changed(){},selected(){},message(){},save(){},approval(){}});
 const adapter=new RealEngineAdapter(threads,undefined,undefined,()=>roots);
 const checks:string[]=[];let context:any={peer:'phone',session:{}};
 const service=new SessionCreation({context:()=>context,authorize:async()=>{},create:id=>adapter.createSession(id),journal:new IdempotencyLog()});
 const key=(n:string)=>'create-'+n.repeat(32);const request=(n='a',workspaceId='')=>({requestId:key(n),workspaceId,sentAt:Date.now()});
 try{
  assert.equal(threads.activeId,null);const folders=await adapter.listWorkspaces();assert.equal(folders.length,2);assert.equal(folders[0].name,folders[1].name);assert.notEqual(folders[0].id,folders[1].id);checks.push('known folders are available from Home with unambiguous opaque ids despite duplicate names');
  const input=request('a',folders[1].id);const first=await service.handle(input,'phone');assert.equal(first?.ok,true);assert.equal(started,0);assert.equal(threads.activeId,null);assert.equal(threads.summary(first!.sessionId!).root,roots[1]);assert.equal((await adapter.getSessionHistory(first!.sessionId!)).messages.length,0);checks.push('new conversation is empty and folder-bound, without selecting or starting an engine on Mac Home');
  const [a,b]=await Promise.all([service.handle(input,'phone'),service.handle({...input,sentAt:Date.now()},'phone')]);assert.equal(a?.sessionId,first?.sessionId);assert.equal(b?.sessionId,first?.sessionId);assert.equal(threads.list().length,1);checks.push('concurrent/retried creation intent returns one saved conversation');
  assert.equal((await service.handle({...input,workspaceId:folders[0].id},'phone'))?.ok,false);assert.equal(threads.list().length,1);checks.push('idempotency key cannot be reused to create in another folder');
  assert.equal(await service.handle(request('b',folders[0].id),'foreign'),null);assert.equal(await service.handle({...input,workspaceId:'../../private'},'phone'),null);assert.equal((await service.handle(request('b','w-'+'0'.repeat(64)),'phone'))?.ok,false);assert.equal(threads.list().length,1);checks.push('foreign peer, raw path and unknown folder cannot create conversations');
  const absent=await adapter.listSessions();assert.equal(absent[0].workspace?.id,folders[1].id);checks.push('existing session list retains workspace metadata independent of active Mac view');
  await assert.rejects(()=>adapter.chat({idempotencyKey:'missing',text:'must not reuse active'},()=>{}),/Choose a folder/);checks.push('a chat without an explicit conversation id never resumes the previous Mac conversation');
  let release!:()=>void;const held=new Promise<void>(r=>release=r);let effects=0;
  const retired=new SessionCreation({context:()=>context,authorize:async()=>{},create:async()=>{effects++;return{sessionId:'bad'};},journal:{execute:async(_key:any,fn:any)=>{await held;return {result:await fn()};}} as any});
  const pending=retired.handle(request('c',folders[0].id),'phone');await Promise.resolve();context=null;release();assert.equal(await pending,null);assert.equal(effects,0);checks.push('Stop/disconnect during journal admission prevents late creation');
  context={peer:'phone',session:{}};let allow!:()=>void;const gate=new Promise<void>(r=>allow=r);let chosen='';
  const snapshotted=new SessionCreation({context:()=>context,authorize:()=>gate,create:async(id)=>{chosen=id;return{sessionId:'safe'};},journal:new IdempotencyLog()});
  const mutable=request('d',folders[0].id),expected=mutable.workspaceId;const promise=snapshotted.handle(mutable,'phone');mutable.workspaceId=folders[1].id;allow();await promise;assert.equal(chosen,expected);checks.push('mutable request data is snapshotted before asynchronous approval/journal work');
  const client=new SessionCreateClient(20);let outbound:any;const created=client.create(key('e'),folders[0].id,r=>outbound=r);client.handle({...outbound,ok:true,workspaceId:folders[1].id,sessionId:'wrong'});client.handle({...outbound,ok:true,sessionId:first!.sessionId});assert.equal(await created,first!.sessionId);checks.push('phone creation client requires exact intent and folder, ignoring foreign results');
  const timed=client.create(key('f'),folders[0].id,()=>{});await assert.rejects(timed,/interrupted/);const retried=client.create(key('f'),folders[0].id,()=>{});client.handle({requestId:key('f'),workspaceId:folders[0].id,ok:true,sessionId:first!.sessionId});assert.equal(await retried,first!.sessionId);checks.push('timeout is visible and explicit retry can reconcile the same creation intent');
  const closed=client.create(key('1'),folders[0].id,()=>{});client.clear();await assert.rejects(closed,/Connection changed/);checks.push('disconnect retires pending creation promises');
  console.log(JSON.stringify({passed:checks.length,checks},null,2));
 }finally{threads.dispose();rmSync(scratch,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
