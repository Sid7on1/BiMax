import { AgentLoop } from '../core/agent.loop';
import { ToolRegistry } from '../tools/tool.registry';
import type { LLMProvider, ChatEvent } from '../core/llm.provider';
import { createAskUserTool } from '../tools/implementations/ask_user.tool';
import { engineEvents } from '../engine/events';
import { getConfig, loadConfig } from '../engine/config';
function scripted(rounds: ChatEvent[][]) {
 let n=0;return { applyConfig(){},userModel:'scripted',async *chat(){ for(const e of rounds[Math.min(n++,rounds.length-1)]) yield e; } } as unknown as LLMProvider;
}
const ask = (id:string,options=['Yes','No']):ChatEvent => ({type:'tool_call',id,name:'AskUserTool',args:JSON.stringify({question:'Which option?',options})});
test('duplicate clarification in a user run reuses its exact answer without prompting; next run asks anew', async () => {
 const registry=new ToolRegistry(),execute=jest.fn(async ()=> 'User selected: No');
 registry.register({name:'AskUserTool',description:'ask',schema:{type:'object',properties:{question:{type:'string'},options:{type:'array',items:{type:'string'}}}},isDestructive:false,isConcurrencySafe:false,execute});
 const loop=new AgentLoop(scripted([[ask('1'),{type:'done'}],[ask('2'),{type:'done'}],[{type:'token',text:'I will use your answer.'},{type:'done'}]]),registry,null as any);
 for await(const _ of loop.execute([{role:'user',content:'Choose the option'}],'sys',{maxIterations:4})){ /* Fixture body intentionally performs no work. */ }
 expect(execute).toHaveBeenCalledTimes(1);
 expect(loop.messages.filter(m=>m.role==='tool')[1].content).toContain('User selected: No');
 const next=new AgentLoop(scripted([[ask('3'),{type:'done'}],[{type:'token',text:'I will use your answer.'},{type:'done'}]]),registry,null as any);
 for await(const _ of next.execute([{role:'user',content:'Choose again'}],'sys',{maxIterations:3})){ /* Fixture body intentionally performs no work. */ }
 expect(execute).toHaveBeenCalledTimes(2);
});
test('changed choice options are a new clarification', async () => {
 const registry=new ToolRegistry(),execute=jest.fn(async ()=> 'User selected: No');registry.register({name:'AskUserTool',description:'',schema:{},isDestructive:false,isConcurrencySafe:false,execute});
 const loop=new AgentLoop(scripted([[ask('1'),{type:'done'}],[ask('2',['Keep','Delete']),{type:'done'}],[{type:'token',text:'Both answers received.'},{type:'done'}]]),registry,null as any);
 for await(const _ of loop.execute([{role:'user',content:'Choose two options'}],'sys',{maxIterations:4})){ /* Fixture body intentionally performs no work. */ }
 expect(execute).toHaveBeenCalledTimes(2);
});
test('Stop releases a real pending human clarification and late answers do not resume the turn', async () => {
 await loadConfig();const config=getConfig(),previous=config.autoAgentDecisions;config.autoAgentDecisions=false;
 let answer!: (s:string)=>void;
 const listener=(_q:string,_options:string[],callback:(s:string)=>void)=>{answer=callback;};engineEvents.on('veto_prompt',listener);
 try {
  const tool=createAskUserTool({approveTaskExecution:async()=>{}} as any,{} as any),stop=new AbortController();
  const pending=tool.execute({question:'Choose the target project folder',options:['First','Second']},{signal:stop.signal});
  while(!answer) await new Promise(r=>setImmediate(r));stop.abort();await expect(pending).rejects.toThrow(/cancelled/);answer('First');
 } finally { config.autoAgentDecisions=previous;engineEvents.off('veto_prompt',listener); }
});
test('a blocked embedded workflow forces an answer-only provider round', async () => {
 const registry=new ToolRegistry();registry.register({name:'NativeHost',description:'',schema:{},isDestructive:true,isConcurrencySafe:false,outputSource:'screen',execute:async()=>({ok:false,blocked:true,executor:'stop',code:'native_workflow_stopped',reason:'postcondition failed',replay:false})});
 const schemaCounts:number[]=[];let n=0;
 const llm={userModel:'scripted',applyConfig(){},async *chat(_m:any,options:any){schemaCounts.push(options?.tools?.length || 0); if(n++===0) yield {type:'tool_call',id:'1',name:'NativeHost',args:'{}'};else yield {type:'token',text:'The operation stopped because verification failed.'};yield {type:'done'};}} as unknown as LLMProvider;
 const loop=new AgentLoop(llm,registry,null as any);for await(const _ of loop.execute([{role:'user',content:'Do the task'}],'sys',{maxIterations:4,toolNames:['NativeHost']})){ /* Fixture body intentionally performs no work. */ }
 expect(schemaCounts[0]).toBe(1);expect(schemaCounts[1]).toBe(0);
});

