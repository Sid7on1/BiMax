import { ComputerUseService } from '../main/computer.use';
import { computerTool } from '../main/computer/tool';
import { checkToolArgs } from '../../../src/tools/args.validate';
import { writeFileSync } from 'node:fs';

const records: any[] = [];
afterAll(() => { if (process.env.BIMAX_MESSAGE_TEST_RECEIPT) writeFileSync(process.env.BIMAX_MESSAGE_TEST_RECEIPT, JSON.stringify({ scope: 'deterministic host contracts; not native/provider/WhatsApp qualification', records }, null, 2)); });
function fixture(existing = 0) {
  let recipient = 'Mom demo', draft = '', serial = 0, sends = 0, mode = 'normal', active = true, delay = 0;
  const messages = [{id:'old-cue',recipient,text:'older example'}, ...Array.from({length: existing}, (_, index) => ({ id: `old-${index}`, recipient, text: 'hi' }))];
  const inputs: any[] = [], approvals: string[] = [];
  let afterApproval: (() => void) | undefined;
  const tools = ['apps','observe','act','press','click_at','type_text'].map(name => ({name, description:'', inputSchema:{type:'object',properties:{}}}));
  const driver = { close: jest.fn(), request: jest.fn(async (operation: string, args: any) => {
    let data: any;
    if(operation === 'apps') data = {apps:[{pid:42,bundle_id:'test.whatsapp.fixture',name:'Message Fixture'}]};
    if(operation === 'observe') {
      const visible = messages.filter(m => m.recipient === recipient && !(delay-- > 0 && m.id.startsWith('new-')));
      data = {pid:42,window_id:5,snapshot:`s${++serial}`,elements:[
        {id:`r-${serial}`,name:'Conversation',role:'StaticText',value:recipient,actions:[]},
        {id:`d-${serial}`,name:'Message',role:'TextField',value:draft,actions:['SET_VALUE']},
        {id:`b-${serial}`,name:'Send',role:'Button',actions:['CLICK']},
        ...visible.map(m=>({id:m.id,name:'Outgoing message',role:'StaticText',value:m.text,actions:[]})),
      ]};
      if(mode === 'ambiguous') data.elements.push({...data.elements[0],id:'duplicate-recipient'});
    }
    if(operation === 'act') {
      // Input must have been rebound to the observation taken AFTER approval.
      expect(args.element).toBe(`${args.action === 'SET_VALUE' ? 'd' : 'b'}-${serial}`);
      inputs.push({...args,recipient});
      if(args.action === 'SET_VALUE') draft=args.value;
      else {
        sends++;
        if(mode !== 'noop' && mode !== 'clear-only') messages.push({id:`new-${sends}`,recipient:mode === 'wrong-target'?'Other demo':recipient,text:draft});
        if(mode === 'duplicate') messages.push({id:`duplicate-${sends}`,recipient,text:draft});
        if(mode !== 'retain-draft') draft='';
        if(mode === 'unknown') throw new Error('Driver disconnected after Send');
        if(mode === 'delayed') delay=2;
      }
      data={status:'done'};
    }
    return {structuredContent:data,content:[]};
  })};
  let service: ComputerUseService;
  const approve = jest.fn(async (_id:string,_app:string,description:string,signal:AbortSignal) => {
    approvals.push(description);
    if(description.includes('CLICK')) afterApproval?.();
    return !signal.aborted;
  });
  service = new ComputerUseService({runtime:'',tools,active:()=>active,accessibility:()=>true,approve,driver:()=>driver,identify:async()=>({path:'/fixture',sha256:'original'})});
  service.begin('message', {pid:42,window_id:5,bundle_id:'test.whatsapp.fixture',name:'Message Fixture',label:'Fixture',identity:{path:'/fixture',sha256:'original'}});
  const message = {recipient:{control:'Conversation',value:'Mom demo'},draft:{control:'Message',value:'hi'},outgoing:{control:'Outgoing message',role:'StaticText',value:'hi'}};
  const plan:any = {operation:'workflow',pid:42,window_id:5,steps:[{action:'SET_VALUE',control:'Message',value:'hi'},{action:'SEND_MESSAGE',control:'Send',message}]};
  const run=(value=plan,signal=new AbortController().signal)=>service.execute('message',value,signal);
  const state=()=>({recipient,draft,sends,messages:structuredClone(messages)});
  return {service,driver,tools,approve,approvals,inputs,plan,message,run,state,setMode:(value:string)=>{mode=value;},setRecipient:(value:string)=>{recipient=value;},setDraft:(value:string)=>{draft=value;},addMessage:()=>{messages.push({id:'human',recipient,text:'hi'});},afterApproval:(fn:()=>void)=>{afterApproval=fn;},stop:()=>{active=false;service.end('message');}};
}

