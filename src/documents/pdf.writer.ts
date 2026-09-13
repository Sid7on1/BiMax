import { PDFDocument } from './pdfkit.runtime';
import { Block, CHART, ChartBlock, COLOR, DocumentSpec, PAGE, SPACE, TYPE, resolveDate } from './design';
import { fitBox, loadImage } from './images';

/**
 * PDF is the one format with no layout engine underneath it — pdfkit draws where you tell it to,
 * so every rule the other writers get from Word or PowerPoint has to be enforced here by hand:
 * the measure, the baseline rhythm, keeping a heading with the paragraph it introduces, and never
 * orphaning a table header at the foot of a page.
 */

const ink = (c: string): string => `#${c}`;

interface Ctx {
  doc: PDFKit.PDFDocument;
  width: number;
}

/** Would this block fit in what's left of the page? If not, break first. */
function ensure(ctx: Ctx, needed: number): void {
  const bottom = ctx.doc.page.height - PAGE.marginBottom;
  if (ctx.doc.y + needed > bottom) ctx.doc.addPage();
}


const CHART_H = 210;

/** Round an axis top up to 1/2/2.5/5 × a power of ten, so ticks land on readable numbers. */
function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}

const tickText = (v: number): string =>
  Math.abs(v) >= 1000 ? v.toLocaleString('en-US') : String(Number(v.toFixed(2)));

/**
 * Charts are drawn, not rasterised: vector output stays sharp at any zoom and print size, and it
 * costs no charting dependency in a binary whose start-up is already dominated by bundle parse.
 */
function chart(ctx: Ctx, block: ChartBlock): void {
  const capH = block.caption ? TYPE.small + SPACE.tight : 0;
  const legendH = (block.chart === 'pie' || block.series.length > 1) ? 16 : 0;
  ensure(ctx, CHART_H + capH + legendH + SPACE.block);
  const { doc } = ctx;
  const left = doc.page.margins.left;
  const top = doc.y + SPACE.tight;

  if (block.chart === 'pie') {
    const values = block.series[0].values.map(v => Math.max(0, v));
    const total = values.reduce((a, b) => a + b, 0);
    const r = Math.min(CHART_H, ctx.width) / 2 - 8;
    const cx = left + ctx.width / 2, cy = top + CHART_H / 2;
    if (total > 0) {
      let a0 = -Math.PI / 2;
      values.forEach((v, i) => {
        const a1 = a0 + (v / total) * Math.PI * 2;
        const large = a1 - a0 > Math.PI ? 1 : 0;
        // A full-circle single slice cannot be drawn as an arc (start === end), so use a circle.
        if (values.filter(x => x > 0).length === 1) doc.circle(cx, cy, r);
        else {
          doc.path(`M ${cx} ${cy} L ${cx + r * Math.cos(a0)} ${cy + r * Math.sin(a0)} `
            + `A ${r} ${r} 0 ${large} 1 ${cx + r * Math.cos(a1)} ${cy + r * Math.sin(a1)} Z`);
        }
        doc.fillColor(ink(CHART[i % CHART.length])).fill();
        a0 = a1;
      });
    }
  } else {
    const flat = block.series.flatMap(x => x.values);
    const rawMax = Math.max(0, ...flat), rawMin = Math.min(0, ...flat);
    const maxV = niceMax(rawMax), minV = rawMin < 0 ? -niceMax(-rawMin) : 0;
    const padL = 44, padB = 22;
    const plotW = ctx.width - padL, plotH = CHART_H - padB;
    const x0 = left + padL, y0 = top;
    const yOf = (v: number): number => y0 + plotH - ((v - minV) / (maxV - minV || 1)) * plotH;

    // Horizontal gridlines with value labels; the zero line is drawn stronger than the rest.
    doc.lineWidth(0.5).font('Helvetica').fontSize(TYPE.micro);
    for (let t = 0; t <= 4; t++) {
      const v = minV + ((maxV - minV) * t) / 4;
      const y = yOf(v);
      doc.moveTo(x0, y).lineTo(x0 + plotW, y).strokeColor(ink(COLOR.rule)).stroke();
      doc.fillColor(ink(COLOR.muted)).text(tickText(v), left, y - TYPE.micro / 2 - 1, { width: padL - 6, align: 'right' });
    }
    const zeroY = yOf(0);
    doc.lineWidth(0.8).moveTo(x0, zeroY).lineTo(x0 + plotW, zeroY).strokeColor(ink(COLOR.faint)).stroke();

    const slot = plotW / block.labels.length;
    if (block.chart === 'bar') {
      const per = block.series.length;
      const bw = Math.max(2, (slot * 0.7) / per);
      block.series.forEach((ser, si) => {
        doc.fillColor(ink(CHART[si % CHART.length]));
        ser.values.forEach((v, i) => {
          const bx = x0 + slot * i + slot * 0.15 + si * bw;
          const by = Math.min(yOf(v), zeroY);
          doc.rect(bx, by, bw, Math.abs(yOf(v) - zeroY)).fill();
        });
      });
    } else {
      block.series.forEach((ser, si) => {
        doc.lineWidth(1.6).strokeColor(ink(CHART[si % CHART.length]));
        ser.values.forEach((v, i) => {
          const px = x0 + slot * i + slot / 2, py = yOf(v);
          if (i === 0) doc.moveTo(px, py); else doc.lineTo(px, py);
        });
        doc.stroke();
      });
    }

    // Category labels, one per slot, clipped to the slot so long names cannot overlap.
    doc.font('Helvetica').fontSize(TYPE.micro).fillColor(ink(COLOR.muted));
    block.labels.forEach((lab, i) => {
      doc.text(lab, x0 + slot * i, y0 + plotH + 5, { width: slot, align: 'center', ellipsis: true, lineBreak: false });
    });
  }

  doc.y = top + CHART_H;
  if (legendH) {
    const names = block.chart === 'pie' ? block.labels : block.series.map(x => x.name);
    let lx = left;
    doc.font('Helvetica').fontSize(TYPE.micro);
    names.forEach((name, i) => {
      doc.rect(lx, doc.y + 4, 7, 7).fillColor(ink(CHART[i % CHART.length])).fill();
      doc.fillColor(ink(COLOR.muted)).text(name, lx + 11, doc.y + 3, { width: 110, lineBreak: false, ellipsis: true });
      lx += 11 + Math.min(110, doc.widthOfString(name)) + 14;
    });
    doc.y += legendH;
  }
  if (block.caption) {
    doc.font('Helvetica-Oblique').fontSize(TYPE.small).fillColor(ink(COLOR.muted))
      .text(block.caption, left, doc.y + 2, { width: ctx.width, align: 'center' });
  }
  doc.x = left;
  doc.moveDown(0.8);
}

