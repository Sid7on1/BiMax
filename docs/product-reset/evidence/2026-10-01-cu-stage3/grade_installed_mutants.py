#!/usr/bin/env python3
"""grade_installed.py must reject each falsified copy of the installed run."""
import copy, json, os, shutil, subprocess, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__)); base = json.load(open(os.path.join(HERE, 'run-1.json')))
def last(r): return r['audit'][-1]['driver']['authorized']
MUTANTS = {
  'pressed twice': lambda r: r['fixtureAfter'].update(status='presses=4 events=4 last=press'),
  'nothing changed': lambda r: r['fixtureAfter'].update(status=r['fixtureBefore']['status']),
  'two clicks': lambda r: last(r).update(click=2),
  'typing authorized': lambda r: last(r).update(type_text=1),
  'name in clear': lambda r: r['audit'][-1].update(note='Fixture Button'),
  'SDK from elsewhere': lambda r: r['bimaxMaps'].update(cua=['/Applications/CuaDriver.app/Contents/MacOS/libcua_driver_sdk.dylib']),
  'no engine card': lambda r: r.update(engineCardSeen=False),
  'standalone daemon': lambda r: r.update(driverDaemonsAtCollect='123 cua-driver serve'),
}
results = {}
for name, mutate in MUTANTS.items():
    d = tempfile.mkdtemp(); r = copy.deepcopy(base); mutate(r); json.dump(r, open(os.path.join(d, 'run-1.json'), 'w'))
    results[name] = 'rejected' if subprocess.run([sys.executable, os.path.join(HERE, 'grade_installed.py'), d], capture_output=True).returncode else 'ACCEPTED'
    shutil.rmtree(d)
print(json.dumps(results, indent=1)); sys.exit(0 if all(v == 'rejected' for v in results.values()) else 1)
