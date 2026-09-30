// Real Files panel with controlled out-of-order host replies; exit 2 means invalid evidence.
import { writeFileSync } from 'node:fs';
import { serveRenderer, openRenderer, feed, feedEvent, settle, pressChord, clickByText } from './harness.mjs';
import { baseFixture, uiSnapshot, PROJECT } from './fixtures.mjs';
const { server, base } = await serveRenderer(); const report = []; let invalid = null;
try {
 for (const zoom of [1, 1.2]) {
  const { browser, page, pageErrors } = await openRenderer({ base, fixture: baseFixture(), size: { width: Math.round(1180/zoom), height: Math.round(800/zoom) } });
  try {
   await page.evaluate(project => { const H=window.__bimaxHarness; H.callbacks.project.forEach(cb=>cb(project)); H.callbacks.state.forEach(cb=>cb('ready','')); window.__loads=[]; window.__searches=[]; window.bimax.files.list=rel=>new Promise((resolve,reject)=>window.__loads.push({rel,resolve,reject})); window.bimax.files.search=q=>new Promise((resolve,reject)=>window.__searches.push({q,resolve,reject})); }, PROJECT);
   await feed(page,{t:'ready',protocol:3}); await feedEvent(page,'ui_snapshot',[uiSnapshot()]); await settle(page,300);
   await pressChord(page,'k'); await page.keyboard.type('Browse files'); await page.keyboard.press('Enter'); await settle(page,300);
   const snapshot=()=>page.$eval('input[aria-label="Filter files"]',el=>{ const panel=el.closest('.h-full'); const v=panel.querySelector('.quiet-scrollbar'); const r=v.getBoundingClientRect(); return {text:panel.innerText,top:r.top,height:r.height,width:r.width}; });
   const loading=await snapshot(); const problems=[];
   if (!loading.text.includes('Loading files')) problems.push('pending list has no honest loading status');
   await clickByText(page,'Refresh the file tree',{exact:true});
   await page.evaluate(()=>window.__loads[1].resolve([{name:'fresh.ts',dir:false},{name:'src',dir:true}])); await settle(page,80);
   await page.evaluate(()=>window.__loads[0].resolve([{name:'stale.ts',dir:false}])); await settle(page,80);
   const ready=await snapshot(); if(!ready.text.includes('fresh.ts')||ready.text.includes('stale.ts')) problems.push('late list replaces the newest files');
   if(ready.text.includes('fresh.ts')) {
    await page.$eval('[role="button"][title="src"]',el=>el.click()); await settle(page,40);
    const open=await page.$eval('[role="button"][title="src"]',el=>el.getAttribute('aria-expanded'));
    if(open!=='true') problems.push('folder waits for the host before acknowledging expansion');
    await page.evaluate(()=>window.__loads.at(-1).resolve([{name:'child.ts',dir:false}])); await settle(page,80);
    const child=await snapshot(); if(!child.text.includes('child.ts')) problems.push('expanded folder did not resolve into its file');
    // A refresh of a tree already on screen (every file the agent writes triggers one) says nothing and moves nothing.
    // It once inserted a "Loading files…" row under each open folder, pushing the tree down and back (2026-10-01).
    const rowTop=()=>page.$eval('[role="button"][title^="src/child.ts"]',el=>el.getBoundingClientRect().top);
    const before=await rowTop(); const pendingFrom=await page.evaluate(()=>window.__loads.length);
    await clickByText(page,'Refresh the file tree',{exact:true}); await settle(page,40);
    const during=await snapshot(); const moved=Math.abs((await rowTop())-before);
    if(during.text.includes('Loading files')||moved>0.5) problems.push(`refreshing a tree already on screen shows a loading line (a row moved ${moved}px)`);
    await page.evaluate(n=>{for(const r of window.__loads.slice(n)) r.resolve(r.rel===''?[{name:'fresh.ts',dir:false},{name:'src',dir:true}]:[{name:'child.ts',dir:false}]);},pendingFrom); await settle(page,80);
   }
   await page.type('input[aria-label="Filter files"]','alpha'); await settle(page,220);
   await page.$eval('input[aria-label="Filter files"]',el=>el.select()); await page.keyboard.press('Backspace'); await page.keyboard.type('beta'); await settle(page,220);
   await page.evaluate(()=>window.__searches[1].resolve({hits:[{rel:'beta.ts',name:'beta.ts',dir:false}],truncated:false})); await settle(page,80);
   await page.evaluate(()=>window.__searches[0].resolve({hits:[{rel:'alpha.ts',name:'alpha.ts',dir:false}],truncated:false})); await settle(page,80);
   const search=await snapshot(); if(!search.text.includes('beta.ts')||search.text.includes('alpha.ts')) problems.push('late search replaces the current query');
   await clickByText(page,'Clear filter',{exact:true}); await clickByText(page,'Refresh the file tree',{exact:true});
   await page.evaluate(()=>window.__loads.findLast(r=>r.rel==='').reject(new Error('Listing denied'))); await settle(page,80);
   const failed=await snapshot(); if(!failed.text.includes('Could not load files')||failed.text.includes('Empty project')) problems.push('failed list pretends the project is empty');
   for(const state of [ready,search,failed]) if(Math.abs(state.top-loading.top)>1||Math.abs(state.height-loading.height)>1||Math.abs(state.width-loading.width)>1) problems.push('loading changes the file viewport geometry');
   if(pageErrors.length) throw new Error(pageErrors.join('\n'));
   report.push({zoom,loading,ready,search,failed,problems});
  } finally {await browser.close();}
 }
} catch(e){invalid=e.stack??String(e);} finally {server.close();}
const value={report,invalid}; writeFileSync(process.argv.find(a=>a.startsWith('--json='))?.slice(7)??'/tmp/bimax-loading.json',JSON.stringify(value,null,2)); console.log(JSON.stringify(value,null,2)); process.exit(invalid?2:report.some(r=>r.problems.length)?1:0);
