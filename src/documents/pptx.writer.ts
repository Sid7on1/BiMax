import PptxGenJS from 'pptxgenjs';
import { CHART, COLOR, DocumentSpec, FONT, Slide, TYPE, resolveDate } from './design';
import { fitBox, loadImage } from './images';

/**
 * Slides, not documents with a projector aimed at them.
 *
 * Three rules do most of the work here. A slide carries ONE claim, so the title is the claim and
 * the bullets are its support — not a heading with the content underneath. Text is never shrunk to
 * fit: if it does not fit, the slide is trying to be two slides, and silently reflowing to 9pt is
 * how decks become unreadable. And the layout is a fixed grid — same title baseline, same left
 * edge, same footer on every slide — so the deck does not appear to shuffle as it advances.
 */

// 16:9 inches.
const W = 13.333;
const H = 7.5;
const M = 0.72;

const hex = (c: string): string => c;

function footer(slide: PptxGenJS.Slide, spec: DocumentSpec, index: number): void {
  slide.addText(spec.title, {
    x: M, y: H - 0.52, w: W - M * 2 - 0.6, h: 0.3,
    fontSize: 9, color: hex(COLOR.faint), fontFace: FONT.sans, align: 'left',
  });
  slide.addText(String(index), {
    x: W - M - 0.6, y: H - 0.52, w: 0.6, h: 0.3,
    fontSize: 9, color: hex(COLOR.faint), fontFace: FONT.sans, align: 'right',
  });
}

function contentSlide(pptx: PptxGenJS, spec: DocumentSpec, s: Slide, index: number, baseDir: string): void {
  const slide = pptx.addSlide();
  slide.background = { color: 'FFFFFF' };

  slide.addText(s.title, {
    x: M, y: 0.62, w: W - M * 2, h: 0.9,
    fontSize: 26, bold: true, color: hex(COLOR.ink), fontFace: FONT.sans,
    valign: 'top', wrap: true, shrinkText: false,
  });
  // A short accent rule under the title anchors every slide to the same baseline.
  slide.addShape(pptx.ShapeType.rect, {
    x: M, y: 1.58, w: 1.1, h: 0.045, fill: { color: hex(COLOR.accent) }, line: { width: 0 },
  });

  const top = 2.0;
  const bodyHeight = H - top - 0.8;

  if (s.statement) {
    slide.addText(s.statement, {
      x: M, y: top, w: W - M * 2, h: bodyHeight,
      fontSize: 40, bold: true, color: hex(COLOR.accent), fontFace: FONT.sans,
      valign: 'middle', align: 'left',
    });
  } else if (s.table) {
    const head = s.table.columns.map(c => ({
      text: c,
      options: { bold: true, color: hex(COLOR.accent), fill: { color: hex(COLOR.accentWash) }, fontSize: 13 },
    }));
    const rows = s.table.rows.map(r => r.map(cell => ({
      text: String(cell), options: { color: hex(COLOR.body), fontSize: 13 },
    })));
    slide.addTable([head, ...rows], {
      x: M, y: top, w: W - M * 2,
      fontFace: FONT.sans,
      border: [
        { type: 'none' }, { type: 'none' },
        { type: 'solid', color: hex(COLOR.rule), pt: 0.5 }, { type: 'none' },
      ] as PptxGenJS.TableProps['border'],
      rowH: 0.38,
      valign: 'middle',
    });
  } else if (s.image) {
    // Centred in the body box at its true aspect ratio. A slide-filling stretch is how a
    // screenshot ends up unreadable, so the picture is fitted, never cropped or distorted.
    const img = loadImage(s.image.path, baseDir);
    const capH = s.image.caption ? 0.32 : 0;
    const box = fitBox(img.width, img.height, W - M * 2, bodyHeight - capH);
    slide.addImage({
      data: `image/${img.type};base64,${img.data.toString('base64')}`,
      x: M + (W - M * 2 - box.w) / 2, y: top, w: box.w, h: box.h,
    });
    if (s.image.caption) {
      slide.addText(s.image.caption, {
        x: M, y: top + box.h + 0.06, w: W - M * 2, h: capH,
        fontSize: 11, color: hex(COLOR.muted), fontFace: FONT.sans, align: 'center',
      });
    }
  } else if (s.chart) {
    const c = s.chart;
    const type = c.chart === 'line' ? pptx.ChartType.line : c.chart === 'pie' ? pptx.ChartType.pie : pptx.ChartType.bar;
    // A real chart part, not a picture of one: the reader can click it and see the numbers.
    const data = c.chart === 'pie'
      ? [{ name: c.series[0].name, labels: c.labels, values: c.series[0].values }]
      : c.series.map(ser => ({ name: ser.name, labels: c.labels, values: ser.values }));
    const capH = c.caption ? 0.32 : 0;
    slide.addChart(type, data, {
      x: M, y: top, w: W - M * 2, h: bodyHeight - capH,
      chartColors: [...CHART],
      showLegend: c.chart === 'pie' || c.series.length > 1,
      legendPos: 'b', legendFontFace: FONT.sans, legendFontSize: 11,
      catAxisLabelFontFace: FONT.sans, catAxisLabelFontSize: 11, catAxisLabelColor: hex(COLOR.muted),
      valAxisLabelFontFace: FONT.sans, valAxisLabelFontSize: 11, valAxisLabelColor: hex(COLOR.muted),
      dataLabelFontFace: FONT.sans, dataLabelFontSize: 10,
      showValue: c.chart === 'pie',
      showPercent: false,
    });
    if (c.caption) {
      slide.addText(c.caption, {
        x: M, y: H - 1.05, w: W - M * 2, h: capH,
        fontSize: 11, color: hex(COLOR.muted), fontFace: FONT.sans, align: 'center',
      });
    }
  } else if (s.bullets?.length) {
    slide.addText(
      s.bullets.map(b => ({ text: b, options: { bullet: { characterCode: '2022' }, breakLine: true } })),
      {
        x: M, y: top, w: W - M * 2, h: bodyHeight,
        // One size. Nothing here scales with bullet count on purpose: an overfull slide should
        // look overfull so it gets split, not silently shrink until it is unreadable.
        fontSize: 18, color: hex(COLOR.body), fontFace: FONT.sans,
        lineSpacingMultiple: 1.35, valign: 'top',
      },
    );
  }

  if (s.notes) slide.addNotes(s.notes);
  footer(slide, spec, index);
}

