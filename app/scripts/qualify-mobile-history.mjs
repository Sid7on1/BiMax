import { readFileSync,writeFileSync,mkdtempSync,rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mobileLink } from './mobile.integration.mjs';
const root=mobileLink().mobileRoot;
const scratch=mkdtempSync(path.join(tmpdir(),'bimax-history-faults-'));
const output=process.env.BIMAX_HISTORY_MUTATIONS;
const source=readFileSync(path.join(root,'apps/desktop-responder/src/history.ts'),'utf8');
const incoming=readFileSync(path.join(root,'apps/mobile/lib/session/incoming.ts'),'utf8');
const cases=[
 {name:'skip-history-authorization',variable:'BIMAX_HISTORY_SOURCE',source,from:'await this.ports.authorize(req.sessionId, title);',to:'/* deliberate fault: no host authorization */'},
 {name:'reuse-cursor-after-secure-reconnect',variable:'BIMAX_HISTORY_SOURCE',source,from:'stored.context.session !== context.session ||',to:''},
 {name:'dispatch-plaintext-history',variable:'BIMAX_INCOMING_SOURCE',source:incoming,from:'if (!authenticated && !isAllowedUnauthenticatedKind(env.kind)) return;',to:'/* deliberate fault: accept plaintext */'},
];
const results=[];
try {for(const c of cases){assert.ok(c.source.includes(c.from),`fault anchor missing: ${c.name}`);const file=path.join(scratch,c.name+'.ts');writeFileSync(file,c.source.replace(c.from,c.to));const r=spawnSync(process.execPath,[path.join(import.meta.dirname,'verify-mobile-history.mjs')],{cwd:path.resolve(import.meta.dirname,'../..'),env:{...process.env,[c.variable]:file},encoding:'utf8',timeout:60000,maxBuffer:1024*1024});const assertion=/AssertionError/.test(r.stdout+r.stderr);assert.ok(r.status!==0&&assertion,`${c.name} did not fail an assertion: ${r.stderr}`);results.push({name:c.name,caught:true,assertion:true});}
 console.log(JSON.stringify(results,null,2));if(output)writeFileSync(output,JSON.stringify(results,null,2));
}finally{rmSync(scratch,{recursive:true,force:true});}
