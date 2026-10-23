import {
  AlignmentType, BorderStyle, Document, HeadingLevel, ImageRun, Packer, Paragraph, ShadingType,
  Table, TableCell, TableRow, TextRun, WidthType,
} from 'docx';
import { Block, COLOR, DocumentSpec, FONT, PAGE, SPACE, TYPE, resolveDate } from './design';
import { fitBox, loadImage } from './images';

/** docx sizes are half-points; spacing is twentieths of a point (DXA). */
const hp = (pt: number): number => Math.round(pt * 2);
const dxa = (pt: number): number => Math.round(pt * 20);

function runs(text: string, opts: { size?: number; bold?: boolean; color?: string; font?: string; italics?: boolean } = {}): TextRun[] {
  return [new TextRun({
    text,
    size: hp(opts.size ?? TYPE.body),
    bold: opts.bold ?? false,
    italics: opts.italics ?? false,
    color: opts.color ?? COLOR.body,
    font: opts.font ?? FONT.prose,
  })];
}

function headingParagraph(level: 1 | 2 | 3, text: string): Paragraph {
  const size = level === 1 ? TYPE.h1 : level === 2 ? TYPE.h2 : TYPE.h3;
  return new Paragraph({
    heading: level === 1 ? HeadingLevel.HEADING_1 : level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
    // Space BEFORE a heading is what groups it with the text it introduces rather than the text it
    // follows; without it every heading floats equidistant and the page loses its structure.
    spacing: { before: dxa(SPACE.section), after: dxa(SPACE.paragraph) },
    children: runs(text, { size, bold: true, color: level === 1 ? COLOR.ink : COLOR.accent, font: FONT.sans }),
  });
}

function tableBlock(columns: string[], rows: string[][], caption?: string): (Table | Paragraph)[] {
  // Usable width is 8.5in less two 1in margins = 6.5in = 9360 DXA. Word autofits a table with no
  // declared widths to its MINIMUM content width, which collapses every column to a single
  // character and renders the text vertically. Declaring the widths is what prevents that.
  const usableDxa = 9360;
  const colDxa = Math.floor(usableDxa / columns.length);
  const cellWidth = { size: colDxa, type: WidthType.DXA } as const;

  const header = new TableRow({
    tableHeader: true,
    children: columns.map(c => new TableCell({
      width: cellWidth,
      shading: { type: ShadingType.CLEAR, fill: COLOR.accentWash },
      margins: { top: dxa(5), bottom: dxa(5), left: dxa(7), right: dxa(7) },
      children: [new Paragraph({ children: runs(c, { size: TYPE.small, bold: true, color: COLOR.accent, font: FONT.sans }) })],
    })),
  });
  const body = rows.map(r => new TableRow({
    children: r.map(cell => new TableCell({
      width: cellWidth,
      margins: { top: dxa(5), bottom: dxa(5), left: dxa(7), right: dxa(7) },
      children: [new Paragraph({ children: runs(cell, { size: TYPE.small, font: FONT.sans }) })],
    })),
  }));

  // Horizontal rules only. Ruling all four sides of every cell is the single loudest thing a
  // generated table does; the eye already groups columns by alignment.
  const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  const line = { style: BorderStyle.SINGLE, size: 4, color: COLOR.rule };
  const table = new Table({
    width: { size: usableDxa, type: WidthType.DXA },
    columnWidths: columns.map(() => colDxa),
    borders: { top: line, bottom: line, left: none, right: none, insideHorizontal: line, insideVertical: none },
    rows: [header, ...body],
  });

  if (!caption) return [table];
  return [table, new Paragraph({
    spacing: { before: dxa(SPACE.tight), after: dxa(SPACE.block) },
    children: runs(caption, { size: TYPE.micro, color: COLOR.muted, font: FONT.sans, italics: true }),
  })];
}

