import { ArcTransport } from '/Users/vishsiddharth/Bimax/app/src/main/arc.transport';
import { ArcService } from '/Users/vishsiddharth/Bimax/app/src/main/arc.service';
import { createThreadBroker } from '/Users/vishsiddharth/Bimax/app/src/main/thread.broker';
import { registerMcpTools } from '/Users/vishsiddharth/Bimax/src/mcp/client';
import { ToolRegistry } from '/Users/vishsiddharth/Bimax/src/tools/tool.registry';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const runtime = process.argv[2];
async function main() {
 let active = true; const approvals: any[] = [];
 const arc = new ArcService({ runtime, tools: JSON.parse(readFileSync(path.join(runtime,'tools.json'),'utf8')),
  active: () => active, accessibility: () => true,
  ...(process.env.ARC_PROOF_NOOP === '1' ? { driver: () => {
    const actual = new ArcTransport(path.join(runtime, 'bimax-arc-cua', 'bimax-arc-cua'));
    return { close: () => actual.close(), request: (method: string, params: any) => params?.name === 'act'
      ? Promise.resolve({ structuredContent: { status: 'done' }, content: [{ type: 'text', text: '{"status":"done"}' }] })
      : actual.request(method, params) };
  } } : {}),
  approve: async (id, application, operation) => { approvals.push({ id, application, operation }); assert.equal(application,'Arc Fixture'); return true; } });
 const manager = { get: () => ({ summary: { root: '/private/tmp/arc-proof' } }) } as any;
 const broker = await createThreadBroker(manager, undefined, { arc: (id,message,signal) => arc.handle(id,message,signal) });
 const specs = JSON.parse(arc.environment(broker.environment('fixture-turn'), process.execPath).BIMAX_HOST_CAPABILITIES_JSON);
 const registry = new ToolRegistry(), governor = { approveTaskExecution: async () => {} } as any;
 let connections: any[] = [];
 try {
  connections = await registerMcpTools(specs, registry, governor);
  assert.equal(connections.length,1); assert.equal(connections[0].toolNames.length,16);
  const call = async (name:string,args:any={}) => JSON.parse(await registry.getTool(`mcp__bimax-arc__${name}`)!.execute(args,{cwd:'/private/tmp/arc-proof'}));
  const status = await call('status'); assert.equal(status.version,'0.1.1'); assert.equal(status.permissions.accessibility,true);
  const apps = await call('apps'); const fixture = apps.apps.find((a:any)=>a.bundle_id==='org.arc.proof.fixture'); assert(fixture);
  const before = JSON.parse(readFileSync('/private/tmp/arc-proof/state.json','utf8')); assert.equal(before.saves,0);
  const view = await call('observe',{pid:fixture.pid});
  const field = view.elements.find((e:any)=>e.name==='Verification message'); assert(field);
  const token='arc-native-proof-20261007';
  await call('act',{snapshot:view.snapshot,action:'SET_VALUE',element:field.id,value:token});
  const filled = await call('observe',{pid:fixture.pid}); assert.equal(filled.elements.find((e:any)=>e.id===field.id).value,token);
  const button = filled.elements.find((e:any)=>e.name==='Save verification'); assert(button);
  await call('act',{snapshot:filled.snapshot,action:'CLICK',element:button.id});
  const after = JSON.parse(readFileSync('/private/tmp/arc-proof/state.json','utf8')); assert.deepEqual(after,{saves:1,text:token});
  const final = await call('observe',{pid:fixture.pid}); assert(final.elements.some((e:any)=>e.value===`Saved: ${token}`));
  await assert.rejects(call('act',{snapshot:filled.snapshot,action:'CLICK',element:button.id}));
  active=false;arc.end('fixture-turn'); await assert.rejects(call('act',{snapshot:final.snapshot,action:'CLICK',element:button.id}));
  assert.deepEqual(JSON.parse(readFileSync('/private/tmp/arc-proof/state.json','utf8')),after);
  writeFileSync('/private/tmp/arc-proof/native-receipt.json',JSON.stringify({runtime,toolNames:connections[0].toolNames,status,before,after,final,approvals,deniedReuse:true,stoppedInput:true},null,2));
  console.log('PASS: actual MCP proxy → authenticated broker → Mac host authority → frozen arc Driver → persistent native fixture state; reuse and Stop make no extra save.');
 } finally { arc.close(); for(const conn of connections) await conn.client.close();broker.close(); }
}
main().catch(e=>{console.error(e);process.exitCode=1});
