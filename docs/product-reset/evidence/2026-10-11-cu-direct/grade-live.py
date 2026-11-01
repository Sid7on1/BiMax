from pathlib import Path
import json,copy,hashlib
r=Path(__file__).parent
def grade(q):
 assert q['installedSha256']==json.loads((r/'install.json').read_text())['appAsarSha256'],'build'
 assert q['status']=='idle','unfinished'
 assert q['inputs']==[],'completed turn retained queued input'
 calls=q['calls'];assert len(calls)==4 and all(c['toolName']=='BimaxCuTool' and c['status']=='success' for c in calls),'extra/failed tool'
 plans=[json.loads(c['input']) for c in calls];outs=[json.loads(c['output']) for c in calls]
 assert [p['operation'] for p in plans]==['apps','windows','observe','workflow'],'discovery order'
 assert outs[0]['otherAppsRedacted']>=1,'manual target filtering instead of automatic discovery'
 apps=outs[0]['apps'];assert len(apps)==1 and apps[0]['bundle_id']=='org.arc.proof.fixture','actual target app'
 pid=apps[0]['pid'];win=plans[2]['window_id'];assert plans[1]['pid']==plans[2]['pid']==plans[3]['pid']==pid,'actual pid'
 assert win in [w['window_id'] for w in outs[1]['windows']] and plans[3]['window_id']==win,'actual window'
 assert outs[2]['pid']==pid and outs[2]['window_id']==win,'initial observation'
 plan=plans[3];result=outs[3];token='bimax-direct-cu-20261011'
 assert [s['action'] for s in plan['steps']]==['SET_VALUE','CLICK'],'ordered plan'
 assert [s['control'] for s in plan['steps']]==['Verification message','Save verification'],'controls'
 assert plan['steps'][0]['value']==token and plan['steps'][1]['expect']=={'role':'StaticText','value':'Saved: '+token},'literal postcondition'
 assert result['ok'] is True and result['verified'] is True and result['verification']=='exact' and result['mode']=='do','verified exact Do'
 assert result['completedCount']==2 and len(result['completed'])==2 and all(s['verified'] is True and s['input'] is True for s in result['completed']),'completed steps'
 assert len(result['attempted'])==2 and [s['action'] for s in result['attempted']]==['SET_VALUE','CLICK'] and all(s['inputStatus']=='done' for s in result['attempted']),'repeated/partial input'
 final=result['final'];assert final['pid']==pid and final['window_id']==win and final['application']=='Arc Fixture' and final['window']=='Arc Driver Verification','final target'
 assert final['snapshot']!=outs[2]['snapshot'],'stale observation'
 assert sum(e.get('role')=='TextField' and e.get('name')=='Verification message' and e.get('value')==token for e in final['elements'])==1,'field readback'
 assert sum(e.get('role')=='StaticText' and e.get('value')=='Saved: '+token for e in final['elements'])==1,'status readback'
 assert q['before']=={'text':'','saves':0} and q['after']=={'text':token,'saves':1},'persisted exact text / one save'
 assert q['independentAX']['field']==token and q['independentAX']['status']=='Saved: '+token and q['independentAX']['app']=='org.arc.proof.fixture','independent AX'
def result(q,change):
 out=json.loads(q['calls'][-1]['output']);change(out);q['calls'][-1]['output']=json.dumps(out)
def plan(q,index,change):
 out=json.loads(q['calls'][index]['input']);change(out);q['calls'][index]['input']=json.dumps(out)
mutations={
 'unchanged-state':lambda q:q.update(after=copy.deepcopy(q['before'])),
 'duplicate-save':lambda q:q['after'].update(saves=2),
 'wrong-text':lambda q:q['after'].update(text='wrong'),
 'unfinished':lambda q:q.update(status='working'),
 'missing-discovery':lambda q:q['calls'].pop(0),
 'duplicate-workflow':lambda q:q['calls'].append(copy.deepcopy(q['calls'][-1])),
 'picker-filtered-apps':lambda q:q['calls'][0].update(output=json.dumps({'apps':json.loads(q['calls'][0]['output'])['apps'],'otherAppsRedacted':0})),
 'wrong-mode':lambda q:result(q,lambda p:p.update(mode='guide')),
 'foreign-pid':lambda q:plan(q,3,lambda p:p.update(pid=7)),
 'foreign-window':lambda q:plan(q,3,lambda p:p.update(window_id=8)),
 'false-done':lambda q:result(q,lambda p:p.update(verified=False)),
 'partial':lambda q:result(q,lambda p:p.update(completedCount=1)),
 'replayed-input':lambda q:result(q,lambda p:p['attempted'].append(copy.deepcopy(p['attempted'][-1]))),
 'stale-readback':lambda q:result(q,lambda p:p['final'].update(snapshot=json.loads(q['calls'][2]['output'])['snapshot'])),
 'foreign-final-window':lambda q:result(q,lambda p:p['final'].update(window_id=8)),
 'wrong-independent-AX':lambda q:q['independentAX'].update(field='wrong'),
}
q=json.loads((r/'live-direct.json').read_text());grade(q);faults=[]
for name,change in mutations.items():
 bad=copy.deepcopy(q);change(bad)
 try:grade(bad)
 except AssertionError as e:faults.append({'fault':name,'rejected':True,'assertion':str(e)})
 else:raise AssertionError('survived '+name)
report={'scope':'one installed gpt-oss-20b / owned fixture / direct Do run; not full M02/X01 or broad model reliability','passed':True,'faults':faults};(r/'live-grades.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
