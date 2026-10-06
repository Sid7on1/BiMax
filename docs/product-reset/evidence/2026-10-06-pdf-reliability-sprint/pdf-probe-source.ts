import fs from 'node:fs';
import assert from 'node:assert/strict';
import { buildPdf } from '/Users/vishsiddharth/Bimax/src/documents/pdf.writer';
import { readPdf, extractTextLayer, pdfPageCount } from '/Users/vishsiddharth/Bimax/src/documents/pdf.raster';
(async () => {
 const file=process.argv[2];
 const body='Ultrasonic inspection confirms a minimum shell thickness of 8.2 mm at grid location C4. The measurements on this page must remain exact text without OCR.';
 fs.writeFileSync(file, await buildPdf({title:'Bimax PDF reliability inspection',author:'Bimax local qualification',date:'2026-10-06',blocks:[
 {kind:'heading',level:1,text:'Course one: inspection summary'}, {kind:'paragraph',text:body},
 {kind:'table',columns:['Location','Thickness','Disposition'],rows:[['C4','8.2 mm','Review against design minimum'],['C5','8.6 mm','Retain for comparison']]},
 {kind:'pagebreak'}, {kind:'heading',level:1,text:'Course two: verification'}, {kind:'paragraph',text:body},
 {kind:'bullets',items:['Embedded text preserves the measured value.','No footer-only page should reach OCR.','Every finished page carries its own number.']},
 {kind:'pagebreak'}, {kind:'heading',level:1,text:'Course three: follow-up'}, {kind:'paragraph',text:body},
 {kind:'paragraph',text:'This disposable report verifies the bundled PDF writer and real Poppler reader. It is a local fixture, not a real inspection or an engineering recommendation.'}
 ]}));
 assert.equal(await pdfPageCount(file),3);
 const layers=await extractTextLayer(file); assert.equal(layers.length,3);
 layers.forEach((text,i)=>{assert.match(text,new RegExp('(?:^|\\n)\\s*'+(i+1)+'\\s*$'));assert.ok(text.includes('8.2 mm'));});
 const result=await readPdf(file); assert.deepEqual(result.pages.map(p=>p.source),['text-layer','text-layer','text-layer']); assert.equal(result.outDir,undefined);
 console.log(JSON.stringify({pages:result.totalPages,sources:result.pages.map(p=>p.source),sequentialFooters:true,exactMeasurementOnEveryPage:true,bundledProbe:true}));
})().catch(error=>{console.error(error);process.exitCode=1;});