function heading(ctx: Ctx, level: 1 | 2 | 3, text: string): void {
  const size = level === 1 ? TYPE.h1 : level === 2 ? TYPE.h2 : TYPE.h3;
  // Keep-with-next: reserve room for the heading AND two lines under it, so a heading never ends
  // a page with its section starting on the next one.
  ensure(ctx, size + SPACE.section + TYPE.body * 2.6);
  ctx.doc.moveDown(level === 1 ? 1.1 : 0.85);
  ctx.doc
    .font('Helvetica-Bold').fontSize(size)
    .fillColor(ink(level === 1 ? COLOR.ink : COLOR.accent))
    .text(text, { width: ctx.width });
  ctx.doc.moveDown(0.35);
}

function body(ctx: Ctx, text: string): void {
  ensure(ctx, TYPE.body * 3);
  ctx.doc.font('Times-Roman').fontSize(TYPE.body).fillColor(ink(COLOR.body))
    .text(text, { width: ctx.width, align: 'left', lineGap: 3 });
  ctx.doc.moveDown(0.55);
}

function list(ctx: Ctx, items: string[], ordered: boolean): void {
  ctx.doc.font('Times-Roman').fontSize(TYPE.body).fillColor(ink(COLOR.body));
  items.forEach((item, i) => {
    ensure(ctx, TYPE.body * 2.4);
    const marker = ordered ? `${i + 1}.` : '•';
    const left = ctx.doc.x;
    ctx.doc.text(marker, left, ctx.doc.y, { width: 18, continued: false });
    ctx.doc.moveUp();
    ctx.doc.text(item, left + 18, ctx.doc.y, { width: ctx.width - 18, lineGap: 2 });
    ctx.doc.x = left;
    ctx.doc.moveDown(0.25);
  });
  ctx.doc.moveDown(0.4);
}

