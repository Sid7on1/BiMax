import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractFile } from '../documents/extract';
import { ocrPages } from '../documents/ocr';

jest.mock('../documents/ocr', () => ({ ocrPages: jest.fn() }));

test('malformed TIFFs report failure without invoking an OCR backend', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-tiff-'));
  try {
    for (const bytes of [Buffer.from([0, 1, 2, 3, 0, 255]), Buffer.alloc(128)]) {
      const file = path.join(dir, 'scan.tiff');
      fs.writeFileSync(file, bytes);
      const result = await extractFile(file);
      expect(result.ok).toBe(false);
      expect(result.note).toMatch(/Unreadable TIFF/);
      expect(ocrPages).not.toHaveBeenCalled();
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test.each(['49492a00', '4d4d002a', '49492b00', '4d4d002b'])('a plausible %s TIFF header reaches OCR', async magic => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-tiff-'));
  const file = path.join(dir, 'scan.tif');
  try {
    fs.writeFileSync(file, Buffer.concat([Buffer.from(magic, 'hex'), Buffer.alloc(12)]));
    (ocrPages as jest.Mock).mockResolvedValue({ pages: [{ imagePath: file, text: 'retained text', lines: 1 }] });
    const result = await extractFile(file);
    expect(result.ok).toBe(true);
    expect(result.segments[0].text).toBe('retained text');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
