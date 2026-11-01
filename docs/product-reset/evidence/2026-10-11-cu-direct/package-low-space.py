from pathlib import Path
import subprocess,shutil,hashlib,json,plistlib
root=Path(__file__).resolve().parents[4];r=Path(__file__).parent
source=Path('/Applications/Bimax.app');stage=Path('/private/tmp/bimax-cu-direct-20261011-v2/mac-arm64/Bimax.app');scratch=Path('/private/tmp/bimax-cu-direct-asar-20261011')
assert not stage.exists() and not scratch.exists()
assert not subprocess.run(['pgrep','-f','^/Applications/Bimax.app/Contents/MacOS/Bimax$'],capture_output=True).stdout.strip()
assert (root/'app/node_modules/electron/dist/version').read_text().strip()=='43.3.0'
# Reuse only the unchanged installed runtime and packaging metadata, via APFS clone.
stage.parent.mkdir(parents=True);subprocess.run(['cp','-cR',str(source),str(stage)],check=True)
original=source/'Contents/Resources/app.asar';asar=stage/'Contents/Resources/app.asar'
api=str(root/'app/node_modules/@electron/asar/lib/asar.js')
subprocess.run(['node','-e',f'const a=require(process.argv[1]);a.extractAll(process.argv[2],process.argv[3])',api,str(original),str(scratch)],check=True)
shutil.rmtree(scratch/'out');shutil.copytree(root/'app/out',scratch/'out')
assert json.loads((scratch/'package.json').read_text())['version']==json.loads((root/'app/package.json').read_text())['version']
subprocess.run(['node','-e',"const a=require(process.argv[1]);a.createPackageWithOptions(process.argv[2],process.argv[3],{unpackDir:'node_modules/{@lydell,electron-liquid-glass}/**'}).catch(e=>{console.error(e);process.exit(1)})",api,str(scratch),str(asar)],check=True)
# Verify every compiled app output against the archive being shipped.
for p in (root/'app/out').rglob('*'):
 if p.is_file():
  rel='out/'+str(p.relative_to(root/'app/out'))
  output=subprocess.run(['node','-e','const a=require(process.argv[1]);process.stdout.write(a.extractFile(process.argv[2],process.argv[3]))',api,str(asar),rel],check=True,capture_output=True).stdout
  assert hashlib.sha256(output).digest()==hashlib.sha256(p.read_bytes()).digest(),rel
shutil.rmtree(scratch)
for name in ['engine','cu-runtime','voice','notch']:
 dest=stage/'Contents/Resources'/name;shutil.rmtree(dest)
 subprocess.run(['cp','-cR',str(root/'app'/name),str(dest)],check=True)
ext=stage/'Contents/Extensions/BimaxIntents.appex';shutil.rmtree(ext);subprocess.run(['cp','-cR',str(root/'app/intents/BimaxIntents.appex'),str(ext)],check=True)
header=subprocess.run(['node','-e','const a=require(process.argv[1]);process.stdout.write(a.getRawHeader(process.argv[2]).headerString)',api,str(asar)],check=True,capture_output=True).stdout
plist=stage/'Contents/Info.plist';info=plistlib.loads(plist.read_bytes());info['ElectronAsarIntegrity']={'Resources/app.asar':{'algorithm':'SHA256','hash':hashlib.sha256(header).hexdigest()}};plist.write_bytes(plistlib.dumps(info,fmt=plistlib.FMT_BINARY))
subprocess.run(['xattr','-cr',str(stage)],check=True)
report={'reason':'standard electron-builder failed with ENOSPC; APFS clone avoids full Electron duplication','installedRuntimeVersion':'43.3.0','compiledOutputVerified':True,'freshExtras':['engine','cu-runtime','voice','notch','BimaxIntents.appex'],'stage':str(stage),'appAsarSha256':hashlib.sha256(asar.read_bytes()).hexdigest()}
(r/'packaging.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
