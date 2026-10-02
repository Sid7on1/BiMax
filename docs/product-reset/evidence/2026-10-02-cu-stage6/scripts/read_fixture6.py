#!/usr/bin/env python3
"""Independent fixture reader for record 65 stage 6: the standalone cua-driver under the TERMINAL's grant, read-only
(list_windows + get_window_state), so Bimax's own counts and read-backs are never the grader. Prints the fixture's
status line, its text field and text area values and its checkbox value."""
import json, re, subprocess, sys
sys.path.insert(0, '/Users/vishsiddharth/Developer/bimax-research/cu')
from bench_driver import Mcp
pid = int(subprocess.run(['pgrep', '-f', 'BimaxCuFixture.app/Contents/MacOS/bimax-cu-fixture'], capture_output=True, text=True).stdout.split()[0])
m = Mcp()
try:
    wins = m.call('list_windows', {'pid': pid})['data']['windows']
    wid = next(w['window_id'] for w in wins if w['title'] == 'Bimax-Cu Fixture')
    st = m.call('get_window_state', {'pid': pid, 'window_id': wid, 'include_screenshot': False})['data']
    md = st.get('tree_markdown', '') or ''
    hit = re.search(r'presses=\d+ events=\d+ last=[a-z]+', md)
    els = st.get('elements') or []
    first = lambda role: next((e for e in els if e.get('role') == role), None)
    value = lambda role: (first(role) or {}).get('value')
    print(json.dumps({'pid': pid, 'window_id': wid, 'status': hit.group(0) if hit else None,
                      'textField': value('AXTextField'), 'textArea': value('AXTextArea'), 'checkbox': value('AXCheckBox')}))
finally:
    m.close()
