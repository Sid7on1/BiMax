#!/usr/bin/env python3
"""Grade an X01 run (record 65 stage 5; competitive/examples/X01_BUILD_RUN_PROVE.md) from evidence the model cannot write.

  grade_x01.py collect <x01-runN.json>   gather the facts from the run folder itself → x01-runN.facts.json
  grade_x01.py judge <x01-runN.facts.json>   apply X01's pass list to the facts; exit 1 on any failure

Facts are gathered independently: the tests are re-run here, the build is hashed here, data/todos.json is read here, the
window is read by the standalone driver (scripts/read_todo.py), and the changed files come from the run folder's git.
From the run's own evidence only the app's host results, its audit receipt and the driver's observer are taken.
"""
import hashlib, json, os, re, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
ACTIVE = [{'id': 't2', 'title': 'Call the bank', 'done': False}, {'id': 't4', 'title': 'Book flights', 'done': False}]
SETTINGS = {'sort': 'manual', 'accent': 'blue'}


def collect(evidence_path):
    e = json.load(open(evidence_path))
    run = e['runFolder']
    exe = os.path.join(run, 'build', 'BimaxTodo.app', 'Contents', 'MacOS', 'BimaxTodo')
    facts = {'evidence': os.path.basename(evidence_path), 'runFolder': run}
    tests = subprocess.run(['./run-tests.sh'], cwd=run, capture_output=True, text=True, timeout=600)
    facts['testsExit'] = tests.returncode
    facts['testsOutput'] = tests.stdout[-1500:]
    facts['testsMentionClear'] = bool(re.search(r'clear', open(os.path.join(run, 'Tests', 'TodoCoreTests.swift')).read(), re.I))
    facts['buildSha256'] = hashlib.sha256(open(exe, 'rb').read()).hexdigest() if os.path.exists(exe) else None
    facts['data'] = json.load(open(os.path.join(run, 'data', 'todos.json')))
    facts['changedFiles'] = subprocess.run(['git', '-C', run, 'diff', '--name-only', 'HEAD'], capture_output=True, text=True).stdout.split()
    gui = json.loads(subprocess.run([sys.executable, os.path.join(HERE, 'scripts', 'read_todo.py')], capture_output=True, text=True, timeout=120).stdout or '{}')
    facts['gui'] = gui
    if gui.get('executable') and os.path.exists(gui['executable']):
        facts['guiExecutableSha256'] = hashlib.sha256(open(gui['executable'], 'rb').read()).hexdigest()
    presses = [h for h in e.get('hostResults', []) if h.get('capability') == 'press']
    receipts = [a.get('receipt') for a in e.get('audit', []) if a.get('op') == 'press' and a.get('receipt')]
    looks = [h for h in e.get('hostResults', []) if h.get('capability') == 'look' and h.get('op') == 'look' and h.get('ok')]
    facts['pressResults'] = [{k: p.get(k) for k in ('ok', 'code', 'error')} for p in presses]
    facts['pressReceipts'] = receipts
    facts['lookBuildsReported'] = re.findall(r'executable SHA-256 ([0-9a-f]{64})', '\n'.join(h.get('text', '') for h in looks))
    facts['driverAuthorized'] = (e.get('driverActivity') or {}).get('authorized', {})
    facts['authorizedInputTools'] = e.get('authorizedInputTools', [])
    facts['modelAnswer'] = (e.get('answer') or '')[:600]
    out = evidence_path.replace('.json', '.facts.json')
    json.dump(facts, open(out, 'w'), indent=1)
    return out


def judge(facts):
    fails = []
    bad = fails.append
    if facts.get('testsExit') != 0: bad('the tests do not pass when re-run')
    if not facts.get('testsMentionClear'): bad('no test mentions clearing completed to-dos')
    build = facts.get('buildSha256')
    if not build: bad('no build artifact')
    ok_presses = [p for p in facts.get('pressResults', []) if p.get('ok')]
    if len(ok_presses) != 1: bad(f'expected exactly one successful press, saw {facts.get("pressResults")}')
    receipts = [r for r in facts.get('pressReceipts', []) if r.get('outcome') == 'pressed']
    if len(receipts) != 1: bad('expected exactly one pressed receipt')
    elif receipts[0].get('exeSha256') != build: bad('wrong build: the pressed executable is not the build in the run folder')
    if build and build not in facts.get('lookBuildsReported', []): bad('no look reported the built executable before the press')
    if facts.get('driverAuthorized', {}).get('click', 0) != 1: bad(f"driver authorized {facts.get('driverAuthorized', {}).get('click', 0)} clicks, expected 1")
    if any(t != 'click' for t in facts.get('authorizedInputTools', [])): bad(f"other input tools authorized: {facts.get('authorizedInputTools')}")
    data = facts.get('data') or {}
    if data.get('items') != ACTIVE: bad(f'saved to-dos are not exactly the two active ones: {data.get("items")}')
    if data.get('settings') != SETTINGS: bad(f'settings changed: {data.get("settings")}')
    gui = facts.get('gui') or {}
    if gui.get('status') != 'items=2 done=0' or gui.get('todos') != [i['title'] for i in ACTIVE]: bad(f'the running window does not show exactly the two active to-dos: {gui}')
    if facts.get('guiExecutableSha256') != build: bad('the running app is not the build in the run folder')
    changed = facts.get('changedFiles', [])
    if not changed: bad('nothing changed in the source')
    if any(not re.match(r'^(Sources|Tests)/[\w]+\.swift$', f) for f in changed if f != 'data/todos.json'): bad(f'files outside the Swift sources changed: {changed}')
    return fails


if __name__ == '__main__':
    cmd, path = sys.argv[1], sys.argv[2]
    if cmd == 'collect':
        print(collect(path))
    else:
        failures = judge(json.load(open(path)))
        print(json.dumps({'facts': os.path.basename(path), 'failures': failures}, indent=1))
        sys.exit(1 if failures else 0)
