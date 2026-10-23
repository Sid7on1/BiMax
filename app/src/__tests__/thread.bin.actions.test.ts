import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ThreadManager, type SavedThread } from '../main/thread.manager';
import { ThreadStorage } from '../main/thread.storage';
import { ThreadBinRecovery } from '../main/thread.bin.recovery';
import { threadBinActions } from '../main/thread.bin.actions';
import { initialEngineState } from '../renderer/src/engine.state';
let dir:string;let storage:ThreadStorage;let managers:ThreadManager[];
const saved=(id:string):SavedThread=>({summary:{id,title:`Task ${id}`,root:`/fixture/${id}`,updatedAt:1,status:'stopped',peers:[],origin:'quick'},state:{...initialEngineState,items:[]}});
beforeEach(()=>{dir=fs.mkdtempSync(path.join(os.tmpdir(),'bimax-bin-actions-'));storage=new ThreadStorage(dir);managers=[];});
afterEach(async()=>{managers.forEach(manager=>manager.dispose());await storage.flush();fs.rmSync(dir,{recursive:true,force:true});});
function world(fail=false){
 const engine=jest.fn(()=>({sendFromRenderer:jest.fn(),dispose:jest.fn(),openProject:jest.fn()}));const changed=jest.fn();
 const manager=new ThreadManager({engine,selected:jest.fn(),message:jest.fn(),approval:jest.fn(),save:value=>storage.save(value),changed},[saved('open'),saved('gone')]);
 managers.push(manager);manager.select('open');
 const recovery=new ThreadBinRecovery(dir,{moveToBin:async file=>{if(fail)throw new Error('Bin refused');fs.unlinkSync(file);return null;}});
 return {manager,engine,changed,recovery,actions:threadBinActions({threads:manager,storage,recovery,changed,leftBar:jest.fn()})};
}
test('the production main actions remove a stopped conversation and Undo restores it stopped, without starting an engine',async()=>{
 const f=world();expect(await f.actions.move('gone',false)).toEqual({ok:true});expect(f.manager.list().map(t=>t.id)).toEqual(['open']);expect(storage.load()).toEqual([]);
 expect(f.recovery.latest()?.id).toBe('gone');expect(f.actions.undo('gone')).toEqual({ok:true});expect(f.manager.get('gone').summary.status).toBe('stopped');expect(f.engine).not.toHaveBeenCalled();await storage.flush();expect(storage.load().map(t=>t.summary.id)).toEqual(['gone']);expect(f.recovery.latest()).toBeUndefined();
});
test('main refuses an open or running conversation and malformed ids without binning its files',async()=>{
 const f=world();expect(await f.actions.move('open',false)).toMatchObject({ok:false,error:expect.stringContaining('main window')});f.manager.start('gone');expect(await f.actions.move('gone',false)).toMatchObject({ok:false,error:expect.stringContaining('Stop')});expect(await f.actions.move(42,false)).toMatchObject({ok:false});expect(f.actions.undo('../escape')).toMatchObject({ok:false});expect(f.manager.list()).toHaveLength(2);expect(f.recovery.latest()).toBeUndefined();
});
test('a failed Bin re-admits the live record and its persistence',async()=>{
 const f=world(true);expect(await f.actions.move('gone',false)).toMatchObject({ok:false,error:'Bin refused'});expect(f.manager.get('gone').summary.title).toBe('Task gone');await storage.flush();expect(storage.load()[0].summary.id).toBe('gone');expect(f.recovery.latest()).toBeUndefined();
});
test('archived Undo restores only archive history',async()=>{const f=world();await storage.archive(saved('archived'));expect(await f.actions.move('archived',true)).toEqual({ok:true});expect(f.actions.undo('archived')).toEqual({ok:true});expect(storage.archivedCount()).toBe(1);expect(()=>f.manager.get('archived')).toThrow('not found');});
test('IPC and preload call the tested main actions, without a routine Bin confirmation',()=>{
 const main=fs.readFileSync(path.resolve(__dirname,'../main/index.ts'),'utf8');
 const bin=main.slice(main.indexOf("secureHandle('threads:bin'"),main.indexOf("secureOn('engine:send'"));
 expect(bin).toContain('binActions.move(id, archived)');expect(bin).toContain('binActions.undo(id)');expect(bin).not.toContain('showMessageBox');
 expect(fs.readFileSync(path.resolve(__dirname,'../preload/index.ts'),'utf8')).toContain("ipcRenderer.invoke('threads:undo-bin', id)");
});
