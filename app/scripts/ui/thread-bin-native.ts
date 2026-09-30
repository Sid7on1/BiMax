// Native system-Bin fallback and exact-byte recovery, using only a temporary conversation.
// Bundle with bun --target=node --format=esm --external=electron, then run the .mjs with Electron.
import {app,shell} from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ThreadStorage} from '../../src/main/thread.storage';
import {ThreadBinRecovery} from '../../src/main/thread.bin.recovery';
import {initialEngineState} from '../../src/renderer/src/engine.state';
app.whenReady().then(async()=>{
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bimax-native-bin-proof-'));
let code=0;
try{
 const storage=new ThreadStorage(dir); const value={summary:{id:'native-proof',title:'Local Bin undo check',root:dir,updatedAt:1,status:'stopped' as const,peers:[]},state:{...initialEngineState,items:[]}};
 const original=await storage.writeFinal(value);const before=fs.readFileSync(original,'utf8');
 // Exercise the existing system API fallback: no Finder automation or trash-path assumption.
 const recovery=new ThreadBinRecovery(dir,{moveToBin:async target=>{await shell.trashItem(target);return null;}});
 await recovery.move('native-proof',false);const removed=!fs.existsSync(original);const offered=recovery.latest()?.id==='native-proof';
 recovery.undo('native-proof');const restored=fs.readFileSync(original,'utf8')===before;const consumed=!recovery.latest();
 if(!removed||!offered||!restored||!consumed)throw new Error('Native Bin end state failed');
 console.log(JSON.stringify({backend:'Electron shell.trashItem on macOS',removed,offered,restoredExactBytes:restored,consumed,FinderTrashPath:'unmeasured',provider:'none'},null,2));

}catch(error){console.error(error);code=1;}finally{fs.rmSync(dir,{recursive:true,force:true});app.exit(code);}

});