function table(ctx: Ctx, columns: string[], rows: string[][], caption?: string): void {
  const colWidth = ctx.width / columns.length;
  const rowHeight = 20;

  // Capture the left edge ONCE. `doc.text(str, x, y)` sets doc.x as a side effect, so reading
  // doc.x inside the loop made every header cell start from the previous cell's end and walked the
  // last columns off the page.
  const startX = ctx.doc.x;

  const header = (): void => {
    const y = ctx.doc.y;
    ctx.doc.rect(startX, y, ctx.width, rowHeight).fill(ink(COLOR.accentWash));
    ctx.doc.font('Helvetica-Bold').fontSize(TYPE.micro).fillColor(ink(COLOR.accent));
    columns.forEach((c, i) => ctx.doc.text(c, startX + i * colWidth + 6, y + 6, { width: colWidth - 12, ellipsis: true, lineBreak: false }));
    ctx.doc.x = startX;
    ctx.doc.y = y + rowHeight;
  };

  // A header stranded at the foot of a page is worse than a page break: require the header plus
  // two rows, and repeat the header after any break.
  ensure(ctx, rowHeight * 3);
  header();

  ctx.doc.font('Helvetica').fontSize(TYPE.micro).fillColor(ink(COLOR.body));
  for (const row of rows) {
    if (ctx.doc.y + rowHeight > ctx.doc.page.height - PAGE.marginBottom) {
      ctx.doc.addPage();
      ctx.doc.x = startX;
      header();
      ctx.doc.font('Helvetica').fontSize(TYPE.micro).fillColor(ink(COLOR.body));
    }
    const y = ctx.doc.y;
    row.forEach((cell, i) => ctx.doc.text(String(cell), startX + i * colWidth + 6, y + 6, { width: colWidth - 12, ellipsis: true, lineBreak: false }));
    ctx.doc.x = startX;
    ctx.doc.y = y + rowHeight;
    ctx.doc.moveTo(startX, ctx.doc.y).lineTo(startX + ctx.width, ctx.doc.y)
      .strokeColor(ink(COLOR.rule)).lineWidth(0.5).stroke();
  }

  ctx.doc.x = startX;
  ctx.doc.moveDown(0.5);
  if (caption) {
    ctx.doc.font('Helvetica-Oblique').fontSize(TYPE.micro).fillColor(ink(COLOR.muted))
      .text(caption, { width: ctx.width });
    ctx.doc.moveDown(0.5);
  }
}

