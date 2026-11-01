import {createHash,createPublicKey,verify} from 'node:crypto';
import {createIdentity} from 'desktop-responder';
import {authorizeCloud,cloudProof,validateCloudGrant,CLOUD_SERVICE} from '../cloud';
const identity=createIdentity('fixture-mac');
const room=createHash('sha256').update(identity.helloPubkeyB64).digest('hex');
const grant={action:'grant' as const,deviceId:identity.deviceId,relayUrl:CLOUD_SERVICE.replace('https:','wss:')+'/room/'+room,credential:'rd_12345678-1234-1234-1234-123456789abc'};
test('saved cloud admission binds the exact Mac key, owned service and scoped credential',()=>{
 expect(validateCloudGrant(grant,identity)).toEqual(grant);
 for(const change of [{deviceId:'other'},{relayUrl:grant.relayUrl.replace('bimax-relay','attacker')},{relayUrl:grant.relayUrl+'?token=leak'},{relayUrl:grant.relayUrl.replace(room,'a'.repeat(64))},{credential:'account-refresh-token'}])expect(()=>validateCloudGrant({...grant,...change},identity)).toThrow();
});
test('renewal and revocation proofs bind action, credential, fresh nonce, key-derived room and device',()=>{
 const a=cloudProof(identity,grant.credential,'renew'),b=cloudProof(identity,grant.credential,'revoke');expect(a.nonce).not.toBe(b.nonce);expect(a.roomId).toBe(room);expect(Date.now()-a.at).toBeLessThan(1000);
 const {signature,...body}=a;
 const key=createPublicKey({format:'der',type:'spki',key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(identity.helloKeypair.publicKey)])});
 expect(verify(null,Buffer.from(JSON.stringify(body)),key,Buffer.from(signature,'base64'))).toBe(true);
 expect(verify(null,Buffer.from(JSON.stringify({...body,action:'revoke'})),key,Buffer.from(signature,'base64'))).toBe(false);
});
test('ticket requests expose no user account token and refuse oversized bodies or unexpected targets',async()=>{
 const original=global.fetch;let cancelled=false;
 try{
  global.fetch=jest.fn(async(_url,init)=>{expect(_url).toBe(CLOUD_SERVICE+'/v1/relay-device/renew');expect((init?.headers as Record<string,string>).Authorization).toBe('Bearer '+grant.credential);return new Response(JSON.stringify({ticket:'abc.def.ghi'}));});
  expect(await authorizeCloud(identity,()=>grant,grant.relayUrl)).toBe(grant.relayUrl+'?ticket=abc.def.ghi');
  await expect(authorizeCloud(identity,()=>grant,grant.relayUrl+'/changed')).rejects.toThrow(/target/);
  global.fetch=jest.fn(async()=>new Response(new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(8193));},cancel(){cancelled=true;}})));
  await expect(authorizeCloud(identity,()=>grant,grant.relayUrl)).rejects.toThrow(/response/);expect(cancelled).toBe(true);
 }finally{global.fetch=original;}
});
