import {mobileLink} from './mobile.integration.mjs';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const mobile=mobileLink().mobileRoot,lib=path.join(mobile,'apps/mobile/lib'),scratch=mkdtempSync(path.join(tmpdir(),'bimax-recovery-faults-'));
const results=[];
function qualify(name,files,command,env,expected){
 const root=path.join(scratch,name);mkdirSync(root,{recursive:true});
 for(const [file,contents]of Object.entries(files)){const target=path.join(root,file);mkdirSync(path.dirname(target),{recursive:true});writeFileSync(target,contents);}
 const r=spawnSync(process.execPath,command,{cwd:mobile,encoding:'utf8',timeout:60000,env:{...process.env,...env(root)}});
 assert(!r.error,`${name}: ${r.error}`);assert.notEqual(r.status,0,`${name} survived`);assert.match(r.stdout+r.stderr,expected,`${name} failed outside its assertion`);results.push({name,caught:true});
}
const recovery=readFileSync(path.join(lib,'renderer/recovery.ts'),'utf8'),client=readFileSync(path.join(lib,'relay/client.ts'),'utf8');
try{
 const units=path.join(mobile,'apps/mobile/test/renderer-recovery-test.mjs');
 for(const [name,from,to]of [['unbounded-auto-remount','if (this.attempts.length >= 2) return false;','if (false) return false;'],['duplicate-native-events','if (generation !== this.generation || this.failedGeneration === generation) return false;','if (false) return false;'],['unbounded-event-retention','if (this.events.length > 32) this.events.shift();','']]){
  assert(recovery.includes(from));qualify(name,{'renderer/recovery.ts':recovery.replace(from,to),'relay/client.ts':client},[units],root=>({BIMAX_RECOVERY_SOURCE_ROOT:root}),/AssertionError|ERR_ASSERTION/);
 }
 const unsafe='Promise.resolve(this.opts.onMessage(env as unknown as Envelope<MessageKind, unknown>))';
 qualify('synchronous-socket-throw',{'renderer/recovery.ts':recovery,'relay/client.ts':client.replace('Promise.resolve().then(() => this.opts.onMessage(env as unknown as Envelope<MessageKind, unknown>))',unsafe)},[units],root=>({BIMAX_RECOVERY_SOURCE_ROOT:root}),/unwanted exception|ERR_ASSERTION/);
 const hook=readFileSync(path.join(lib,'session/use-remote-actions.ts'),'utf8');
 qualify('phone-model-call',{'hook.ts':hook.replace('      const trimmed = options.text.trim();','      await fetch("https://inert.invalid/chat/completions");\n      const trimmed = options.text.trim();')},[path.join(import.meta.dirname,'verify-mobile-routing-recovery.mjs')],root=>({BIMAX_REMOTE_ACTIONS_SOURCE:path.join(root,'hook.ts')}),/No phone HTTP\/model authority/);
 const accountGuard='      if (requireActiveAccount() !== owner || trustedRef.current?.deviceId !== desktopId)\n        throw new Error("Account or paired Mac changed");';
 assert(hook.includes(accountGuard));qualify('account-change-during-write',{'hook.ts':hook.replace(accountGuard,'')},[path.join(import.meta.dirname,'verify-mobile-routing-recovery.mjs')],root=>({BIMAX_REMOTE_ACTIONS_SOURCE:path.join(root,'hook.ts')}),/ERR_ASSERTION/);
 const screen=readFileSync(path.join(mobile,'apps/mobile/app/desktop-chat/[id].tsx'),'utf8');
 const caseRoot=path.join(scratch,'metadata');mkdirSync(path.join(caseRoot,'app/desktop-chat'),{recursive:true});symlinkSync(path.join(mobile,'apps/mobile/components'),path.join(caseRoot,'components'),'dir');symlinkSync(lib,path.join(caseRoot,'lib'),'dir');
 const target=path.join(caseRoot,'app/desktop-chat/[id].tsx');writeFileSync(target,screen.replace('[id, connected, desktopId, watchConversation, revision]','[id, connected, trustedDesktop, desktopId, watchConversation, revision]'));
 const r=spawnSync(process.execPath,[path.join(import.meta.dirname,'verify-mobile-chat-ui.mjs')],{cwd:path.resolve(import.meta.dirname,'../..'),encoding:'utf8',timeout:60000,env:{...process.env,BIMAX_CHAT_SCREEN_SOURCE:target}});
 assert(!r.error,String(r.error));assert.notEqual(r.status,0,'metadata resubscribe survived');assert.match(r.stdout+r.stderr,/ERR_ASSERTION/);results.push({name:'metadata-resubscription',caught:true});
 console.log(JSON.stringify({faults:results},null,2));
}finally{rmSync(scratch,{recursive:true,force:true});}