test('a native terminal failure prevents later calls from the same model response', async () => {
 const registry=new ToolRegistry(),later=jest.fn(async()=> 'would mutate');
 registry.register({name:'NativeHost',description:'',schema:{},isDestructive:true,isConcurrencySafe:false,outputSource:'screen',execute:async()=>({ok:false,blocked:true,executor:'stop',code:'native_workflow_stopped',reason:'denied',replay:false})});
 registry.register({name:'LaterTool',description:'',schema:{},isDestructive:true,isConcurrencySafe:false,execute:later});
 const llm=scripted([[{type:'tool_call',id:'1',name:'NativeHost',args:'{}'},{type:'tool_call',id:'2',name:'LaterTool',args:'{}'},{type:'done'}],[{type:'token',text:'The native operation stopped.'},{type:'done'}]]);
 const loop=new AgentLoop(llm,registry,null as any);for await(const _ of loop.execute([{role:'user',content:'Do the task'}],'sys',{maxIterations:3,toolNames:['NativeHost','LaterTool']})){ /* Fixture body intentionally performs no work. */ }
 expect(later).not.toHaveBeenCalled();expect(loop.messages.filter(m=>m.role==='tool').map(m=>m.tool_call_id)).toEqual(['1','2']);
});

test('a model-emitted out-of-scope call cannot execute despite being in the registry', async () => {
 const registry=new ToolRegistry(),mutate=jest.fn(async()=> 'escaped'),native=jest.fn(async()=>({ok:true,operation:'workflow',verified:true}));
 registry.register({name:'BashTool',description:'shell',schema:{type:'object'},isDestructive:true,isConcurrencySafe:false,execute:mutate});
 registry.register({name:'NativeHost',description:'native',schema:{type:'object'},isDestructive:true,isConcurrencySafe:false,outputSource:'screen',execute:native});
 const seen:string[][]=[];let turn=0;
 const llm={userModel:'scripted',applyConfig(){},async *chat(_m:any,opts:any){seen.push(opts.tools.map((t:any)=>t.name));if(turn++===0){yield {type:'tool_call',id:'escape',name:'BashTool',args:'{}'};yield {type:'tool_call',id:'native',name:'NativeHost',args:'{}'};}else yield {type:'token',text:'Verified.'};yield {type:'done'};}} as unknown as LLMProvider;
 const loop=new AgentLoop(llm,registry,null as any);
 for await(const _ of loop.execute([{role:'user',content:'Do native work'}],'sys',{maxIterations:3,toolNames:['NativeHost']})){ /* Fixture body intentionally performs no work. */ }
 expect(mutate).not.toHaveBeenCalled();expect(native).toHaveBeenCalledTimes(1);expect(seen[0]).toEqual(['NativeHost']);
 expect(loop.messages.some(m=>m.role==='tool'&&String(m.content).includes('outside this turn'))).toBe(true);
});

test('explicit-only host tools stay absent in normal schemas and cannot be guessed into a normal turn', async () => {
 const registry=new ToolRegistry(),native=jest.fn(async()=>({ok:true}));
 registry.register({name:'NativeHost',description:'native',schema:{},scopeOnly:true,isDestructive:true,isConcurrencySafe:false,execute:native});registry.discover('NativeHost');
 expect(registry.getSchemas({mode:'smart'})).toEqual([]);expect(registry.getSchemas({mode:'full'})).toEqual([]);expect(registry.getAllSchemas().map(t=>t.name)).toEqual(['NativeHost']);expect(registry.deferredSummary()).toEqual([]);
 const loop=new AgentLoop(scripted([[{type:'tool_call',id:'guess',name:'NativeHost',args:'{}'},{type:'done'}],[{type:'token',text:'Select the capability first.'},{type:'done'}]]),registry,null as any);
 for await(const _ of loop.execute([{role:'user',content:'Normal turn'}],'sys',{maxIterations:3})){ /* Fixture body intentionally performs no work. */ }
 expect(native).not.toHaveBeenCalled();
});
