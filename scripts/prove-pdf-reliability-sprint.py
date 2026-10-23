#!/usr/bin/env python3
"""Executable PDF faults must fail assertions; restore exact source after every trial."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / 'docs/product-reset/evidence/2026-10-06-pdf-reliability-sprint'
RASTER = 'src/documents/pdf.raster.ts'
WRITER = 'src/documents/pdf.writer.ts'
EXTRACT = 'src/documents/extract.ts'
TOOL = 'src/tools/implementations/readdoc.tool.ts'
TEST = 'src/__tests__/pdf.raster.sprint.test.ts'
WRITER_TEST = 'src/__tests__/pdf.writer.sprint.test.ts'
CLEANUP_TEST = 'src/__tests__/pdf.cleanup.sprint.test.ts'
TESTS = [TEST, WRITER_TEST, CLEANUP_TEST, 'src/__tests__/extract.layout.routing.test.ts', 'src/__tests__/extract.layout.ocr.test.ts']
# Optional occurrence chooses one of identical caller cleanup sites; every anchor is checked.
MUTANTS = [
 ('buffer-all-pages', WRITER, 'bufferPages: true', 'bufferPages: false', WRITER_TEST, 'numbers every finished'),
 ('footer-auto-flow', WRITER, '{ lineBreak: false });', '{ width, lineBreak: false });', WRITER_TEST, 'keeps a short digital'),
 ('sequential-page-number', WRITER, 'String(i - range.start + 1)', "String(1)", WRITER_TEST, 'numbers every finished'),
 ('final-text-page', RASTER, "if (stdout.endsWith('\\f')) pages.pop();", 'pages.pop();', TEST, 'preserves the final text'),
 ('empty-page-count', RASTER, "if (!count) throw new Error('PDF page count is unavailable: the reader produced no pages.');", 'if (!count) return 1;', TEST, 'does not invent page'),
 ('real-read-failure', RASTER, "if ((error as { code?: string } | null)?.code === 'ENOENT') throw new PdfToolingMissing('pdftotext');", "throw new PdfToolingMissing('pdftotext');", TEST, 'retains malformed', 0),
 ('permission-not-ready', RASTER, "if (code === 'ENOENT') return false;", "if (code === 'ENOENT') return false; if (code === 'EACCES') return true;", TEST, 'refuses inaccessible'),
 ('deadline', RASTER, ')), deadline);', ')), deadline + 2000);', TEST, 'enforces a requested short deadline'),
 ('kill-before-settlement', RASTER, "process.kill(-child.pid, 'SIGKILL')", 'process.kill(-child.pid, 0)', TEST, 'inherited worker process group'),
 ('inherited-worker-kill', RASTER, "process.kill(-child.pid, 'SIGKILL')", "child.kill('SIGKILL')", TEST, 'inherited worker process group'),
 ('abort-listener', RASTER, "options.signal?.addEventListener('abort', abort, { once: true });", '// abort listener removed', TEST, 'inherited worker process group'),
 ('range-validation', RASTER, "if (page !== undefined && (!Number.isSafeInteger(page) || page < 1))", 'if (false)', TEST, 'validates page ranges'),
 ('owned-render-directory', RASTER, "fs.mkdtempSync(path.join(parent, 'bimax-pdf-'))", 'parent', TEST, 'cannot reuse stale images'),
 ('complete-render-coverage', RASTER, 'if (needRaster.some(page => !imageFor.has(page)))', 'if (false)', TEST, 'refuses incomplete rendered'),
 ('render-only-needed-envelope', RASTER, 'firstPage: needRaster[0], lastPage: needRaster[needRaster.length - 1]', 'firstPage: first, lastPage: last', TEST, 'rasterizes only the envelope'),
 ('utf8-chunk-preservation', RASTER, 'chunks.push(chunk);', "chunks.push(Buffer.from(chunk.toString('utf8')));", TEST, 'split UTF-8'),
 ('aggregate-output-cap', RASTER, 'bytes > (options.maxBuffer ?? 1 << 26)', 'bytes > (1 << 30)', TEST, 'bounds combined captured'),
 ('deadline-no-fallback', RASTER, "if (code !== 'ENOENT' && typeof code !== 'number') throw error;", "if (code !== 'ENOENT' && code !== 'ETIMEDOUT' && typeof code !== 'number') throw error;", TEST, 'does not start a fallback'),
 ('duplicate-image-identity', RASTER, ' || imageFor.has(page)', '', TEST, 'rejects duplicate page'),
 ('regular-render-images', RASTER, 'return !stat.isFile() || stat.size === 0;', 'return stat.size === 0;', TEST, 'rejects linked images'),
 ('failed-render-cleanup', RASTER, '    await dispose();\n    if (options.signal?.aborted) throw error;\n    if ((error as { code?: string } | null)?.code', '    // cleanup omitted\n    if (options.signal?.aborted) throw error;\n    if ((error as { code?: string } | null)?.code', TEST, 'partially rendered job'),
 ('layout-ocr-cleanup', EXTRACT, 'finally { await result.dispose?.(); }', 'finally { /* cleanup omitted */ }', CLEANUP_TEST, 'layout merge', 0),
 ('fallback-ocr-cleanup', EXTRACT, 'finally { await result.dispose?.(); }', 'finally { /* cleanup omitted */ }', CLEANUP_TEST, 'fallback extraction', 1),
 ('tool-ocr-cleanup', TOOL, 'finally { await result.dispose?.(); }', 'finally { /* cleanup omitted */ }', CLEANUP_TEST, 'keeps tool images'),
 ('abort-before-io-classification', RASTER, 'if (options.signal?.aborted) throw error;', '// abort precedence omitted', TEST, 'preserves pre-abort', 0),
 ('stop-during-ocr', TOOL, '          context?.signal?.throwIfAborted();', '          // Stop check omitted', CLEANUP_TEST, 'Stop received during OCR'),
]

def run(label, test=None, pattern=None):
 command = [str(ROOT / 'node_modules/.bin/jest'), '--coverage=false', '--runInBand'] + ([test] if test else TESTS)
 if pattern: command += ['--testNamePattern', pattern]
 result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=60)
 output = result.stdout + result.stderr
 (EVIDENCE / f'mutation-{label}.log').write_text(output)
 return result.returncode, output

if run('baseline-before')[0]: sys.exit('Pre-mutation baseline failed')
only = sys.argv[2] if len(sys.argv) == 3 and sys.argv[1] == '--only' else None
selected = [entry for entry in MUTANTS if only is None or entry[0] == only]
if not selected: sys.exit('No matching mutation')
receipts = json.loads((EVIDENCE/'mutations.json').read_text()) if only else []
if only:
 receipts = [r for r in receipts if r['name'] != only]
 if not all(r['killed'] and r['restored'] and hashlib.sha256((ROOT/r['source']).read_bytes()).hexdigest() == r['sha256'] for r in receipts): sys.exit('Prior receipts do not match final source')
for entry in selected:
 label, source, old, new, test, pattern, *occurrence = entry
 file = ROOT / source; original = file.read_bytes(); digest=hashlib.sha256(original).hexdigest()
 text=original.decode(); count=text.count(old); index=occurrence[0] if occurrence else 0
 if (not occurrence and count != 1) or count <= index: sys.exit(f'Anchor mismatch: {label} count={count}')
 offset=[m.start() for m in re.finditer(re.escape(old),text)][index]
 try:
  file.write_text(text[:offset]+new+text[offset+len(old):])
  code, output=run(label,test,pattern)
  assertion_failure=bool(re.search(r'expect\([^\n]*\)\.',output))
  invalid='Test suite failed to run' in output or 'Exceeded timeout' in output
  killed=code != 0 and assertion_failure and not invalid
 finally:
  file.write_bytes(original); restored=hashlib.sha256(file.read_bytes()).hexdigest()==digest
 receipts.append(dict(name=label,source=source,exit=code,assertion_failure=assertion_failure,invalid=invalid,killed=killed,restored=restored,sha256=digest))
 (EVIDENCE/'mutations.json').write_text(json.dumps(receipts,indent=2)+'\n')
 print(f'{label}: {"caught" if killed else "INVALID/SURVIVED"}, restored={restored}',flush=True)
 if not restored or not killed: sys.exit(1)
if run('baseline-after')[0]: sys.exit('Restored baseline failed')
print(f'All {len(receipts)} mutants caught; exact restoration; passing before/after baselines.')
