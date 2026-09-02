import ExcelJS from 'exceljs';
import { COLOR, DocumentSpec, FONT, Sheet, TYPE } from './design';

/**
 * A workbook someone can actually work in.
 *
 * The tells of a generated spreadsheet are all functional, not decorative: columns too narrow to
 * read, no frozen header so scrolling loses the column names, numbers stored as text so SUM
 * returns 0, and totals typed in as literals so the sheet silently lies the moment a cell is
 * edited. Each is handled here — widths are measured from the content, row 1 freezes, numerics are
 * written as numbers, and totals are real SUM formulas.
 */

const argb = (c: string): string => `FF${c}`;

function writeSheet(wb: ExcelJS.Workbook, sheet: Sheet): void {
  const ws = wb.addWorksheet(sheet.name.slice(0, 31), {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  ws.addRow(sheet.columns);
  const header = ws.getRow(1);
  header.height = 22;
  header.eachCell((cell) => {
    cell.font = { name: FONT.sans, size: TYPE.small, bold: true, color: { argb: argb(COLOR.accent) } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(COLOR.accentWash) } };
    cell.alignment = { vertical: 'middle' };
    cell.border = { bottom: { style: 'thin', color: { argb: argb(COLOR.rule) } } };
  });

  for (const row of sheet.rows) {
    // Keep numbers numeric. A column of right-looking strings is the single most common reason a
    // generated sheet cannot be summed, charted or sorted.
    ws.addRow(row.map(v => (v === null || v === undefined ? null : v)));
  }

  ws.columns.forEach((column, i) => {
    const values = [sheet.columns[i], ...sheet.rows.map(r => String(r[i] ?? ''))];
    const longest = values.reduce((max, v) => Math.max(max, String(v).length), 0);
    column.width = Math.min(52, Math.max(10, longest + 3));
    if (sheet.formats?.[i]) column.numFmt = sheet.formats[i];
    column.font = { name: FONT.sans, size: TYPE.small, color: { argb: argb(COLOR.body) } };
  });
  // The header's own font must survive the column-wide font assignment above.
  header.eachCell((cell) => {
    cell.font = { name: FONT.sans, size: TYPE.small, bold: true, color: { argb: argb(COLOR.accent) } };
  });

  if (sheet.totals?.length) {
    const first = 2;
    const last = sheet.rows.length + 1;
    const totalRow = ws.addRow(sheet.columns.map((_, i) => {
      if (i === 0) return 'Total';
      if (!sheet.totals?.includes(i)) return null;
      const col = ws.getColumn(i + 1).letter;
      return { formula: `SUM(${col}${first}:${col}${last})` } as unknown as string;
    }));
    totalRow.eachCell((cell) => {
      cell.font = { name: FONT.sans, size: TYPE.small, bold: true, color: { argb: argb(COLOR.ink) } };
      cell.border = { top: { style: 'thin', color: { argb: argb(COLOR.rule) } } };
    });
  }

  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columns.length } };
}

export async function buildXlsx(spec: DocumentSpec): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = spec.author || 'Bimax';
  wb.title = spec.title;
  wb.created = new Date();

  for (const sheet of spec.sheets ?? []) writeSheet(wb, sheet);

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}
