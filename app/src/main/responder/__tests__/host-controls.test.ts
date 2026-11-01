import { Menu, Tray, dialog, BrowserWindow } from 'electron';
import { DesktopHostControls } from '../host-controls';
jest.mock('electron', () => {
  class FakeTray { setTitle=jest.fn();setToolTip=jest.fn();setContextMenu=jest.fn();destroy=jest.fn(); }
  return {Tray:jest.fn(()=>new FakeTray()),Menu:{buildFromTemplate:jest.fn(items=>items)},nativeImage:{createEmpty:()=>({})},dialog:{showMessageBox:jest.fn()},BrowserWindow:jest.fn()};
});
const operation={kind:'chat' as const,peer:'paired-phone',text:'Run the selected chat'};
beforeEach(()=>jest.clearAllMocks());
test('one trusted pairing authorizes ordinary work without Mac dialogs or overlay windows',async()=>{
 const controls=new DesktopHostControls(async()=>{});const signal=new AbortController().signal;
 expect(await controls.authorize(operation,signal)).toBe(false);
 await controls.setRemoteSessionActive(true,operation.peer);
 for(const kind of ['history','chat','command','file'] as const)for(let i=0;i<5;i++)expect(await controls.authorize({...operation,kind},signal)).toBe(true);
 expect(dialog.showMessageBox).not.toHaveBeenCalled();expect(BrowserWindow).not.toHaveBeenCalled();
 expect(Tray).toHaveBeenCalledTimes(1);expect(Menu.buildFromTemplate).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({label:'Stop Phone Access'})]));
 await controls.setRemoteSessionActive(false);expect(await controls.authorize(operation,signal)).toBe(false);
 await controls.setRemoteSessionActive(true,operation.peer);expect(await controls.authorize(operation,signal)).toBe(true);
});
test('foreign peers, aborted actions and oversized inputs receive no grant',async()=>{
 const controls=new DesktopHostControls(async()=>{});await controls.setRemoteSessionActive(true,operation.peer);
 expect(await controls.authorize({...operation,peer:'foreign'},new AbortController().signal)).toBe(false);
 expect(await controls.authorize({...operation,text:'x'.repeat(32769)},new AbortController().signal)).toBe(false);
 const abort=new AbortController();abort.abort();expect(await controls.authorize(operation,abort.signal)).toBe(false);
});
test('local Stop immediately revokes a grant and stays latched off even during slow cancellation',async()=>{
 let finish!:()=>void;const controls=new DesktopHostControls(()=>new Promise<void>(r=>{finish=r;}));await controls.setRemoteSessionActive(true,operation.peer);
 const stopped=controls.stop();expect(await controls.authorize(operation,new AbortController().signal)).toBe(false);
 await expect(controls.setRemoteSessionActive(true,operation.peer)).rejects.toThrow(/restart/);finish();await stopped;
 await expect(controls.setRemoteSessionActive(true,operation.peer)).rejects.toThrow(/restart/);
});
test('Stop failure still destroys connection authority and cannot become a new grant',async()=>{
 const controls=new DesktopHostControls(async()=>{throw Error('failed');});await controls.setRemoteSessionActive(true,operation.peer);
 await expect(controls.stop()).rejects.toThrow('failed');expect(await controls.authorize(operation,new AbortController().signal)).toBe(false);
 await expect(controls.setRemoteSessionActive(true,operation.peer)).rejects.toThrow(/restart/);
});
