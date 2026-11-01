"""Count physical source lines from Git's tracked + nonignored working-tree inventory.

No dependency traversal; physical lines include comments and blanks. Not a quality metric.
"""
import collections
import hashlib
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[4]
OUT = pathlib.Path(__file__).resolve().parent
EXT = {'.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.swift', '.c', '.h', '.cpp', '.mm', '.m', '.go', '.rs', '.sh', '.css', '.html'}
names = sorted(set(subprocess.check_output(['git', 'ls-files', '-co', '--exclude-standard', '-z'], cwd=ROOT).decode().split('\0')) - {''})
rows = []
for name in names:
    p = ROOT / name
    if p.suffix not in EXT or not p.is_file() or p.is_symlink():
        continue
    parts = p.relative_to(ROOT).parts
    if any(x in parts for x in ('node_modules', '.build', 'dist', 'out', 'coverage', '__pycache__')):
        bucket = 'generated_or_dependency'
    elif parts[0] in ('archive', 'third_party') or 'vendor' in parts:
        bucket = 'vendored_or_archived'
    elif any(x in parts for x in ('__tests__', '__mocks__', 'fixtures', 'test', 'tests')) or any(x in p.name for x in ('.test.', '.spec.')):
        bucket = 'tests_and_fixtures'
    elif parts[0] == 'src' or (parts[0] == 'app' and len(parts) > 1 and parts[1] in ('src', 'native')):
        bucket = 'first_party_runtime'
    elif parts[0] == 'scripts' or (parts[0] == 'app' and len(parts) > 1 and parts[1] == 'scripts'):
        bucket = 'build_and_verification_scripts'
    elif parts[0] == 'benchmarks' or (parts[0] == 'app' and len(parts) > 1 and parts[1] in ('benchmarks', 'design-preview')):
        bucket = 'benchmarks_and_design_preview'
    else:
        bucket = 'other_source_or_evidence'
    data = p.read_bytes()
    lines = data.splitlines()
    rows.append(dict(path=name, bucket=bucket, physical_lines=len(lines), nonblank_lines=sum(bool(x.strip()) for x in lines), sha256=hashlib.sha256(data).hexdigest()))
totals = collections.defaultdict(lambda: dict(files=0, physical_lines=0, nonblank_lines=0))
for row in rows:
    for key in totals[row['bucket']]:
        totals[row['bucket']][key] += 1 if key == 'files' else row[key]
runtime_areas = collections.defaultdict(lambda: dict(files=0, physical_lines=0))
for row in rows:
    if row['bucket'] != 'first_party_runtime':
        continue
    p = row['path']
    area = 'engine' if p.startswith('src/') else 'native' if p.startswith('app/native/') else 'desktop_mobile_ui_and_host'
    runtime_areas[area]['files'] += 1
    runtime_areas[area]['physical_lines'] += row['physical_lines']
result = dict(method='git ls-files -co --exclude-standard; deduplicated existing regular source files; physical lines, including blanks/comments; no dependencies walked', head=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT).decode().strip(), totals=dict(totals), runtime_areas=dict(runtime_areas), largest_runtime=sorted((r for r in rows if r['bucket'] == 'first_party_runtime'), key=lambda r: r['physical_lines'], reverse=True)[:20], files=rows)
(OUT / 'census.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({k:v for k,v in result.items() if k not in ('files', 'largest_runtime')}, indent=2))