function renderBlock(ctx: Ctx, block: Block, baseDir: string): void {
  switch (block.kind) {
    case 'heading': return heading(ctx, block.level, block.text);
    case 'paragraph': return body(ctx, block.text);
    case 'bullets': return list(ctx, block.items, false);
    case 'numbered': return list(ctx, block.items, true);
    case 'keyvalue': {
      ctx.doc.fontSize(TYPE.small);
      for (const pair of block.pairs) {
        ensure(ctx, TYPE.small * 2.2);
        const left = ctx.doc.x;
        ctx.doc.font('Helvetica-Bold').fillColor(ink(COLOR.muted)).text(`${pair.label}`, left, ctx.doc.y, { width: 140, continued: false });
        ctx.doc.moveUp();
        ctx.doc.font('Helvetica').fillColor(ink(COLOR.body)).text(pair.value, left + 148, ctx.doc.y, { width: ctx.width - 148 });
        ctx.doc.x = left;
        ctx.doc.moveDown(0.2);
      }
      ctx.doc.moveDown(0.5);
      return;
    }
    case 'quote': {
      ensure(ctx, TYPE.body * 4);
      const left = ctx.doc.x;
      const top = ctx.doc.y;
      ctx.doc.font('Times-Italic').fontSize(TYPE.body).fillColor(ink(COLOR.ink))
        .text(block.text, left + 16, top, { width: ctx.width - 16, lineGap: 3 });
      if (block.attribution) {
        ctx.doc.font('Helvetica').fontSize(TYPE.micro).fillColor(ink(COLOR.muted))
          .text(`— ${block.attribution}`, left + 16, ctx.doc.y + 2, { width: ctx.width - 16 });
      }
      ctx.doc.rect(left, top, 2, ctx.doc.y - top).fill(ink(COLOR.accent));
      ctx.doc.x = left;
      ctx.doc.moveDown(0.8);
      return;
    }
    case 'code': {
      const lines = block.text.split('\n');
      const height = lines.length * (TYPE.micro + 3) + 12;
      ensure(ctx, height);
      const left = ctx.doc.x;
      const top = ctx.doc.y;
      ctx.doc.rect(left, top, ctx.width, height).fill(ink(COLOR.wash));
      ctx.doc.font('Courier').fontSize(TYPE.micro).fillColor(ink(COLOR.ink));
      lines.forEach((line, i) => ctx.doc.text(line, left + 8, top + 6 + i * (TYPE.micro + 3), { width: ctx.width - 16, ellipsis: true }));
      ctx.doc.y = top + height;
      ctx.doc.x = left;
      ctx.doc.moveDown(0.6);
      return;
    }
    case 'table': return table(ctx, block.columns, block.rows, block.caption);
    case 'image': {
      const img = loadImage(block.path, baseDir);
      const maxH = ctx.doc.page.height - PAGE.marginTop - PAGE.marginBottom;
      const box = fitBox(img.width, img.height, ctx.width * (block.width ?? 1), maxH);
      const capH = block.caption ? TYPE.small + SPACE.tight : 0;
      ensure(ctx, box.h + capH + SPACE.block);
      const left = ctx.doc.page.margins.left;
      ctx.doc.image(img.data, left + (ctx.width - box.w) / 2, ctx.doc.y, { width: box.w, height: box.h });
      ctx.doc.y += box.h;
      if (block.caption) {
        ctx.doc.font('Helvetica-Oblique').fontSize(TYPE.small).fillColor(ink(COLOR.muted))
          .text(block.caption, left, ctx.doc.y + SPACE.tight, { width: ctx.width, align: 'center' });
      }
      ctx.doc.x = left;
      ctx.doc.moveDown(0.8);
      return;
    }
    case 'chart': return chart(ctx, block);
    case 'divider': {
      ensure(ctx, 18);
      ctx.doc.moveDown(0.4);
      ctx.doc.moveTo(ctx.doc.x, ctx.doc.y).lineTo(ctx.doc.x + ctx.width, ctx.doc.y)
        .strokeColor(ink(COLOR.rule)).lineWidth(0.5).stroke();
      ctx.doc.moveDown(0.8);
      return;
    }
    case 'pagebreak': { ctx.doc.addPage(); return; }
    default: return;
  }
}

export function buildPdf(spec: DocumentSpec, baseDir: string = process.cwd()): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: PAGE.marginTop, bottom: PAGE.marginBottom, left: PAGE.marginLeft, right: PAGE.marginRight },
      info: { Title: spec.title, Author: spec.author || 'Bimax' },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const width = doc.page.width - PAGE.marginLeft - PAGE.marginRight;
    const ctx: Ctx = { doc, width };

    doc.font('Helvetica-Bold').fontSize(TYPE.title).fillColor(ink(COLOR.ink)).text(spec.title, { width });
    if (spec.subtitle) {
      doc.moveDown(0.2);
      doc.font('Helvetica').fontSize(TYPE.h3).fillColor(ink(COLOR.muted)).text(spec.subtitle, { width });
    }
    doc.moveDown(0.35);
    doc.font('Helvetica').fontSize(TYPE.small).fillColor(ink(COLOR.muted))
      .text([spec.author, resolveDate(spec)].filter(Boolean).join('  ·  '), { width });
    doc.moveDown(0.3);
    doc.moveTo(PAGE.marginLeft, doc.y).lineTo(PAGE.marginLeft + width, doc.y)
      .strokeColor(ink(COLOR.accent)).lineWidth(1).stroke();
    doc.moveDown(1);

    for (const block of spec.blocks ?? []) renderBlock(ctx, block, baseDir);

    // Page numbers last, over the finished page set, so the count is real.
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.font('Helvetica').fontSize(TYPE.micro).fillColor(ink(COLOR.faint))
        .text(`${i - range.start + 1}`, PAGE.marginLeft, doc.page.height - PAGE.marginBottom + 24, {
          width, align: 'center', lineBreak: false,
        });
    }

    doc.end();
  });
}
