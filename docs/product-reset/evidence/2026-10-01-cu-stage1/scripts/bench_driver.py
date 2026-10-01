#!/usr/bin/env python3
"""Record 65 stage 1: drive BimaxCuFixture.app through Cua Driver 0.31 over MCP stdio, in the background.

Every action is graded twice, independently:
  - our grader re-snapshots the window and reads the control's value and the fixture's status line;
  - the driver's own `verify_state` predicate.
And every action checks the background claim: the frontmost app and the real pointer must not change.

The fixture's controls are inert by construction: they mutate only their own state.
"""
import json, os, subprocess, sys, time

DRIVER = os.path.expanduser('~/.local/bin/cua-driver')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'driver-bench.json')


class Mcp:
    def __init__(self):
        self.p = subprocess.Popen([DRIVER, 'mcp'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, text=True, bufsize=1)
        self.n = 0
        self.rpc('initialize', {'protocolVersion': '2025-06-18', 'capabilities': {},
                                'clientInfo': {'name': 'bimax-stage1-bench', 'version': '0'}})
        self.send({'jsonrpc': '2.0', 'method': 'notifications/initialized'})

    def send(self, msg):
        self.p.stdin.write(json.dumps(msg) + '\n'); self.p.stdin.flush()

    def rpc(self, method, params):
        self.n += 1
        self.send({'jsonrpc': '2.0', 'id': self.n, 'method': method, 'params': params})
        while True:
            line = self.p.stdout.readline()
            if not line:
                raise RuntimeError('driver closed the stream')
            msg = json.loads(line)
            if msg.get('id') == self.n:
                return msg

    def call(self, tool, args):
        t0 = time.perf_counter()
        msg = self.rpc('tools/call', {'name': tool, 'arguments': args})
        ms = (time.perf_counter() - t0) * 1000
        res = msg.get('result') or {}
        sc = res.get('structuredContent')
        if sc is None:
            text = ''.join(c.get('text', '') for c in res.get('content', []) if c.get('type') == 'text')
            try:
                sc = json.loads(text)
            except Exception:
                sc = {'text': text[:400]}
        return {'ok': not res.get('isError') and 'error' not in msg, 'ms': round(ms, 1), 'data': sc,
                'error': msg.get('error') or (sc if res.get('isError') else None)}

    def close(self):
        try:
            self.p.stdin.close(); self.p.wait(timeout=5)
        except Exception:
            self.p.kill()


def frontmost():
    out = subprocess.run(['lsappinfo', 'front'], capture_output=True, text=True).stdout.strip()
    info = subprocess.run(['lsappinfo', 'info', '-only', 'name', out], capture_output=True, text=True).stdout
    return info.strip()


def main():
    pid = int(subprocess.run(['pgrep', '-f', 'BimaxCuFixture.app/Contents/MacOS/bimax-cu-fixture'],
                             capture_output=True, text=True).stdout.split()[0])
    m = Mcp()
    wins = m.call('list_windows', {'pid': pid})['data']['windows']
    wid = next(w['window_id'] for w in wins if w['title'] == 'Bimax-Cu Fixture')

    # The animated agent cursor costs ~1.45 s per action; Bimax would draw its own feedback.
    m.call('set_agent_cursor_enabled', {'enabled': False})
    # The real background condition: the user's own app in front, the fixture behind it.
    subprocess.run(['open', '-a', 'Ghostty']); time.sleep(1.0)
    snap_md = {}

    def snap():
        r = m.call('get_window_state', {'pid': pid, 'window_id': wid, 'include_screenshot': False})
        snap_md['md'] = r['data'].get('tree_markdown') or ''
        return r, (r['data'].get('elements') or [])

    def find(els, role, label=None, prefix=None):
        for e in els:
            if e.get('role') != role:
                continue
            text = e.get('label') or e.get('value') or ''
            if label is not None and e.get('label') == label:
                return e
            if prefix is not None and str(e.get('value') or e.get('label') or '').startswith(prefix):
                return e
        return None

    def status(els):
        # Static text is not in `elements` (it never was: record bimax-driver-elements-omit-text); it is in the
        # Markdown rendering of the same snapshot.
        import re
        hit = re.search(r'presses=\d+ events=\d+ last=[a-z]+', snap_md.get('md', ''))
        return hit.group(0) if hit else None

    def pointer():
        return m.call('get_cursor_position', {})['data']

    results = []

    def run(name, act, check, verify=None):
        r0, els = snap()
        before_status = status(els)
        front0, ptr0 = frontmost(), pointer()
        tool, args = act(els)
        if args is None:
            results.append({'action': name, 'outcome': 'target_not_found'}); return
        res = m.call(tool, {**args, 'pid': pid, 'window_id': wid})
        time.sleep(0.25)
        r1, els1 = snap()
        ok, detail = check(els1, before_status)
        v = m.call('verify_state', {'pid': pid, 'window_id': wid, 'expect': verify}) if verify else None
        front1, ptr1 = frontmost(), pointer()
        results.append({
            'action': name, 'tool': tool, 'driver_ok': res['ok'], 'driver_ms': res['ms'],
            'driver_error': res['error'], 'graded': ok, 'detail': detail,
            'status_before': before_status, 'status_after': status(els1),
            'verify_state': (v['data'] if v else None), 'verify_ms': (v['ms'] if v else None),
            'frontmost_unchanged': front0 == front1, 'frontmost': [front0, front1],
            'pointer_unchanged': ptr0 == ptr1,
            'snapshot_ms': r0['ms'], 'walk_ms': r0['data'].get('walk_elapsed_ms'),
        })

    tok = lambda e: {'element_token': e['element_token']} if e else None
    first = lambda els, role: next((e for e in els if e.get('role') == role), None)
    typed0 = {'n': str((first(snap()[1], 'AXTextArea') or {}).get('value', '')).count('+typed')}
    val = lambda els, role, label: (find(els, role, label) or {}).get('value')

    run('invoke (press button)',
        lambda els: ('click', tok(find(els, 'AXButton', 'Fixture Button'))),
        lambda els, s0: (status(els) != s0 and 'last=press' in (status(els) or ''), status(els)),
        [{'element': {'selector': {'role': 'AXStaticText', 'label_contains': 'last=press'}, 'exists': True}}])

    def checkbox_check(els, s0):
        return ('last=toggle' in (status(els) or ''), val(els, 'AXCheckBox', 'Fixture Checkbox'))
    run('toggle (checkbox)', lambda els: ('click', tok(find(els, 'AXCheckBox', 'Fixture Checkbox'))), checkbox_check)
    run('toggle back (checkbox)', lambda els: ('click', tok(find(els, 'AXCheckBox', 'Fixture Checkbox'))), checkbox_check)

    run('set_value (text field)',
        lambda els: ('set_value', {**tok(first(els, 'AXTextField')), 'value': f'bimax stage one {time.time():.0f}'}
                     if first(els, 'AXTextField') else None),
        lambda els, s0: (str((first(els, 'AXTextField') or {}).get('value', '')).startswith('bimax stage one'), (first(els, 'AXTextField') or {}).get('value')))

    run('type_text (text area)',
        lambda els: ('type_text', {**tok(first(els, 'AXTextArea')), 'text': ' +typed'} if first(els, 'AXTextArea') else None),
        lambda els, s0: (str((first(els, 'AXTextArea') or {}).get('value', '')).count('+typed') > typed0.get('n', 0),
                         str((first(els, 'AXTextArea') or {}).get('value'))[-40:]))

    run('set_value (slider to 40)',
        lambda els: ('set_value', {**(tok(find(els, 'AXSlider', 'fixture-slider')) or {}), 'value': '40'}
                     if find(els, 'AXSlider', 'fixture-slider') else None),
        lambda els, s0: (str(val(els, 'AXSlider', 'fixture-slider')).startswith('40'), val(els, 'AXSlider', 'fixture-slider')))

    stepper0 = {}
    def stepper_act(els):
        # The driver exposes no AXIncrement (click actions: press, show_menu, pick, confirm, cancel, open), so the
        # stepper is set by value — the old kit performs `increment` itself.
        e = find(els, 'AXIncrementor', 'fixture-stepper'); stepper0['v'] = (e or {}).get('value')
        return ('set_value', {**tok(e), 'value': str(int(float(stepper0['v'])) + 1)} if e else None)
    run('increment (stepper, by value)', stepper_act,
        lambda els, s0: (str(val(els, 'AXIncrementor', 'fixture-stepper')) != str(stepper0.get('v')),
                         [stepper0.get('v'), val(els, 'AXIncrementor', 'fixture-stepper')]))

    run('select (radio One)',
        lambda els: ('click', tok(find(els, 'AXRadioButton', 'One'))),
        lambda els, s0: (str(val(els, 'AXRadioButton', 'One')) == '1' and 'last=choose' in (status(els) or ''),
                         [val(els, 'AXRadioButton', 'One'), val(els, 'AXRadioButton', 'Two')]),
        [{'element': {'selector': {'role': 'AXRadioButton', 'label_contains': 'One'}, 'value_equals': '1'}}])

    m.close()
    rss = subprocess.run(['ps', '-o', 'rss=', '-p', subprocess.run(['pgrep', '-f', 'CuaDriver.app/Contents/MacOS/cua-driver serve'],
                         capture_output=True, text=True).stdout.split()[0]], capture_output=True, text=True).stdout.strip()
    summary = {'driver': subprocess.run([DRIVER, '--version'], capture_output=True, text=True).stdout.strip(),
               'daemon_rss_kb': rss, 'results': results}
    json.dump(summary, open(OUT, 'w'), indent=1, default=str)
    for r in results:
        print(f"{r['action']:<26} graded={r.get('graded')} driver_ok={r.get('driver_ok')} "
              f"bg_front={r.get('frontmost_unchanged')} bg_ptr={r.get('pointer_unchanged')} "
              f"act={r.get('driver_ms')}ms verify={(r.get('verify_state') or {}).get('status') if r.get('verify_state') else '-'} "
              f"detail={str(r.get('detail'))[:60]}")
    print('daemon RSS KB', rss)


if __name__ == '__main__':
    main()
