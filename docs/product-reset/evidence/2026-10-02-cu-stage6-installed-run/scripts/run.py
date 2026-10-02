#!/usr/bin/env python3
"""Record 65 stage 6, installed: a real task in the INSTALLED Bimax.app, a real model, the owner answering every card.

  run.py start <n> <prompt>   notes the audit length, opens a bimax://task link in a scratch folder for run <n>
  run.py watch <n>            this run's audit lines so far (content-free: op, app, ok/code, counts, receipts)

Graded from what the model cannot write: the app's content-free audit and the driver's own observer tally in it.
Names and texts are never in the audit (hashed); this script prints nothing else of any window.
"""
import glob, json, os, subprocess, sys, time, urllib.parse
HERE = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.dirname(HERE)
RUNS = os.path.expanduser('~/Library/Caches/bimax-cu-stage6-run')
AUDIT = os.path.expanduser('~/Library/Application Support/Bimax/computer/audit.jsonl')
def audit():
    try:
        with open(AUDIT) as f: return [json.loads(l) for l in f if l.strip()]
    except FileNotFoundError: return []
def folder(n): return next(p for p in glob.glob(os.path.join(RUNS, '*')) if os.path.basename(p).startswith(f'{n} '))
def state(n): return os.path.join(OUT, f'run-{n}.json')
if sys.argv[1] == 'start':
    n, prompt = sys.argv[2], sys.argv[3]
    subprocess.run([os.path.expanduser('~/.local/bin/cua-driver'), 'stop'], capture_output=True, timeout=30)
    rec = {'run': n, 'folder': folder(n), 'prompt': prompt, 'startedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'auditBefore': len(audit())}
    json.dump(rec, open(state(n), 'w'), indent=1)
    subprocess.run(['open', 'bimax://task?' + urllib.parse.urlencode({'folder': rec['folder'], 'prompt': prompt}, quote_via=urllib.parse.quote)])
    print(json.dumps(rec))
else:
    n = sys.argv[2]; rec = json.load(open(state(n)))
    lines = audit()[rec['auditBefore']:]
    rec['audit'] = lines; json.dump(rec, open(state(n), 'w'), indent=1)
    for l in lines:
        r = l.get('receipt') or {}
        print(l['at'][11:19], l['op'], l.get('bundleId'), 'ok' if l['ok'] else l.get('code'), '| asked', r.get('asked'), '| outcome', r.get('outcome'), '| front', r.get('front'), '| driver', (l.get('driver') or {}).get('authorized'))
