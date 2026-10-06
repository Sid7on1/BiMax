import json, pathlib, subprocess
root=pathlib.Path.cwd()
out=root/'docs/product-reset/evidence/2026-10-05-fresh-chat'
cases=[
 ('replay-events-reach-chat','src/engine/events.ts','    if (isReplayActive()) return false;','', 'src/__tests__/replay.harness.test.ts','keeps old replay cards'),
 ('process-global-replay-flag','src/core/replay.scope.ts',None,"let active = false;\nexport async function inReplayScope<T>(action: () => T): Promise<Awaited<T>> { active = true; try { return await action(); } finally { active = false; } }\nexport function isReplayActive(): boolean { return active; }\n",'src/__tests__/replay.scope.test.ts','overlapping replays'),
 ('replay-steals-steering','src/core/agent.loop.ts','    if (isReplayActive()) return;','', 'src/__tests__/replay.harness.test.ts','does not consume live steering'),
 ('replay-closes-live-metrics','src/core/agent.loop.ts','      if (!isReplayActive()) {\n        if (signal?.aborted) taskMetrics.markInterrupted();','      if (true) {\n        if (signal?.aborted) taskMetrics.markInterrupted();', 'src/__tests__/replay.harness.test.ts','does not consume live steering'),
 ('replay-observers-write-live-state','src/core/tool.outcome.observers.ts','  if (isReplayActive()) return o.result;','', 'src/__tests__/replay.harness.test.ts','replaying ReadFileTool'),
 ('replay-runs-live-completion','src/core/agent.loop.ts','const completion = isReplayActive() ? null : getCompletionChecks();','const completion = getCompletionChecks();', 'src/__tests__/replay.harness.test.ts','replaying EditFileTool'),
 ('recorded-file-output-double-fenced','src/core/agent.tool.round.ts','content: ran && !isReplayActive() ? fenceUntrusted','content: ran ? fenceUntrusted', 'src/__tests__/replay.harness.test.ts','replaying ReadFileTool'),
 ('opening-repo-resumes-old-chat','app/src/main/thread.manager.ts','const reuse = options.restart && active?.summary.root === root;','const reuse = active?.summary.root === root;', 'app/src/__tests__/threads.test.ts','opening a repo starts fresh'),
]
results=[]
for name,file,old,new,test,pattern in cases:
 p=root/file; original=p.read_text()
 try:
  if old is not None:
   assert original.count(old)==1,(name,original.count(old))
   mutated=original.replace(old,new)
  else: mutated=new
  p.write_text(mutated)
  run=subprocess.run(['npx','jest','--runInBand','--coverage=false',test,'--testNamePattern',pattern],capture_output=True,text=True)
  log=run.stdout+run.stderr; (out/f'mutant-{name}.log').write_text(log)
  caught=run.returncode==1 and 'expect(received)' in log and 'Test Suites: 1 failed' in log and 'error TS' not in log
  results.append({'fault':name,'caught':caught,'exitCode':run.returncode})
 finally: p.write_text(original)
(out/'mutants.json').write_text(json.dumps(results,indent=2)+'\n')
print(json.dumps(results,indent=2))
assert all(item['caught'] for item in results)
