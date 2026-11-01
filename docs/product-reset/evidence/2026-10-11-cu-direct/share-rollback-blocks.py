from pathlib import Path
import hashlib,os,subprocess,json
root=Path.home()/'Developer/bimax-archive/apps';rel=Path('Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework');source=Path('/Applications/Bimax.app')/rel
names=['2026-10-11-at-cu-before-approval-normalization','2026-10-11-before-cu-modes','2026-10-11-before-cu-modes-polish']
def attrs_of(p):
 names=subprocess.run(['xattr',str(p)],check=True,capture_output=True,text=True).stdout.splitlines()
 return {n:subprocess.run(['xattr','-px',n,str(p)],check=True,capture_output=True,text=True).stdout.replace(' ','').replace('\n','') for n in names}
report=[]
for name in names:
 p=root/name/'Bimax.app'/rel; assert p.is_file() and p.stat().st_nlink==1
 before=hashlib.sha256(p.read_bytes()).hexdigest();stat=p.stat();attrs=attrs_of(p)
 same=0;size=0
 with p.open('rb') as old,source.open('rb') as base:
  while chunk:=old.read(1048576):
   size+=len(chunk);same+=len(chunk) if chunk==base.read(len(chunk)) else 0
 assert same/size>.95,(name,same/size)
 temp=p.with_name(p.name+'.sharing-blocks');assert not temp.exists()
 subprocess.run(['cp','-cp',str(source),str(temp)],check=True)
 with p.open('rb') as old,temp.open('r+b') as cloned:
  offset=0
  while chunk:=old.read(1048576):
   if cloned.read(len(chunk))!=chunk:cloned.seek(offset);cloned.write(chunk)
   offset+=len(chunk);cloned.seek(offset)
  cloned.truncate(size)
 os.chmod(temp,stat.st_mode);os.utime(temp,ns=(stat.st_atime_ns,stat.st_mtime_ns))
 subprocess.run(['xattr','-c',str(temp)],check=True)
 for n,v in attrs.items():subprocess.run(['xattr','-wx',n,v,str(temp)],check=True)
 assert hashlib.sha256(temp.read_bytes()).hexdigest()==before
 temp.replace(p)
 assert hashlib.sha256(p.read_bytes()).hexdigest()==before and attrs_of(p)==attrs
 report.append({'archive':name,'bytesUnchanged':True,'sha256':before,'sharedIdenticalBytes':same,'fileBytes':size})
(Path(__file__).parent/'rollback-storage.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
