import {mobileLink} from './mobile.integration.mjs';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const source=readFileSync(path.join(mobileLink().mobileRoot,'apps/desktop-responder/src/session-create.ts'),'utf8');
const cases=[
 ['late creation after Stop','if (!valid()) throw Error("Secure session retired");','/* fault: retired admission accepted */'],
 ['mutable folder across asynchronous admission',/const request = raw && \{[\s\S]*?\n    \};/,'const request = raw;'],
 ['creation intent reused for another folder','canonicalJson({ kind: "session_create", peer, workspaceId: request.workspaceId })','canonicalJson({ kind: "session_create", peer })'],
];
const results=[];
for(const [name,before,after] of cases){
 const scratch=mkdtempSync(path.join(tmpdir(),'bimax-workspace-fault-'));
 try{
  const changed=source.replace(before,after);assert.notEqual(changed,source,`Missing mutation anchor: ${name}`);const file=path.join(scratch,'session-create.ts');writeFileSync(file,changed);
  const r=spawnSync(process.execPath,[path.join(import.meta.dirname,'verify-mobile-workspaces.mjs')],{encoding:'utf8',timeout:25000,env:{...process.env,BIMAX_SESSION_CREATION_MUTANT:file}});
  assert.ok(r.status!==0&&/AssertionError/.test(r.stdout+r.stderr),`Fault not caught by assertion: ${name}\n${r.stdout}\n${r.stderr}`);
  results.push({name,caught:true});
 }finally{rmSync(scratch,{recursive:true,force:true});}
}
console.log(JSON.stringify({caught:results.length,results},null,2));
