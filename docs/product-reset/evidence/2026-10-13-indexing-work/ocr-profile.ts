import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { buildPdf } from '../../../../src/documents/pdf.writer';
import { rasterizePages } from '../../../../src/documents/pdf.raster';
const out = path.resolve(import.meta.dir);
const dir = path.join(out, 'ocr-fixture'); fs.mkdirSync(dir, { recursive: true });
const source = path.join(dir, 'inspection.pdf');
fs.writeFileSync(source, await buildPdf({ title: 'Equipment Inspection Report', subtitle: 'Crude Distillation Unit - Vessel PV-4021-A', date: '12 August 2026', blocks: [
  { kind: 'heading', level: 2, text: 'Findings' },
  { kind: 'paragraph', text: 'Ultrasonic thickness survey recorded a minimum shell thickness of 8.2 mm against a design minimum of 9.0 mm at grid location C4.' },
  { kind: 'heading', level: 2, text: 'Recommendation' },
  { kind: 'paragraph', text: 'Replace the affected shell course within 90 days.' },
] }));
const { images } = await rasterizePages(source, { outDir: dir, dpi: 150, lastPage: 1 });
const scanned = path.join(dir, 'scanned.pdf');
execFileSync('/usr/bin/sips', ['-s', 'format', 'pdf', images[0], '--out', scanned], { stdio: 'pipe' });
const raster = await rasterizePages(scanned, { outDir: dir, dpi: 150, lastPage: 1 });
const baseline = fs.readFileSync(path.join(out, 'baseline/src/documents/native/ocr.swift'), 'utf8');
// Diagnostic source only: preserve raw per-pass observations before the existing selection.
const instrumented = baseline.replace('found.append(candidate.string)', 'found.append(candidate.string)\n            let receipt: [String: Any] = ["pass": level == .accurate ? "accurate" : "fast", "text": candidate.string, "confidence": candidate.confidence, "x": observation.boundingBox.minX, "y": observation.boundingBox.minY, "width": observation.boundingBox.width, "height": observation.boundingBox.height]\n            if let data = try? JSONSerialization.data(withJSONObject: receipt), let text = String(data: data, encoding: .utf8) { FileHandle.standardError.write((text + "\\n").data(using: .utf8)!) }');
fs.writeFileSync(path.join(out, 'ocr-profile.swift'), instrumented);
console.log(JSON.stringify({ image: raster.images[0], fixture: scanned }));
