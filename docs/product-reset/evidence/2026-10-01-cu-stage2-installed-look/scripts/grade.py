#!/usr/bin/env python3
"""Grade the installed look runs from evidence only: the app's audit, the driver's own observer, the independent fixture
reader and the dylibs mapped into Bimax. The model's answer is recorded, never graded as proof."""
import glob, json, os, re, sys
HERE = os.path.dirname(os.path.abspath(__file__)); OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(HERE)  # a folder of runs (mutant checks pass a copy)
SRC = open(os.path.join(HERE, '../../../../../app/src/main/computer/look.manifest.ts')).read()
INPUT = re.findall(r"'([a-z_]+)'", SRC.split('export const INPUT_TOOLS = [')[1].split('] as const')[0])
rows, fails = [], []
for p in sorted(glob.glob(os.path.join(OUT, 'run-*.json'))):
    r = json.load(open(p)); name = os.path.basename(p)
    authorized = {}
    for a in r.get('audit', []):
        for k, v in a['driver']['authorized'].items(): authorized[k] = max(authorized.get(k, 0), v)
    row = {
        'run': name, 'threads': [a['threadId'] for a in r.get('audit', [])],
        'hostCalls': [(a['op'], a['ok'], a.get('code')) for a in r.get('audit', [])],
        'appCounts': [a['counts'] for a in r.get('audit', [])],
        'driverAuthorized': authorized,
        'authorizedInputTools': sorted(t for t in authorized if t in INPUT),
        'appInputCalls': sum(a['counts']['inputCalls'] for a in r.get('audit', [])),
        'fixture': [r.get('fixtureBefore', {}).get('status'), r.get('fixtureAfter', {}).get('status')],
        'sdkMappedFromUnpacked': all('/Applications/Bimax.app/Contents/Resources/app.asar.unpacked/' in m for m in r.get('bimaxMaps', {}).get('cua', [])) and bool(r.get('bimaxMaps', {}).get('cua')),
        'standaloneDaemon': [r.get('driverDaemonsBefore'), r.get('driverDaemonsAtCollect')],
        'modelAnswer': [m['content'] for t in r.get('threads', []) for m in t['messages'] if m['role'] == 'assistant'][-1:],
        'outcome': r.get('outcome', 'Allow run'),
    }
    if row['authorizedInputTools'] or row['appInputCalls']: fails.append(f"{name}: input authorized")
    if row['fixture'][0] is None or row['fixture'][0] != row['fixture'][1]: fails.append(f"{name}: fixture changed or unread")
    if any(row['standaloneDaemon']): fails.append(f"{name}: a standalone driver daemon was running")
    if any(c['looks'] for c in row['appCounts']) and not row['sdkMappedFromUnpacked']: fails.append(f"{name}: a look ran but the SDK was not mapped from the installed app")
    rows.append(row)
if len(sys.argv) == 1: json.dump({'inputTools': INPUT, 'runs': rows, 'failures': fails}, open(os.path.join(OUT, 'grade.json'), 'w'), indent=1)
print(json.dumps({'runs': len(rows), 'failures': fails}))
sys.exit(1 if fails else 0)
