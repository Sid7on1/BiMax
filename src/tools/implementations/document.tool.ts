import { outcomeOk, outcomeError } from '../outcome';
import * as fs from 'fs';
import * as path from 'path';
import { IGovernor } from '../../core/interfaces';
import { buildTool } from '../tool.factory';
import { resolvePath } from '../path.util';
import { createHash } from 'crypto';
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
  const drafts = new Map<string, { spec: DocumentSpec; expectedWords?: number; hashes: Set<string> }>();
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
- \`{kind:"image", path, caption?, width?}\` — a PNG or JPEG already on disk, project-relative.
  \`width\` is a fraction of the text column (0–1); the aspect ratio is always kept.
- \`{kind:"chart", chart:"bar"|"line"|"pie", labels:[...], series:[{name, values:[...]}], caption?}\`
  Give the DATA, not a picture — the chart is drawn as vectors. Every series needs one value per
  label. **PDF only** (Word has no chart part: in docx it becomes a placeholder note, so use a
  table there instead).
- \`{kind:"quote", text, attribution?}\` · \`{kind:"code", text, language?}\`
- \`{kind:"divider"}\` · \`{kind:"pagebreak"}\`

## pptx — \`spec.slides\`, an array
\`{title, bullets?:[...], statement?, table?:{columns,rows}, image?:{path,caption?}, chart?:{...}, notes?}\`
A slide takes exactly ONE body: bullets, statement, table, image or chart. \`chart\` has the same
shape as the block above and becomes a real, editable PowerPoint chart, not a picture of one.
One claim per slide. Put the claim in \`title\` and its support in \`bullets\`. Use \`statement\` for a
section divider or a headline number. Text is never auto-shrunk: if a slide overflows, split it.

## xlsx — \`spec.sheets\`, an array
\`{name, columns:[...], rows:[[...]], formats?:{colIndex:"#,##0.00"}, totals?:[colIndex]}\`
Write numbers as JSON numbers, not strings, or they cannot be summed. \`totals\` adds real SUM
formulas, not typed-in values.

# Long prose and exact word counts
- For long stories, use action "draft" with the first paragraphs, then "append" with ONLY new paragraphs, and "finalize" when the count is correct. Use the same path and format throughout. Drafts stay in memory for this session; a restart requires a new draft.
- expectedWords is the requested exact prose length (PDF/Word paragraph text, excluding title/headings). Each draft response reports the actual count and how much is missing. Never resubmit the same short story.
- action "replace" replaces ONE existing block using blockIndex and spec.blocks:[replacement]. Use it to adjust a paragraph to the exact remaining count. action "finalize" needs no spec.
- If action "create" receives an undersized draft, it is retained automatically. Continue it with append, not WriteFileTool or shell conversion.

# Rules
- Content only. Do not ask for fonts, colours or sizes — the house style owns them, including the
  chart palette (chosen to survive greyscale printing and red-green colour deficiency).
- Images come from a path on disk. There is no URL and no base64 — save the file first, with
  another tool, then reference it.
- Prose belongs in \`paragraph\`; do not simulate layout with blank lines or ASCII tables.
- Write the file, then tell the user the path and what is in it.`,
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'draft', 'append', 'replace', 'finalize'] },
        expectedWords: { type: 'integer', minimum: 0 },
        blockIndex: { type: 'integer', minimum: 0 },
        format: { type: 'string', enum: [...FORMATS], description: 'docx | pdf | pptx | xlsx' },
        path: { type: 'string', description: 'Project-relative output path, extension matching format' },
        spec: { type: 'object', description: 'Document content (see the description)' },
      },
      required: ['format', 'path'],
    },
    isDestructive: true,
    isConcurrencySafe: false,
    execute: async (args: { format?: string; path?: string; spec?: DocumentSpec; action?: string; expectedWords?: number; blockIndex?: number }, context?: { cwd?: string }) => {
      const format = String(args.format || '').toLowerCase() as Format;
      if (!FORMATS.includes(format)) {
        return `Error: format must be one of ${FORMATS.join(', ')} (got "${args.format}").`;
      }
      if (!args.path) return 'Error: path is required.';

      const ext = path.extname(args.path).toLowerCase().replace('.', '');
      if (ext !== format) {
        return `Error: path "${args.path}" ends in ".${ext || '(none)'}" but format is "${format}". They must match.`;
      }

      const baseDir = context?.cwd || process.cwd();
      const target = resolvePath(args.path, baseDir);
      const action = args.action || 'create';
      if (!['create', 'draft', 'append', 'replace', 'finalize'].includes(action)) return outcomeError('invalid_args', 'Unknown document action.');
      if ((action === 'create' || action === 'draft') && !args.spec) return outcomeError('invalid_args', 'spec is required for create and draft.');
      const prior = drafts.get(target);
      if (args.expectedWords !== undefined && (!Number.isInteger(args.expectedWords) || args.expectedWords < 0)) return outcomeError('invalid_args', 'expectedWords must be a non-negative integer.');
      let spec = args.spec as DocumentSpec;
      const hash = createHash('sha256').update(JSON.stringify(args.spec ?? {})).digest('hex');
      if (['append', 'replace', 'finalize'].includes(action)) {
        if (!prior) return outcomeError('invalid_args', 'No draft exists at this path in this session. Start with action draft.');
        spec = { ...prior.spec, blocks: [...(prior.spec.blocks ?? [])] };
        if (action === 'append') {
          if (prior.hashes.has(hash)) return outcomeError('invalid_args', 'These paragraphs are already in the draft. Append NEW paragraphs, or replace a specific block. Nothing was duplicated.');
          if (!Array.isArray(args.spec?.blocks) || !args.spec.blocks.length) return outcomeError('invalid_args', 'append requires spec.blocks containing new paragraphs.');
          spec.blocks!.push(...args.spec.blocks);
        }
        if (action === 'replace') {
          if (!Number.isInteger(args.blockIndex) || args.blockIndex! < 0 || args.blockIndex! >= spec.blocks!.length || args.spec?.blocks?.length !== 1) return outcomeError('invalid_args', 'replace requires a valid blockIndex and exactly one replacement block.');
          spec.blocks![args.blockIndex!] = args.spec.blocks[0];
        }
      }
      const problem = validateSpec(spec, NEEDS[format]);
      if (problem) return outcomeError('invalid_args', `Error: ${problem}.`);
      const expectedWords = args.expectedWords ?? prior?.expectedWords;
      const words = (spec.blocks ?? []).filter(b => b.kind === 'paragraph').map(b => (b as { text: string }).text).join(' ').trim().split(/\s+/).filter(Boolean).length;
      // Long prose is staged in memory until it meets the requested length, so an undersized story is
      // extended paragraph by paragraph instead of being regenerated whole and resubmitted.
      const staged = action !== 'create' || (expectedWords !== undefined && words !== expectedWords);
      if (staged) {
        if (!['pdf', 'docx'].includes(format)) return outcomeError('invalid_args', 'Incremental prose drafts support PDF and Word.');
        if (!prior && drafts.size >= 8) return outcomeError('invalid_args', 'Finish an existing document draft before starting another.');
        if (JSON.stringify(spec).length > 2_000_000) return outcomeError('invalid_args', 'Document draft exceeds the 2 MB limit.');
        const hashes = new Set(prior?.hashes); hashes.add(hash);
        drafts.set(target, { spec, expectedWords, hashes });
        if (action !== 'finalize' || (expectedWords !== undefined && words !== expectedWords)) {
          const remaining = expectedWords === undefined ? '' : ` Target ${expectedWords}; ${expectedWords - words >= 0 ? `add ${expectedWords - words}` : `remove ${words - expectedWords}`} words.`;
          return outcomeOk(`Draft retained in this session: ${words} paragraph words, ${spec.blocks?.length} blocks.${remaining} No output file has been written. Continue with DocumentTool action append (only new paragraphs), replace (blockIndex), or finalize. Keep path ${target}.`);
        }
      }

      let buffer: Buffer;
      try {
        if (format === 'docx') buffer = await (await import('../../documents/docx.writer')).buildDocx(spec, baseDir);
        else if (format === 'pdf') buffer = await (await import('../../documents/pdf.writer')).buildPdf(spec, baseDir);
        else if (format === 'pptx') buffer = await (await import('../../documents/pptx.writer')).buildPptx(spec, baseDir);
        else buffer = await (await import('../../documents/xlsx.writer')).buildXlsx(spec);
      } catch (e: unknown) {
        return outcomeError('external', `Error: could not build the ${format}: ${e instanceof Error ? e.message : String(e)}`);
      }

      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, buffer);
        if (!fs.readFileSync(target).equals(buffer)) return outcomeError('io', 'Document bytes on disk did not match the generated document.');
      } catch (e: unknown) {
        return outcomeError('io', `Error: could not write ${args.path}: ${e instanceof Error ? e.message : String(e)}`);
      }

      const counts =
        format === 'pptx' ? `${(spec.slides ?? []).length} slide(s)`
          : format === 'xlsx' ? `${(spec.sheets ?? []).length} sheet(s), ${(spec.sheets ?? []).reduce((n, s) => n + s.rows.length, 0)} row(s)`
            : `${(spec.blocks ?? []).length} block(s)`;

      // Word has no chart part. Degrading silently would report a success the document does not
      // contain, so the receipt says what happened and what to do instead.
      const dropped = format === 'docx' ? (spec.blocks ?? []).filter(b => b.kind === 'chart').length : 0;
      const note = dropped
        ? ` Note: ${dropped} chart block(s) became a placeholder — docx has no chart support; use pdf or pptx, or a table here.`
        : '';
      drafts.delete(target);
      return outcomeOk(`Wrote ${target} — ${format.toUpperCase()}, ${counts}, ${(buffer.length / 1024).toFixed(1)} KB.${note}${expectedWords !== undefined ? ` Verified ${words} paragraph words.` : ''}`);
    },
  }, governor);
}
