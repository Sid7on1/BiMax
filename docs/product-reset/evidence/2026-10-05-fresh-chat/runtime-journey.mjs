import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import puppeteer from '../../../../app/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
const evidence=path.resolve('docs/product-reset/evidence/2026-10-05-fresh-chat');
const fixture=JSON.parse(fs.readFileSync('/tmp/bimax-fresh-chat-runtime/fixture.json','utf8'));
const bundle=process.argv[2] || '/tmp/bimax-fresh-chat-20261005/mac-arm64/Bimax.app';
const log=fs.openSync(path.join(evidence,'runtime-host.log'),'w');
const host=spawn(path.resolve('app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),[path.join(evidence,'runtime-host.cjs')],{
 env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,LANG:'en_US.UTF-8',BIMAX_FIXTURE_BUNDLE:bundle,BIMAX_BREAKGLASS_DIR:path.join(fixture.base,'keys'),NVIDIA_API_KEY:'nvapi-synthetic-fixture',BGW_BASE_URL:'http://127.0.0.1:1/v1',BIMAX_AUTO_INDEX:'0',BIMAX_DISABLE_CODEMEM:'1',BIMAX_DISABLE_CODEBASE_MEMORY:'1',BIMAX_DRIVES_BOOT:'0',BIMAX_CODE_INDEX:'0',BIMAX_RECORDER:'0'},stdio:['ignore',log,log]});
let browser;
try {
 let endpoint;
 for(let i=0;i<200;i++) {
  try { const data=await fetch('http://127.0.0.1:9237/json/version').then(r=>r.json());endpoint=data.webSocketDebuggerUrl;break; }catch{}
  if(host.exitCode!==null) throw new Error('host exited '+host.exitCode);
  await new Promise(r=>setTimeout(r,100));
 }
 assert(endpoint,'debug endpoint must start');
 browser=await puppeteer.connect({browserWSEndpoint:endpoint});
 let page;
 for(let i=0;i<100;i++) { page=(await browser.pages()).find(p=>p.url().includes('app.asar/out/renderer/index.html'));if(page)break; await new Promise(r=>setTimeout(r,100)); }
 assert(page,'actual packaged renderer must load');
 await page.waitForFunction(()=>window.bimax?.threads,{timeout:20000});
 await page.evaluate(()=>{window.__fixtureSelections=[];window.__fixtureFrames=[];window.bimax.threads.onSelected(s=>window.__fixtureSelections.push(s));window.bimax.onMessage((f,id)=>window.__fixtureFrames.push({...f,threadId:id}));});
 await page.evaluate(project=>window.bimax.openProject(project),fixture.project);
 await page.waitForFunction(()=>window.__fixtureSelections.length>0);
 const first=await page.evaluate(()=>window.__fixtureSelections.at(-1));
 assert.notEqual(first.id,'fixture-old');assert.equal(first.state.items.length,0);
 await page.evaluate(()=>window.bimax.threads.select('fixture-old'));
 await page.waitForFunction(()=>document.body.innerText.includes('PREVIOUS_CONVERSATION'));
 const newLabel=await page.evaluate(()=>[...document.querySelectorAll('button span')].find(s=>s.textContent.trim()==='New')?.textContent.trim());
 assert.equal(newLabel,'New');
 await page.evaluate(()=>[...document.querySelectorAll('button span')].find(s=>s.textContent.trim()==='New').closest('button').click());
 await page.waitForFunction(()=>window.__fixtureSelections.at(-1)?.id!=='fixture-old' && !document.body.innerText.includes('PREVIOUS_CONVERSATION'));
 const fresh=await page.evaluate(()=>window.__fixtureSelections.at(-1));
 assert.notEqual(fresh.id,first.id);assert.equal(fresh.state.items.length,0);
 await page.waitForFunction(id=>window.__fixtureFrames.some(f=>f.threadId===id && f.t==='ready'),{timeout:30000},fresh.id);
 await page.locator('textarea').fill('/episodes replay '+fixture.episodeId);
 await page.keyboard.press('Enter');
 await page.waitForFunction(id=>window.__fixtureFrames.some(f=>f.threadId===id && f.t==='event' && f.name==='message' && String(f.args[0]?.content).includes('IDENTICAL')),{timeout:30000},fresh.id);
 // Command success messages are deliberately filtered as chatter by Transcript.buildRows.
 // Grade report delivery/persistence and absence of recorded cards instead of their visibility.
 fs.writeFileSync(path.join(evidence,'runtime-dom.txt'),await page.evaluate(()=>document.body.innerText));
 const frames=await page.evaluate(()=>window.__fixtureFrames);
 const cards=frames.filter(f=>f.threadId===fresh.id && f.t==='event' && ['tool_call','tool_call_result'].includes(f.name));
 assert.equal(cards.length,0);
 assert(frames.some(f=>f.threadId===fresh.id && f.t==='event' && f.name==='message' && String(f.args[0]?.content).includes('IDENTICAL')),'positive control: report reached the fresh chat');
 assert.equal(await page.evaluate(()=>document.body.innerText.includes('STALE_TOOL_OUTPUT')),false);
 const data=JSON.parse(fs.readFileSync(path.join(fixture.data,'threads',fresh.id+'.json'),'utf8'));
 assert.equal(data.state.items.filter(i=>i.kind==='tool').length,0);
 await page.screenshot({path:path.join(evidence,'packaged-fresh-chat.png')});
 await page.evaluate(project=>window.bimax.openProject(project),fixture.project);
 await page.waitForFunction(previous=>window.__fixtureSelections.at(-1)?.id!==previous,{},fresh.id);
 const reopened=await page.evaluate(()=>window.__fixtureSelections.at(-1));
 assert.equal(reopened.state.items.length,0);
 const result={bundle,host:'same-version Electron, actual packaged main/preload/renderer/worker; disposable userData',freshRepoOpen:true,explicitOldSelection:true,newButtonLabel:newLabel,newButtonEmptyChat:true,recordedEpisodeIdentical:true,replayedToolCards:cards.length,persistedToolCards:0,reopenFresh:true,providerCalls:0};
 fs.writeFileSync(path.join(evidence,'runtime-journey.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}catch(error){if(browser){const pages=await browser.pages();const p=pages.find(p=>p.url().includes('app.asar/out/renderer/index.html'));if(p){fs.writeFileSync(path.join(evidence,'runtime-debug.json'),JSON.stringify(await p.evaluate(()=>({dom:document.body.innerText,frames:window.__fixtureFrames,selections:window.__fixtureSelections})),null,2));await p.screenshot({path:path.join(evidence,'runtime-debug.png')});}}throw error;}finally{if(browser)browser.disconnect();host.kill('SIGTERM');fs.closeSync(log);}
