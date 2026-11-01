import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const appRoot = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(process.argv[2] ?? join(appRoot, '../docs/product-reset/evidence/2026-10-16-mobile-host'));
mkdirSync(output, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), 'bimax-host-proof-'));
try {
  await build({ entryPoints: [process.env.BIMAX_HOST_SOURCE || join(appRoot, 'src/main/responder/host-controls.ts')],
    outfile: join(scratch, 'host.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
  writeFileSync(join(scratch, 'run.cjs'), `
const {app,BrowserWindow,Menu,dialog}=require('electron');
let nativeMenu;const buildMenu=Menu.buildFromTemplate;Menu.buildFromTemplate=items=>(nativeMenu=buildMenu(items));
dialog.showMessageBox=()=>{throw Error('Unexpected Mac approval dialog');};
const {writeFileSync}=require('node:fs');
const assert=require('node:assert/strict');
const {DesktopHostControls}=require('./host.cjs');
const out=${JSON.stringify(output)};
app.setPath('userData',${JSON.stringify(join(scratch, 'profile'))});
app.on('window-all-closed',()=>{});
const watchdog=setTimeout(()=>app.exit(1),10000);
app.whenReady().then(async()=>{
  let stopCalls=0;
  const controls=new DesktopHostControls(async()=>{stopCalls++});
  await controls.setRemoteSessionActive(true,'fixture-phone');
  assert.equal(BrowserWindow.getAllWindows().length,0,'no remote overlay window');
  assert.equal(await controls.authorize({kind:'chat',peer:'unpaired',text:'Wrong peer'},new AbortController().signal),false,'foreign peer has no grant');
  const signal=new AbortController().signal;
  for(const kind of ['history','chat','command','file']) for(let i=0;i<5;i++)
    assert.equal(await controls.authorize({kind,peer:'fixture-phone',text:'Synthetic fixture'},signal),true);
  await controls.setRemoteSessionActive(false);
  assert.equal(await controls.authorize({kind:'chat',peer:'fixture-phone',text:'After disconnect'},signal),false,'disconnect revokes grant');
  await controls.setRemoteSessionActive(true,'fixture-phone');
  // Electron Tray is real; the main-owned Stop callback is exposed only through its native menu.
  assert.equal(controls.indicator.isDestroyed(),false);
  nativeMenu.items.find(item=>item.label==='Stop Phone Access').click();
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(stopCalls,1,'Stop reaches the engine');
  assert.equal(await controls.authorize({kind:'chat',peer:'fixture-phone',text:'After Stop'},signal),false,'Stop revokes grant');
  await assert.rejects(()=>controls.setRemoteSessionActive(true,'fixture-phone'),/restart Bimax/);
  writeFileSync(out+'/native-result.json',JSON.stringify({platform:process.platform,electron:process.versions.electron,node:process.versions.node,
    overlayWindows:0,ordinaryRequestsWithoutPrompt:20,foreignPeerRefused:true,disconnectRevoked:true,stopCalls,remoteRestartBlocked:true,
    realEngine:false,physicalPhone:false},null,2)+'\\n');
  clearTimeout(watchdog);app.exit(0);
}).catch(error=>{console.error(error);clearTimeout(watchdog);app.exit(1)});
`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  execFileSync(require('electron'), [join(scratch, 'run.cjs')], { env, stdio: 'inherit', timeout: 15000 });
  console.log(`Native host UI checks passed; evidence in ${output}`);
} finally { rmSync(scratch, { recursive: true, force: true }); }