function renderBlock(block: Block, baseDir: string): (Paragraph | Table)[] {
  switch (block.kind) {
    case 'heading':
      return [headingParagraph(block.level, block.text)];
    case 'paragraph':
      return [new Paragraph({
        spacing: { after: dxa(SPACE.paragraph), line: 300 },
        children: runs(block.text),
      })];
    case 'bullets':
      return block.items.map(item => new Paragraph({
        bullet: { level: 0 },
        spacing: { after: dxa(SPACE.tight), line: 290 },
        children: runs(item),
      }));
    case 'numbered':
      return block.items.map(item => new Paragraph({
        numbering: { reference: 'bimax-ordered', level: 0 },
        spacing: { after: dxa(SPACE.tight), line: 290 },
        children: runs(item),
      }));
    case 'keyvalue':
      // A definition list, not a two-column table: labels are metadata, and ruling them makes the
      // page look like a form.
      return block.pairs.map(pair => new Paragraph({
        spacing: { after: dxa(SPACE.tight) },
        children: [
          ...runs(`${pair.label}  `, { size: TYPE.small, bold: true, color: COLOR.muted, font: FONT.sans }),
          ...runs(pair.value, { size: TYPE.small, font: FONT.sans }),
        ],
      }));
    case 'quote':
      return [new Paragraph({
        indent: { left: dxa(24) },
        border: { left: { style: BorderStyle.SINGLE, size: 12, color: COLOR.accent, space: 12 } },
        spacing: { before: dxa(SPACE.block), after: dxa(SPACE.block), line: 300 },
        children: [
          ...runs(block.text, { italics: true, color: COLOR.ink }),
          ...(block.attribution ? runs(`  — ${block.attribution}`, { size: TYPE.small, color: COLOR.muted }) : []),
        ],
      })];
    case 'code':
      return [new Paragraph({
        shading: { type: ShadingType.CLEAR, fill: COLOR.wash },
        spacing: { before: dxa(SPACE.tight), after: dxa(SPACE.block) },
        children: block.text.split('\n').flatMap((line, i) => [
          ...(i > 0 ? [new TextRun({ break: 1 })] : []),
          ...runs(line, { size: TYPE.micro, font: FONT.mono, color: COLOR.ink }),
        ]),
      })];
    case 'table':
      return tableBlock(block.columns, block.rows, block.caption);
    case 'image': {
      const img = loadImage(block.path, baseDir);
      // Word wants explicit points. Fit to the text column at the true aspect ratio so a wide
      // screenshot shrinks to the margin instead of running under it.
      const maxW = PAGE.width - PAGE.marginLeft - PAGE.marginRight;
      const box = fitBox(img.width, img.height, maxW * (block.width ?? 1), 560);
      return [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: dxa(SPACE.block), after: dxa(block.caption ? SPACE.tight : SPACE.block) },
          children: [new ImageRun({
            type: img.type === 'jpeg' ? 'jpg' : 'png',
            data: img.data,
            transformation: { width: Math.round(box.w), height: Math.round(box.h) },
          })],
        }),
        ...(block.caption ? [new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: dxa(SPACE.block) },
          children: runs(block.caption, { size: TYPE.small, color: COLOR.muted, font: FONT.sans, italics: true }),
        })] : []),
      ];
    }
    case 'chart':
      // Word has no chart part in this library. Saying so beats emitting a silent blank.
      return [new Paragraph({
        spacing: { before: dxa(SPACE.block), after: dxa(SPACE.block) },
        children: runs(
          `[chart "${block.caption ?? block.chart}" omitted — charts are supported in pptx and pdf; use a table here]`,
          { size: TYPE.small, color: COLOR.muted, font: FONT.sans, italics: true },
        ),
      })];
    case 'divider':
      return [new Paragraph({
        spacing: { before: dxa(SPACE.block), after: dxa(SPACE.block) },
        border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: COLOR.rule, space: 1 } },
        children: [],
      })];
    case 'pagebreak':
      return [new Paragraph({ pageBreakBefore: true, children: [] })];
    default:
      return [];
  }
}

export async function buildDocx(spec: DocumentSpec, baseDir: string = process.cwd()): Promise<Buffer> {
  const date = resolveDate(spec);

  // A title block, not a title page: an approval note that opens with a blank cover wastes the
  // reader's first screen. Rule under the title is what separates it from the body.
  const head: Paragraph[] = [
    new Paragraph({
      spacing: { after: dxa(SPACE.tight) },
      children: runs(spec.title, { size: TYPE.title, bold: true, color: COLOR.ink, font: FONT.sans }),
    }),
  ];
  if (spec.subtitle) {
    head.push(new Paragraph({
      spacing: { after: dxa(SPACE.tight) },
      children: runs(spec.subtitle, { size: TYPE.h3, color: COLOR.muted, font: FONT.sans }),
    }));
  }
  head.push(new Paragraph({
    spacing: { after: dxa(SPACE.section) },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: COLOR.accent, space: 8 } },
    children: runs([spec.author, date].filter(Boolean).join('  ·  '), {
      size: TYPE.small, color: COLOR.muted, font: FONT.sans,
    }),
  }));

  const doc = new Document({
    creator: spec.author || 'Bimax',
    title: spec.title,
    description: spec.subtitle || '',
    numbering: {
      config: [{
        reference: 'bimax-ordered',
        levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.START }],
      }],
    },
    sections: [{
      properties: { page: { margin: { top: dxa(72), bottom: dxa(72), left: dxa(72), right: dxa(72) } } },
      children: [...head, ...(spec.blocks ?? []).flatMap(b => renderBlock(b, baseDir))],
    }],
  });

  return Packer.toBuffer(doc);
}
