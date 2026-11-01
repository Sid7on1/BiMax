from pathlib import Path
import json,copy,hashlib
r=Path(__file__).resolve().parent

def state_grade(q):
 before=q['before'];after=q['after'];result=q['result'];recipient='Mom demo';text='hi'
 assert after['recipient']==recipient and after['draft']=='','conversation/draft'
 assert after['sends']==before['sends']+1,'exactly one send'
 old=before['messages'];new=after['messages']
 assert len(new)==len(old)+1 and new[:len(old)]==old,'all prior contacts/messages unchanged'
 assert new[-1]['recipient']==recipient and new[-1]['text']==text,'correct new message/contact'
 assert new[-1]['id'] not in [m['id'] for m in old],'fresh outgoing identity'
 assert result['ok'] is True and result['verified'] is True and result['verification']=='exact','exact verified result'
 assert result['completedCount']==2 and len(result['completed'])==2 and all(s['verified'] is True and s['input'] is True for s in result['completed']),'completed input steps'
 assert [s['action'] for s in result['attempted']]==['SET_VALUE','SEND_MESSAGE'] and all(s['inputStatus']=='done' for s in result['attempted']),'no input replay'
 proof=result['messageVerification'];count=sum(m['recipient']==recipient and m['text']==text for m in old)
 assert proof['recipient']==recipient and proof['text']==text and proof['beforeCount']==count and proof['afterCount']==count+1,'new matching row baseline'
 assert proof['outcome']=='observed-outgoing' and proof['delivery']=='unconfirmed','no invented delivery'
 assert proof['beforeSnapshot'] and proof['afterSnapshot'] and proof['beforeSnapshot']!=proof['afterSnapshot'],'fresh snapshots'
 final=result['final'];assert final['pid']==42 and final['window_id']==5,'exact fixture target'
 assert final['snapshot']==proof['afterSnapshot'] and final['elements'],'actual final observation'
 assert sum(e.get('name')=='Conversation' and e.get('value')==recipient for e in final['elements'])==1,'recipient observation'
 assert sum(e.get('name')=='Message' and e.get('role')=='TextField' and e.get('value','')=='' for e in final['elements'])==1,'draft observation'
 assert sum(e.get('name')=='Outgoing message' and e.get('value')==text for e in final['elements'])==count+1,'outgoing observation'

host=json.loads((r/'host-runs.json').read_text());good=[q for q in host['records'] if q['case'].startswith('existing-identical-')]
assert len(good)==20
for q in good: state_grade(q)
seed=good[1]
mutations={
 'unchanged':lambda q:q.update(after=copy.deepcopy(q['before'])),
 'duplicate':lambda q:q['after'].update(sends=2),
 'wrong-contact':lambda q:q['after']['messages'][-1].update(recipient='Other demo'),
 'wrong-text':lambda q:q['after']['messages'][-1].update(text='bye'),
 'touched-bystander':lambda q:q['after']['messages'][0].update(text='corrupted'),
 'old-message-reused':lambda q:q['after']['messages'][-1].update(id=q['before']['messages'][0]['id']),
 'false-success':lambda q:q['result'].update(verified=False),
 'partial':lambda q:q['result'].update(completedCount=1),
 'provider-error':lambda q:q['result'].update(ok=False,reason='Provider unavailable'),
 'missing-observation':lambda q:q['result'].update(final={}),
 'foreign-window':lambda q:q['result']['final'].update(window_id=99),
 'stale-read':lambda q:q['result']['messageVerification'].update(afterSnapshot=q['result']['messageVerification']['beforeSnapshot']),
 'replayed-send':lambda q:q['result']['attempted'].append(copy.deepcopy(q['result']['attempted'][-1])),
 'fake-delivery':lambda q:q['result']['messageVerification'].update(delivery='delivered'),
 'uncleared-draft':lambda q:q['after'].update(draft='hi'),
}
faults=[]
for name,change in mutations.items():
 q=copy.deepcopy(seed);change(q)
 try:state_grade(q)
 except (AssertionError,KeyError) as e:faults.append({'fault':name,'rejected':True,'reason':str(e)})
 else:raise AssertionError('Grader accepted '+name)
report={'scope':'20 deterministic host fixture cases; not 20 native/provider repetitions','hostCasesPassed':len(good),'graderMutants':faults}
(r/'host-grades.json').write_text(json.dumps(report,indent=2)+'\n')
if (r/'live-attempt-2.json').exists():
 q=json.loads((r/'live-attempt-2.json').read_text());calls=q['calls'];plans=[json.loads(c['input']) for c in calls];outputs=[json.loads(c['output']) for c in calls]
 assert q['installedSha256']==json.loads((r/'install-v2.json').read_text())['appAsarSha256'],'build'
 assert q['status']=='idle' and q['inputs']==[] and q['humanInterventions']==2 and q['controlledInterruption']=='Pause then Resume before first input' and json.loads((r/'live-pause.json').read_text())['fixtureUnchanged'] is True,'finished with declared interruption only'
 assert len(calls)==4 and all(c['toolName']=='BimaxCuTool' and c['status']=='success' for c in calls),'actual successful tool path'
 assert [p['operation'] for p in plans]==['apps','windows','observe','workflow'],'actual discovery order'
 app=outputs[0]['apps'];assert len(app)==1 and app[0]['bundle_id']=='org.cu.proof.whatsapp-fixture','target app'
 pid=app[0]['pid'];window=plans[2]['window_id'];assert plans[1]['pid']==plans[2]['pid']==plans[3]['pid']==pid,'discovered pid'
 assert plans[3]['window_id']==window and window in [w['window_id'] for w in outputs[1]['windows']],'discovered exact window'
 result=copy.deepcopy(outputs[3]);assert result['final']['pid']==pid and result['final']['window_id']==window,'native final target'
 assert result['mode']=='do','actual mode'
 assert result['final']['snapshot']!=outputs[2]['snapshot'],'fresh native final observation'
 # The same assertion-based grader checks independent persistent state and semantic evidence.
 # Only native PID/window differ from the deterministic fixture's fixed IDs.
 result['final']['pid']=42;result['final']['window_id']=5
 state_grade({'before':q['before'],'after':q['after'],'result':result})
 ax=json.loads((r/'independent-ax.json').read_text());assert ax['recipient']=='Mom demo' and ax['draft']=='' and ax['outgoingCombinedText']=='hi hi','independent native AX'
 assert q['stateFileModifiedAfterStart'] is True,'prior-task state cannot pass'
 (r/'live-grades.json').write_text(json.dumps({'scope':'one installed saved gpt-oss-20b Low / owned fixture / selected conversation; not WhatsApp or full M01','passed':True,'graderMutants':faults},indent=2)+'\n')
print(json.dumps({'hostPassed':len(good),'mutantsRejected':len(faults),'liveGraded':(r/'live-grades.json').exists()}))
