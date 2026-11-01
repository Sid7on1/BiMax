import {build} from 'esbuild';
import {mobileLink,prepareMobile} from './mobile.integration.mjs';
import {mkdtempSync,symlinkSync,rmSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
const link=prepareMobile(mobileLink()),scratch=mkdtempSync(path.join(tmpdir(),'bimax-workspace-fixture-'));
try{symlinkSync(path.join(link.mobileRoot,'node_modules'),path.join(scratch,'node_modules'),'dir');
 await build({entryPoints:[path.join(import.meta.dirname,'fixtures/mobile-workspaces.ts')],outfile:path.join(scratch,'test.cjs'),bundle:true,platform:'node',format:'cjs',packages:'external',plugins:[{name:'isolated-source-fault',setup(b){if(process.env.BIMAX_SESSION_CREATION_MUTANT)b.onLoad({filter:/session-create\.ts$/},args=>({contents:readFileSync(process.env.BIMAX_SESSION_CREATION_MUTANT,'utf8'),loader:'ts',resolveDir:path.dirname(args.path)}));}}],alias:{'workspace-service':path.join(link.mobileRoot,'apps/desktop-responder/src/session-create.ts'),'workspace-journal':path.join(link.mobileRoot,'apps/desktop-responder/src/idempotency.ts'),'phone-session-create':path.join(link.mobileRoot,'apps/mobile/lib/session/session-create-client.ts')}});
 const r=spawnSync(process.execPath,[path.join(scratch,'test.cjs')],{stdio:'inherit',timeout:15000});if(r.error)throw r.error;if(r.status)throw Error('Workspace creation regression failed');
}finally{rmSync(scratch,{recursive:true,force:true});}
