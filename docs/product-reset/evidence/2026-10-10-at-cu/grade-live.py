from pathlib import Path
import json,hashlib,copy
r=Path(__file__).resolve().parent
profile=Path.home()/'Library/Application Support/Bimax/threads'
threads=[(p,json.loads(p.read_text())) for p in profile.glob('*.json')]
p,v=next((p,v) for p,v in threads if any(i.get('kind')=='msg' and i.get('msg',{}).get('role')=='user' and i['msg'].get('content','').startswith('@CU This is a new fixture test.') for i in v['state']['items']))
receipt={'threadId':p.stem,'model':'saved gpt-oss-20b','provider':'saved app configuration; not a provider fixture','status':v['summary']['status'],'before':json.loads((r/'live-v3-before.json').read_text())['fixture'],'after':json.loads(Path('/private/tmp/arc-proof/state.json').read_text()),'calls':[i['call'] for i in v['state']['items'] if i.get('kind')=='tool'],'messages':[i['msg']['content'] for i in v['state']['items'] if i.get('kind')=='msg' and i.get('msg',{}).get('role')=='user'],'installedAppAsarSha256':hashlib.sha256(Path('/Applications/Bimax.app/Contents/Resources/app.asar').read_bytes()).hexdigest(),'scope':'one installed arm64 fixture with explicit full expected postcondition; independent file state plus fresh workflow AX readback; no separate CUA fixture AX binding, repeated reliability, inferred postcondition or M02/X01 qualification'}
def grade(q):
 token='bimax-at-cu-v3-20261011'
 assert q['before']=={'text':'bimax-at-cu-20261011','saves':1}
 assert q['after']=={'text':token,'saves':2}
 assert q['status']=='idle'
 assert all(c['toolName']=='BimaxCuTool' for c in q['calls'])
 calls=[c for c in q['calls'] if json.loads(c['input']).get('operation')=='workflow'];assert len(calls)==1
 c=calls[0];a=json.loads(c['input']);o=json.loads(c['output'])
 assert c['status']=='success' and o['ok'] is True and o['verified'] is True and o['completedCount']==2
 assert [s['action'] for s in a['steps']]==['SET_VALUE','CLICK'] and a['steps'][0]['value']==token
 assert a['steps'][1]['expect']['value']=='Saved: '+token
 assert a['pid']==10526 and a['window_id']==697
 assert [s['action'] for s in o['attempted']]==['SET_VALUE','CLICK'] and all(s['inputStatus']=='done' for s in o['attempted'])
 assert all(s['input'] is True and s['verified'] is True for s in o['completed']) and len(o['completed'])==2
 assert o['final']['pid']==a['pid'] and o['final']['window_id']==a['window_id']
 assert any(e.get('name')=='Verification message' and e.get('value')==token for e in o['final']['elements'])
 assert any(e.get('role')=='StaticText' and e.get('value')=='Saved: '+token for e in o['final']['elements'])
 assert len(q['messages'])==1 and q['messages'][0].startswith('@CU This is a new fixture test.') and 'Computer Use → Arc Fixture' in q['messages'][0]
 assert '[Computer Use for this message]' not in q['messages'][0]
 assert q['installedAppAsarSha256']==json.loads((r/'live-v3-before.json').read_text())['installedAppAsarSha256']
grade(receipt)
faults=[]
for fault in ['duplicate_save','wrong_text','non_idle','missing_workflow','wrong_native_status','foreign_window','coding_tool']:
 q=copy.deepcopy(receipt)
 if fault=='duplicate_save':q['after']['saves']=3
 elif fault=='wrong_text':q['after']['text']='wrong'
 elif fault=='non_idle':q['status']='working'
 elif fault=='missing_workflow':q['calls']=[c for c in q['calls'] if json.loads(c['input']).get('operation')!='workflow']
 elif fault=='coding_tool':q['calls'].append({'toolName':'BashTool'})
 else:
  c=next(c for c in q['calls'] if json.loads(c['input']).get('operation')=='workflow');o=json.loads(c['output'])
  if fault=='foreign_window':o['final']['window_id']=999
  else:
   for e in o['final']['elements']:
    if e.get('role')=='StaticText':e['value']='Not saved'
  c['output']=json.dumps(o)
 try:grade(q)
 except AssertionError:faults.append({'fault':fault,'assertionCaught':True})
 else:raise AssertionError('Grader accepted '+fault)
receipt['graderFaultsCaught']=len(faults)
(r/'live-v3-model-workflow.json').write_text(json.dumps(receipt,indent=2)+'\n');(r/'live-v3-grader-faults.json').write_text(json.dumps(faults,indent=2)+'\n')
print('PASS: installed @CU model route, two verified inputs, exact file state and one additional save; seven grader faults caught')
