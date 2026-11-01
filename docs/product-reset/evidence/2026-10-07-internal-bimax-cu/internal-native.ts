import { ComputerUseService } from '../../../../app/src/main/computer.use';
import { ComputerUseTransport } from '../../../../app/src/main/computer/transport';
import { bindEmbeddedTools } from '../../../../app/src/main/embedded.tools';
import { registerEmbeddedHostTools } from '../../../../src/tools/embedded.host';
import { ToolRegistry } from '../../../../src/tools/tool.registry';
import { MessageChannel } from 'node:worker_threads';
import { readFileSync,writeFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
async function main(){
 const runtime=process.argv[2];let active=true;const approvals:any[]=[];
 const service=new ComputerUseService({runtime,tools:JSON.parse(readFileSync(path.join(runtime,'operations.json'),'utf8')),active:()=>active,accessibility:()=>true,
  ...(process.env.BIMAX_PROOF_NOOP==='1'?{driver:()=>{const driver=new ComputerUseTransport(path.join(runtime,'bimax-cu','bimax-cu'));return {close:()=>driver.close(),request:(op:string,args:any)=>op==='act'?Promise.resolve({structuredContent:{status:'done'},content:[]}):driver.request(op,args)};}}:{}),
  approve:async(id,app,operation)=>{assert.equal(app,'Arc Fixture');approvals.push({id,app,operation});return true;}});
 const {port1,port2}=new MessageChannel(),binding=service.binding('proof');const close=bindEmbeddedTools(port1,binding);
 const registry=new ToolRegistry();registerEmbeddedHostTools(registry,{approveTaskExecution:async()=>{throw new Error('MCP/governor cannot own native approval');}} as any,{bimaxEngineRoot:'/private/tmp/arc-proof',bimaxEnginePort:port2,bimaxEmbeddedToolsPort:port2,bimaxEmbeddedTools:binding.tools});
 const call=async(operation:string,args:any={})=>registry.getTool('BimaxCuTool')!.execute({operation,arguments:args},{});
 try{
  assert.deepEqual(registry.getToolNames(),['BimaxCuTool']);const status=await call('status');assert.equal(status.name,'Bimax CU');assert.equal(status.permissions.accessibility,true);
  const apps=await call('apps'),fixture=apps.apps.find((a:any)=>a.bundle_id==='org.arc.proof.fixture');assert(fixture);
  const before=JSON.parse(readFileSync('/private/tmp/arc-proof/state.json','utf8'));assert.equal(before.saves,0);
  const windows=await call('windows',{pid:fixture.pid}),window=windows.windows.find((w:any)=>w.title==='Arc Driver Verification');assert(window);
  const initial=await call('observe',{pid:fixture.pid,window_id:window.window_id});assert(initial.elements.some((e:any)=>e.name==='Verification message'));
  const token='bimax-integrated-workflow-20261007',plan={operation:'workflow',pid:fixture.pid,window_id:window.window_id,steps:[{action:'SET_VALUE',control:'Verification message',value:token},{action:'CLICK',control:'Save verification',expect:{role:'StaticText',value:`Saved: ${token}`}}]};
  const result=await registry.getTool('BimaxCuTool')!.execute(plan,{});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.completedCount,2);
  const after=JSON.parse(readFileSync('/private/tmp/arc-proof/state.json','utf8'));assert.deepEqual(after,{saves:1,text:token});
  const repeat=await registry.getTool('BimaxCuTool')!.execute(plan,{});assert.equal(repeat.ok,false);assert.deepEqual(JSON.parse(readFileSync('/private/tmp/arc-proof/state.json','utf8')),after);
  active=false;service.end('proof');assert.equal((await call('act',{snapshot:result.final.snapshot,element:'invented',action:'CLICK'})).ok,false);assert.deepEqual(JSON.parse(readFileSync('/private/tmp/arc-proof/state.json','utf8')),after);
  writeFileSync('/private/tmp/arc-proof/internal-receipt.json',JSON.stringify({runtime,status,before,after,plan,result,approvals,noMcp:true,replayRefused:true,stopRefused:true},null,2));
  console.log('PASS internal Bimax CU → MessagePort → Mac authority → actual Arc Driver. Ordered SET_VALUE/CLICK and independently persisted single Save proved; replay and Stop refused.');
 }finally{close();port2.close();service.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1});
