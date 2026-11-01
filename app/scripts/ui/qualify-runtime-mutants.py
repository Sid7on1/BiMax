#!/usr/bin/env python3
import pathlib,subprocess,json,hashlib
root=pathlib.Path(__file__).resolve().parents[3];evidence=root/'docs/product-reset/evidence/2026-10-19-rich-outputs/mutations';report=[]
compile_module="require('./app/node_modules/esbuild').buildSync({entryPoints:['app/src/main/outputs.preview.ts'],bundle:true,platform:'node',format:'cjs',external:['electron','esbuild'],outfile:'app/out/main/runtime-probe.module.cjs'})"
compile_host="require('./app/node_modules/esbuild').buildSync({entryPoints:['app/src/preview/mcp.host.ts'],bundle:true,platform:'browser',format:'iife',minify:true,outfile:'app/out/preview/mcp.host.js'})"
for name,file,replace,compile in [
 ('guest-all-authority','app/src/main/outputs.preview.ts',lambda s:s.replace('sandbox: true,','sandbox: false,').replace('nodeIntegration: false,','nodeIntegration: true,').replace('contextIsolation: true,','contextIsolation: false,'),compile_module),
 ('mcp-frame-origin','app/src/preview/mcp.host.ts',lambda s:s.replace("'allow-scripts'","'allow-scripts allow-same-origin'"),compile_host),
]:
 target=root/file;original=target.read_bytes();changed=replace(original.decode());assert changed!=original.decode()
 try:
  target.write_text(changed);subprocess.run(['node','-e',compile],cwd=root,check=True,capture_output=True)
  p=subprocess.run(['app/node_modules/.bin/electron','app/scripts/ui/output-runtime.cjs'],cwd=root,capture_output=True,timeout=60)
  output=p.stdout.decode(errors='replace')+p.stderr.decode(errors='replace');(evidence/(name+'.log')).write_text(output)
  caught=p.returncode!=0 and 'AssertionError' in output
  report.append(dict(name=name,caught=caught,exitCode=p.returncode,source=file,sha256=hashlib.sha256(original).hexdigest()))
 finally:
  target.write_bytes(original);subprocess.run(['node','-e',compile],cwd=root,check=True,capture_output=True)
 (evidence/'runtime-results.json').write_text(json.dumps(report,indent=2));print(name,caught,flush=True)
assert all(r['caught'] for r in report)
