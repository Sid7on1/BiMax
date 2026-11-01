#!/usr/bin/env python3
"""Catch one deliberately reintroduced fault per audit finding in disposable source copies."""
import argparse, json, os, pathlib, shutil, subprocess, tempfile
ROOT = pathlib.Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--output', required=True)
args = parser.parse_args()
output = pathlib.Path(args.output).resolve(); output.mkdir(parents=True, exist_ok=True)
cases = [
 ('F01', 'app/src/main/security.ts', [("url.protocol==='file:'&&key!==null&&packaged.some(p=>documentKey(p)===key)", "url.protocol==='file:'")], 'app/src/__tests__/security.boundaries.regression.test.ts', 'F01'),
 ('F02', 'app/src/main/project.files.ts', [("const data = await this.call(tail ? 'tail' : 'read', rel);", "const unsafe = await import('node:fs/promises'); const payload = await unsafe.readFile(path.join(this.root, String(rel))); const head = Buffer.alloc(8); head.writeBigUInt64BE(BigInt(payload.length)); const data = Buffer.concat([head, payload]);")], 'app/src/__tests__/security.boundaries.regression.test.ts', 'linked outside'),
 ('F03', 'src/governor/governor.ts', [("subject !== undefined && r.subject === subject", "true")], 'src/__tests__/security.admission.regression.test.ts', 'F03'),
 ('F04', 'app/src/main/responder/adapter.ts', [("const approvalId = approval.token;", "const approvalId = String(approval.request.id);")], 'app/src/main/responder/__tests__/approval.security.test.ts', 'independent engine'),
 ('F05', 'src/tools/implementations/public-request.ts', [("export function publicIp(ip: string): boolean {", "export function publicIp(ip: string): boolean { return true;")], 'src/__tests__/webfetch.security.regression.test.ts', 'F05'),
 ('F06', 'src/tools/implementations/public-request.ts', [("BigInt(declared) > BigInt(maxBytes)", "false"), ("if (bytes > maxBytes)", "if (false)")], 'src/__tests__/webfetch.security.regression.test.ts', 'F06'),
 ('F07', 'src/governor/governor.ts', [("if (taskType === 'NETWORK_ACCESS') {", "if (taskType === 'NETWORK_ACCESS') { return;")], 'src/__tests__/security.admission.regression.test.ts', 'F07'),
 ('P01', 'app/src/main/responder/mobile.connection.ts', [("enabled: !!this.running,", "enabled: true,")], 'app/src/main/responder/__tests__/mobile.connection.test.ts', 'off by default'),
 ('P02', 'app/src/main/responder/mobile.connection.ts', [("this.storage();\n      const { loadOrCreateIdentity", "/* unsafe startup */\n      const { loadOrCreateIdentity")], 'app/src/main/responder/__tests__/mobile.connection.test.ts', 'unavailable/plaintext'),
 ('P03', 'app/src/main/responder/mobile.connection.ts', [("candidate.verificationCode !== code", "false")], 'app/src/main/responder/__tests__/mobile.connection.test.ts', 'expired, foreign'),
 ('P04', 'app/src/main/responder/mobile.connection.ts', [("this.halted = true;", "/* missing stop latch */")], 'app/src/main/responder/__tests__/mobile.connection.test.ts', 'Stop retires'),

]
results=[]
with tempfile.TemporaryDirectory(prefix='bimax-security-mutants-') as temporary:
 work=pathlib.Path(temporary).resolve()
 for directory in ['src','app/src']:
  shutil.copytree(ROOT/directory,work/directory)
 for file in ['tsconfig.json','jest.config.ts','jest.setup.ts','package.json','scripts/jest-renderer-setup.cjs','scripts/jest-style.cjs']:
  (work/file).parent.mkdir(parents=True,exist_ok=True)
  shutil.copy2(ROOT/file,work/file)
 (work/'node_modules').symlink_to(ROOT/'node_modules',target_is_directory=True)
 (work/'app/node_modules').symlink_to(ROOT/'app/node_modules',target_is_directory=True)
 (work/'app/project-files').symlink_to(ROOT/'app/project-files',target_is_directory=True)
 for finding, file, replacements, suite, name in cases:
  target=work/file; original=target.read_text(); mutated=original
  for before,after in replacements:
   if mutated.count(before)!=1: raise RuntimeError(f'{finding}: mutation site drift: {before}')
   mutated=mutated.replace(before,after,1)
  target.write_text(mutated)
  try:
   run=subprocess.run([str(ROOT/'node_modules/.bin/jest'),'--config',str(work/'jest.config.ts'),'--runInBand','--forceExit','--coverage=false','--no-cache','--json',f'--outputFile={output/f"{finding}.json"}','--runTestsByPath',str(work/suite),'--testNamePattern',name],cwd=work,env=os.environ,capture_output=True,text=True,timeout=60)
   (output/f'{finding}.log').write_text(run.stdout+run.stderr)
   report=json.loads((output/f'{finding}.json').read_text())
   failed=[assertion for suite_result in report['testResults'] for assertion in suite_result['assertionResults'] if assertion['status']=='failed']
   if not failed or run.returncode==0: raise RuntimeError(f'{finding}: fault not caught by test assertion')
   results.append({'finding':finding,'caught':True,'failedAssertions':[a['fullName'] for a in failed]})
  finally: target.write_text(original)
(output/'mutations.json').write_text(json.dumps(results,indent=2)+'\n')
print(json.dumps(results,indent=2))
