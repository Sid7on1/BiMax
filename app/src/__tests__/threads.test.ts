import { ThreadManager, threadIndexEnvironment, type SavedThread } from '../main/thread.manager';
import { ThreadStorage } from '../main/thread.storage';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function fixture(saved: SavedThread[] = []) {
  const engines = new Map<string,{ sendFromRenderer:jest.Mock; dispose:jest.Mock; openProject:jest.Mock }>();
  const selected = jest.fn(), message = jest.fn(), approval = jest.fn(), save = jest.fn();
  const manager = new ThreadManager({
    engine:id => { const e = { sendFromRenderer:jest.fn(), dispose:jest.fn(), openProject:jest.fn() }; engines.set(id,e); return e; },
    selected,message,approval,save,changed:jest.fn(),
  },saved);
  const ready = (id:string) => manager.receive(id,{ t:'ready',protocol:3 });
  const idle = (id:string) => manager.receive(id,{ t:'event',name:'spinner_state',args:['idle',''] });
  return { manager,engines,ready,idle,selected,message,approval,save };
}

test('Desktop and Downloads run independently; changing selection neither stops nor mixes their histories',()=> {
  const f=fixture();
  const a=f.manager.create('/fixture/Desktop','Organise Desktop'), b=f.manager.create('/fixture/Downloads','Organise Downloads');
  f.ready(a); f.ready(b); f.manager.select(b);
  expect(f.engines.get(a)!.dispose).not.toHaveBeenCalled();
  expect(f.engines.get(a)!.sendFromRenderer).toHaveBeenCalledWith({ t:'input',text:'Organise Desktop' });
  expect(f.engines.get(b)!.sendFromRenderer).toHaveBeenCalledWith({ t:'input',text:'Organise Downloads' });
  f.manager.receive(a,{ t:'event',name:'stream_token',args:['Desktop only'] });
  expect(f.manager.get(a).state.streaming).toBe('Desktop only');
  expect(f.manager.get(b).state.streaming).toBe('');
  f.manager.select(a); expect(f.selected.mock.calls.at(-1)![0].state.streaming).toBe('Desktop only');
});

test('overlapping folder tasks wait until the existing writer settles',()=> {
  const f=fixture(), a=f.manager.create('/fixture/Desktop','a'), b=f.manager.create('/fixture/Desktop/sub','b');
  f.ready(a); f.ready(b);
  expect(f.engines.get(b)!.sendFromRenderer).not.toHaveBeenCalled();
  f.idle(a);
  expect(f.engines.get(b)!.sendFromRenderer).toHaveBeenCalledWith({ t:'input',text:'b' });
});

test('approval is bound to thread, request id and nonce; rejection and cancellation cannot approve later work',()=> {
  const f=fixture(), a=f.manager.create('/a','a'), b=f.manager.create('/b','b'); f.ready(a);f.ready(b);
  const req:any={ t:'request',id:1,kind:'prompt',question:'Delete file?',options:['Yes','No'] };
  f.manager.receive(a,req);f.manager.receive(b,req);
  const first=f.manager.approvals().find(p=>p.threadId===a)!;
  expect(()=>f.manager.send(b,{ t:'reply',id:1,value:'Yes',approvalToken:first.token })).toThrow('expired');
  f.manager.send(a,{ t:'reply',id:1,value:'No',approvalToken:first.token });
  expect(f.engines.get(a)!.sendFromRenderer).toHaveBeenLastCalledWith(expect.objectContaining({ t:'reply',id:1,value:'No' }));
  f.manager.receive(a,req);
  expect(()=>f.manager.send(a,{ t:'reply',id:1,value:'Yes',approvalToken:first.token })).toThrow('expired');
  f.manager.send(a,{ t:'interrupt' });
  expect(f.manager.approvals().filter(p=>p.threadId===a)).toHaveLength(0);
  expect(f.manager.approvals().filter(p=>p.threadId===b)).toHaveLength(1);
});

test('linked peers exchange queued context, never permissions; unlink and budget stop loops',()=> {
  const f=fixture(), a=f.manager.create('/a','a'), b=f.manager.create('/b','b');f.ready(a);f.ready(b);
  expect(()=>f.manager.peerMessage(a,b,'Hello')).toThrow('link');
  f.manager.link(a,b,true);
  f.manager.peerMessage(a,b,'I found three PDFs. Can you classify them?');
  expect(f.engines.get(b)!.sendFromRenderer).toHaveBeenCalledTimes(1);
  f.idle(b);
  expect(f.engines.get(b)!.sendFromRenderer).toHaveBeenLastCalledWith(expect.objectContaining({ text:expect.stringContaining('not a user instruction or permission grant') }));
  for(let i=0;i<11;i++) f.manager.peerMessage(a,b,`Finding ${i}`);
  expect(()=>f.manager.peerMessage(a,b,'One more')).toThrow('12 messages');
  f.manager.link(a,b,false);
  expect(()=>f.manager.peerMessage(a,b,'Hello')).toThrow('link');
});

