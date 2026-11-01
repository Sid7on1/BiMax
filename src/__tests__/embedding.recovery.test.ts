import {RemoteEmbeddingBackend} from '../memory/embeddings';
import {capabilitySnapshot,resetCapabilityStatus} from '../core/capability.status';
afterEach(resetCapabilityStatus);
const credentials={apiKey:'private-fixture-key',baseURL:'http://localhost:11434/v1'};
const reason=()=>capabilitySnapshot().find(x=>x.id==='embeddings')!;
test('stopped local service is diagnosed without leaking error text, key or input, then real use can recover',async()=>{
 let healthy=false;
 const backend=new RemoteEmbeddingBackend({resolve:async()=>credentials,model:'all-minilm',dimensions:2,transport:async()=>{
  if(!healthy)throw Object.assign(Error('private raw error'),{cause:{code:'ECONNREFUSED'}});
  return{ok:true,status:200,json:async()=>({data:[{index:0,embedding:[3,4]}]})};
 }});
 expect(await backend.embed(['private document'],'query')).toBeNull();expect(reason().reason).toContain('Open Ollama');
 expect(JSON.stringify(reason())).not.toMatch(/private raw error|private-fixture-key|private document/);
 healthy=true;expect(await backend.embed(['retry'],'query')).toEqual([[0.6,0.8]]);expect(reason().state).toBe('ready');
});
test.each(['timeout','json','network'])('failure class %s is truthful without claiming semantic recovery',async kind=>{
 const backend=new RemoteEmbeddingBackend({resolve:async()=>credentials,model:'fixture',timeoutMs:10,transport:async()=>{
  if(kind==='timeout')return new Promise<any>(()=>{});
  if(kind==='json')return{ok:true,status:200,json:async()=>{throw new SyntaxError('private response');}};
  throw Object.assign(Error('private URL secret'),{cause:{code:'ENOTFOUND'}});
 }});
 expect(await backend.embed(['input'],'query')).toBeNull();expect(reason().state).toBe('degraded');
 expect(reason().reason).toMatch(kind==='timeout'?/timed out/:kind==='json'?/unreadable JSON/:/could not be reached/);
 expect(JSON.stringify(reason())).not.toMatch(/private response|private URL secret/);
});
