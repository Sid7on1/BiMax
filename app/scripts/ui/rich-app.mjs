import puppeteer from 'puppeteer-core';
import {serveRenderer,installBridge} from './renderer.mjs';
import {baseFixture} from './fixtures.mjs';
import {chromeExecutable} from './harness.mjs';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'../../..'),scratch=mkdtempSync(path.join(os.tmpdir(),'bimax-app-probe-'));
await build({entryPoints:[path.join(root,'app/src/renderer/src/engine.state.ts')],bundle:true,platform:'node',format:'cjs',outfile:path.join(scratch,'state.cjs')});
const initial=createRequire(import.meta.url)(path.join(scratch,'state.cjs')).initialEngineState;
const report={checks:[],errors:[]},check=(name,value)=>{assert.equal(value,true,name);report.checks.push(name);};
const {server,base}=await serveRenderer();let browser;
try{
 browser=await puppeteer.launch({executablePath:chromeExecutable(),headless:true,args:['--force-prefers-reduced-motion']});const page=await browser.newPage();await page.setViewport({width:1500,height:1000});page.on('pageerror',e=>report.errors.push(e.message));await page.evaluateOnNewDocument(installBridge,baseFixture());
 await page.evaluateOnNewDocument(state=>{
  const a=window,H=a.__bimaxHarness,docs=[];a.saves=[];a.cancelled=0;
  const callbacks=new Set();let selected;const originalOnMessage=a.bimax.onMessage;a.bimax.onMessage=cb=>originalOnMessage((message,id)=>cb(message,id===undefined?a.owner:id));
  a.bimax.threads.onSelected=cb=>{selected=cb;setTimeout(()=>a.selectOwner('A'),100);return()=>{};};
  a.selectOwner=id=>{a.owner=id;selected({id,state:{...state,project:H.fixture.project,threadId:id,engine:{state:'ready',detail:''},items:[{kind:'msg',msg:{id:'message-'+id,role:'assistant',content:'A useful result\n\n```js\nconst report = "'+id+'";\n```'}}]}});};
  a.bimax.outputs={list:async()=>docs.map(d=>d.record),read:async id=>docs.find(d=>d.record.id===id),onChanged:cb=>{callbacks.add(cb);return()=>callbacks.delete(cb);},onPreview:()=>()=>{},cancelPreview:async()=>{a.cancelled++;return true;},stop:async()=>true,save:async(owner,input)=>{a.saves.push({owner,input});await new Promise(r=>setTimeout(r,100));const version={id:'version-'+input.key,sha256:'fixture',byteLength:input.content.length,createdAt:new Date().toISOString()};const d={record:{id:input.key,title:input.title,ownerThreadId:owner,producerRunId:'run',format:input.format,language:input.language,createdAt:version.createdAt,updatedAt:version.createdAt,versions:[version]},version,content:input.content,state:'available'};docs.push(d);callbacks.forEach(cb=>cb());return d;},export:async()=>true};
 },initial);
 await page.goto(base);await page.waitForSelector('.keep-output');await page.waitForFunction(()=>document.body.textContent.includes('const report'));
 await page.evaluate(()=>[...document.querySelectorAll('.keep-output')].find(n=>n.textContent==='Keep output').click());await page.waitForSelector('.outputs-workspace .output-heading');check('Keep output opens exact saved version in the real workbench',await page.$eval('.output-heading strong',n=>n.textContent==='Saved js output'));
 check('chat and composer remain beside output',await page.$('textarea')!==null && await page.$eval('body',n=>n.textContent.includes('A useful result')));
 await new Promise(r=>setTimeout(r,650));check('output pane settles visibly beside chat',await page.evaluate(()=>{let opacity=1;for(let n=document.querySelector('.outputs-workspace');n;n=n.parentElement)opacity*=Number(getComputedStyle(n).opacity);return opacity>.95&&document.querySelector('.outputs-workspace').getBoundingClientRect().width>250;}));await page.screenshot({path:path.join(root,'docs/product-reset/evidence/2026-10-19-rich-outputs/app-workbench.png')});
 await page.evaluate(()=>window.selectOwner('B'));await page.waitForFunction(()=>document.body.textContent.includes('"B"'));await page.waitForFunction(()=>!document.querySelector('.output-heading'));check('conversation switch clears old output selection',true);
 await page.evaluate(()=>[...document.querySelectorAll('.keep-output')].find(n=>n.textContent==='Keep output').click());await page.evaluate(()=>window.selectOwner('C'));await new Promise(r=>setTimeout(r,400));check('late save cannot select old output in a new owner',await page.$('.output-heading')===null);
 check('save uses the originating owner',await page.evaluate(()=>window.saves.length===2&&window.saves[0].owner==='A'&&window.saves[1].owner==='B'));
 await page.evaluate(()=>{const H=window.__bimaxHarness;H.callbacks.msg.forEach(cb=>cb({t:'event',name:'engine_notice',args:[{id:'pricing:fixture',category:'pricing',text:'Fixture cost is estimated.'}]}));H.callbacks.msg.forEach(cb=>cb({t:'event',name:'status',args:['Reading fixture']}));});
 check('configuration notice stays out of conversation',await page.$eval('body',n=>!n.textContent.includes('Fixture cost is estimated.')));
 await page.click('#sidebar-settings');await page.waitForSelector('[role=dialog]');await page.evaluate(()=>[...document.querySelectorAll('button')].find(n=>n.textContent.trim()==='Providers & models').click());await page.waitForFunction(()=>document.querySelector('[role=dialog]').textContent.includes('Fixture cost is estimated.'));check('pricing notice appears in provider Usage settings',true);await page.screenshot({path:path.join(root,'docs/product-reset/evidence/2026-10-19-rich-outputs/app-settings.png')});
 check('no unhandled app renderer exceptions',report.errors.length===0);
}catch(error){report.failure=String(error);process.exitCode=1;}finally{writeFileSync(path.join(root,'docs/product-reset/evidence/2026-10-19-rich-outputs/app.json'),JSON.stringify(report,null,2));await browser?.close();await new Promise(r=>server.close(r));rmSync(scratch,{recursive:true,force:true});console.log(JSON.stringify(report));}