export async function buildPptx(spec: DocumentSpec, baseDir: string = process.cwd()): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  pptx.author = spec.author || 'Bimax';
  pptx.title = spec.title;

  // Title slide: the deck's one full-bleed moment.
  const cover = pptx.addSlide();
  cover.background = { color: hex(COLOR.accent) };
  // 44pt overflowed a realistic title off the right edge. 34pt with two lines of room wraps
  // instead of clipping, and `wrap` is set explicitly rather than relied on as a default.
  cover.addText(spec.title, {
    x: M, y: 2.15, w: W - M * 2, h: 2.0,
    fontSize: 34, bold: true, color: 'FFFFFF', fontFace: FONT.sans,
    valign: 'bottom', wrap: true, shrinkText: false,
  });
  if (spec.subtitle) {
    cover.addText(spec.subtitle, {
      x: M, y: 4.05, w: W - M * 2, h: 0.6,
      fontSize: 18, color: 'D6E2EF', fontFace: FONT.sans,
    });
  }
  cover.addText([spec.author, resolveDate(spec)].filter(Boolean).join('   ·   '), {
    x: M, y: H - 1.1, w: W - M * 2, h: 0.4,
    fontSize: 12, color: 'AFC4D9', fontFace: FONT.sans,
  });

  (spec.slides ?? []).forEach((s, i) => contentSlide(pptx, spec, s, i + 1, baseDir));

  const out = await pptx.write({ outputType: 'nodebuffer' });
  return out as Buffer;
}
