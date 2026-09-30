import {writeFileSync} from 'node:fs';
import {serveRenderer,openRenderer,feed,feedEvent,settle,clickByText} from './harness.mjs';
import {baseFixture,uiSnapshot,PROJECT} from './fixtures.mjs';
const {server,base}=await serveRenderer();const report=[];let invalid=null;
try{for(const zoom of [1,1.2]){
 const {browser,page,pageErrors}=await openRenderer({base,fixture:baseFixture(),size:{width:Math.round(1180/zoom),height:Math.round(800/zoom)}});
 try{
  await page.evaluateOnNewDocument(()=>{
   const H=window.__bimaxHarness; H.fixture.threads=[{id:'gone',title:'Fix the fetch client',root:'/fixture/project',updatedAt:2,status:'stopped',peers:[],origin:'quick'}];H.callbacks.threadLists=[];
   const list=()=>({activeId:null,threads:H.fixture.threads,shortcutAvailable:true,undoBin:H.undo});
   const emit=()=>H.callbacks.threadLists.forEach(cb=>cb(list()));
   window.bimax.threads.list=async()=>list(); window.bimax.threads.onList=cb=>{H.callbacks.threadLists.push(cb);return()=>{};};
   window.bimax.threads.moveToBin=(id,archived)=>new Promise(resolve=>{H.calls.push({name:'threads.moveToBin',args:{id,archived}});H.finishBin=()=>{H.saved=H.fixture.threads.find(t=>t.id===id);H.fixture.threads=H.fixture.threads.filter(t=>t.id!==id);H.undo={id,title:H.saved.title,expiresAt:Date.now()+300000};emit();resolve({ok:true});};});
   window.bimax.threads.undoBin=async id=>{H.calls.push({name:'threads.undoBin',args:id});H.fixture.threads.push(H.saved);H.undo=undefined;emit();return{ok:true};};
  });await page.reload({waitUntil:'domcontentloaded'});
  await page.evaluate(p=>{const H=window.__bimaxHarness;H.callbacks.project.forEach(cb=>cb(p));H.callbacks.state.forEach(cb=>cb('ready',''));},PROJECT);
  await feed(page,{t:'ready',protocol:3});await feedEvent(page,'ui_snapshot',[uiSnapshot()]);await settle(page,350);
  const before=await page.$$eval('.glass-row',els=>els.filter(el=>el.textContent.includes('Fix the fetch client')).length);
  await page.click('button[aria-label="Move to the Bin"]');
  const pending=await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>resolve(document.body.innerText.includes('Updating conversation…')))));
  const reached=await page.evaluate(()=>{const H=window.__bimaxHarness;if(!H.finishBin)return false;H.finishBin();return true;});await settle(page,120);
  const removed=await page.$$eval('.glass-row',els=>els.filter(el=>el.textContent.includes('Fix the fetch client')).length);
  const undo=await page.$$eval('button',els=>els.some(el=>el.textContent.trim()==='Undo'));
  const problems=[];if(!pending)problems.push('Bin has no immediate pending acknowledgement');if(!reached)problems.push('Bin never reached its host');if(before!==1||removed!==0)problems.push('Bin did not remove its conversation row');if(!undo)problems.push('Bin has no immediate Undo');
  if(undo){await clickByText(page,'Undo',{exact:true});}
  const restored=await page.$$eval('.glass-row',els=>els.filter(el=>el.textContent.includes('Fix the fetch client')).length);
  const calls=await page.evaluate(()=>window.__bimaxHarness.calls.filter(c=>c.name.startsWith('threads.')));
  if(undo && (restored!==1||!calls.some(c=>c.name==='threads.undoBin')))problems.push('Undo did not restore its conversation through main');
  if(pageErrors.length)throw new Error(pageErrors.join('\n'));
  report.push({zoom,pending,reached,before,removed,undo,restored,calls,problems});
 }finally{await browser.close();}
}}catch(e){invalid=e.stack??String(e);}finally{server.close();}
const value={report,invalid};writeFileSync(process.argv.find(a=>a.startsWith('--json='))?.slice(7)??'/tmp/bimax-bin-ui.json',JSON.stringify(value,null,2));console.log(JSON.stringify(value,null,2));process.exit(invalid?2:report.some(r=>r.problems.length)?1:0);
