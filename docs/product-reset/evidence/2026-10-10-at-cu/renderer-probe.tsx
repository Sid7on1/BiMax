import React, { useState } from '../../../../app/node_modules/react';
import { createRoot } from '../../../../app/node_modules/react-dom/client';
import { flushSync } from '../../../../app/node_modules/react-dom';
import { Composer } from '../../../../app/src/renderer/src/components/Composer';
import { ThreadQuickBar } from '../../../../app/src/renderer/src/components/ThreadSurfaces';
import { useEngine } from '../../../../app/src/renderer/src/useEngine';
import { initialEngineState } from '../../../../app/src/renderer/src/engine.state';
const host = window as any, callbacks = new Map<string, Set<Function>>(), requests: any[] = [];
const sub = (name:string, cb:Function) => { if(!callbacks.has(name))callbacks.set(name,new Set());callbacks.get(name)!.add(cb);return()=>callbacks.get(name)!.delete(cb); };
const emit = (name:string,...args:any[]) => {for(const cb of callbacks.get(name)||[])cb(...args);};
let windowsDone: ((v:any)=>void)|undefined, delayWindows=false, failSubmit=false;
const target={token:'12345678-1234-1234-1234-123456789abc',label:'Fixture · Main'};
host.bimax={
 onMessage:(cb:Function)=>sub('messages',cb),onEngineState:(cb:Function)=>sub('states',cb),onProject:(cb:Function)=>sub('project',cb),rendererReady(){},
 send:(m:any)=>requests.push({type:'engine',m}),
 computer:{
  targets:async(id:string|undefined,pid?:number)=>{requests.push({type:'targets',id,pid});if(pid===undefined)return {ok:true,apps:[{pid:42,name:'Fixture',bundle_id:'org.fixture'}]};if(delayWindows)return new Promise(r=>{windowsDone=r;});return {ok:true,windows:[{id:5,title:'Main',target}]};},
  cancelTargets:async()=>true,
  submit:async(id:string,text:string,engineText:string,route:any)=>{requests.push({type:'projectSubmit',id,text,engineText,route});if(failSubmit)return {ok:false,error:'Computer Use target expired. Choose again.'};emit('messages',{t:'event',name:'thread_user',args:[text]},id);return {ok:true};},
 },
 threads:new Proxy({onSelected:(cb:Function)=>sub('selected',cb),context:async()=>({root:'/fixture',source:'Selected'}),quickCurrent:async()=>null,
 quickSubmit:async(text:string,options:any)=>{requests.push({type:'quickSubmit',text,options});emit('onQuickMsg',{t:'event',name:'thread_user',args:[text]});return {ok:true,id:'quick'};},
 },{get(obj:any,key:string){return key in obj?obj[key]:key.startsWith('on')?(cb:Function)=>sub(key,cb):async()=>null;}}),
};
function Fixture(){
 const engine=useEngine(),[surface,setSurface]=useState('main'),[busy,setBusy]=useState(false);
 host.probe={requests,emit,setBusy:(v:boolean)=>flushSync(()=>setBusy(v)),surface:(s:string)=>flushSync(()=>setSurface(s)),
  select:(id:string)=>emit('selected',{id,state:{...initialEngineState,threadId:id,project:'/fixture'}}),
  delayWindows:(v:boolean)=>{delayWindows=v;}, windowsDone:()=>windowsDone?.({ok:true,windows:[{id:5,title:'STALE WINDOW',target:{...target,label:'STALE WINDOW'}}]}),fail:(v:boolean)=>{failSubmit=v;}};
 return surface==='quick'?<ThreadQuickBar/>:<Composer key={engine.state.threadId||'initial'} busy={busy} mode="code" tier="auto" project="/fixture" draftKey={engine.state.threadId||'initial'} threadId={engine.state.threadId} branch={null} snapshot={null} streamedChars={0} completions={engine.state.completions.items} onSubmit={engine.submit} onInterrupt={engine.interrupt} onControls={engine.setControls} onCommand={engine.sendCommand} onQuery={engine.query} onIngest={engine.ingestAttachment} onClearCompletions={engine.clearCompletions} onOpenModels={()=>{}} runtime={{phase:'ready'} as any}/>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
