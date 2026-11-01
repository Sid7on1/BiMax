"""Re-run three bounded, assertion-caught chat faults in disposable source copies."""
from pathlib import Path
import argparse, tempfile, subprocess, os, json
parser=argparse.ArgumentParser()
parser.add_argument('--mobile',default=str(Path.home()/'Desktop/bimax-mobile'))
parser.add_argument('--output',default=str(Path(__file__).resolve().parent))
args=parser.parse_args();root=Path(args.mobile).resolve();out=Path(args.output).resolve();out.mkdir(parents=True,exist_ok=True)
results=[]
cases=[('S01','gateway.ts','(expoFetch as unknown as typeof fetch)','fetch'),('S02','chat-stream.ts','for (const reject of pending) reject();','/* ignored abort */'),('S03','chat-stream.ts','if (!fullContent.trim())','if (false)')]
for name,file,before,after in cases:
 with tempfile.TemporaryDirectory(prefix='bimax-chat-mutant-') as directory:
  scratch=Path(directory)
  for source in ['gateway.ts','chat-stream.ts']:
   (scratch/source).write_text((root/'apps/mobile/lib'/source).read_text())
  target=scratch/file;text=target.read_text();assert before in text,(name,before)
  target.write_text(text.replace(before,after))
  run=subprocess.run(['node','apps/mobile/test/chat-stream-test.mjs'],cwd=root,env={**os.environ,'BIMAX_CHAT_SOURCE_ROOT':str(scratch)},stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=12)
  (out/(name+'-delivered.log')).write_bytes(run.stdout)
  caught=run.returncode!=0 and b'AssertionError' in run.stdout
  results.append({'id':name,'file':file,'assertionCaught':caught,'exit':run.returncode,'log':name+'-delivered.log'})
  assert caught,(name,run.stdout.decode()[-1800:])
(out/'mutations-delivered.json').write_text(json.dumps(results,indent=2));print(json.dumps(results))
