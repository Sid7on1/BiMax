from pathlib import Path
import os,subprocess,hashlib,json
r=Path(__file__).parent
stage=Path('/private/tmp/bimax-cu-modes-20261011-v1/mac-arm64/Bimax.app')
installed=Path('/Applications/Bimax.app');incoming=Path('/Applications/Bimax.incoming-cu-modes-20261011.app')
rollback=Path.home()/'Developer/bimax-archive/apps/2026-10-11-before-cu-modes/Bimax.app'
assert stage.exists() and installed.exists() and not incoming.exists() and not rollback.exists()
assert not subprocess.run(['pgrep','-f','^/Applications/Bimax.app/Contents/MacOS/Bimax$'],capture_output=True).stdout.strip(),'Bimax is still running'
def inventory(root):
 return {str(p.relative_to(root)):('link:'+os.readlink(p) if p.is_symlink() else hashlib.sha256(p.read_bytes()).hexdigest()) for p in root.rglob('*') if p.is_file() or p.is_symlink()}
before=json.loads((r/'profile-before.json').read_text())['files']
assert all(Path(p).exists() and hashlib.sha256(Path(p).read_bytes()).hexdigest()==h for p,h in before.items()),'profile changed before replacement'
subprocess.run(['ditto',str(stage),str(incoming)],check=True)
subprocess.run(['codesign','--verify','--deep','--strict',str(incoming)],check=True)
expected=inventory(stage);assert inventory(incoming)==expected
rollback.parent.mkdir(parents=True)
installed.rename(rollback)
try:incoming.rename(installed)
except:rollback.rename(installed);raise
assert inventory(installed)==expected
assert all(hashlib.sha256(Path(p).read_bytes()).hexdigest()==h for p,h in before.items())
report={'staged':str(stage),'installed':str(installed),'rollback':str(rollback),'filesMatched':len(expected),'protectedJsonFilesUnchanged':len(before),'appAsarSha256':hashlib.sha256((installed/'Contents/Resources/app.asar').read_bytes()).hexdigest(),'signing':'Bimax Local Code Signing; unhardened, not notarized'}
(r/'install.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
