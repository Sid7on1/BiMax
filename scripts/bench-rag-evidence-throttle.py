#!/usr/bin/env python3
"""Transport-only recovery wrapper; preserve frozen model driver and request bodies."""
import datetime,email.utils,hashlib,inspect,json,os,runpy,sys,threading,time
from pathlib import Path
import requests

ROOT=Path(__file__).resolve().parents[1]
OUT=Path(sys.argv[sys.argv.index('--output')+1]).resolve()
MODEL_DRIVER=ROOT/'scripts/bench-rag-evidence-model.py'
BASE_SESSION=requests.Session
condition=threading.Condition();slots=threading.Semaphore(2)
next_send=0.;cooldown=0.;consecutive_limits=0;profile_written=False
RPM=10
assert os.environ.get('NVIDIA_API_KEY_RPM')=='10','Keep the original driver ceiling aligned with the wrapper'
def acquire():
 global next_send,profile_written
 started=time.monotonic()
 with condition:
  while (wait:=max(next_send,cooldown)-time.monotonic())>0:condition.wait(timeout=min(wait,5))
  next_send=time.monotonic()+60/RPM+.03
  if not profile_written:
   value={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'wrapperSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    'driverSha256':hashlib.sha256(MODEL_DRIVER.read_bytes()).hexdigest(),'maximumRPM':RPM,'maximumConcurrentHTTP':2,
    'cooldown':'60 seconds doubling for consecutive429, capped300s; honor a longer supplied Retry-After.',
    'semantics':'Only HTTP admission/cooldown changes. Model, prompt, reasoning, output cap, keys and frozen driver are unchanged. Existing valid answers are reused regardless of correctness.'}
   with (OUT/'transport-wrapper.json').open('x') as f:json.dump(value,f,indent=2);f.write('\n')
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
   with (OUT/f'transport-{label}-{attempt}.json').open('x') as f:json.dump(observation,f,indent=2);f.write('\n')
   return response
requests.Session=CooldownSession
sys.argv[0]=str(MODEL_DRIVER)
runpy.run_path(str(MODEL_DRIVER),run_name='__main__')
