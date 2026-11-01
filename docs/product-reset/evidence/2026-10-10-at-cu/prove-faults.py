from pathlib import Path
import subprocess,json,hashlib
root=Path(__file__).resolve().parents[4]
evidence=Path(__file__).resolve().parent
faults=[
 ('native-unattended-gate', 'app/src/main/computer/route.ts', '!gates.unattended', 'true', 'app/src/__tests__/computer.route.test.ts', 'native authority uses real'),
 ('explicit-host-execution', 'src/core/agent.tool.round.ts', 'tool.scopeOnly && !options?.toolNames?.includes(tc.name)', 'false', 'src/__tests__/agent.loop.clarification.test.ts', 'explicit-only host tools'),
 ('explicit-host-schema', 'src/tools/tool.registry.ts', "if (this.tools.get(name)?.scopeOnly) return false;\n    // Gated tools", "if (false) return false;\n    // Gated tools", 'src/__tests__/agent.loop.clarification.test.ts', 'explicit-only host tools'),
 ('execution-scope', 'src/core/agent.tool.round.ts', "options?.toolNames && !options.toolNames.includes(tc.name)", 'false', 'src/__tests__/agent.loop.clarification.test.ts','out-of-scope'),
 ('selected-window', 'app/src/main/computer.use.ts', 'windowId !== target.window_id', 'false', 'app/src/__tests__/computer.route.test.ts','wrong selected app/window'),
 ('receipt-owner', 'app/src/main/computer/targets.ts', 'receipt.owner !== owner', 'false', 'app/src/__tests__/computer.route.test.ts','receipt cannot cross'),
 ('discovery-owner', 'app/src/main/computer/targets.ts', ' || !ownerActive()', '', 'app/src/__tests__/computer.route.test.ts','selection change during approval'),
 ('persona-scope', 'src/engine/personas/base.persona.ts', '      toolNames: options?.toolNames,\n      requireTool: options?.requireTool,', '      toolNames: undefined,\n      requireTool: options?.requireTool,', 'src/__tests__/memory.wiring.test.ts','explicit host scope'),
 ('saved-route', 'app/src/main/thread.manager.ts', 'inputs: inputs.map((input) => ({ ...input }))', 'inputs: inputs.map((input) => ({ ...input, route: undefined }))', 'app/src/__tests__/computer.route.test.ts','expired/restored CU input'),
 ('normalized-approval-authority', 'app/src/renderer/src/protocol.normalize.ts', "    ...(isRecord(raw.approvals)\n      && typeof raw.approvals.askBeforeEdits === 'boolean'\n      && typeof raw.approvals.readOnly === 'boolean'\n      && typeof raw.approvals.unattended === 'boolean' ? {\n      approvals: {\n        askBeforeEdits: raw.approvals.askBeforeEdits,\n        readOnly: raw.approvals.readOnly,\n        unattended: raw.approvals.unattended,\n      },\n    } : {}),", '', 'app/src/__tests__/computer.route.test.ts', 'real engine snapshot reduction'),
]
records=[]
for name,rel,old,new,test,pattern in faults:
 file=root/rel;original=file.read_bytes();text=original.decode()
 if text.count(old)!=(2 if name=='selected-window' else 1):raise RuntimeError(f'{name}: expected unique edit, found {text.count(old)}')
 try:
  file.write_text(text.replace(old,new))
  run=subprocess.run(['npx','jest','--runInBand','--coverage=false',test,'--testNamePattern',pattern],cwd=root,capture_output=True,text=True,timeout=90)
  log=run.stdout+run.stderr;(evidence/f'mutant-{name}.log').write_text(log)
  caught=run.returncode==1 and ('expect(' in log or 'Expected:' in log) and 'Test suite failed to run' not in log and 'exceeded timeout' not in log
  records.append({'fault':name,'exit':run.returncode,'assertionCaught':caught,'originalSha256':hashlib.sha256(original).hexdigest()})
 finally:file.write_bytes(original)
 if not caught:raise RuntimeError(f'{name} not assertion-caught: see log')
(evidence/'faults.json').write_text(json.dumps(records,indent=2)+'\n')
print(json.dumps(records))
