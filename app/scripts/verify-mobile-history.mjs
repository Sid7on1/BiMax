import { build } from 'esbuild';
import { mobileLink, prepareMobile } from './mobile.integration.mjs';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const link=prepareMobile(mobileLink());
const scratch=mkdtempSync(path.join(tmpdir(),'bimax-history-'));
try {
 symlinkSync(path.join(link.mobileRoot,'node_modules'),path.join(scratch,'node_modules'),'dir');
 await build({entryPoints:[path.join(import.meta.dirname,'fixtures/mobile-history.ts')],outfile:path.join(scratch,'test.cjs'),bundle:true,platform:'node',format:'cjs',packages:'external',alias:{...(process.env.BIMAX_HISTORY_SOURCE ? {'desktop-responder':process.env.BIMAX_HISTORY_SOURCE} : {}),'phone-incoming':process.env.BIMAX_INCOMING_SOURCE || path.join(link.mobileRoot,'apps/mobile/lib/session/incoming.ts'),'phone-history':path.join(link.mobileRoot,'apps/mobile/lib/session/history-client.ts'),'phone-keys':path.join(link.mobileRoot,'packages/core/src/crypto/keys.ts')}});
 const r=spawnSync(process.execPath,[path.join(scratch,'test.cjs')],{stdio:'inherit',timeout:30000});if(r.error)throw r.error;if(r.status)throw Error('History regression failed');
} finally {rmSync(scratch,{recursive:true,force:true});}
