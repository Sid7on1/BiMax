#!/usr/bin/env python3
"""Grade stage 3's installed press run (run-*.json from scripts/press_run.py) from evidence only: the fixture read by the
standalone reader, the app's audit (its counts, the driver's own observer, the receipt), the dylibs mapped into Bimax,
and the engine card found in the saved Thread record. grade_installed.py [folder] — exit 1 on any failure."""
import glob, json, os, re, sys
HERE = os.path.dirname(os.path.abspath(__file__)); DIR = sys.argv[1] if len(sys.argv) > 1 else HERE
INPUT = ['click', 'double_click', 'right_click', 'drag', 'scroll', 'move_cursor', 'type_text', 'set_value', 'press_key', 'hotkey', 'invoke_menu', 'bring_to_front']
fails, rows = [], []
for p in sorted(glob.glob(os.path.join(DIR, 'run-*.json'))):
    r = json.load(open(p)); name = os.path.basename(p); bad = lambda why: fails.append(f'{name}: {why}')
    n = lambda s: int(re.search(r'presses=(\d+)', s or '').group(1)) if re.search(r'presses=(\d+)', s or '') else None
    before, after = n(r.get('fixtureBefore', {}).get('status')), n(r.get('fixtureAfter', {}).get('status'))
    if before is None or after is None: bad('fixture unread'); continue
    if after - before != 1: bad(f'fixture presses changed by {after - before}, expected 1')
    audit = r.get('audit', [])
    presses = [a for a in audit if a['op'] == 'press']
    if len(presses) != 1 or presses[0]['ok'] is not True: bad(f'expected exactly one ok press host call, saw {[(a["op"], a["ok"]) for a in audit]}')
    last = audit[-1]['driver']['authorized'] if audit else {}
    if last.get('click', 0) != 1: bad(f"driver authorized {last.get('click', 0)} clicks")
    others = [t for t in INPUT if t != 'click' and last.get(t, 0)]
    if others: bad(f'other input tools authorized: {others}')
    if presses and (presses[0].get('receipt') or {}).get('outcome') != 'pressed': bad('receipt does not say pressed')
    if 'Fixture Button' in json.dumps(audit): bad('the audit holds the control name in clear')
    maps = r.get('bimaxMaps', {}).get('cua', [])
    if not maps or not all('/Applications/Bimax.app/Contents/Resources/app.asar.unpacked/' in m for m in maps): bad('SDK not mapped from the installed app')
    if any([r.get('driverDaemonsBefore'), r.get('driverDaemonsAtCollect')]): bad('a standalone driver daemon was running')
    if r.get('engineCardSeen') is not True: bad("the engine's own press card was not found")
    rows.append({'run': name, 'fixture': [before, after], 'clicks': last.get('click', 0), 'receipt': presses[0].get('receipt') if presses else None})
if len(sys.argv) == 1: json.dump({'runs': rows, 'failures': fails}, open(os.path.join(HERE, 'grade_installed.json'), 'w'), indent=1)
print(json.dumps({'graded': len(rows), 'failures': fails})); sys.exit(1 if fails or not rows else 0)
