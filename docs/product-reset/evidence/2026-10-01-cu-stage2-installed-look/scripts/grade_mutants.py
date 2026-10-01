#!/usr/bin/env python3
"""The grader must reject each of these: an authorized input tool, an app-counted input call, a changed fixture, an
unread fixture, a standalone driver daemon running, and an SDK mapped from outside the installed app."""
import copy, json, os, shutil, subprocess, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.dirname(HERE)
base = json.load(open(os.path.join(OUT, 'run-1.json')))
def m_input(r): r['audit'][0]['driver']['authorized']['click'] = 1
def m_appinput(r): r['audit'][0]['counts']['inputCalls'] = 1
def m_fixture(r): r['fixtureAfter']['status'] = 'presses=1 events=1 last=button'
def m_unread(r): r['fixtureBefore'] = {'error': 'x'}
def m_daemon(r): r['driverDaemonsAtCollect'] = '123 /Applications/CuaDriver.app/Contents/MacOS/cua-driver serve'
def m_sdk(r): r['bimaxMaps']['cua'] = ['/Applications/CuaDriver.app/Contents/MacOS/libcua_driver_sdk.dylib']
results = {}
for name, mutate in [('authorized input tool', m_input), ('app input call', m_appinput), ('fixture changed', m_fixture),
                     ('fixture unread', m_unread), ('standalone daemon', m_daemon), ('sdk outside app', m_sdk)]:
    d = tempfile.mkdtemp(); r = copy.deepcopy(base); mutate(r)
    json.dump(r, open(os.path.join(d, 'run-1.json'), 'w'))
    code = subprocess.run([sys.executable, os.path.join(HERE, 'grade.py'), d], capture_output=True, text=True).returncode
    results[name] = 'rejected' if code != 0 else 'ACCEPTED'
    shutil.rmtree(d)
print(json.dumps(results))
sys.exit(0 if all(v == 'rejected' for v in results.values()) else 1)
