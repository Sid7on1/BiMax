import json,pathlib,copy,hashlib
root=pathlib.Path('/Users/vishsiddharth/Bimax/docs/product-reset/evidence/2026-10-07-full-arc-cu-feature')
thread=pathlib.Path.home()/'Library/Application Support/Bimax/threads/9998fb1a-a6a5-4293-92f9-74401c734f17.json'
v=json.loads(thread.read_text());calls=[i['call'] for i in v['state']['items'] if i.get('kind')=='tool']
receipt={'outcome':'pass','threadId':thread.stem,'model':'gpt-oss-20b','provider':'saved app configuration, not a deterministic provider fixture','fixtureBefore':json.loads((root/'live-v4-fixture-before.json').read_text())['fixture'],'fixtureAfter':json.loads(pathlib.Path('/private/tmp/arc-proof/state.json').read_text()),'calls':calls,'status':v['summary']['status'],'actualFixtureAX':{'field':'bimax-full-feature-v4-20261007','status':'Saved: bimax-full-feature-v4-20261007'},'nativeApprovals':'unchanged mandatory Mac authority; v3 read prompt directly observed, v4 individual native dialogs were not captured by the agent','scope':'one installed arm64 run, one configured saved model, one owned fixture; no broad M02/X01, latency or bystander claim'}
def grade(r):
 token='bimax-full-feature-v4-20261007'
 assert r['fixtureBefore']=={'text':'','saves':0}
 assert r['fixtureAfter']=={'text':token,'saves':1}
 assert r['status']=='idle'
 tools=r['calls'];assert all(c['toolName']=='BimaxCuTool' for c in tools)
 workflows=[c for c in tools if json.loads(c['input']).get('operation')=='workflow']
 assert len(workflows)==1
 c=workflows[0];a=json.loads(c['input']);o=json.loads(c['output'])
 assert c['status']=='success' and o['ok'] is True and o['verified'] is True and o['completedCount']==2
 assert [s['action'] for s in a['steps']]==['SET_VALUE','CLICK']
 assert a['steps'][0]['value']==token
 assert [s['action'] for s in o['attempted']]==['SET_VALUE','CLICK'] and all(s['inputStatus']=='done' for s in o['attempted'])
 assert [s['action'] for s in o['completed']]==['SET_VALUE','CLICK'] and all(s['input'] is True and s['verified'] is True for s in o['completed'])
 assert o['final']['pid']==a['pid'] and o['final']['window_id']==a['window_id']
 assert any(e.get('name')=='Verification message' and e.get('value')==token for e in o['final']['elements'])
 assert any(e.get('role')=='StaticText' and e.get('value')=='Saved: '+token for e in o['final']['elements'])
 assert r['actualFixtureAX']=={'field':token,'status':'Saved: '+token}
grade(receipt)
mutants=[]
for fault in ['duplicate_save','wrong_persisted_text','non_idle_task','missing_workflow','wrong_visible_status']:
 r=copy.deepcopy(receipt)
 if fault=='duplicate_save':r['fixtureAfter']['saves']=2
 elif fault=='wrong_persisted_text':r['fixtureAfter']['text']='wrong'
 elif fault=='non_idle_task':r['status']='working'
 elif fault=='missing_workflow':r['calls']=[c for c in r['calls'] if json.loads(c['input']).get('operation')!='workflow']
 else:r['actualFixtureAX']['status']='Not saved'
 try:grade(r)
 except AssertionError:mutants.append({'fault':fault,'assertionCaught':True})
 else:raise AssertionError('Grade accepted '+fault)
receipt['graderFaultsCaught']=len(mutants)
receipt['installedAppAsarSha256']=hashlib.sha256(pathlib.Path('/Applications/Bimax.app/Contents/Resources/app.asar').read_bytes()).hexdigest()
assert receipt['installedAppAsarSha256']==json.loads((root/'live-v4-fixture-before.json').read_text())['installedAppAsarSha256']
(root/'live-v4-model-workflow.json').write_text(json.dumps(receipt,indent=2)+'\n');(root/'live-v4-grader-faults.json').write_text(json.dumps(mutants,indent=2)+'\n')
print('PASS: actual saved-model workflow, two native effects, exact persisted value, one save, visible result; five grader faults caught')
