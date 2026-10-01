#!/usr/bin/env python3
"""Independent reader for the X01 to-do app (record 65 stage 5): the standalone cua-driver under its own grant,
read-only (list_windows + get_window_state). Prints the status line, the to-dos shown and the process's executable."""
import json, os, re, subprocess, sys
sys.path.insert(0, '/Users/vishsiddharth/Developer/bimax-research/cu')
from bench_driver import Mcp
pids = subprocess.run(['pgrep', '-f', 'BimaxTodo.app/Contents/MacOS/BimaxTodo'], capture_output=True, text=True).stdout.split()
if not pids:
    print(json.dumps({'running': False})); sys.exit(0)
pid = int(pids[0])
m = Mcp()
try:
    wins = m.call('list_windows', {'pid': pid})['data']['windows']
    wid = next(w['window_id'] for w in wins if w['title'] == 'Bimax To-Do')
    md = m.call('get_window_state', {'pid': pid, 'window_id': wid, 'include_screenshot': False})['data'].get('tree_markdown', '') or ''
    status = re.search(r'items=\d+ done=\d+', md)
    todos = re.findall(r'AXCheckBox "([^"]+)"', md)
    buttons = re.findall(r'AXButton "([^"]+)"', md)
    exe = subprocess.run(['ps', '-o', 'comm=', '-p', str(pid)], capture_output=True, text=True).stdout.strip()
    print(json.dumps({'running': True, 'pid': pid, 'status': status.group(0) if status else None, 'todos': todos, 'buttons': buttons, 'executable': exe}))
finally:
    m.close()
    subprocess.run([os.path.expanduser('~/.local/bin/cua-driver'), 'stop'], capture_output=True)
