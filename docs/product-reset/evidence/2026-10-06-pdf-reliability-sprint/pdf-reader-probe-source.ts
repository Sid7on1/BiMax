import fs from 'node:fs';
import assert from 'node:assert/strict';
import { readPdf, pdfPageCount, pdfToolingAvailable } from '../../../../src/documents/pdf.raster';
(async () => {
 const file = process.argv[2];
 const before = fs.readFileSync(file);
 const result = await readPdf(file);
 assert.equal(result.totalPages, 3);
 assert.deepEqual(result.pages.map(page => page.source), ['text-layer', 'text-layer', 'text-layer']);
 assert.ok(result.pages.every(page => page.text?.includes('8.2 mm')));
 for (const reason of [null, Object.assign(new Error('Stop'), { code: 'ENOENT' })]) {
  const controller = new AbortController(); controller.abort(reason);
  assert.equal(await pdfPageCount(file, { signal: controller.signal }).catch(error => error), reason);
  assert.equal(await pdfToolingAvailable({ signal: controller.signal }).catch(error => error), reason);
 }
 assert.deepEqual(fs.readFileSync(file), before);
 console.log(JSON.stringify({ pages: 3, exactTextPages: 3, nullableAbortReasonPreserved: true, codedAbortReasonPreserved: true, inputUnmodified: true, bundledReader: true }));
})().catch(error => { console.error(error); process.exitCode = 1; });
