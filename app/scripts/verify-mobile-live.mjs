import {build} from 'esbuild';
import {mobileLink,prepareMobile} from './mobile.integration.mjs';
import {mkdtempSync,symlinkSync,rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
const link=prepareMobile(mobileLink()),scratch=mkdtempSync(path.join(tmpdir(),'bimax-live-'));
try{symlinkSync(path.join(link.mobileRoot,'node_modules'),path.join(scratch,'node_modules'),'dir');
 await build({entryPoints:[path.join(import.meta.dirname,'fixtures/mobile-live.ts')],outfile:path.join(scratch,'test.cjs'),bundle:true,platform:'node',format:'cjs',packages:'external',alias:{'phone-history':path.join(link.mobileRoot,'apps/mobile/lib/session/history-client.ts'),'phone-live':path.join(link.mobileRoot,'apps/mobile/lib/session/live-client.ts'),'phone-renderer-bridge':path.join(link.mobileRoot,'apps/mobile/lib/renderer/bridge.ts')}});
 const r=spawnSync(process.execPath,[path.join(scratch,'test.cjs')],{stdio:'inherit',timeout:15000});if(r.error)throw r.error;if(r.status)throw Error('Live conversation regression failed');
}finally{rmSync(scratch,{recursive:true,force:true});}