for(let existing=0;existing<20;existing++) test(`message clears its draft and adds exactly one outgoing row with ${existing} identical old rows`,async()=>{
  const f=fixture(existing),before=f.state();
  expect(checkToolArgs(computerTool(f.tools).schema,f.plan).violations).toEqual([]);
  const result=await f.run(),after=f.state();
  expect(result).toMatchObject({ok:true,verified:true,completedCount:2,messageVerification:{recipient:'Mom demo',text:'hi',beforeCount:existing,afterCount:existing+1,outcome:'observed-outgoing',delivery:'unconfirmed'}});
  expect(after).toEqual({recipient:'Mom demo',draft:'',sends:1,messages:[...before.messages,{id:'new-1',recipient:'Mom demo',text:'hi'}]});
  expect(f.inputs.map(v=>v.action)).toEqual(['SET_VALUE','CLICK']);
  expect(f.approvals).toHaveLength(3);expect(f.approvals[2]).toContain('Intended recipient: "Mom demo"');
  expect(result.messageVerification.afterSnapshot).not.toBe(result.messageVerification.beforeSnapshot);
  records.push({case:`existing-identical-${existing}`,before,after,result,inputs:f.inputs,approvals:f.approvals});f.service.close();
});

test.each(['noop','clear-only','duplicate','wrong-target','retain-draft'])('%s cannot be accepted as a verified send or corrected status',async mode=>{
  const f=fixture(1);f.setMode(mode);const result=await f.run();
  expect(result).toMatchObject({ok:false,replay:false,completedCount:1,executor:'stop'});
  expect(result.reason).toContain('Do not send again');expect(f.state().sends).toBe(1);
  expect(f.service.state('message')?.phase).toBe('failed');expect(f.service.state('message')?.candidates).toBeUndefined();
  records.push({case:mode,result,after:f.state(),inputs:f.inputs});f.service.close();
});

test('delayed outgoing evidence is reread without repeating Send',async()=>{
  const f=fixture();f.setMode('delayed');expect(await f.run()).toMatchObject({ok:true,completedCount:2});expect(f.state().sends).toBe(1);f.service.close();
});
test.each(['Other demo',''])('wrong or absent recipient %s cannot even receive a draft edit',async recipient=>{
  const f=fixture();f.setRecipient(recipient);const result=await f.run();expect(result.ok).toBe(false);expect(f.inputs).toEqual([]);expect(f.state().messages).toEqual([{id:'old-cue',recipient:'Mom demo',text:'older example'}]);f.service.close();
});
test('duplicate recipient evidence cannot choose the first contact',async()=>{
  const f=fixture();f.setMode('ambiguous');expect((await f.run()).ok).toBe(false);expect(f.inputs).toEqual([]);f.service.close();
});
test.each(['recipient','draft','outgoing'])('%s change during Send approval prevents native Send',async change=>{
  const f=fixture();f.afterApproval(()=>{if(change==='recipient')f.setRecipient('Other demo');else if(change==='draft')f.setDraft('changed by person');else f.addMessage();});
  const result=await f.run();expect(result.ok).toBe(false);expect(f.inputs.map(v=>v.action)).toEqual(['SET_VALUE']);expect(f.state().sends).toBe(0);f.service.close();
});
test('recipient change during draft approval prevents any input',async()=>{
  const f=fixture();f.approve.mockImplementation(async(_id,_app,description)=>{if(description.includes('SET_VALUE'))f.setRecipient('Other demo');return true;});
  expect((await f.run()).ok).toBe(false);expect(f.inputs).toEqual([]);f.service.close();
});
test('unknown completion after native side effect is never retried, even under a changed plan',async()=>{
  const f=fixture();f.setMode('unknown');const result=await f.run();
  expect(result).toMatchObject({ok:false,replay:false,completedCount:1});expect(f.state().sends).toBe(1);expect(f.state().messages).toHaveLength(2);
  const retry=structuredClone(f.plan);retry.steps[1].role='Button';expect((await f.run(retry)).ok).toBe(false);expect(f.state().sends).toBe(1);f.service.close();
});
test('direct Send and Return bypasses are refused before input',async()=>{
  for(const operation of ['act','press','click_at','type_text']){
    const f=fixture();const view=await f.service.perform('message','observe',{pid:42,window_id:5},new AbortController().signal);
    const result=await f.run({operation,snapshot:view.structuredContent.snapshot,element:`b-1`,action:'CLICK',key:'Return',text:'hi',x:1,y:1});
    expect(result.ok).toBe(false);expect(f.inputs).toEqual([]);expect(f.driver.request.mock.calls.some(([op])=>op===operation)).toBe(false);f.service.close();
  }
});
test('invalid message evidence and extra actions refuse before observing or granting',async()=>{
  for(const mutate of [(p:any)=>delete p.steps[1].message.recipient,(p:any)=>p.steps[1].message.outgoing.value='other',(p:any)=>p.steps.unshift({action:'CLICK',control:'Other contact',expect:{control:'Conversation',value:'Mom demo'}})]){
    const f=fixture();mutate(f.plan);await expect(f.run()).rejects.toThrow();expect(f.driver.request).not.toHaveBeenCalled();expect(f.approvals).toEqual([]);f.service.close();
  }
});
test('Stop during Send approval preserves the draft and submits no send',async()=>{
  const f=fixture();f.afterApproval(()=>f.stop());expect((await f.run()).ok).toBe(false);expect(f.state()).toMatchObject({draft:'hi',sends:0,messages:[{id:'old-cue',recipient:'Mom demo',text:'older example'}]});f.service.close();
});

