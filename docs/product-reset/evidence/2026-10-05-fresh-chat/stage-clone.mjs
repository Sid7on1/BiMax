// Preserve the unchanged runtime and all dependencies; replace every current app payload.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import * as asar from '../../../../app/node_modules/@electron/asar/lib/asar.js';
import { Pickle } from '../../../../app/node_modules/@electron/asar/lib/pickle.js';
import { getFileIntegrity } from '../../../../app/node_modules/@electron/asar/lib/integrity.js';
const repo=process.cwd(), stage='/tmp/bimax-fresh-chat-20261005/mac-arm64/Bimax.app';
const source='/Applications/Bimax.app/Contents/Resources/app.asar';
const resources=path.join(stage,'Contents/Resources'), target=path.join(resources,'app.asar');
const version=execFileSync('/usr/libexec/PlistBuddy',['-c','Print :CFBundleVersion',path.join(stage,'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist')],{encoding:'utf8'}).trim();
if(version!=='43.3.0') throw new Error('unexpected Electron '+version);
const raw=asar.getRawHeader(source), header=raw.header;
const original=fs.readFileSync(source), originalBody=original.subarray(8+raw.headerSize);
const previousPackage=JSON.parse(asar.extractFile(source,'package.json').toString());
const currentPackage=JSON.parse(fs.readFileSync('app/package.json','utf8'));
for(const key of ['name','version','main']) if(previousPackage[key]!==currentPackage[key]) throw new Error('changed package '+key);
let offset=originalBody.length;
const newBodies=[], appFiles=[];
async function directory(dir,relative) {
 const files={};
 for(const name of fs.readdirSync(dir).sort()) {
  const file=path.join(dir,name), rel=path.posix.join(relative,name), stat=fs.statSync(file);
  if(stat.isDirectory()) files[name]=await directory(file,rel);
  else {
   const bytes=fs.readFileSync(file);
   files[name]={size:bytes.length,offset:String(offset),integrity:await getFileIntegrity(Readable.from([bytes]))};
   if(stat.mode&0o111) files[name].executable=true;
   offset+=bytes.length;newBodies.push(bytes);appFiles.push(rel);
  }
 }
 return {files};
}
header.files.out=await directory(path.join(repo,'app/out'),'out');
const headerString=JSON.stringify(header), headerPickle=Pickle.createEmpty();headerPickle.writeString(headerString);
const headerBytes=headerPickle.toBuffer(), sizePickle=Pickle.createEmpty();sizePickle.writeUInt32(headerBytes.length);
fs.writeFileSync(target,Buffer.concat([sizePickle.toBuffer(),headerBytes,originalBody,...newBodies]));
asar.uncache(target);
let dependencyFiles=0;
for(const file of asar.listPackage(source)) {
 const relative=file.slice(1), info=asar.statFile(source,relative,false);
 if(relative.startsWith('out/')||relative==='out'||info.files||info.link) continue;
 if(info.unpacked) continue;
 if(!asar.extractFile(target,relative).equals(asar.extractFile(source,relative))) throw new Error('dependency changed '+relative);
 dependencyFiles++;
}
for(const file of appFiles) if(!asar.extractFile(target,file).equals(fs.readFileSync(path.join(repo,'app',file)))) throw new Error('stale app '+file);
for(const name of ['engine','voice','notch']) {
 fs.rmSync(path.join(resources,name),{recursive:true,force:true});
 fs.cpSync(path.join(repo,'app',name),path.join(resources,name),{recursive:true});
}
fs.rmSync(path.join(stage,'Contents/Extensions/BimaxIntents.appex'),{recursive:true,force:true});
fs.cpSync(path.join(repo,'app/intents/BimaxIntents.appex'),path.join(stage,'Contents/Extensions/BimaxIntents.appex'),{recursive:true});
fs.rmSync(path.join(resources,'app.asar.unpacked'),{recursive:true,force:true});
fs.cpSync('/Applications/Bimax.app/Contents/Resources/app.asar.unpacked',path.join(resources,'app.asar.unpacked'),{recursive:true});
const hash=crypto.createHash('sha256').update(headerString).digest('hex');
execFileSync('/usr/libexec/PlistBuddy',['-c','Set :ElectronAsarIntegrity:Resources/app.asar:hash '+hash,path.join(stage,'Contents/Info.plist')]);
console.log(JSON.stringify({stage,runtimeVersion:version,asarHeaderSHA256:hash,currentAppFiles:appFiles.length,unchangedDependencyFiles:dependencyFiles,method:'APFS cloned runtime, archive replacement preserving dependencies, current engine and rebuilt native helpers'}));
