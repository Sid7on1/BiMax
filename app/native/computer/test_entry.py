"""Private Bimax native protocol contracts; no OS actions or live permissions."""
import importlib.util, io, json, pathlib, sys, threading, types, unittest
from unittest import mock
spec = importlib.util.spec_from_file_location('bimax_native', pathlib.Path(__file__).with_name('entry.py'))
entry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(entry)

class FakeDriver:
    instances = []
    def __init__(self):
        self.cancelled = threading.Event(); self.inputs = 0; self.closed = False
        self.instances.append(self)
    def status(self): return {'permissions': {'accessibility': True}, 'version': 'fake-contract'}
    def press(self, *args, **kwargs): self.inputs += 1; raise AssertionError('Queued input must not execute after EOF')
    def close(self): self.closed = True

class Protocol(unittest.TestCase):
    def run_messages(self, messages):
        source = io.BytesIO(('\n'.join(json.dumps(m) for m in messages)+'\n').encode())
        old_in,old_out,old_driver = sys.stdin,sys.stdout,entry.Driver
        sink=io.StringIO()
        try:
            sys.stdin=types.SimpleNamespace(buffer=source);sys.stdout=sink;entry.Driver=FakeDriver
            entry.serve()
            return [json.loads(line) for line in sink.getvalue().splitlines()], FakeDriver.instances[-1]
        finally: sys.stdin,sys.stdout,entry.Driver = old_in,old_out,old_driver
    def test_private_status_identity(self):
        replies,driver=self.run_messages([{'id':1,'operation':'status','arguments':{}}])
        self.assertEqual(replies[0]['result']['data']['name'],'Bimax CU');self.assertTrue(driver.closed)
    def test_no_mcp_handshake(self):
        replies,_=self.run_messages([{'id':1,'jsonrpc':'2.0','method':'initialize','params':{}}])
        self.assertIn('private operation contract',replies[0]['error']['message'])
    def test_eof_does_not_dispatch_queued_input(self):
        replies,driver=self.run_messages([{'id':1,'operation':'press','arguments':{'pid':42,'keys':'ENTER'}}])
        self.assertEqual(driver.inputs,0);self.assertIn('queued input was not run',replies[0]['error']['message'])
    def test_cancelled_queued_input_is_not_run(self):
        replies,driver=self.run_messages([{'id':1,'operation':'press','arguments':{'pid':42,'keys':'ENTER'}},{'cancel':1}])
        self.assertEqual(driver.inputs,0);self.assertEqual(replies,[])
    def test_no_upstream_cli_or_mcp_entrypoint(self):
        old=entry.serve;calls=[]
        try:
            entry.serve=lambda: calls.append(True)
            for argv in [['mcp'],['run'],['--identity','mcp']]:
                with mock.patch('sys.stderr',io.StringIO()): self.assertEqual(entry.main(argv),2)
            self.assertEqual(calls,[])
        finally:entry.serve=old

    def test_standalone_entry_resolves_exact_native_window_target(self):
        from arc_cua.driver import WindowTarget
        # This module is deliberately loaded as a standalone script, like PyInstaller's entry.
        target = entry.BimaxCuDriver._where(42, 7)
        self.assertEqual(target, WindowTarget(42, 7))
        self.assertEqual(entry.BimaxCuDriver._where(42, None), 42)

if __name__=='__main__':unittest.main()
