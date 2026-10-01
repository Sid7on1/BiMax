#!/usr/bin/env python3
"""The grader must reject each of these: an authorized input tool, an app-counted input call, a changed fixture, an
unread fixture, a standalone driver daemon running, an SDK mapped from outside the installed app, and — on the
preview-off run — a revoked look that read the window, answered ok, or was reported as a plain denial; and on the
Stop-after-Allow run — a grant that survived the Stop, no new card, or a read after the Stop."""
import copy, json, os, shutil, subprocess, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.dirname(HERE)
base = json.load(open(os.path.join(OUT, 'run-1.json')))
deny = json.load(open(os.path.join(OUT, 'run-4.json')))
stop = json.load(open(os.path.join(OUT, 'run-6.json')))
def m_input(r): r['audit'][0]['driver']['authorized']['click'] = 1
def m_appinput(r): r['audit'][0]['counts']['inputCalls'] = 1
def m_fixture(r): r['fixtureAfter']['status'] = 'presses=1 events=1 last=button'
def m_unread(r): r['fixtureBefore'] = {'error': 'x'}
def m_daemon(r): r['driverDaemonsAtCollect'] = '123 /Applications/CuaDriver.app/Contents/MacOS/cua-driver serve'
def m_sdk(r): r['bimaxMaps']['cua'] = ['/Applications/CuaDriver.app/Contents/MacOS/libcua_driver_sdk.dylib']
def m_revoked_read(r): r['audit'][0]['driver']['authorized']['get_window_state'] = 1
def m_revoked_ok(r): r['audit'][0]['ok'] = True; r['audit'][0].pop('code', None)
def m_wrong_code(r): r['audit'][0]['code'] = 'denied'
def m_grant_survived(r): r['audit'][1].update(ok=True); r['audit'][1].pop('code', None); r['audit'][1]['counts']['asked'] = 1
def m_no_new_card(r): r['audit'][1]['counts']['asked'] = 1
def m_read_after_stop(r): r['audit'][1]['driver']['authorized']['get_window_state'] = 2
results = {}
for name, mutate in [('authorized input tool', m_input), ('app input call', m_appinput), ('fixture changed', m_fixture),
                     ('fixture unread', m_unread), ('standalone daemon', m_daemon), ('sdk outside app', m_sdk),
                     ('revoked look read the window', m_revoked_read), ('revoked look answered ok', m_revoked_ok),
                     ('revocation reported as a plain denial', m_wrong_code),
                     ('stop: grant survived', m_grant_survived), ('stop: no new card', m_no_new_card),
                     ('stop: read after the stop', m_read_after_stop)]:
    d = tempfile.mkdtemp(); r = copy.deepcopy(stop if name.startswith('stop') else deny if name.startswith('revo') else base); mutate(r)
    json.dump(r, open(os.path.join(d, 'run-1.json'), 'w'))
    code = subprocess.run([sys.executable, os.path.join(HERE, 'grade.py'), d], capture_output=True, text=True).returncode
    results[name] = 'rejected' if code != 0 else 'ACCEPTED'
    shutil.rmtree(d)
print(json.dumps(results))
sys.exit(0 if all(v == 'rejected' for v in results.values()) else 1)
