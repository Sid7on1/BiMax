import { readFileSync } from 'node:fs';
import path from 'node:path';
import { computerRequest, computerCompletion } from '../shared/computer';
import { ComputerTargetPicker, type NativeTarget } from '../main/computer/targets';
import { ComputerUseService } from '../main/computer.use';
import { prepareComputerInput, computerTurnActive, claimComputerRoute } from '../main/computer/route';
import { ThreadManager, type SavedInput, type SavedThread } from '../main/thread.manager';
import { initialEngineState, engineReducer } from '../renderer/src/engine.state';
const tools = JSON.parse(readFileSync(path.resolve(__dirname, '../../cu-runtime/operations.json'), 'utf8'));
const target: NativeTarget = { pid: 42, name: 'Fixture', bundle_id: 'org.fixture', window_id: 5, identity: { path: '/fixture', sha256: 'original' }, label: 'Fixture · Main' };
function fixture() {
  let now = 0, value = '', inputs = 0, windows = [5, 6], identity = target.identity, bundle = target.bundle_id;
  const requests: any[] = [], closed = jest.fn(), approve = jest.fn(async () => true);
  const driver = { close: closed, request: jest.fn(async (operation: string, args: any = {}) => {
    requests.push([operation, args]);
    let data: any = {};
    if (operation === 'apps') data.apps = [{ ...target, bundle_id: bundle }, { pid: 43, name: 'Bystander', bundle_id: 'org.bystander' }, { pid: 44, name: 'Passwords', bundle_id: 'com.apple.Passwords' }];
    if (operation === 'windows') data.windows = windows.map(window_id => ({ window_id, title: 'Main' }));
    if (operation === 'observe') data = { snapshot: 'view', pid: args.pid, window_id: args.window_id, elements: [{ id: 'field', role: 'TextField', name: 'Message', actions: ['SET_VALUE'], value }] };
    if (operation === 'act') { inputs++; value = args.value; data = { status: 'done' }; }
    return { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
  }) };
  const identify = async () => identity;
  const picker = new ComputerTargetPicker({ driver: () => driver, approve, accessibility: () => true, identify, now: () => now });
  const service = new ComputerUseService({ runtime: '/fixture', tools, driver: () => driver, approve: async (...args) => approve(), active: () => true, accessibility: () => true, identify, now: () => now, requireTarget: true });
  const route = async () => {
    const found = await picker.discover('owner', 42);
    expect(found.ok).toBe(true);
    return picker.claim('owner', found.windows![0].target.token, 'thread');
  };
  const call = (operation: string, args: any = {}) => service.execute('thread', { operation, ...args }, new AbortController().signal);
  return { picker, service, route, call, approve, requests, driver, closed, state: () => ({ value, inputs }), time: (at: number) => { now = at; }, replace: () => { identity = { ...identity, sha256: 'replaced' }; }, bundle: () => { bundle = 'org.reused-pid'; }, windows: (ids: number[]) => { windows = ids; } };
}
test.each(['please @CU type', '"@CU type"', '`@CU type`', '```\n@CU type\n```', '@CU/file', '@CUsers', 'mail@cu', '@./CU', ' @CU type'])('CU is not implicitly selected by %s', text => expect(computerRequest(text)).toBeNull());
test.each(['@CU', '@cu ', '@Cu\n'])('exact leading token selects an empty request: %s', text => expect(computerRequest(text)).toBe(''));
test('request preserves constraints, later mentions and file references', () => expect(computerRequest('@CU Fill Message. Stop before Submit.\n@"./invoice one.pdf"')).toBe('Fill Message. Stop before Submit.\n@"./invoice one.pdf"'));
test('completion only offers CU at the start of the input', () => { expect(computerCompletion('@C', 2)).toBe(true); expect(computerCompletion('say @C', 6)).toBe(false); expect(computerCompletion('@CUser', 2)).toBe(false); });
test('app discovery has zero read prompts or input and excludes protected apps', async () => {
  const f = fixture(), result = await f.picker.discover('owner');
  expect(result.apps!.map(a => a.pid)).toEqual([42, 43]); expect(f.approve).not.toHaveBeenCalled(); expect(f.state()).toEqual({ inputs: 0, value: '' }); expect(f.closed).toHaveBeenCalledTimes(1);
});
test('window discovery denial reaches no window read, target receipt or input', async () => {
  const f = fixture(); f.approve.mockResolvedValue(false);
  expect((await f.picker.discover('owner', 42)).ok).toBe(false);
  expect(f.requests.map(r => r[0])).toEqual(['apps']); expect(f.state().inputs).toBe(0);
});
test('selection change during approval reaches no window read', async () => {
  const f = fixture(); let active = true;
  f.approve.mockImplementation(async () => { active = false; return true; });
  expect((await f.picker.discover('owner', 42, () => active)).ok).toBe(false);
  expect(f.requests.map(r => r[0])).toEqual(['apps']); expect(f.state().inputs).toBe(0);
});
test('picker cancellation before discovery reply discards stale windows', async () => {
  const f = fixture(); let reply!: (v: any) => void;
  f.driver.request.mockImplementation(() => new Promise(resolve => { reply = resolve; }));
  const pending = f.picker.discover('owner'); f.picker.cancel('owner'); reply({ structuredContent: { apps: [target] } });
  expect((await pending).ok).toBe(false); expect(f.approve).not.toHaveBeenCalled();
});
test('receipt cannot cross renderer/conversation owners, be reused or survive a restart', async () => {
  const f = fixture(), result = await f.picker.discover('owner', 42), token = result.windows![0].target.token;
  expect(() => f.picker.claim('other-owner', token, 'thread')).toThrow(/expired/);
  const route = f.picker.claim('owner', token, 'thread');
  expect(() => f.picker.take('other-thread', route)).toThrow(/expired/);
  expect(f.picker.take('thread', route).window_id).toBe(5);
  expect(() => f.picker.take('thread', route)).toThrow(/expired/);
  const fresh = fixture(); expect(() => fresh.picker.take('thread', route)).toThrow(/expired/);
});
test('expired queued receipt cannot start native authority', async () => {
  const f = fixture(), route = await f.route(); f.time(600_001);
  expect(() => prepareComputerInput('thread', { text: 'Task', display: '@CU Task', route } as SavedInput, f.service, f.picker)).toThrow(/expired/);
  expect((await f.call('observe', { pid: 42, window_id: 5 })).ok).toBe(false); expect(f.state().inputs).toBe(0);
});
test('selected turn narrows tools, names real IDs, preserves visible text and asks again for task reads', async () => {
  const f = fixture(), route = await f.route();
  const input = prepareComputerInput('thread', { text: 'Set Message. Stop before Submit.', display: '@CU Set Message', route } as SavedInput, f.service, f.picker);
  expect(input.toolScope).toEqual({ names: ['BimaxCuTool', 'AskUserTool'], required: 'BimaxCuTool' });
  expect(input.text).toContain('pid: 42; exact window_id: 5'); expect(input.text).toContain('Stop before Submit.'); expect(input.displayText).toBe('@CU Set Message');
  const apps = await f.call('apps'); expect(apps.apps.map((a: any) => a.pid)).toEqual([42]);
  const view = await f.call('observe', { pid: 42, window_id: 5 }); expect(view.snapshot).toBeTruthy(); expect(f.approve).toHaveBeenCalledTimes(2);
  await f.call('act', { snapshot: view.snapshot, action: 'SET_VALUE', element: 'field', value: 'routed' });
  expect(f.state()).toEqual({ value: 'routed', inputs: 1 }); expect(f.approve).toHaveBeenCalledTimes(3);
  f.service.end('thread'); expect((await f.call('observe', { pid: 42, window_id: 5 })).ok).toBe(false);
});
test.each([{ pid: 43, window_id: 5 }, { pid: 42, window_id: 6 }])('wrong selected app/window refuses before read and input: %j', async args => {
  const f = fixture(); f.service.begin('thread', target);
  expect((await f.call('observe', args)).blocked).toBe(true); expect(f.requests).toHaveLength(0); expect(f.approve).not.toHaveBeenCalled(); expect(f.state().inputs).toBe(0);
});
test.each(['replace', 'bundle'] as const)('PID/executable replacement before observing refuses target: %s', async change => {
  const f = fixture(); f.service.begin('thread', target); f[change]();
  expect((await f.call('observe', { pid: 42, window_id: 5 })).blocked).toBe(true); expect(f.approve).not.toHaveBeenCalled(); expect(f.state().inputs).toBe(0);
});
test('selected-window CU refuses app-wide menu input and another native returned window', async () => {
  const f = fixture(); f.service.begin('thread', target);
  const view = await f.call('observe', { pid: 42, window_id: 5 });
  expect((await f.call('run_command', { pid: 42, snapshot: view.snapshot, path: ['File', 'Save'] })).blocked).toBe(true);
  expect(f.state().inputs).toBe(0);
  const previous = f.driver.request.getMockImplementation()!;
  f.driver.request.mockImplementation(async (op, args) => { const result = await previous(op, args); if (op === 'observe') result.structuredContent.window_id = 6; return result; });
  expect((await f.call('observe', { pid: 42, window_id: 5 })).blocked).toBe(true); expect(f.state().inputs).toBe(0);
});
function queue(saved: SavedThread[] = [], prepareInput: any = (_id: string, input: SavedInput) => ({ text: input.text, toolScope: input.route ? { names: ['Native'], required: 'Native' } : undefined })) {
  const sent: any[] = [], disk: SavedThread[] = [], messages: any[] = [];
  const manager = new ThreadManager({ engine: () => ({ openProject() {}, sendFromRenderer: m => sent.push(m), dispose() {} }), selected() {}, changed() {}, approval() {}, message: (_id, m) => messages.push(m), save: v => disk.push(JSON.parse(JSON.stringify(v))), prepareInput }, saved);
  return { manager, sent, disk, messages, ready: (id: string) => manager.receive(id, { t: 'ready', protocol: 3 }), idle: (id: string) => manager.receive(id, { t: 'event', name: 'spinner_state', args: ['idle', 'Ready'] }) };
}
const route = { kind: 'computer-use' as const, target: { token: '12345678-1234-1234-1234-123456789abc', label: 'Fixture' } };
test('a CU message queued during work retains its route and cannot steer the current turn', () => {
  const f = queue(), id = f.manager.create('/fixture', 'First'); f.ready(id);
  f.manager.submit(id, 'Set field', '@CU Set field', true, route);
  expect(f.sent).toHaveLength(1); expect(f.manager.get(id).inputs![1].route).toEqual(route);
  f.idle(id); expect(f.sent[1]).toMatchObject({ t: 'input', text: 'Set field', toolScope: { names: ['Native'] } });
});
test('expired/restored CU input is refused, never downgraded to coding; next plain input still runs', () => {
  const first = queue(), id = first.manager.create('/fixture', 'First'); first.ready(id); first.manager.submit(id, 'Set field', '@CU Set field', true, route);
  const saved = first.disk.at(-1)!;
  const second = queue([saved], (_id: string, input: SavedInput) => { if (input.route) throw new Error('Computer Use target expired.'); return { text: input.text }; });
  second.manager.start(id); second.ready(id); expect(second.sent).toHaveLength(0);
  expect(second.messages.some(m => JSON.stringify(m).includes('target expired'))).toBe(true);
  second.manager.submit(id, 'Code next'); expect(second.sent).toEqual([{ t: 'input', text: 'Code next' }]);
});
test('a renderer cannot forge a scope and raw @CU cannot become unscoped steering', () => {
  const f = queue(), id = f.manager.create('/fixture', 'First'); f.ready(id); f.idle(id);
  f.manager.send(id, { t: 'input', text: 'Plain', toolScope: { names: ['Native'] } }); expect(f.sent.at(-1).toolScope).toBeUndefined();
  expect(() => f.manager.steer(id, '@CU input')).toThrow(/Choose/);
});

const interactive = {summary:{status:'working'},state:{mode:'CODE',snapshot:{approvals:{readOnly:false,unattended:false}}}};
test('real engine snapshot reduction retains native approval authority and fails closed on malformed gates', () => {
 const approvals = {askBeforeEdits:true,readOnly:false,unattended:false};
 const state = engineReducer(initialEngineState, {type:'outbound',msg:{t:'event',name:'ui_snapshot',args:[{approvals}]}});
 expect(state.snapshot?.approvals).toEqual(approvals);
 expect(computerTurnActive({summary:{status:'working'},state},true,false)).toBe(true);
 for (const invalid of [{...approvals,readOnly:'false'}, {askBeforeEdits:true,readOnly:false}, null]) {
  const malformed = engineReducer(state,{type:'outbound',msg:{t:'event',name:'ui_snapshot',args:[{approvals:invalid}]}});
  expect(malformed.snapshot?.approvals).toBeUndefined();
  expect(computerTurnActive({summary:{status:'working'},state:malformed},true,false)).toBe(false);
 }
});
test('native authority uses real approval gates, fails closed before snapshot, and refuses unattended tasks', () => {
 expect(computerTurnActive(interactive,true,false)).toBe(true);
 expect(computerTurnActive({...interactive,state:{...interactive.state,snapshot:null}},true,false)).toBe(false);
 expect(computerTurnActive(interactive,true,true)).toBe(false);
 expect(computerTurnActive({...interactive,state:{...interactive.state,snapshot:{approvals:{readOnly:false,unattended:true}}}},false,false)).toBe(false);
 expect(computerTurnActive({...interactive,summary:{status:'idle'}},true,false)).toBe(false);
});
test.each(['PLAN','EXPLORE','SKETCH'])('native input refuses read-only mode %s but permits granted observation', mode => {
 const task={...interactive,state:{...interactive.state,mode}};
 expect(computerTurnActive(task,true,false)).toBe(false); expect(computerTurnActive(task,false,false)).toBe(true);
});
test('an actual read-only approval gate blocks input even when the displayed mode is CODE', () => {
 expect(computerTurnActive({...interactive,state:{...interactive.state,snapshot:{approvals:{readOnly:true,unattended:false}}}},true,false)).toBe(false);
});

function startDirect(f: ReturnType<typeof fixture>, mode: 'do' | 'guide' | 'teach' = 'do') {
 const route = claimComputerRoute(f.picker, 'owner', {kind:'computer-use', mode}, 'thread');
 return prepareComputerInput('thread', {text:'Set Message in Fixture. Stop before Submit.',display:'@CU Set Message in Fixture',route} as SavedInput,f.service,f.picker);
}
test('direct @CU starts without a picker read, narrows tools and discovers real targets after Send', async () => {
 const f=fixture(), input=startDirect(f);
 expect(f.requests).toEqual([]); expect(f.approve).not.toHaveBeenCalled();
 expect(input.text).toContain('Find the app needed for the task yourself'); expect(input.text).toContain('Stop before Submit.');
 expect(input.toolScope?.required).toBe('BimaxCuTool');
 expect((await f.call('apps')).apps.map((a:any)=>a.pid)).toEqual([42,43]);
 expect(f.approve).not.toHaveBeenCalled();
 expect((await f.call('windows',{pid:42})).windows.map((w:any)=>w.window_id)).toEqual([5,6]);
 const view=await f.call('observe',{pid:42,window_id:5});
 expect(view.snapshot).toBeTruthy();expect(f.approve).toHaveBeenCalledTimes(1);
 await f.call('act',{snapshot:view.snapshot,element:'field',action:'SET_VALUE',value:'direct'});
 expect(f.state()).toEqual({value:'direct',inputs:1});expect(f.approve).toHaveBeenCalledTimes(2);
 expect(f.service.state('thread')?.target).toBe('Fixture');
});
test('direct tickets are single use, owned, expiring and cannot survive restart or renderer forgery', () => {
 const f=fixture(),route=f.picker.auto('thread');
 expect(()=>f.picker.takeAuto('foreign',route)).toThrow(/expired/);
 expect(()=>claimComputerRoute(f.picker,'owner',route,'thread')).toThrow(/Invalid/);
 f.picker.takeAuto('thread',route);expect(()=>f.picker.takeAuto('thread',route)).toThrow(/expired/);
 const queued=f.picker.auto('thread');f.time(600001);expect(()=>f.picker.takeAuto('thread',queued)).toThrow(/expired/);
 expect(()=>fixture().picker.takeAuto('thread',queued)).toThrow(/expired/);
 expect(()=>prepareComputerInput('thread',{text:'task',route:{kind:'computer-use'}} as SavedInput,f.service,f.picker)).toThrow(/expired/);
});
test('direct route refuses guessed app IDs and windows before any private app read',async()=>{
 const f=fixture();startDirect(f);
 expect((await f.call('windows',{pid:42})).blocked).toBe(true);
 expect(f.requests).toEqual([]);
 await f.call('apps');
 expect((await f.call('observe',{pid:42,window_id:5})).blocked).toBe(true);
 expect(f.approve).not.toHaveBeenCalled();
 await f.call('windows',{pid:42});
 expect((await f.call('observe',{pid:42,window_id:99})).blocked).toBe(true);
 expect(f.requests.filter(r=>r[0]==='observe')).toHaveLength(0); expect(f.state().inputs).toBe(0);
});
test('direct native read cannot return a foreign window snapshot',async()=>{
 const f=fixture();startDirect(f);await f.call('apps');await f.call('windows',{pid:42});
 const previous=f.driver.request.getMockImplementation()!;
 f.driver.request.mockImplementation(async(op,args)=>{const result=await previous(op,args);if(op==='observe')result.structuredContent.window_id=6;return result;});
 expect((await f.call('observe',{pid:42,window_id:5})).blocked).toBe(true);expect(f.state().inputs).toBe(0);
});
test('direct executable replacement revokes read grant before observation',async()=>{
 const f=fixture();startDirect(f);await f.call('apps');await f.call('windows',{pid:42});f.replace();
 expect((await f.call('observe',{pid:42,window_id:5})).blocked).toBe(true);
 expect(f.requests.filter(r=>r[0]==='observe')).toHaveLength(0);expect(f.state().inputs).toBe(0);
});
test('direct denied read reaches no window read or input',async()=>{
 const f=fixture();startDirect(f);await f.call('apps');f.approve.mockResolvedValue(false);
 expect((await f.call('windows',{pid:42})).blocked).toBe(true);
 expect(f.requests.filter(r=>r[0]==='windows')).toHaveLength(0);expect(f.state().inputs).toBe(0);
});
test('direct Pause revokes snapshots and grants; resume reads again without replay',async()=>{
 const f=fixture();startDirect(f);await f.call('apps');await f.call('windows',{pid:42});
 const view=await f.call('observe',{pid:42,window_id:5});
 const revision=f.service.state('thread')!.revision;expect(f.service.control('thread',revision,'pause')).toBe(true);
 expect(f.state().inputs).toBe(0);
 expect(f.service.control('thread',f.service.state('thread')!.revision,'resume')).toBe(true);
 expect((await f.call('act',{snapshot:view.snapshot,element:'field',action:'SET_VALUE',value:'stale'})).blocked).toBe(true);
 await f.call('observe',{pid:42,window_id:5});expect(f.approve).toHaveBeenCalledTimes(2);expect(f.state().inputs).toBe(0);
});
test('ending direct turn removes automatic native admission',async()=>{
 const f=fixture();startDirect(f);f.service.end('thread');expect((await f.call('apps')).blocked).toBe(true);expect(f.requests).toEqual([]);
});

test('ordinary turn cannot guess CU discovery without an admitted @CU request', async()=>{
 const f=fixture(); expect((await f.call('apps')).blocked).toBe(true);expect(f.requests).toEqual([]);expect(f.approve).not.toHaveBeenCalled();
});

test('automatic Teach saves verified instructions with the actual discovered app identity',async()=>{
 const f=fixture();startDirect(f,'teach');await f.call('apps');await f.call('windows',{pid:42});
 const result=await f.call('workflow',{pid:42,window_id:5,steps:[{control:'Message',role:'TextField',action:'SET_VALUE',value:'taught-direct'}]});
 expect(result.verified).toBe(true);expect(f.state()).toEqual({value:'taught-direct',inputs:1});
 expect(f.service.state('thread')?.recipe).toContain('"Fixture" (org.fixture)');
 expect(f.service.state('thread')?.recipe).toContain('discover its current windows');
});
test('automatic app changes require a separate read grant',async()=>{
 const f=fixture();startDirect(f);await f.call('apps');await f.call('windows',{pid:42});
 await f.call('windows',{pid:43});expect(f.approve).toHaveBeenCalledTimes(2);expect(f.state().inputs).toBe(0);
});
