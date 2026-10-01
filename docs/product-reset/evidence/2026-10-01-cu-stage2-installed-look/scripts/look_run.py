#!/usr/bin/env python3
"""Record 65 stage 2, installed: one look run in the INSTALLED Bimax.app, the person played by the owner.

  look_run.py start <n>   fixture status before (independent reader), then opens a bimax://task link for run <n>
  look_run.py collect <n> fixture status after, this run's audit lines, the Thread record, and what Bimax's process maps

The grader never takes the model's word: it reads the app's content-free audit (its counts and the driver's own
observer tally), the fixture's status line through a SEPARATE reader (standalone cua-driver under the terminal's grant),
and the dylibs mapped into Bimax's own process.
"""
import glob, json, os, subprocess, sys, time, urllib.parse
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.dirname(HERE)
RUNS = os.path.expanduser('~/Library/Caches/bimax-cu-stage2-look')
SUPPORT = os.path.expanduser('~/Library/Application Support/Bimax')
AUDIT = os.path.join(SUPPORT, 'computer', 'audit.jsonl')
PROMPT = ("Use LookAtAppTool to look at the app named BimaxCuFixture, then tell me the exact text of its status line, "
          "which starts with 'presses='. Do nothing else: no files, no shell, no other tools.")

def folder(n):
    num = ''.join(ch for ch in n if ch.isdigit())  # a repeated run (2b) reuses its number's folder
    return next(p for p in glob.glob(os.path.join(RUNS, '*')) if os.path.basename(p).startswith(f'{num} '))

def fixture():
    r = subprocess.run([sys.executable, os.path.join(HERE, 'read_fixture.py')], capture_output=True, text=True, timeout=60)
    # The reader's daemon (CuaDriver.app, its own TCC identity) must not be running while Bimax looks.
    subprocess.run([os.path.expanduser('~/.local/bin/cua-driver'), 'stop'], capture_output=True, timeout=30)
    time.sleep(1)
    return json.loads(r.stdout) if r.returncode == 0 else {'error': r.stderr[-400:]}

def bimax_pid():
    out = subprocess.run(['pgrep', '-f', 'Bimax.app/Contents/MacOS/Bimax$'], capture_output=True, text=True).stdout.split()
    return int(out[0]) if out else None

def audit_lines():
    try:
        with open(AUDIT) as f: return [json.loads(l) for l in f if l.strip()]
    except FileNotFoundError: return []

def state_path(n): return os.path.join(OUT, f'run-{n}.json')

def start(n):
    pid = bimax_pid()
    ps = subprocess.run(['ps', '-o', 'pid=,ppid=,lstart=', '-p', str(pid)], capture_output=True, text=True).stdout.strip()
    rec = {'run': n, 'folder': folder(n), 'prompt': PROMPT, 'startedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
           'bimax': {'pid': pid, 'ps': ps}, 'auditLinesBefore': len(audit_lines()), 'fixtureBefore': fixture(),
           'driverDaemonsBefore': subprocess.run(['pgrep', '-fl', 'cua-driver|CuaDriver'], capture_output=True, text=True).stdout.strip()}
    json.dump(rec, open(state_path(n), 'w'), indent=1)
    link = 'bimax://task?' + urllib.parse.urlencode({'folder': rec['folder'], 'prompt': PROMPT}, quote_via=urllib.parse.quote)
    subprocess.run(['open', link])
    print(json.dumps({k: rec[k] for k in ('run', 'folder', 'fixtureBefore', 'auditLinesBefore')}))

def collect(n):
    rec = json.load(open(state_path(n)))
    pid = bimax_pid()
    rec['collectedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    rec['driverDaemonsAtCollect'] = subprocess.run(['pgrep', '-fl', 'cua-driver|CuaDriver'], capture_output=True, text=True).stdout.strip()
    rec['audit'] = audit_lines()[rec['auditLinesBefore']:]
    threads = []
    for p in glob.glob(os.path.join(SUPPORT, 'threads', '*.json')):
        try: t = json.load(open(p))
        except Exception: continue
        if os.path.realpath(t.get('summary', {}).get('root', '')) == os.path.realpath(rec['folder']): threads.append(t)
    for t in threads: t['items'] = t.get('items') or t.get('state', {}).get('items', [])  # saved Threads keep them in state
    rec['threads'] = [{'summary': t['summary'],
                       'tools': [{'tool': i['call']['toolName'], 'input': i['call'].get('input'), 'status': i['call'].get('status'),
                                  'output': str(i['call'].get('output', ''))[:600]} for i in t.get('items', []) if i.get('kind') == 'tool'],
                       'messages': [{'role': i['msg']['role'], 'content': str(i['msg'].get('content', ''))[:600]} for i in t.get('items', []) if i.get('kind') == 'msg']}
                      for t in threads]
    lsof = subprocess.run(['lsof', '-p', str(pid)], capture_output=True, text=True).stdout if pid else ''
    rec['bimaxMaps'] = {'pid': pid, 'cua': sorted({l.split()[-1] for l in lsof.splitlines() if 'cua' in l.lower()})}
    rec['fixtureAfter'] = fixture()
    json.dump(rec, open(state_path(n), 'w'), indent=1)
    print(json.dumps({'audit': rec['audit'], 'tools': [t['tools'] for t in rec['threads']], 'maps': rec['bimaxMaps'],
                      'fixture': [rec['fixtureBefore'].get('status'), rec['fixtureAfter'].get('status')],
                      'answer': [m['content'] for t in rec['threads'] for m in t['messages'] if m['role'] == 'assistant'][-1:]}, indent=1))

def before(n):
    """Re-read the fixture's before-state for a run whose first reading failed (the link is not opened again)."""
    rec = json.load(open(state_path(n)))
    rec.setdefault('notes', []).append(f"fixtureBefore re-read at {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}: first reading failed")
    rec['fixtureBeforeFirstAttempt'] = rec['fixtureBefore']
    rec['fixtureBefore'] = fixture()
    json.dump(rec, open(state_path(n), 'w'), indent=1)
    print(json.dumps(rec['fixtureBefore']))

{'start': start, 'collect': collect, 'before': before}[sys.argv[1]](sys.argv[2])
