import * as fs from 'fs';
import * as path from 'path';
import { IGovernor } from '../../core/interfaces';
import { buildTool } from '../tool.factory';
import { resolvePath } from '../path.util';
import { DocumentSpec, validateSpec } from '../../documents/design';

/**
 * Real deliverables, not a chat reply about one.
 *
 * Before this existed the model had no way to produce a .docx / .pdf / .pptx / .xlsx, so asked for
 * "a PDF" it did the only thing it could: wrote prose with `WriteFileTool` and named the file
 * `.pdf`. That file opens in nothing — measured, and it is what motivated this tool.
 *
 * Layout is deliberately NOT the model's job. It supplies structure (headings, bullets, a table,
 * slides, sheets) and the writers in src/documents apply one house style — a single type scale,
 * one accent colour, real table rules, frozen headers, SUM formulas. A model asked to also choose
 * fonts and colours produces the generated-document look; constraining it to content is what
 * avoids that.
 */

const FORMATS = ['docx', 'pdf', 'pptx', 'xlsx'] as const;
type Format = (typeof FORMATS)[number];

const NEEDS: Record<Format, 'blocks' | 'slides' | 'sheets'> = {
  docx: 'blocks', pdf: 'blocks', pptx: 'slides', xlsx: 'sheets',
};

export function createDocumentTool(governor: IGovernor) {
  return buildTool({
    name: 'DocumentTool',
    description: `Produce a real, openable Word / PDF / PowerPoint / Excel deliverable.

Use this whenever the user asks for a document, report, note, deck, or spreadsheet as a FILE.
Never write document content with WriteFileTool and name it .pdf/.docx — that produces a file no
application can open.

# Arguments
- \`format\` — one of: docx, pdf, pptx, xlsx
- \`path\` — where to write it, project-relative. The extension must match \`format\`.
- \`spec\` — the content. Always: \`title\`, optional \`subtitle\`, \`author\`, \`date\`.

## docx / pdf — \`spec.blocks\`, an ordered array
- \`{kind:"heading", level:1|2|3, text}\`
- \`{kind:"paragraph", text}\`
- \`{kind:"bullets", items:[...]}\` · \`{kind:"numbered", items:[...]}\`
- \`{kind:"keyvalue", pairs:[{label,value}]}\` — for metadata blocks (Ref, Date, Prepared by)
- \`{kind:"table", columns:[...], rows:[[...]], caption?}\` — every row must match \`columns\` length
- \`{kind:"quote", text, attribution?}\` · \`{kind:"code", text, language?}\`
- \`{kind:"divider"}\` · \`{kind:"pagebreak"}\`

## pptx — \`spec.slides\`, an array
\`{title, bullets?:[...], statement?, table?:{columns,rows}, notes?}\`
One claim per slide. Put the claim in \`title\` and its support in \`bullets\`. Use \`statement\` for a
section divider or a headline number. Text is never auto-shrunk: if a slide overflows, split it.

## xlsx — \`spec.sheets\`, an array
\`{name, columns:[...], rows:[[...]], formats?:{colIndex:"#,##0.00"}, totals?:[colIndex]}\`
Write numbers as JSON numbers, not strings, or they cannot be summed. \`totals\` adds real SUM
formulas, not typed-in values.

# Rules
- Content only. Do not ask for fonts, colours or sizes — the house style owns them.
- Prose belongs in \`paragraph\`; do not simulate layout with blank lines or ASCII tables.
- Write the file, then tell the user the path and what is in it.`,
    schema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: [...FORMATS], description: 'docx | pdf | pptx | xlsx' },
        path: { type: 'string', description: 'Project-relative output path, extension matching format' },
        spec: { type: 'object', description: 'Document content (see the description)' },
      },
      required: ['format', 'path', 'spec'],
    },
    isDestructive: true,
    isConcurrencySafe: false,
    execute: async (args: { format?: string; path?: string; spec?: DocumentSpec }, context?: { cwd?: string }) => {
      const format = String(args.format || '').toLowerCase() as Format;
      if (!FORMATS.includes(format)) {
        return `Error: format must be one of ${FORMATS.join(', ')} (got "${args.format}").`;
      }
      if (!args.path) return 'Error: path is required.';

      const ext = path.extname(args.path).toLowerCase().replace('.', '');
      if (ext !== format) {
        return `Error: path "${args.path}" ends in ".${ext || '(none)'}" but format is "${format}". They must match.`;
      }

      const spec = args.spec as DocumentSpec;
      const problem = validateSpec(spec, NEEDS[format]);
      if (problem) return `Error: ${problem}.`;

      const target = resolvePath(args.path, context?.cwd || process.cwd());

      let buffer: Buffer;
      try {
        if (format === 'docx') buffer = await (await import('../../documents/docx.writer')).buildDocx(spec);
        else if (format === 'pdf') buffer = await (await import('../../documents/pdf.writer')).buildPdf(spec);
        else if (format === 'pptx') buffer = await (await import('../../documents/pptx.writer')).buildPptx(spec);
        else buffer = await (await import('../../documents/xlsx.writer')).buildXlsx(spec);
      } catch (e: unknown) {
        return `Error: could not build the ${format}: ${e instanceof Error ? e.message : String(e)}`;
      }

      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, buffer);
      } catch (e: unknown) {
        return `Error: could not write ${args.path}: ${e instanceof Error ? e.message : String(e)}`;
      }

      const counts =
        format === 'pptx' ? `${(spec.slides ?? []).length} slide(s)`
          : format === 'xlsx' ? `${(spec.sheets ?? []).length} sheet(s), ${(spec.sheets ?? []).reduce((n, s) => n + s.rows.length, 0)} row(s)`
            : `${(spec.blocks ?? []).length} block(s)`;

      return `Wrote ${args.path} — ${format.toUpperCase()}, ${counts}, ${(buffer.length / 1024).toFixed(1)} KB.`;
    },
  }, governor);
}
