from pathlib import Path
import json,sys
r=Path(__file__).resolve().parent
thread_id=sys.argv[1];output=sys.argv[2];install=sys.argv[3]
q=json.loads((Path.home()/'Library/Application Support/Bimax/threads'/f'{thread_id}.json').read_text())
calls=[]
for item in q['state']['items']:
 if item['kind']=='tool':
  call=item['call'];args=json.loads(call['input'])
  if args['operation']=='apps' and call.get('output'):
   data=json.loads(call['output']);all_apps=data.get('apps',[]);data['apps']=[app for app in all_apps if app['bundle_id']=='org.cu.proof.whatsapp-fixture'];data['otherAppsRedacted']=len(all_apps)-len(data['apps']);call['output']=json.dumps(data)
  calls.append(call)
record={'scope':'installed native/provider owned fixture; not WhatsApp qualification','installedSha256':json.loads((r/install).read_text())['appAsarSha256'],'threadId':thread_id,'model':'gpt-oss-20b','effort':'Low','status':q['summary']['status'],'calls':calls,'before':json.loads((r/('live-before-v2.json' if install=='install-v2.json' else 'live-before.json')).read_text()),'after':json.loads(Path('/private/tmp/bimax-message-proof/state.json').read_text()),'inputs':q['inputs'],'assistantMessages':[item['msg'] for item in q['state']['items'] if item['kind']=='msg'],'humanInterventions':0}
if install=='install-v2.json':
 record.update(humanInterventions=2,controlledInterruption='Pause then Resume before first input',approvalPrompts=5,approvalAllows=4,approvalDetailsReviewed=True)
 start=min(__import__('datetime').datetime.fromisoformat(call['startTime'].replace('Z','+00:00')).timestamp() for call in calls)
 record['stateFileModifiedAfterStart']=Path('/private/tmp/bimax-message-proof/state.json').stat().st_mtime>start
(r/output).write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps({'threadId':thread_id,'status':record['status'],'calls':len(calls),'sends':record['after']['sends']}))
