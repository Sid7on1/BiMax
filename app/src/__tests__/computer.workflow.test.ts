import { ComputerUseService } from '../main/computer.use';
import { CU_TOOL, computerTool } from '../main/computer/tool';
import { checkToolArgs } from '../../../src/tools/args.validate';

function fixture() {
  let text = '', saves = 0, nonce = 0, active = true, noOp = false, changedBuild = false;
  const inputs: string[] = [], reads: string[] = [];
  const approve = jest.fn(async () => true);
  const driver = { close: jest.fn(), request: jest.fn(async (operation: string, args: any) => {
    reads.push(operation);
    let data: any;
    if (operation === 'apps') data = { apps: [{ pid: 42, bundle_id: 'test.fixture', name: 'Fixture' }] };
    if (operation === 'observe') data = { pid: 42, window_id: 5, snapshot: `s${++nonce}`, elements: [
      { id: 'field', name: 'Message', role: 'TextField', value: text, actions: ['SET_VALUE'] },
      { id: 'save', name: 'Save', role: 'Button', actions: ['CLICK'] },
      { id: 'saved', name: 'Saved', role: 'StaticText', value: saves ? `Saved: ${text}` : 'Not saved', actions: [] },
    ] };
    if (operation === 'act') { inputs.push(args.action); if (!noOp) { if (args.action === 'SET_VALUE') text = args.value; else saves++; } data = { status: 'done' }; }
    return { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
  }) };
  const service = new ComputerUseService({ runtime: '', tools: ['apps','observe','act'].map(name => ({ name, description: '', inputSchema: { type:'object', properties: {} } })),
    active: () => active, approve, accessibility: () => true, driver: () => driver,
    identify: async () => ({ path: '/fixture', sha256: changedBuild ? 'changed' : 'original' }) });
  const plan = { operation: 'workflow', pid: 42, window_id: 5, steps: [
    { action: 'SET_VALUE', control: 'Message', value: 'hello' },
    { action: 'CLICK', control: 'Save', expect: { control: 'Saved', value: 'Saved: hello' } },
  ] };
  const run = (args: any = plan, signal = new AbortController().signal) => service.execute('a', args, signal);
  const begin = (mode: 'do' | 'guide' | 'teach' = 'do') => service.begin('a', { pid: 42, bundle_id: 'test.fixture', name: 'Fixture', window_id: 5, label: 'Fixture', identity: { path: '/fixture', sha256: 'original' } }, mode);
  const human = (value: string, save = false) => { text = value; if (save) saves++; };
  const hostApprovals = () => (approve as jest.Mock).mockImplementation((id: string, app: string, operation: string, signal: AbortSignal) => service.requestApproval(id, app, operation, signal));
  return { service, plan, run, begin, human, hostApprovals, approve, driver, inputs, reads, state: () => ({ text, saves }), noOp: () => { noOp = true; }, replaceBuild: () => { changedBuild = true; }, stop: () => { active = false; service.end('a'); } };
}

test('model schema accepts the compact ordered workflow', () => { const f = fixture(); expect(checkToolArgs(CU_TOOL.schema, f.plan).violations).toEqual([]); });
test('ordered steps independently verify text before saving and actual end-state', async () => {
  const f = fixture(); const result = await f.run();
  expect(result).toMatchObject({ ok: true, verified: true, completedCount: 2 });
  expect(f.inputs).toEqual(['SET_VALUE','CLICK']); expect(f.state()).toEqual({ text: 'hello', saves: 1 });
  expect(f.reads.filter(v => v === 'observe')).toHaveLength(4); expect(f.approve).toHaveBeenCalledTimes(3);
  expect(f.approve.mock.calls[2]).toBeDefined(); f.service.close();
});
test('fake done with no state change is caught and later click never runs', async () => {
  const f = fixture(); f.noOp(); const result = await f.run();
  expect(result).toMatchObject({ ok: false, completedCount: 0, replay: false }); expect(result.reason).toMatch(/Postcondition/);
  expect(f.inputs).toEqual(['SET_VALUE']); expect(f.state().saves).toBe(0); f.service.close();
});
test('identical submitted workflow is refused even after partial native effect', async () => {
  const f = fixture(); f.approve.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  expect(await f.run()).toMatchObject({ ok: false, completedCount: 1 });
  expect(await f.run()).toMatchObject({ ok: false, completedCount: 0 }); expect(f.inputs).toEqual(['SET_VALUE']); f.service.close();
});
test('invalid click plan is refused before any permission or native observation', async () => {
  const f = fixture(); await expect(f.run({ ...f.plan, steps: [{ action: 'CLICK', control: 'Save' }] })).rejects.toThrow(/explicit/);
  expect(f.driver.request).not.toHaveBeenCalled(); expect(f.approve).not.toHaveBeenCalled();
});
test('Stop in the first input approval stops all remaining steps', async () => {
  const f = fixture(); f.approve.mockResolvedValueOnce(true).mockImplementationOnce(async () => { f.stop(); return true; });
  expect(await f.run()).toMatchObject({ ok: false, completedCount: 0 }); expect(f.inputs).toEqual([]); expect(f.driver.close).toHaveBeenCalledTimes(1);
});
test('running executable replacement during approval cannot spend the observed target', async () => {
  const f = fixture(); f.approve.mockResolvedValueOnce(true).mockImplementationOnce(async () => { f.replaceBuild(); return true; });
  const result = await f.run(); expect(result.ok).toBe(false); expect(result.reason).toMatch(/executable changed/); expect(f.inputs).toEqual([]); f.service.close();
});
test('ambiguous control cannot be resolved by choosing the first match', async () => {
  const f = fixture(), original = f.driver.request.getMockImplementation()!;
  f.driver.request.mockImplementation(async (operation, args) => { const result = await original(operation,args); if(operation === 'observe') result.structuredContent.elements.push({...result.structuredContent.elements[0],id:'duplicate'}); return result; });
  const result = await f.run(); expect(result.ok).toBe(false); expect(result.reason).toMatch(/ambiguous/); expect(f.inputs).toEqual([]); f.service.close();
});

test('old engine generation cleanup cannot revoke its replacement', async () => {
  const f = fixture(), first = f.service.binding('a'), second = f.service.binding('a');
  first.close(); await expect(Promise.resolve().then(() => second.execute('BimaxCuTool', f.plan, new AbortController().signal))).resolves.toMatchObject({ok:true});
  expect(() => first.execute('BimaxCuTool', f.plan, new AbortController().signal)).toThrow(/generation/);second.close();
});

test('actual pinned Arc schema accepts SET_VALUE with a union-typed string value', async () => {
  const { validateOperation } = await import('../main/computer/validate');
  expect(() => validateOperation({type:['string','number','boolean']},'hello')).not.toThrow();
  expect(() => validateOperation({type:['string','number','boolean']},{})).toThrow();
});

test('anonymous native status text is verified by unique role plus exact value', async () => {
  const f=fixture(),original=f.driver.request.getMockImplementation()!;
  f.driver.request.mockImplementation(async(op,args)=>{const result=await original(op,args);if(op==='observe')delete result.structuredContent.elements[2].name;return result;});
  f.plan.steps[1].expect={role:'StaticText',value:'Saved: hello'} as any;
  expect(checkToolArgs(CU_TOOL.schema,f.plan).violations).toEqual([]);
  expect(await f.run()).toMatchObject({ok:true,completedCount:2});expect(f.state()).toEqual({text:'hello',saves:1});f.service.close();
});
test('role alone cannot stand in for an explicit click postcondition', async () => {
  const f=fixture();f.plan.steps[1].expect={role:'StaticText'} as any;
  await expect(f.run()).rejects.toThrow();expect(f.inputs).toEqual([]);expect(f.approve).not.toHaveBeenCalled();
});

test('provider wire schema advertises workflow alongside observation operations', async () => {
  const {normalizeToolSchema}=await import('../../../src/core/tool.wire');
  for(const flavor of ['portable','gemini'] as const){
    const schema=normalizeToolSchema(CU_TOOL.schema,flavor);
    expect(schema.properties.operation.enum).toEqual(expect.arrayContaining(['workflow','apps','observe','act']));
    expect(schema.properties.steps.items.properties.expect.anyOf[1].required).toEqual(['role','value']);
  }
});

function flatFixture() {
  const tools = [
    { name: 'apps', description: '', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'windows', description: '', inputSchema: { type: 'object', properties: { pid: { type: 'integer', minimum: 1 } }, required: ['pid'], additionalProperties: false } },
  ];
  const driver = { close: jest.fn(), request: jest.fn(async (name: string, args: any) => ({
    structuredContent: name === 'apps' ? { apps: [{ pid: 42, bundle_id: 'test.fixture', name: 'Fixture' }] } : { windows: [{ window_id: 5, title: 'Fixture' }], pid: args.pid }, content: [],
  })) };
  const approve = jest.fn(async () => true);
  const service = new ComputerUseService({ runtime: '', tools, active: () => true, accessibility: () => true, approve, driver: () => driver });
  const run = (args: any) => service.execute('flat', args, new AbortController().signal);
  return { service, tools, driver, approve, run };
}

test('advertised flat PID reaches native windows with the actual app grant', async () => {
  const f = flatFixture(), args = { operation: 'windows', pid: 42 };
  expect(checkToolArgs(computerTool(f.tools).schema, args).violations).toEqual([]);
  expect(await f.run(args)).toMatchObject({ pid: 42, windows: [{ window_id: 5 }] });
  expect(f.driver.request).toHaveBeenCalledWith('windows', { pid: 42 }); expect(f.approve).toHaveBeenCalledTimes(1); f.service.close();
});
test('legacy nested native arguments remain valid', async () => {
  const f = flatFixture(); expect(await f.run({ operation: 'windows', arguments: { pid: 42 } })).toMatchObject({ pid: 42 }); f.service.close();
});
test('mixed flat/nested target IDs refuse before any driver or app approval', async () => {
  const f = flatFixture(); expect(await f.run({ operation: 'windows', pid: 42, arguments: { pid: 99 } })).toMatchObject({ ok: false, blocked: true, executor: 'stop' });
  expect(f.driver.request).not.toHaveBeenCalled(); expect(f.approve).not.toHaveBeenCalled(); f.service.close();
});
test('flat unknown read fields are correctable failures before native execution', async () => {
  const f = flatFixture(); const result = await f.run({ operation: 'windows', pid: 42, invented: true });
  expect(result).toMatchObject({ ok: false, code: 'native_arguments_invalid' }); expect(result.executor).toBeUndefined();
  expect(f.driver.request).not.toHaveBeenCalled(); expect(f.approve).not.toHaveBeenCalled(); f.service.close();
});

test('missing read PID can be corrected in the same turn without input replay', async () => {
  const f = flatFixture(); const result = await f.run({ operation: 'windows' });
  expect(result).toMatchObject({ ok: false, code: 'native_arguments_invalid', required: ['pid'] });
  expect(result.executor).toBeUndefined(); expect(result.recovery).toContain('apps');
  expect(f.driver.request).not.toHaveBeenCalled(); expect(f.approve).not.toHaveBeenCalled();
  expect(await f.run({ operation: 'windows', pid: 42 })).toMatchObject({ pid: 42 });
  expect(f.driver.request.mock.calls.filter(([operation]) => operation === 'windows')).toHaveLength(1);
  f.service.close();
});
test('denied read consent still stops the native task and never reaches windows', async () => {
  const f = flatFixture(); f.approve.mockResolvedValue(false);
  expect(await f.run({ operation: 'windows', pid: 42 })).toMatchObject({ ok: false, executor: 'stop', blocked: true });
  expect(f.driver.request.mock.calls.some(([operation]) => operation === 'windows')).toBe(false); f.service.close();
});
test('invalid native input remains terminal with zero native calls', async () => {
  const f = fixture();
  expect(await f.run({ operation: 'act', invented: true })).toMatchObject({ ok: false, executor: 'stop' });
  expect(f.driver.request).not.toHaveBeenCalled(); expect(f.approve).not.toHaveBeenCalled(); f.service.close();
});
test('provider optional nulls cannot override an actual flat target', async () => {
  const f = flatFixture(); expect(await f.run({ operation: 'windows', pid: 42, arguments: null, steps: null })).toMatchObject({ pid: 42 }); f.service.close();
});

async function phase(f: ReturnType<typeof fixture>, wanted: string) {
  for (let i = 0; i < 200; i++) { const state = f.service.state('a'); if (state?.phase === wanted) return state; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`Phase ${wanted} was never reached: ${JSON.stringify(f.service.state('a'))}`);
}
function press(f: ReturnType<typeof fixture>, action: import('../shared/computer').ComputerControl, candidate?: number) {
  return f.service.control('a', f.service.state('a')!.revision, action, candidate);
}

test('Guide checks two real human effects and dispatches zero native inputs', async () => {
  const f = fixture(); f.begin('guide'); const pending = f.run();
  const first = await phase(f, 'waiting-user'); expect(first.step).toContain('Message'); expect(f.inputs).toEqual([]);
  f.human('hello'); expect(press(f, 'check')).toBe(true);
  const second = await phase(f, 'waiting-user'); expect(second.step).toContain('Save');
  f.human('hello', true); press(f, 'check');
  expect(await pending).toMatchObject({ok:true,mode:'guide',completedCount:2,completed:[{input:false},{input:false}]});
  expect(f.inputs).toEqual([]); expect(f.state()).toEqual({text:'hello',saves:1}); f.service.close();
});
test('Guide rejects direct act and never confuses Check step with proof', async () => {
  const f = fixture(); f.begin('guide');
  const view=await f.run({operation:'observe',pid:42,window_id:5});
  expect(await f.run({operation:'act',snapshot:view.snapshot,element:'field',action:'SET_VALUE',value:'unsafe'})).toMatchObject({ok:false}); expect(f.inputs).toEqual([]);
  const pending=f.run(); await phase(f,'waiting-user'); press(f,'check');
  const next=await phase(f,'waiting-user'); expect(next.reason).toContain('Perform'); expect(f.inputs).toEqual([]);
  press(f,'stop'); expect(await pending).toMatchObject({ok:false,completedCount:0,replay:false}); f.service.close();
});
test('Take over revokes pending approval; resume reobserves and asks again without replay', async () => {
  const f=fixture(); f.begin(); let approvalSignal: AbortSignal | undefined;
  (f.approve as jest.Mock).mockImplementationOnce(async()=>true).mockImplementationOnce(async (...args: any[]) => {
    approvalSignal=args[3]; return new Promise<boolean>(resolve=>approvalSignal!.addEventListener('abort',()=>resolve(false),{once:true}));
  });
  const pending=f.run();
  for(let i=0;i<100&&!approvalSignal;i++)await new Promise(resolve=>setTimeout(resolve,5));
  expect(approvalSignal).toBeDefined(); const old=f.service.state('a')!.revision;
  expect(press(f,'takeover')).toBe(true); expect(approvalSignal!.aborted).toBe(true);
  await new Promise(resolve=>setTimeout(resolve,20)); expect(f.inputs).toEqual([]);
  expect(f.service.control('a',old,'resume')).toBe(false);
  expect(press(f,'resume')).toBe(true); expect(await pending).toMatchObject({ok:true,completedCount:2});
  expect(f.inputs).toEqual(['SET_VALUE','CLICK']); expect(f.approve.mock.calls.length).toBeGreaterThan(3); f.service.close();
});
test('Pause after a dispatched input never dispatches it twice or advances to Save', async () => {
  const f=fixture();f.begin(); const original=f.driver.request.getMockImplementation()!;
  let release: (()=>void)|undefined;
  f.driver.request.mockImplementation(async(op,args)=>{const result=await original(op,args);if(op==='act'&&!release){await new Promise<void>(resolve=>{release=resolve;});}return result;});
  const pending=f.run();for(let i=0;i<100&&!release;i++)await new Promise(resolve=>setTimeout(resolve,5));
  expect(release).toBeDefined();press(f,'pause');release!();await new Promise(resolve=>setTimeout(resolve,20));
  expect(f.inputs).toEqual(['SET_VALUE']);expect(f.state().saves).toBe(0);
  press(f,'resume');expect(await pending).toMatchObject({ok:true});expect(f.inputs).toEqual(['SET_VALUE','CLICK']);f.service.close();
});
test('Model incorrect expected status is reconciled by read-only explicit correction', async () => {
  const f=fixture();f.begin();f.plan.steps[1].expect={role:'StaticText',value:'Saved'} as any;
  const pending=f.run();const state=await phase(f,'verification');
  expect(state.expected).toContain('Saved');expect(state.candidates).toEqual([{role:'StaticText',value:'Saved: hello'}]);
  expect(f.inputs).toEqual(['SET_VALUE','CLICK']);expect(f.state().saves).toBe(1);
  expect(press(f,'correct',9)).toBe(false);expect(press(f,'correct',0)).toBe(true);
  expect(await pending).toMatchObject({ok:true,verification:'user-corrected-expectation',completedCount:2});
  expect(f.inputs).toEqual(['SET_VALUE','CLICK']);expect(f.state().saves).toBe(1);f.service.close();
});
test('Correction must still match fresh state; stale changed status never passes or replays', async () => {
  const f=fixture();f.begin();f.plan.steps[1].expect={role:'StaticText',value:'Saved'} as any;
  const pending=f.run();await phase(f,'verification');f.human('wrong');press(f,'correct',0);
  expect(await pending).toMatchObject({ok:false,replay:false});expect(f.inputs).toEqual(['SET_VALUE','CLICK']);f.service.close();
});
test('No-op done remains a failure with zero later actions and no correction offered', async () => {
  const f=fixture();f.begin();f.noOp();expect(await f.run()).toMatchObject({ok:false,completedCount:0});
  expect(f.service.state('a')?.phase).toBe('failed');expect(f.inputs).toEqual(['SET_VALUE']);f.service.close();
});
test('Abort releases Guide wait and preserves zero native effects', async()=>{
  const f=fixture();f.begin('guide');const abort=new AbortController(),pending=f.run(f.plan,abort.signal);
  await phase(f,'waiting-user');abort.abort();expect(await pending).toMatchObject({ok:false,replay:false});expect(f.inputs).toEqual([]);f.service.close();
});
test('Paused workflow does not hold the global native queue', async()=>{
  const f=fixture();f.begin('guide');const pending=f.run();await phase(f,'waiting-user');press(f,'pause');
  expect(await f.service.execute('other',{operation:'apps'},new AbortController().signal)).toMatchObject({apps:[{pid:42}]});
  press(f,'stop');await pending;f.service.close();
});
test('Executable replacement during takeover blocks resumed input',async()=>{
  const f=fixture();f.begin('guide');const pending=f.run();await phase(f,'waiting-user');press(f,'takeover');f.replaceBuild();press(f,'resume');f.human('hello');press(f,'check');
  expect(await pending).toMatchObject({ok:false,replay:false});expect(f.inputs).toEqual([]);f.service.close();
});
test('Teach produces reusable literal instructions only after fresh verification',async()=>{
  const f=fixture();f.begin('teach');expect(f.service.state('a')?.recipe).toBeUndefined();
  expect(await f.run()).toMatchObject({ok:true,mode:'teach'});const state=f.service.state('a')!;
  expect(state.phase).toBe('complete');expect(state.recipe).toContain('@CU ');expect(state.recipe).toContain('Saved: hello');expect(state.recipe).not.toMatch(/"pid"|"snapshot"|"element"/);f.service.close();
});
test('Twenty distinct ordered values maintain one Save each against independent fixture state',async()=>{
  for(let i=0;i<20;i++){
    const f=fixture();f.begin();f.plan.steps[0].value=`case-${i}`;f.plan.steps[1].expect!.value=`Saved: case-${i}`;
    expect(await f.run()).toMatchObject({ok:true,verification:'exact',completedCount:2});
    expect(f.state()).toEqual({text:`case-${i}`,saves:1});expect(f.inputs).toEqual(['SET_VALUE','CLICK']);f.service.close();
  }
});

test('Guide incorrect literal after a human Save offers correction without instructing a repeat',async()=>{
  const f=fixture();f.begin('guide');f.plan.steps[1].expect={role:'StaticText',value:'Saved'} as any;
  const pending=f.run();await phase(f,'waiting-user');f.human('hello');press(f,'check');await phase(f,'waiting-user');f.human('hello',true);press(f,'check');
  await phase(f,'verification');press(f,'correct',0);expect(await pending).toMatchObject({ok:true,mode:'guide',verification:'user-corrected-expectation'});expect(f.inputs).toEqual([]);expect(f.state().saves).toBe(1);f.service.close();
});
test('Concurrent model input is refused while a workflow waits on human controls',async()=>{
  const f=fixture();f.begin('guide');const pending=f.run();await phase(f,'waiting-user');
  expect(await f.run({operation:'act',action:'CLICK'})).toMatchObject({ok:false,code:'native_workflow_busy'});expect(f.inputs).toEqual([]);press(f,'stop');await pending;f.service.close();
});

test('Actual panel approval can pause, revoke stale Allow, resume and ask afresh', async()=>{
  const f=fixture();f.begin();f.hostApprovals();const pending=f.run();
  const read=await phase(f,'approval');expect(read.approval!.operation).toContain('Read this app');press(f,'allow');
  const input=await phase(f,'approval');expect(input.approval!.operation).toContain('SET_VALUE');press(f,'pause');
  expect(f.service.control('a',input.revision,'allow')).toBe(false);await new Promise(resolve=>setTimeout(resolve,20));expect(f.inputs).toEqual([]);
  press(f,'resume');const reread=await phase(f,'approval');expect(reread.approval!.operation).toContain('Read this app');press(f,'allow');
  await phase(f,'approval');press(f,'allow');const save=await phase(f,'approval');expect(save.approval!.operation).toContain('CLICK');press(f,'allow');
  expect(await pending).toMatchObject({ok:true});expect(f.inputs).toEqual(['SET_VALUE','CLICK']);f.service.close();
});
test('Deny in the actual approval panel stops before any input',async()=>{
  const f=fixture();f.begin();f.hostApprovals();const pending=f.run();await phase(f,'approval');press(f,'allow');await phase(f,'approval');press(f,'deny');
  expect(await pending).toMatchObject({ok:false,replay:false});expect(f.inputs).toEqual([]);f.service.close();
});

test('Teach save is host-owned, revision-bound and available only after completion',async()=>{
  const f=fixture();f.begin('teach');const save=jest.fn(async()=> 'My workflow');(f.service as any).options.saveRecipe=save;
  expect(await f.service.saveRecipe('a',f.service.state('a')!.revision,'My workflow')).toBe(false);
  await f.run();const revision=f.service.state('a')!.revision;
  expect(await f.service.saveRecipe('a','stale','My workflow')).toBe(false);
  expect(await f.service.saveRecipe('a',revision,'My workflow')).toBe(true);
  expect(await f.service.saveRecipe('a',revision,'My workflow')).toBe(false);expect(save).toHaveBeenCalledTimes(1);
  expect(save.mock.calls[0]).toBeDefined();f.service.close();
});
