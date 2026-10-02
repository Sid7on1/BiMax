#!/usr/bin/env node
/** Real wrapper with a controlled SDK: lease expiry, native label tombstones, zero input during reads,
 * fresh contexts after delayed approvals, and no replay after dispatch. No real macOS input is performed.
 * --mutant=<name> changes only a temporary compiled copy; a behavior assertion must fail.
 */
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const appRoot = path.resolve(__dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-session-renewal-'));
const mutant = process.argv.find(x => x.startsWith('--mutant='))?.split('=')[1];
const mutations = {
  no_transient_retry: ["} else if (/\\bax_(?:tree_empty|app_launching|window_unresolved):|AX tree walk .*did not return within/i.test(reason(error).message)) {", "} else if (false) {"],
  cached_use: ["await dropSession(key);\n    requireCurrent(threadId, generation);\n    const manifestText", "if (sessions.has(key)) return sessions.get(key).session;\n    const manifestText"],
  reused_name: ["}-${randomUUID()}`", "}`"],
  no_close: ["try { await value.session.close?.(); }", "try { /* no close */ }"],
  all_errors: ['else { throw reason(error); }', 'else { /* retry unrelated denial */ }'],
  no_renewal: ['if (sessionLeaseEnded(error)) {', 'if (sessionLeaseEnded(error)) { throw reason(error);'],
};
const key = Symbol.for('bimax.session.renewal.proof');
async function main() {
  if (mutant) assert(mutations[mutant], 'unknown mutant');
  await require(path.join(appRoot, 'node_modules/esbuild')).build({ entryPoints: [path.join(appRoot, 'src/main/computer/look.driver.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(temp, 'driver.cjs'),
    plugins: mutant ? [{name:'mutant',setup(build){build.onLoad({filter:/look\.driver\.ts$/}, async args => {
      let contents = fs.readFileSync(args.path,'utf8'); const [from,to]=mutations[mutant]; assert(contents.includes(from), 'mutation anchor absent');
      contents=contents.split(from).join(to); return {loader:'ts',contents};
    });}}] : [] });
  const {createLookDriver} = require(path.join(temp,'driver.cjs'));
  const checks=[];
  for (const scenario of ['list-expired','state-expired','ended','denied','twice-expired','ax-unready','ax-timeout','twice-unready','delayed-press','uncertain-input','isolation']) {
    const state={sessions:[],calls:[],errors:['twice-expired','twice-unready'].includes(scenario)?2:1}; globalThis[key]=state;
    const appPath=path.join(temp,scenario), sdk=path.join(appPath,'node_modules/@trycua/cua-driver/dist'); fs.mkdirSync(sdk,{recursive:true});
    fs.writeFileSync(path.join(sdk,'../package.json'),'{"type":"module"}');
    fs.writeFileSync(path.join(sdk,'index.js'),`
      import fs from 'node:fs';
      const state=globalThis[Symbol.for('bimax.session.renewal.proof')], scenario=${JSON.stringify(scenario)};
      const options={create:o=>o}; export const ConfiguredDriverOptions=options, RuntimeAuthorizationOptions=options, TrustedSessionOptions=options;
      export const SessionPermissionMode={Bounded:'bounded'};
      export const CuaDriver={createConfiguredWithActivityObserver:()=>({})};
      export function createTrustedSession(_,options){
        if(state.sessions.some(s=>s.options.publicSession===options.publicSession)) throw new Error('session has ended: public label tombstone');
        const record={options,manifest:fs.readFileSync(options.capabilityManifestPath,'utf8'),closed:false,expired:false};state.sessions.push(record);
        return {close:async()=>{record.closed=true;},callTool:async(tool)=>{
          state.calls.push(tool);
          if(record.expired)throw new Error('Permission denied: authorization context expired');
          const errorTool=['state-expired','ax-unready','ax-timeout','twice-unready'].includes(scenario)?'get_window_state':'list_windows';
          if(['list-expired','state-expired','ended','denied','twice-expired','ax-unready','ax-timeout','twice-unready'].includes(scenario)&&tool===errorTool&&state.errors-->0)
            throw new Error(['ax-unready','twice-unready'].includes(scenario)?'ax_app_launching: app did not answer accessibility within timeout_ms':scenario==='ax-timeout'?'AX tree walk for pid=123 did not return within 9 s: an accessibility call stopped answering':scenario==='denied'?'Permission denied: outside the manifest':scenario==='ended'?"session 'x' has ended; call start_session":'Permission denied: authorization context expired');
          if(tool==='click'&&scenario==='uncertain-input')throw new Error('transport disconnected after dispatch');
          if(tool==='list_windows')return {structuredJson:JSON.stringify({windows:[{window_id:1,title:'Fixture',is_on_screen:true,bounds:{width:100,height:100}}]})};
          return {structuredJson:JSON.stringify({tree_markdown:'fixture',elements:[{element_index:0,role:'AXWindow'},{element_index:1,parent_index:0,role:'AXButton',label:'Fixture Button',actions:['AXPress'],element_token:'target'}]})};
        }};
      }
    `);
    const driver=createLookDriver({stateDir:path.join(appPath,'state'),packaged:false,resourcesPath:'',appPath});
    const app={name:'Fixture',bundleId:'ai.bimax.cu.fixture',pid:123}, target={windowId:1,role:'AXButton',label:'Fixture Button'};
    if(['delayed-press','uncertain-input'].includes(scenario)){
      const first=await driver.press('t1',app,target);
      if(scenario==='uncertain-input'){
        assert.equal(first.kind,'uncertain'); assert.equal(state.calls.filter(x=>x==='click').length,1,'uncertain input replayed');
      } else {
        assert.equal(first.kind,'pressed'); state.sessions.forEach(s=>s.expired=true);
        const second=await driver.press('t1',app,target).catch(error=>({kind:'error',detail:error.message})); assert.equal(second.kind,'pressed','expired use context reused after approval delay');
        assert.equal(state.sessions.length,2);assert(state.sessions[0].closed,'old use context not closed');
        assert.equal(state.calls.filter(x=>x==='click').length,2);
        assert(state.sessions.every(s=>s.options.ttlSeconds===300n&&s.options.idleTtlSeconds===120n),'lease widened');
      }
    }else if(scenario==='isolation'){
      await driver.look('t1',app);await driver.look('t2',app);await driver.look('t1',{...app,bundleId:'com.apple.Music'});
      await driver.end('t1');assert(state.sessions[0].closed&&state.sessions[2].closed);assert(!state.sessions[1].closed,'ended another Thread context');
    }else{
      const result=await driver.look('t1',app).then(()=>({ok:true}),error=>({ok:false,error:error.message}));
      assert.equal(result.ok,!['denied','twice-expired','twice-unready'].includes(scenario));
      assert.equal(state.sessions.length,['denied','ax-unready','ax-timeout','twice-unready'].includes(scenario)?1:2,'renewal count');
      if(!['denied','ax-unready','ax-timeout','twice-unready'].includes(scenario))assert(state.sessions[0].closed,'expired context not closed');
      assert(state.sessions.every(s=>!s.manifest.includes('allow:\n  tools: [click')));
      assert(!state.calls.includes('click'),'read recovery dispatched input');
    }
    await driver.end('t1');await driver.end('t2');
    assert(state.sessions.every(s=>s.closed),'context leaked');
    assert.equal(fs.readdirSync(path.join(appPath,'state')).filter(x=>x!=='runtime.yaml').length,0,'manifest leaked');
    checks.push({scenario,passed:true,sessions:state.sessions.length,inputCalls:state.calls.filter(x=>x==='click').length});
  }
  console.log(JSON.stringify({kind:'controlled-sdk-real-wrapper',mutant:mutant||null,passed:checks.length,checks},null,2));
}
main().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(()=>{delete globalThis[key];fs.rmSync(temp,{recursive:true,force:true})});
