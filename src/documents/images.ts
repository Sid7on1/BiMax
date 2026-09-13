import * as fs from 'fs';
import * as path from 'path';

/**
 * Loading an image for a document is a trust boundary, so this does four things the callers
 * must not skip: it keeps the path inside the project, it identifies the format from the BYTES
 * rather than the extension (a `.png` that is really a JPEG makes Word write a file that opens
 * to a broken-image box), it caps the size, and it reads the real pixel dimensions so a writer
 * can preserve the aspect ratio instead of stretching the picture to whatever box it has.
 */

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export interface LoadedImage {
  data: Buffer;
  /** Sniffed from the file's magic bytes, never from its name. */
  type: 'png' | 'jpeg';
  width: number;
  height: number;
  /** Project-relative, for messages. */
  rel: string;
}

/** PNG: IHDR is fixed-offset. JPEG: walk the segment chain to the first SOF frame header. */
function dimensions(buf: Buffer): { type: 'png' | 'jpeg'; width: number; height: number } | null {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue; }         // resync past padding bytes
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const length = buf.readUInt16BE(i + 2);
      // SOF0..SOF15 carry the frame size; C4/C8/CC are tables and are not frame headers.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: 'jpeg', width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      if (length < 2) return null;                        // malformed: refuse rather than loop
      i += 2 + length;
    }
  }
  return null;
}

export function loadImage(spec: string, baseDir: string): LoadedImage {
  if (!spec || typeof spec !== 'string') throw new Error('image.path is required');
  const full = path.resolve(baseDir, spec);
  const rel = path.relative(baseDir, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`image "${spec}" is outside the project`);
  }
  let stat: fs.Stats;
  try { stat = fs.statSync(full); } catch { throw new Error(`image "${spec}" does not exist`); }
  if (!stat.isFile()) throw new Error(`image "${spec}" is not a file`);
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new Error(`image "${spec}" is ${(stat.size / 1048576).toFixed(1)}MB; the limit is ${MAX_IMAGE_BYTES / 1048576}MB`);
  }
  const data = fs.readFileSync(full);
  const dim = dimensions(data);
  if (!dim) throw new Error(`image "${spec}" is not a PNG or JPEG (checked its bytes, not its name)`);
  if (!dim.width || !dim.height) throw new Error(`image "${spec}" reports a zero dimension`);
  return { data, type: dim.type, width: dim.width, height: dim.height, rel };
}

/** Fit `(w,h)` inside a box, never enlarging past the box's width. Returns points/inches in. */
export function fitBox(w: number, h: number, maxW: number, maxH: number): { w: number; h: number } {
  const scale = Math.min(maxW / w, maxH / h, Number.MAX_SAFE_INTEGER);
  return { w: w * scale, h: h * scale };
}
