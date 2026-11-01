#!/usr/bin/env python3
"""Additional independent preference/all-elements controls under the frozen run profile.

Run only after the benchmark provider workers finish, preserving the shared RPM budget.
The fixtures do not use selected benchmark questions or predictions.
"""
import argparse, datetime, hashlib, json, runpy, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--output', type=Path, required=True)
p.add_argument('--run', type=Path, required=True)
args = p.parse_args()
config = json.loads((args.run / 'configuration.json').read_text())
summary = json.loads((args.run / 'summary.json').read_text())
assert summary['validQuestions'] == 200 and not summary['invalidQuestions']
for path, expected in config['sourceHashes'].items():
    assert hashlib.sha256((ROOT / path).read_bytes()).hexdigest() == expected, path
fixtures = [
    ('preference-positive', 'Suggest dinner for my preferences.',
     'The response should suggest a vegetarian meal and avoid peanuts.',
     'Try a vegetarian lentil and spinach stew with rice; use no peanuts or peanut oil.',
     True, 'single-session-preference', False),
    ('preference-partial-positive', 'Suggest dinner for my preferences.',
     'The user is vegetarian, enjoys Italian food, and prefers quick meals. The response should use these personal preferences.',
     'Try Italian-inspired vegetarian mushroom risotto.', True, 'single-session-preference', False),
    ('preference-negative', 'Suggest dinner for my preferences.',
     'The response should suggest a vegetarian meal and avoid peanuts.',
     'Try chicken satay with peanut sauce.', False, 'single-session-preference', False),
    ('all-elements-positive', 'Which two colors were selected?', ['red', 'blue'],
     'Red and blue.', True, 'single-session-user', True),
    ('all-elements-partial', 'Which two colors were selected?', ['red', 'blue'],
     'Red.', False, 'single-session-user', True),
]
sys.argv = ['bench-rag-public.py', '--output', str(args.output), '--model', config['judge'],
            '--thinking-budget', str(config['reasoning']['reasoning_budget'])]
ns = runpy.run_path(str(ROOT / 'scripts/bench-rag-public.py'), run_name='rubric_controls')
ns['immutable']('control-contract.json', {
    'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'profileRun': str(args.run.resolve()), 'model': config['judge'],
    'sourceHashes': config['sourceHashes'], 'fixtures': fixtures,
    'rule': 'Fixed independent inputs; preserve all valid verdicts, including wrong ones. No tuning or benchmark replay.',
})
observations = []
for name, question, reference, prediction, expected, kind, required_all in fixtures:
    actual, _ = ns['judge'](question, reference, prediction, kind, False,
                            'rubric-control-' + name, required_all=required_all)
    observations.append({'name': name, 'expected': expected, 'actual': actual, 'passed': actual == expected})
ns['immutable']('results.json', observations)
print(json.dumps(observations, indent=2))
if not all(row['passed'] for row in observations):
    raise RuntimeError('Additional rubric control failed; report the limitation without tuning the benchmark')