async function waitPhase(f:ReturnType<typeof fixture>,phase:string){for(let i=0;i<100;i++){const state=f.service.state('message');if(state?.phase===phase)return state;await new Promise(resolve=>setTimeout(resolve,2));}throw new Error(`No ${phase}`);}
function hostApprovals(f:ReturnType<typeof fixture>){f.approve.mockImplementation((id,app,description,signal)=>f.service.requestApproval(id,app,description,signal));}
async function allow(f:ReturnType<typeof fixture>){const s=await waitPhase(f,'approval');expect(f.service.control('message',s.revision,'allow')).toBe(true);}
test('Pause during Send approval revokes stale Allow; Resume rereads and asks again without duplicate Send',async()=>{
  const f=fixture();hostApprovals(f);const promise=f.run();await allow(f);await allow(f);
  const send=await waitPhase(f,'approval');expect(send.approval?.operation).toContain('Send: "hi"');
  expect(f.service.control('message',send.revision,'pause')).toBe(true);expect(f.service.control('message',send.revision,'allow')).toBe(false);
  expect(f.state().sends).toBe(0);const paused=f.service.state('message')!;expect(f.service.control('message',paused.revision,'resume')).toBe(true);
  await allow(f);await allow(f);expect(await promise).toMatchObject({ok:true,completedCount:2});expect(f.state().sends).toBe(1);f.service.close();
});
test('Guide checks one human send with no native input or message-proof override',async()=>{
  const f=fixture();f.service.begin('message',{pid:42,window_id:5,bundle_id:'test.whatsapp.fixture',name:'Message Fixture',label:'Fixture',identity:{path:'/fixture',sha256:'original'}},'guide');
  const promise=f.run();let state=await waitPhase(f,'waiting-user');f.setDraft('hi');f.service.control('message',state.revision,'check');state=await waitPhase(f,'waiting-user');
  // This failed human send must stop, rather than interpreting an arbitrary status as success.
  f.setDraft('');f.service.control('message',state.revision,'check');expect(await promise).toMatchObject({ok:false,completedCount:1});expect(f.inputs).toEqual([]);f.service.close();
});

test.each(['foreign-window','stale-snapshot','disabled-control'])('%s after Send approval is rejected before submission',async fault=>{
  const f=fixture(),original=f.driver.request.getMockImplementation()!;
  f.driver.request.mockImplementation(async(op,args)=>{const result=await original(op,args);if(op==='observe'&&f.approvals.some(v=>v.includes('CLICK'))){const data=result.structuredContent;if(fault==='foreign-window')data.window_id=99;else if(fault==='stale-snapshot')data.snapshot='s4';else data.elements.find((e:any)=>e.name==='Send').enabled=false;}return result;});
  expect((await f.run()).ok).toBe(false);expect(f.state().sends).toBe(0);expect(f.inputs).toHaveLength(1);f.service.close();
});
test('Pause after Send submission waits for Resume and verifies without replay',async()=>{
  const f=fixture(),original=f.driver.request.getMockImplementation()!;
  let resumeNative!:()=>void;const hold=new Promise<void>(resolve=>{resumeNative=resolve;});let submitted!:()=>void;const started=new Promise<void>(resolve=>{submitted=resolve;});
  f.driver.request.mockImplementation(async(op,args)=>{const result=await original(op,args);if(op==='act'&&args.action==='CLICK'){submitted();await hold;}return result;});
  const promise=f.run();await started;const state=f.service.state('message')!;
  expect(f.service.control('message',state.revision,'pause')).toBe(true);resumeNative();await Promise.resolve();
  expect(f.state().sends).toBe(1);const paused=f.service.state('message')!;expect(f.service.control('message',paused.revision,'resume')).toBe(true);
  expect(await promise).toMatchObject({ok:true,completedCount:2});expect(f.state().sends).toBe(1);f.service.close();
});

test('an invented outgoing role is refused before Send, rather than discovering the mistake after a side effect',async()=>{
  const f=fixture();f.message.outgoing.role='Unknown';expect((await f.run()).ok).toBe(false);expect(f.state().sends).toBe(0);expect(f.inputs.map(v=>v.action)).toEqual(['SET_VALUE']);f.service.close();
});