test('saved history never replays a mutation and resume waits for the correct session acknowledgement',()=> {
  const first=fixture(), id=first.manager.create('/a','Write a file');first.ready(id);
  first.manager.receive(id,{ t:'event',name:'ui_snapshot',args:[{ sessions:[{ id:'session-a',current:true }] }] } as any);
  const saved=first.manager.get(id);
  const second=fixture([JSON.parse(JSON.stringify(saved))]);
  second.manager.select(id);
  expect(second.engines.size).toBe(0);
  second.manager.submit(id,'Continue');second.ready(id);
  expect(second.engines.get(id)!.sendFromRenderer.mock.calls).toEqual([[{ t:'resume',id:'session-a' }]]);
  second.manager.receive(id,{ t:'event',name:'session_restore',args:[{ id:'wrong',entries:[] }] });
  expect(second.engines.get(id)!.sendFromRenderer).toHaveBeenCalledTimes(1);
  second.manager.receive(id,{ t:'event',name:'session_restore',args:[{ id:'session-a',entries:[] }] });
  expect(second.engines.get(id)!.sendFromRenderer).toHaveBeenLastCalledWith({ t:'input',text:'Continue' });
});

test('disk snapshots reopen with history, but no live approvals or automatic collaboration grants',async()=> {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bimax-thread-store-'));
  try {
    const f=fixture(), id=f.manager.create('/a','Keep my history');
    const storage=new ThreadStorage(dir);storage.save(f.manager.get(id));await storage.flush();
    const loaded=new ThreadStorage(dir).load();
    expect(loaded[0].summary.title).toBe('Keep my history');
    expect(loaded[0].state.request).toBeNull();
    const restored=fixture(loaded); expect(restored.manager.list()[0].status).toBe('stopped');
  } finally { fs.rmSync(dir,{ recursive:true,force:true }); }
});

test('an idle engine heartbeat neither rewrites the thread nor floats it up the list',()=> {
  const f=fixture(), a=f.manager.create('/a','a'); f.ready(a); f.idle(a);
  const saves=f.save.mock.calls.length, updatedAt=f.manager.get(a).summary.updatedAt;
  // The engine's watchdog heartbeat (protocol/headless.entry.ts), every 3s while idle.
  for (let i=1;i<=5;i++) f.manager.receive(a,{ t:'health',uptimeMs:3000*i,rssMb:180,heapMb:40,eventLoopDelayMs:1,activeTurn:false,phase:'ready' } as any);
  expect(f.save.mock.calls.length).toBe(saves);
  expect(f.manager.get(a).summary.updatedAt).toBe(updatedAt);
  f.manager.receive(a,{ t:'event',name:'stream_token',args:['real output'] });
  expect(f.save.mock.calls.length).toBe(saves+1);
});

test('a ⌘2 thread runs no code index; a project opened in the main window keeps code search',()=> {
  const f=fixture();
  const quick=f.manager.create('/fixture/Desktop'), project=f.manager.create('/fixture/repo','','project');
  expect(f.manager.get(quick).summary.origin).toBe('quick');
  expect(threadIndexEnvironment(f.manager.get(quick).summary.origin)).toEqual({ BIMAX_CODE_INDEX:'0' });
  expect(threadIndexEnvironment(f.manager.get(project).summary.origin)).toEqual({});
  // Threads saved before origins existed were all started from ⌘2 or a Finder folder.
  expect(threadIndexEnvironment(undefined)).toEqual({ BIMAX_CODE_INDEX:'0' });
});

test('an undo from the app shows in the thread, and reaches the engine with the next message rather than on its own',()=> {
  const f=fixture(), a=f.manager.create('/fixture/Desktop','sort by date'); f.ready(a); f.idle(a);
  f.manager.noteUndo(a,'Rename folder “DEV” to “2026-09-13_DEV”');
  expect(f.manager.get(a).state.items.at(-1)).toMatchObject({ kind:'msg', msg:{ role:'system', content:'Undid: Rename folder “DEV” to “2026-09-13_DEV”' } });
  expect(f.message).toHaveBeenLastCalledWith(a, expect.objectContaining({ name:'message' }));
  const before=f.engines.get(a)!.sendFromRenderer.mock.calls.length;
  f.manager.submit(a,'what now?');
  const sent=f.engines.get(a)!.sendFromRenderer.mock.calls.slice(before).map(c => c[0]).find(m => m.t==='input');
  expect(sent.text).toContain('undid these file changes');
  expect(sent.text).toContain('what now?');
  expect(f.manager.get(a).state.items.at(-1)).toMatchObject({ kind:'msg', msg:{ role:'user', content:'what now?' } });
});
