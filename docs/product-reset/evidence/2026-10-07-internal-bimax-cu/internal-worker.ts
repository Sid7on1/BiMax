import { Worker,MessageChannel } from 'node:worker_threads';
import { createServer } from 'node:http';
import { mkdtempSync,writeFileSync,readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { bindEmbeddedTools } from '../../../../app/src/main/embedded.tools';
import { ComputerUseService } from '../../../../app/src/main/computer.use';
import { CU_TOOL } from '../../../../app/src/main/computer/tool';
async function main(){
 const scratch=mkdtempSync('/private/tmp/bimax-internal-worker-');let requests=0,auxiliaryCalls=0,hostCalls=0,final=false;const received:any[]=[];
 const server=createServer(async(req,res)=>{
  if(req.url?.endsWith('/models')){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'channel-fixture',object:'model',owned_by:'fixture'}]}));return;}
  let body='';for await(const c of req)body+=c;const data=JSON.parse(body);const nativeRound=data.tools?.some((t:any)=>t.function?.name==='BimaxCuTool');
  if(nativeRound) { requests++; assert(data.tools.find((t:any)=>t.function?.name==='BimaxCuTool').function.parameters.properties.operation.enum.includes('workflow')); } else auxiliaryCalls++;assert(!data.tools?.some((t:any)=>t.function?.name?.startsWith('mcp__bimax-arc')));
  const delta=!nativeRound?{role:'assistant',content:'This is a native status operation.'}:requests===1?{role:'assistant',tool_calls:[{index:0,id:'internal-status-1',type:'function',function:{name:'BimaxCuTool',arguments:'{"operation":"status"}'}}]}:{role:'assistant',content:'INTERNAL HOST OK.'};
  if(nativeRound && requests>1)assert(data.messages.some((m:any)=>m.role==='tool'&&String(m.content).includes('verified-private-channel')&&String(m.content).includes('<untrusted source="screen')));
  res.setHeader('content-type','text/event-stream');res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'channel-fixture',choices:[{index:0,delta,finish_reason:null}]})}\n\n`);res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:nativeRound && requests===1?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`);res.end();
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address() as any;
 const {port1,port2}=new MessageChannel(),{port1:hostPort,port2:toolPort}=new MessageChannel();
 const runtime=path.join(path.dirname(path.dirname(process.argv[2])),'cu-runtime');
 const service=new ComputerUseService({runtime,tools:JSON.parse(readFileSync(path.join(runtime,'operations.json'),'utf8')),active:()=>true,accessibility:()=>false,approve:async()=>{throw new Error('Status must not request app permission');}});
 const binding=service.binding('worker-status-proof');let nativeStatus:any;
 const close=bindEmbeddedTools(hostPort,{...binding,execute:async(name,args,signal)=>{assert.equal(name,'BimaxCuTool');assert.deepEqual(args,{operation:'status'});hostCalls++;nativeStatus=await binding.execute(name,args,signal);assert.equal(nativeStatus.name,'Bimax CU');assert.equal(nativeStatus.backend_commit,'74ffae1108b1cb4b1f6b161084af12646f544ba5');assert.equal(nativeStatus.permissions.host_accessibility,false);return{...nativeStatus,receipt:'verified-private-channel'};}});

 const env:any={PATH:process.env.PATH,HOME:process.env.HOME,BIMAX_HEADLESS:'1',BIMAX_CWD:scratch,BIMAX_BREAKGLASS_DIR:path.join(scratch,'profile'),BIMAX_KEY_LEDGER_PATH:'memory',BIMAX_ENGINE_MODULE:process.argv[2],BIMAX_DESKTOP_PROVIDER:'openai',BIMAX_DESKTOP_PROVIDER_BASE_URL:`http://127.0.0.1:${address.port}/v1`,OPENAI_API_KEY:'sk-fixture-not-a-real-key',BIMAX_DESKTOP_STRICT_MODEL:'channel-fixture',BGW_MODEL:'channel-fixture',BIMAX_DISABLE_CODEMEM:'1',BIMAX_DISABLE_CODEBASE_MEMORY:'1',BIMAX_AUTO_INDEX:'0',BIMAX_DRIVES_BOOT:'0',BIMAX_DISABLE_HEADROOM:'1',BGW_PARALLEL_TOOL_CALLS:'false'};
 const worker=new Worker(process.argv[2],{env,workerData:{bimaxEngineRoot:scratch,bimaxEnginePort:port2,bimaxEmbeddedTools:[CU_TOOL],bimaxEmbeddedToolsPort:toolPort},transferList:[port2,toolPort],stdout:true,stderr:true});
 let stderr='';worker.stderr.on('data',c=>{stderr+=String(c).slice(0,1000);});worker.stdout.on('data',()=>{});
 try{
  await new Promise<void>((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error('Internal worker test timed out: '+stderr.slice(-3000))),25000);
   worker.on('error',reject);
   port1.on('message',frame=>{if(typeof frame!=='string')return;port1.postMessage({t:'__ack',bytes:frame.length});const msg=JSON.parse(frame);received.push(msg);
    if(msg.t==='ready')port1.postMessage({t:'input',text:'Use BimaxCuTool status to read the host receipt and report it.'});
    if(frame.includes('INTERNAL HOST OK.')){final=true;clearTimeout(timer);resolve();}
   });
  });
  assert.equal(hostCalls,1);assert.equal(requests,2);assert(final);
  writeFileSync('/private/tmp/arc-proof/worker-channel-receipt.json',JSON.stringify({bundle:process.argv[2],hostCalls,providerCalls:requests,auxiliaryCalls,final,noMcp:true,screenOutputFenced:true,workflowAdvertisedOnProviderWire:true,nativeStatus,hostPermission:'false in this status-only component harness; not an installed-main permission claim',provider:'local deterministic fixture; real bundled Arc status, no saved model or native input'},null,2));
  console.log('PASS actual bundled engine worker → internal Bimax CU port → Mac authority → real frozen Arc Driver status; workflow enum visible on provider wire; result fenced and real agent loop completed. No MCP, saved-model or native-input claim.');
 }finally{close();port1.close();await worker.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
main().catch(e=>{console.error(e);process.exitCode=1});
