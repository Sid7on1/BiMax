"""Small offline end-state checks; no provider, embeddings or application processes."""
import importlib.util,json,os,signal,subprocess,sys,tempfile,unittest
from pathlib import Path

MODULE=Path(os.environ.get('RAG_CHECKPOINT_TEST_MODULE') or Path(__file__).with_name('rag_benchmark_checkpoint.py')).resolve()
spec=importlib.util.spec_from_file_location('checkpoint',MODULE)
checkpoint=importlib.util.module_from_spec(spec);spec.loader.exec_module(checkpoint)


class Checkpoints(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory();self.addCleanup(self.temporary.cleanup)
        self.path=Path(self.temporary.name)/'answer-result.json'

    def test_complete_receipt_and_no_pending_file(self):
        expected={'valid':True,'text':'नील'}
        checkpoint.immutable_json(self.path,expected)
        self.assertEqual(json.loads(self.path.read_text()),expected)
        self.assertEqual(list(self.path.parent.iterdir()),[self.path])

    def test_existing_observation_is_never_overwritten(self):
        self.path.write_bytes(b'original observation')
        with self.assertRaises(FileExistsError):checkpoint.immutable_json(self.path,{'new':True})
        self.assertEqual(self.path.read_bytes(),b'original observation')
        self.assertEqual(list(self.path.parent.iterdir()),[self.path])

    def test_failed_serialization_cannot_publish_partial_json(self):
        with self.assertRaises(TypeError):checkpoint.immutable_json(self.path,{'bad':object()})
        self.assertEqual(list(self.path.parent.iterdir()),[])

    def crash(self,after):
        source='''import importlib.util,os,signal,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('checkpoint',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
original=m.os.link
def stop(*args,**kwargs):
 if sys.argv[3]=='after':original(*args,**kwargs)
 os.kill(os.getpid(),signal.SIGKILL)
m.os.link=stop
m.immutable_json(Path(sys.argv[2]),{'valid':True,'value':'checkpoint'})
'''
        result=subprocess.run([sys.executable,'-c',source,str(MODULE),str(self.path),'after' if after else 'before'],capture_output=True,timeout=10)
        self.assertEqual(result.returncode,-signal.SIGKILL)

    def test_process_death_before_publication_leaves_no_completed_result(self):
        self.crash(False)
        self.assertFalse(self.path.exists())
        self.assertEqual(list(self.path.parent.glob('*-result.json')),[])

    def test_process_death_after_publication_leaves_complete_result(self):
        self.crash(True)
        self.assertEqual(json.loads(self.path.read_text()),{'valid':True,'value':'checkpoint'})


if __name__=='__main__':unittest.main()
