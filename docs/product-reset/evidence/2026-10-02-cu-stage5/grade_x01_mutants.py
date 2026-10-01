#!/usr/bin/env python3
"""grade_x01.py judge must reject each falsified copy of a passing run's facts: X01's named mutants (wrong build, no-op)
and the rest of its pass list."""
import copy, json, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from grade_x01 import judge, ACTIVE
base = json.load(open(sys.argv[1]))
assert not judge(base), f'the base facts must pass first: {judge(base)}'
ALL = [{'id': 't1', 'title': 'Buy milk', 'done': True}, ACTIVE[0], {'id': 't3', 'title': 'Write the report', 'done': True}, ACTIVE[1]]
def receipt(f, **kw): f['pressReceipts'][0].update(kw)
MUTANTS = {
    'wrong build: an older executable was pressed': lambda f: receipt(f, exeSha256='0' * 64),
    'wrong build: the running app is not the build': lambda f: f.update(guiExecutableSha256='1' * 64),
    'no-op: nothing was removed': lambda f: (f['data'].update(items=ALL), f['gui'].update(status='items=4 done=2', todos=[i['title'] for i in ALL])),
    'removed an active to-do': lambda f: f['data'].update(items=[ACTIVE[0]]),
    'settings changed': lambda f: f['data'].update(settings={'sort': 'alpha', 'accent': 'blue'}),
    'window not refreshed': lambda f: f['gui'].update(status='items=4 done=2'),
    'tests fail': lambda f: f.update(testsExit=1),
    'no test for clearing': lambda f: f.update(testsMentionClear=False),
    'pressed twice': lambda f: f['driverAuthorized'].update(click=2),
    'typing authorized': lambda f: f.update(authorizedInputTools=['click', 'type_text']),
    'data edited by hand (a script changed)': lambda f: f['changedFiles'].append('build.sh'),
    'never looked at the built executable': lambda f: f.update(lookBuildsReported=[]),
}
results = {}
for name, mutate in MUTANTS.items():
    f = copy.deepcopy(base); mutate(f)
    results[name] = 'rejected' if judge(f) else 'ACCEPTED'
print(json.dumps(results, indent=1))
sys.exit(0 if all(v == 'rejected' for v in results.values()) else 1)
