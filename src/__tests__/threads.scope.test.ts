import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { enforceThreadScope } from '../tools/thread.scope';
import { Governor } from '../governor/governor';
import { GlobalPrompter } from '../cli/prompter';
import { sandboxArgv, sandboxBin } from '../sandbox/exec.sandbox';
import { createDocumentTool } from '../tools/implementations/document.tool';
import { countWords } from '../tools/implementations/file.tool';
import { applyImplicitDocumentConstraints } from '../tools/write.constraints';
import { SafetyPolicy } from '../governor/policy.engine';

// Fixtures live under the repo, not os.tmpdir(): on macOS that resolves to /private/var/…, which the
// governor's workspace floor refuses as a forbidden system path (capability.silence.test does the same).
let dir:string, root:string;
const originalWorkspace = SafetyPolicy.allowedWorkspace;
beforeEach(()=> { dir=fs.mkdtempSync(path.join(process.cwd(),'.thread-scope-test-'));root=path.join(dir,'work');fs.mkdirSync(root);process.env.BIMAX_THREAD_ROOT=root;process.env.BIMAX_STATE_DIR=dir;SafetyPolicy.allowedWorkspace=root; });
afterEach(()=> { delete process.env.BIMAX_THREAD_ROOT;delete process.env.BIMAX_STATE_DIR;SafetyPolicy.allowedWorkspace=originalWorkspace; jest.restoreAllMocks();fs.rmSync(dir,{ recursive:true,force:true }); });

test('deep missing parents under an escaping symlink cannot widen the thread folder',async()=> {
  fs.symlinkSync(dir,path.join(root,'escape'));
  await expect(enforceThreadScope({ path:'escape/new/deeper/file.txt' },root)).rejects.toThrow('outside');
  await expect(enforceThreadScope({ path:'new/deeper/file.txt' },root)).resolves.toBeUndefined();
  await expect(enforceThreadScope({ path:root+'-sibling/file.txt' },root)).rejects.toThrow('outside');
});

test('new files are routine; overwrite and delete still ask despite bypass and blanket rules',async()=> {
  const gov=new Governor({ emit:jest.fn() } as any);gov.mode='bypass';
  gov.rules=[{ tool:'FILE_WRITE',effect:'allow',persistent:true }];
  const ask=jest.spyOn(GlobalPrompter,'ask').mockResolvedValue('No');
  const target=path.join(root,'story.txt');
  await gov.approveTaskExecution('FILE_WRITE',{ targetPath:target,context:{ cwd:root },isDestructive:true });
  expect(ask).not.toHaveBeenCalled();
  fs.writeFileSync(target,'keep');
  await expect(gov.approveTaskExecution('FILE_WRITE',{ targetPath:target,context:{ cwd:root },isDestructive:true })).rejects.toThrow('declined');
  expect(fs.readFileSync(target,'utf8')).toBe('keep');
  await expect(gov.approveTaskExecution('FILE_DELETE',{ targetPath:target,context:{ cwd:root },isDestructive:true })).rejects.toThrow('declined');
  expect(ask).toHaveBeenCalledTimes(2);
});

test('real OS shell sandbox refuses an external write while an internal write succeeds',()=> {
  const bin=sandboxBin();
  if (!bin) throw new Error('This safety gate requires the real OS sandbox');
  const inside=path.join(root,'inside.txt');
  // Use an external directory that is not a globally writable temp exception.
  const outside=path.join(os.homedir(),`.bimax-thread-boundary-${process.pid}.txt`);
  try {
    const argv=sandboxArgv(`printf kept > '${inside}'`,root)!;
    execFileSync(bin,argv,{ stdio:'pipe' });expect(fs.readFileSync(inside,'utf8')).toBe('kept');
    expect(()=>execFileSync(bin,sandboxArgv(`printf escaped > '${outside}'`,root)!,{ stdio:'pipe' })).toThrow();
    expect(fs.existsSync(outside)).toBe(false);
  } finally { if(fs.existsSync(outside)) fs.unlinkSync(outside); }
});

test('a single-line story does not become zero words when a model mislabels it as a title',()=> {
  expect(countWords('one two three',true)).toBe(3);
  expect(countWords('Title\n\none two three',true)).toBe(3);
});

test('underlength PDF retains a draft; append, duplicate rejection, replace and finalize produce exact content',async()=> {
  const tool=createDocumentTool({ approveTaskExecution:async()=>{} } as any);
  const run=(args:any)=>tool.execute({ format:'pdf',path:'story.pdf',...args },{ cwd:root });
  const part={ title:'Story',blocks:[{ kind:'paragraph',text:'one two three' }] };
  const result=await run({ spec:part,expectedWords:6 });
  expect(result).toContain('Draft retained');expect(fs.existsSync(path.join(root,'story.pdf'))).toBe(false);
  const duplicate=await run({ action:'append',spec:part });expect(duplicate).toContain('already');
  await run({ action:'append',spec:{ blocks:[{ kind:'paragraph',text:'four five' }] } });
  const early=await run({ action:'finalize' });expect(early).toContain('add 1');
  await run({ action:'replace',blockIndex:1,spec:{ blocks:[{ kind:'paragraph',text:'four five six' }] } });
  const done=await run({ action:'finalize' });expect(done).toContain('Verified 6 paragraph words');
  expect(fs.readFileSync(path.join(root,'story.pdf')).subarray(0,5).toString()).toBe('%PDF-');
});

test('PDF receives the same explicit word target as prose output',()=> {
  const args=JSON.parse(applyImplicitDocumentConstraints('{"format":"pdf","path":"story.pdf"}',[{ role:'user',content:'i want a 2000 word long horror story' }]));
  expect(args.expectedWords).toBe(2000);
});

test('a thread asks in plain words, refuses deletes it cannot send to the Bin, and journals what it allows',async()=> {
  const gov=new Governor({ emit:jest.fn() } as any);
  fs.mkdirSync(path.join(root,'DEV'));
  const ask=jest.spyOn(GlobalPrompter,'ask').mockResolvedValue('Allow');
  await gov.approveTaskExecution('OS_COMMAND',{ command:'mv DEV 2026-09-13_DEV',context:{ cwd:root },isDestructive:true });
  expect(ask).toHaveBeenCalledWith('Rename folder “DEV” to “2026-09-13_DEV”',['Allow','Deny'],expect.objectContaining({ body:expect.stringContaining('DEV/ → 2026-09-13_DEV') }));
  expect(fs.readFileSync(path.join(dir,'.bimax','undo','journal.jsonl'),'utf8')).toContain('"op":"move"');
  await expect(gov.approveTaskExecution('OS_COMMAND',{ command:'find . -delete',context:{ cwd:root },isDestructive:true })).rejects.toThrow('Bin');
  expect(ask).toHaveBeenCalledTimes(1);
  ask.mockResolvedValue('Deny');
  await expect(gov.approveTaskExecution('OS_COMMAND',{ command:'mv DEV elsewhere',context:{ cwd:root },isDestructive:true })).rejects.toThrow('declined');
});
