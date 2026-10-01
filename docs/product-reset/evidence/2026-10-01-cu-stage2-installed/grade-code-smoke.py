"""Grade only this session's synthetic installed coding read. No real project state is exported."""
import copy
import datetime
import hashlib
import json
import pathlib
import subprocess

evidence_dir = pathlib.Path(__file__).parent
install = json.loads((evidence_dir / 'install.json').read_text())
root = pathlib.Path.home() / 'Library/Caches/bimax-cu-stage2-code-check'
fixture = root / 'stage2-fixture.txt'
expected = 'BIMAX_STAGE2_CODE_ONLY_20261001\n'
records = []
for file in (pathlib.Path.home() / 'Library/Application Support/Bimax/threads').glob('*.json'):
    saved = json.loads(file.read_text())
    if saved.get('summary', {}).get('root') == str(root):
        records.append((file, saved))
assert len(records) == 1, 'Require this session\'s unique synthetic project'
source, saved = records[0]
items = saved['state']['items']
raw = {
    'summary': saved['summary'],
    'items': [{k: v for k, v in item.items() if k != 'thought'} for item in items],
    'fixtureText': fixture.read_text(),
    'fixtureSha256': hashlib.sha256(fixture.read_bytes()).hexdigest(),
}
expected_hash = hashlib.sha256(expected.encode()).hexdigest()
prompt = 'Read stage2-fixture.txt in this project using ReadFileTool. Reply with its exact single line. Do not edit files, run shell commands, or look at other apps.'

def grade(run):
    try:
        tools = [item['call'] for item in run['items'] if item['kind'] == 'tool']
        messages = [item['msg'] for item in run['items'] if item['kind'] == 'msg']
        assert run['summary']['origin'] == 'project' and run['summary']['status'] == 'idle'
        assert run['fixtureText'] == expected and run['fixtureSha256'] == expected_hash
        assert len(tools) == 1 and tools[0]['toolName'] == 'ReadFileTool'
        assert json.loads(tools[0]['input']) == {'path': fixture.name}
        assert tools[0]['status'] == 'success' and tools[0]['output'] == expected
        assert len(messages) == 2 and messages[0]['role'] == 'user' and messages[0]['content'] == prompt
        assert messages[-1]['role'] == 'assistant' and messages[-1]['content'] == expected.strip()
        assert install['at'] < messages[0]['timestamp'] < tools[0]['startTime'] <= tools[0]['endTime'] < messages[-1]['timestamp']
        return True
    except (AssertionError, KeyError, ValueError):
        return False

assert grade(raw), 'Installed read failed independent grading'
mutants = []
for mutant in ['missing-read', 'wrong-target', 'no-op-output', 'duplicate-read', 'stale-run', 'provider-error']:
    run = copy.deepcopy(raw)
    tool = next(item for item in run['items'] if item['kind'] == 'tool')
    if mutant == 'missing-read':
        run['items'].remove(tool)
    elif mutant == 'wrong-target':
        tool['call']['input'] = '{"path":"other.txt"}'
    elif mutant == 'no-op-output':
        tool['call']['output'] = ''
    elif mutant == 'duplicate-read':
        run['items'].append(copy.deepcopy(tool))
    elif mutant == 'stale-run':
        run['items'][0]['msg']['timestamp'] = '2026-09-01T00:00:00Z'
    elif mutant == 'provider-error':
        tool['call']['status'] = 'error'
    assert not grade(run), mutant + ' survived'
    mutants.append(mutant)

pid = subprocess.check_output(['pgrep', '-f', '^/Applications/Bimax.app/Contents/MacOS/Bimax$'], text=True).strip()
mapped = subprocess.check_output(['lsof', '-p', pid, '-Fn'], text=True)
sdk_mappings = [line for line in mapped.splitlines() if '@trycua' in line or 'cua_driver' in line]
settings_path = pathlib.Path.home() / 'Library/Application Support/Bimax/settings.json'
preview = json.loads(settings_path.read_text()).get('computerLook', False)
audit_exists = (pathlib.Path.home() / 'Library/Application Support/Bimax/computer/audit.jsonl').exists()
assert not preview and not sdk_mappings and not audit_exists
result = {
    'kind': 'installed-code-read-smoke', 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'productVersion': '1.1.0', 'backend': 'installed Electron engine worker',
    'modelDisplayed': 'gpt-oss-20b · Low', 'provider': 'not independently captured; configured route unchanged',
    'os': subprocess.check_output(['sw_vers', '-productVersion'], text=True).strip(),
    'buildHashes': install['hashes'], 'sourceThreadRecord': str(source),
    'raw': raw, 'gradedPass': True, 'rejectedGraderMutants': mutants,
    'sampledProcessPid': pid, 'sampledSdkMappings': sdk_mappings, 'previewEnabled': preview,
    'auditLogExists': audit_exists, 'observedTccPrompts': 0,
    'limits': 'One synthetic coding read. SDK mappings sampled after the task; prompts observed through UI, not a whole-session TCC event counter. No installed Computer Use observation or fresh-Mac qualification.',
}
(evidence_dir / 'code-smoke.json').write_text(json.dumps(result, indent=2) + '\n')
print('PASS: installed synthetic read; six grader mutants rejected; preview off; no SDK mapped at post-task sample')
