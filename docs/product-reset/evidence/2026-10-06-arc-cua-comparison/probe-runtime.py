"""Controlled arc-cua runtime checks; no native backend, provider or user app.

Run with the inspected checkout path as the first argument. These checks qualify
only the supplied fake backend/policy, never desktop behavior or journey success.
"""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(sys.argv[1]) / 'src'))
from arc_cua import (ActionKind, Decision, DesktopElement, DesktopExecutor,
                     DesktopSnapshot, RuntimeConfig, Subtask, TerminalKind)


class FakeBackend:
    def __init__(self):
        self.sent = []

    def observe(self):
        return DesktopSnapshot(
            application='In-memory fixture', window='No native window',
            revision=str(len(self.sent)), elements=(
                DesktopElement(id='safe', role='button', name='Inspect', actions=(ActionKind.CLICK,)),
                DesktopElement(id='send', role='button', name='Send', actions=(ActionKind.CLICK,)),
                DesktopElement(id='message', role='text_field', name='Message',
                               focused=True, actions=(ActionKind.TYPE_TEXT,)),
            ),
        )

    def is_fresh(self, snapshot, action):
        return True

    def execute(self, snapshot, action):
        self.sent.append(action.kind.value)


class FakePolicy:
    def __init__(self, first, before_first=None):
        self.first, self.before_first, self.calls = first, before_first, 0

    def decide(self, **kwargs):
        self.calls += 1
        if self.calls == 1:
            if self.before_first:
                self.before_first()
            return self.first
        return Decision(terminal=TerminalKind.SUBTASK_COMPLETE)


task = Subtask(goal='Fixture only', verification=('A condition that is not established',),
               inputs={'body': 'Fixture text'}, max_actions=3)
rows = []


def run(name, policy, config=None):
    backend = FakeBackend()
    executor = DesktopExecutor(backend, policy, config=config)
    result = executor.run(task)
    row = {'name': name, 'status': result.status.value,
           'fake_dispatches': backend.sent, 'reason': result.reason}
    rows.append(row)
    return row


complete = Decision(terminal=TerminalKind.SUBTASK_COMPLETE)
row = run('completion_without_verifier', FakePolicy(complete))
assert row['status'] == 'SUBTASK_COMPLETE' and row['fake_dispatches'] == []
row = run('independent_verifier_rejects', FakePolicy(complete), RuntimeConfig(verify=lambda *_: False))
assert row['status'] == 'NEEDS_AGENT' and row['fake_dispatches'] == []

backend = FakeBackend()
policy = FakePolicy(Decision(kind=ActionKind.CLICK, target_id='safe'))
executor = DesktopExecutor(backend, policy)
policy.before_first = executor.cancel
result = executor.run(task)
rows.append({'name': 'cancel_during_decision', 'status': result.status.value,
             'fake_dispatches': backend.sent, 'reason': result.reason})
assert result.status == TerminalKind.NEEDS_AGENT and backend.sent == ['CLICK']

row = run('deadline_passed_during_decision',
          FakePolicy(Decision(kind=ActionKind.CLICK, target_id='safe'), lambda: time.sleep(0.03)),
          RuntimeConfig(timeout_s=0.01))
assert row['status'] == 'NEEDS_AGENT' and row['fake_dispatches'] == ['CLICK']

row = run('named_send_click_refused', FakePolicy(Decision(kind=ActionKind.CLICK, target_id='send')))
assert row['status'] == 'NEEDS_AGENT' and row['fake_dispatches'] == []
row = run('type_plus_enter_outside_named_click_risk_gate',
          FakePolicy(Decision(kind=ActionKind.TYPE_TEXT, target_id='message', input_key='body', key='ENTER')))
assert row['fake_dispatches'] == ['TYPE_TEXT', 'PRESS_KEY']

print(json.dumps({'scope': 'In-memory runtime only; no native or provider execution',
                  'checks': rows, 'assertions_passed': 6}, indent=2))
