#!/usr/bin/env python3
"""grade.py must reject each of these falsified copies of the evidence."""
import copy, glob, json, os, shutil, subprocess, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
runs = {os.path.basename(p): json.load(open(p)) for p in glob.glob(os.path.join(HERE, 'prove-press-*.json')) if 'INVALID' not in p}
def bump(s, n): import re; return re.sub(r'presses=(\d+)', lambda m: f'presses={int(m.group(1)) + n}', s)
MUTANTS = {
    'press: pressed twice':            ('prove-press-press.json', lambda d: d.update(fixtureAfter=bump(d['fixtureAfter'], 1))),
    'press: nothing changed':          ('prove-press-press.json', lambda d: d.update(fixtureAfter=d['fixtureBefore'])),
    'press: typing authorized':        ('prove-press-press.json', lambda d: d.update(authorizedInputTools=['click', 'type_text'])),
    'deny-card: clicked anyway':       ('prove-press-deny-card.json', lambda d: d['driverActivity']['authorized'].update(click=1)),
    'deny-engine: reached the app':    ('prove-press-deny-engine.json', lambda d: d['hostCalls'].append({'capability': 'press'})),
    'takeover: never switched off':    ('prove-press-takeover.json', lambda d: [c.update(pressOnWhenAnswered=True) for c in d['cards']]),
    'stale: pressed':                  ('prove-press-stale.json', lambda d: d.update(hostResults=[{'capability': 'press', 'ok': True}])),
    'wrong-target: card raised':       ('prove-press-wrong-target.json', lambda d: d['cards'].append({'question': 'Press “Delete Everything” in BimaxCuFixture?'})),
    'replay: carried out twice':       ('prove-press-replay.json', lambda d: d.update(replay={'ok': True})),
    'fixture unread':                  ('prove-press-press.json', lambda d: d.update(fixtureAfter=None)),
}
results = {}
for name, (file, mutate) in MUTANTS.items():
    d = tempfile.mkdtemp()
    for f, run in runs.items():
        r = copy.deepcopy(run)
        if f == file: mutate(r)
        json.dump(r, open(os.path.join(d, f), 'w'))
    code = subprocess.run([sys.executable, os.path.join(HERE, 'grade.py'), d], capture_output=True).returncode
    results[name] = 'rejected' if code else 'ACCEPTED'
    shutil.rmtree(d)
print(json.dumps(results, indent=1))
sys.exit(0 if all(v == 'rejected' for v in results.values()) else 1)
