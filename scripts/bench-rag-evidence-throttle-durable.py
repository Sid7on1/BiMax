#!/usr/bin/env python3
"""Atomic-checkpoint, lower-traffic transport recovery; frozen model and request bodies."""
import datetime,email.utils,hashlib,inspect,json,os,runpy,sys,threading,time
from pathlib import Path
import requests

ROOT=Path(__file__).resolve().parents[1]
OUT=Path(sys.argv[sys.argv.index('--output')+1]).resolve()
MODEL_DRIVER=ROOT/'scripts/bench-rag-evidence-model.py'
sys.path.insert(0,str(ROOT/'scripts/lib'))
from rag_benchmark_checkpoint import immutable_json
CHECKPOINT_SOURCE=ROOT/'scripts/lib/rag_benchmark_checkpoint.py'
def immutable(name,value):immutable_json(OUT/name,value)
BASE_SESSION=requests.Session
condition=threading.Condition();slots=threading.Semaphore(1)
next_send=0.;cooldown=0.;consecutive_limits=0;profile_written=False
RPM=3
assert os.environ.get('NVIDIA_API_KEY_RPM')=='10','Keep the original driver ceiling aligned with the wrapper'
def acquire():
 global next_send,profile_written
 started=time.monotonic()
 with condition:
  while (wait:=max(next_send,cooldown)-time.monotonic())>0:condition.wait(timeout=min(wait,5))
  next_send=time.monotonic()+60/RPM+.03
  if not profile_written:
   value={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'wrapperSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    'driverSha256':hashlib.sha256(MODEL_DRIVER.read_bytes()).hexdigest(),'maximumRPM':RPM,'maximumConcurrentHTTP':1,'driverPacingCeilingRPM':10,
    'cooldown':'60 seconds doubling for consecutive429, capped300s; honor a longer supplied Retry-After.',
    'checkpointSha256':hashlib.sha256(CHECKPOINT_SOURCE.read_bytes()).hexdigest(),
    'checkpoint':'Create-only atomic link after JSON/file fsync, followed by directory fsync. Progress is best-effort; completed result files are authoritative. Not a hardware power-loss guarantee.',
    'semantics':'Only benchmark checkpoint publication and HTTP admission/cooldown change. Model, prompt, reasoning, output cap, keys and frozen driver are unchanged. Existing valid answers are reused regardless of correctness.'}
   immutable('transport-wrapper.json',value)
   profile_written=True
 return (time.monotonic()-started)*1000
class CooldownSession(BASE_SESSION):
 def post(self,*args,**kwargs):
  global cooldown,consecutive_limits
  frame=inspect.currentframe().f_back
  label=frame.f_locals['label'];attempt=frame.f_locals['attempt']
  queued=time.monotonic()
  with slots:
   gate_ms=acquire();started=time.monotonic();response=super().post(*args,**kwargs);http_ms=(time.monotonic()-started)*1000
   with condition:
    if response.status_code==429:
     consecutive_limits+=1;delay=min(300,60*2**min(3,consecutive_limits-1))
     retry=response.headers.get('Retry-After')
     if retry:
      try:delay=max(delay,float(retry))
      except ValueError:
       try:delay=max(delay,(email.utils.parsedate_to_datetime(retry)-datetime.datetime.now(datetime.timezone.utc)).total_seconds())
       except (TypeError,ValueError):pass
     cooldown=max(cooldown,time.monotonic()+delay)
     print(f'HTTP429: global benchmark cooldown {delay:.0f}s',flush=True)
    elif response.status_code==200:consecutive_limits=0
    condition.notify_all()
   observation={'label':label,'attempt':attempt,'status':response.status_code,'gateWaitMs':gate_ms,
    'slotAndGateWaitMs':(started-queued)*1000,'httpWallMs':http_ms,'retryAfter':response.headers.get('Retry-After'),
    'at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
   immutable(f'transport-{label}-{attempt}.json',observation)
   return response
requests.Session=CooldownSession
# The old setup returns before the frozen driver submits any inference. Replace only its
# receipt writer; the original request/judge functions and all request bodies stay intact.
original_run_path=runpy.run_path
def durable_setup(path,*args,**kwargs):
 namespace=original_run_path(path,*args,**kwargs)
 if Path(path).resolve()==ROOT/'scripts/bench-rag-public.py':
  assert namespace['OUT']==OUT
  namespace['immutable']=immutable
  namespace['request'].__globals__['immutable']=immutable
 return namespace
runpy.run_path=durable_setup
sys.argv[0]=str(MODEL_DRIVER)
original_run_path(str(MODEL_DRIVER),run_name='__main__')
