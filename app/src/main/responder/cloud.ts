import {createPrivateKey,randomBytes,sign,createHash} from 'node:crypto';
import type {Identity} from 'desktop-responder';
export const CLOUD_SERVICE='https://bimax-relay.sid7vish.workers.dev';
export interface CloudGrant {action:'grant';deviceId:string;relayUrl:string;credential:string}
export function validateCloudGrant(value:unknown,identity:Identity,service=CLOUD_SERVICE):CloudGrant {
 const g=value as CloudGrant,base=new URL(service),deviceId=identity.deviceId,roomId=createHash('sha256').update(identity.helloPubkeyB64).digest('hex');
 if(!g||g.action!=='grant'||g.deviceId!==deviceId||!/^rd_[a-f0-9-]{36}$/.test(g.credential))throw Error('Invalid cloud device grant');
 const u=new URL(g.relayUrl);if(u.protocol!=='wss:'||u.host!==base.host||u.username||u.password||u.search||u.hash||u.pathname!==`/room/${roomId}`)throw Error('Invalid cloud relay address');
 return {action:'grant',deviceId,relayUrl:u.href,credential:g.credential};
}
export function cloudProof(identity:Identity,credential:string,action:'renew'|'revoke'){
 const body={action,at:Date.now(),credential,deviceId:identity.deviceId,nonce:randomBytes(16).toString('hex'),roomId:createHash('sha256').update(identity.helloPubkeyB64).digest('hex')};
 const key=createPrivateKey({format:'der',type:'pkcs8',key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(identity.helloKeypair.privateKey)])});
 return {...body,signature:sign(null,Buffer.from(JSON.stringify(body)),key).toString('base64')};
}
export async function authorizeCloud(identity:Identity,getGrant:()=>CloudGrant|undefined,relayUrl:string,action:'renew'|'revoke'='renew',service=CLOUD_SERVICE):Promise<string>{
 const grant=validateCloudGrant(getGrant(),identity,service);
 if(relayUrl!==grant.relayUrl)throw Error('Cloud relay target changed');
 const response=await fetch(service+'/v1/relay-device/renew',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${grant.credential}`},body:JSON.stringify(cloudProof(identity,grant.credential,action)),signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw Error('Cloud device authorization denied');
 const reader=response.body?.getReader();if(!reader)throw Error('Missing relay response');
 const chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>8192)throw Error('Invalid relay response');chunks.push(value);}}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 const text=Buffer.concat(chunks).toString('utf8');
 const body=JSON.parse(text) as {ticket?:string;revoked?:boolean};if(action==='revoke'){if(!body.revoked)throw Error('Revocation not confirmed');return relayUrl;}
 if(typeof body.ticket!=='string'||body.ticket.length>4096||!/^[-\w]+\.[-\w]+\.[-\w]+$/.test(body.ticket))throw Error('Invalid cloud ticket');
 const url=new URL(relayUrl);url.searchParams.set('ticket',body.ticket);return url.href;
}
