#!/usr/bin/env python3
"""Fetch pinned MIT public datasets and fix a balanced 200-question selection before inference."""
from pathlib import Path
import concurrent.futures
import hashlib
import json
import time
import requests
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs/product-reset/evidence/2026-10-14-rag-qualification'
CACHE = Path('/tmp/bimax-rag-public-20261014')
CACHE.mkdir(exist_ok=True)
REV_LME = '98d7416c24c778c2fee6e6f3006e7a073259d48f'
REV_MAB = '7ea066982b140a19337e17e60d45d4076e042faf'
SIZE = 277383467
URL = f'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/{REV_LME}/longmemeval_s_cleaned.json?download=true'
FILE = CACHE / 'longmemeval_s_cleaned.json'
CHUNK = 8 * 1024 * 1024
def part(start):
    end = min(SIZE, start + CHUNK) - 1
    target = CACHE / f'lme-part-{start}'
    if target.exists() and target.stat().st_size == end - start + 1:
        return target
    attempts = []; failures = 0
    with requests.Session() as session:
        while start + (target.stat().st_size if target.exists() else 0) <= end:
            offset = start + (target.stat().st_size if target.exists() else 0)
            stop = min(end, offset + 512 * 1024 - 1)
            try:
                with session.get(URL + f'&part={offset}', headers={'Range': f'bytes={offset}-{stop}'}, stream=True, timeout=(15, 45)) as response:
                    response.raise_for_status()
                    if response.status_code != 206 or response.headers.get('Content-Range') != f'bytes {offset}-{stop}/{SIZE}':
                        raise ValueError('server did not honor exact byte range')
                    with target.open('ab') as dest:
                        for data in response.iter_content(64 * 1024): dest.write(data)
                    if start + target.stat().st_size != stop + 1: raise ValueError('incomplete byte range')
                attempts.append({'offset': offset, 'stop': stop, 'ok': True}); failures = 0
            except Exception as error:
                attempts.append({'offset': offset, 'stop': stop, 'ok': False, 'error': type(error).__name__}); failures += 1
                if failures >= 5: raise
                time.sleep(min(8, 2 ** failures))
            finally:
                (OUT / f'download-lme-resume-{start}.json').write_text(json.dumps(attempts, indent=2) + '\n')
    print(f'downloaded {start}-{end}', flush=True)
    return target
if not FILE.exists() or FILE.stat().st_size != SIZE:
    starts = list(range(0, SIZE, CHUNK))
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        parts = list(pool.map(part, starts))
    with FILE.open('wb') as dest:
        for p in parts:
            with p.open('rb') as src:
                while data := src.read(1024 * 1024): dest.write(data)
assert FILE.stat().st_size == SIZE
lme = json.loads(FILE.read_text())
assert len(lme) == 500
mab_path = CACHE / 'Accurate_Retrieval.parquet'
assert mab_path.stat().st_size == 20024386
mab = pq.read_table(mab_path).to_pylist()
assert len(mab) == 22 and sum(len(row['questions']) for row in mab) == 2000
sha = lambda data: hashlib.sha256(data).hexdigest()
seed = 'bimax-rag-qualification-2026-10-14-v1'
def balanced(items, key, count):
    groups = {}
    for item in items: groups.setdefault(key(item), []).append(item)
    for group in groups.values(): group.sort(key=lambda item: sha((seed + json.dumps(item, sort_keys=True)).encode()))
    selected = []
    while len(selected) < count:
        for name in sorted(groups):
            if groups[name] and len(selected) < count: selected.append(groups[name].pop(0))
    return selected
# Selection uses identifiers/types/source families only, never answers or retrieval results.
lme_ids = balanced([{'row': i, 'id': row['question_id'], 'stratum': 'abstention' if row['question_id'].endswith('_abs') else row['question_type']} for i, row in enumerate(lme)], lambda row: row['stratum'], 100)
mab_ids = balanced([{'row': i, 'query': j, 'id': f'mab-{i}-{j}', 'stratum': row['metadata']['source']} for i, row in enumerate(mab) for j in range(len(row['questions']))], lambda row: row['stratum'], 100)
for i, row in enumerate(lme): (CACHE / f'lme-{i}.json').write_text(json.dumps(row))
for i, row in enumerate(mab): (CACHE / f'mab-{i}.json').write_text(json.dumps(row))
manifest = {'selectionVersion': seed, 'scope': '100 balanced LongMemEval_S questions and 100 balanced MemoryAgentBench Accurate_Retrieval questions; not full-suite scores',
    'datasets': [{'name': 'LongMemEval_S cleaned', 'revision': REV_LME, 'url': URL, 'sha256': sha(FILE.read_bytes()), 'bytes': SIZE, 'license': 'MIT', 'totalQuestions': 500},
        {'name': 'MemoryAgentBench Accurate_Retrieval', 'revision': REV_MAB, 'sha256': sha(mab_path.read_bytes()), 'bytes': mab_path.stat().st_size, 'license': 'MIT', 'totalQuestions': 2000}],
    'selection': {'longmemeval': lme_ids, 'memoryagentbench': mab_ids}, 'cache': str(CACHE)}
(OUT / 'public-selection.json').write_text(json.dumps(manifest, indent=2) + '\n')
print('Public selection fixed: 100 + 100 questions', flush=True)
