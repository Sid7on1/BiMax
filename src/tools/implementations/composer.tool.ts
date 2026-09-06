import { ToolDef, buildTool, BuiltTool } from '../tool.factory';
import { IGovernor } from '../../core/interfaces';
import { ComposerCorpus, CorpusScope } from '../../memory/corpus';

/**
 * The Composer's retrieval surface.
 *
 * Two tools, split deliberately along the line that matters for confidentiality and for context
 * budget:
 *
 * - **ComposerSearchTool** is how the model reads what the user dropped. It is read-only, safe to
 *   run concurrently, and returns cited fragments rather than whole files. This is the tool that
 *   makes "review this inspection report against the SOP" answerable when the report is 60 pages
 *   and the SOP library is 400 — neither fits in a context window, and neither needs to.
 *
 * - **ComposerIngestTool** puts more files in. It is separated because ingestion is *work*: OCR on a
 *   scanned P&ID is seconds per page, and a model that could silently ingest a directory while
 *   "just looking something up" would spend a user's whole turn budget on it.
 *
 * The reason retrieval is a tool rather than an automatic prompt stuffer: a turn that needs nothing
 * from the corpus should pay nothing for it. Automatic injection taxes every turn — including "fix
 * this typo" — with an embedding call and a few thousand tokens of possibly-irrelevant document.
 */

function renderHits(hits: Awaited<ReturnType<ComposerCorpus['search']>>): string {
  if (hits.length === 0) {
    return 'No relevant passages found in the Composer corpus. '
      + 'If the user referred to a document they believe was attached, list what is ingested with ComposerIngestTool action:"list" before telling them it is missing.';
  }
  return hits.map((hit) => {
    const where = hit.locator ? `${hit.name} · ${hit.locator}` : hit.name;
    const caveat = hit.ocr ? ' (read by OCR — verify critical figures against the source)' : '';
    return `--- ${where} [${hit.scope}]${caveat}\n${hit.text}`;
  }).join('\n\n');
}

export function createComposerSearchTool(governor: IGovernor, corpus: ComposerCorpus): BuiltTool {
  const def: ToolDef = {
    name: 'ComposerSearchTool',
    description: `Searches the documents the user has dropped into the Composer (session) and the standing knowledge library, using hybrid retrieval (BM25 + dense embeddings + rerank). Returns the relevant passages WITH their source file and page/sheet/slide.

Use this whenever the user refers to "this report", "the attached", "our SOP", "the spec", "previous inspections", or any content that is not in the source tree. Read the corpus before answering from general knowledge — a document the user attached is authoritative and your training data is not.

# Instructions
- **Cite what you use.** Every passage arrives with its source, e.g. \`E-204 Inspection Report.pdf · page 3\`. Carry that into your answer. An engineering assessment or approval note without a source reference cannot be signed off.
- **Query with the salient terms**, not a whole sentence: \`"E-204 shell thickness corrosion nozzle N2"\` beats \`"can you tell me about the heat exchanger"\`. Exact tags and equipment numbers match lexically; paraphrases match semantically.
- **Search more than once** when a question has parts. "Compare this report against the SOP and past history" is three queries (the finding, the SOP limit, the history), not one.
- **OCR passages are marked.** Text recovered from a scan may misread digits. When a number decides an action (a thickness, a pressure, a date), say it came from OCR and recommend confirming it against the original.
- **Absence is a finding.** If the corpus has nothing, say so plainly rather than inventing a plausible figure.`,
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for. Lead with the distinctive terms.' },
        limit: { type: 'number', description: 'Passages to return (default 8, max 25).' },
        scope: {
          type: 'string',
          enum: ['session', 'library', 'both'],
          description: 'Which corpus to search. Default "both": freshly dropped files and the standing library.',
        },
      },
      required: ['query'],
    },
    isDestructive: false,
    isConcurrencySafe: true,
    execute: async (args: { query: string; limit?: number; scope?: string }) => {
      const scopes: CorpusScope[] = args.scope === 'session' ? ['session']
        : args.scope === 'library' ? ['library']
        : ['session', 'library'];
      const limit = Math.max(1, Math.min(25, args.limit ?? 8));
      const hits = await corpus.search(args.query, limit, scopes);
      return renderHits(hits);
    },
  };
  return buildTool(def, governor);
}

export function createComposerIngestTool(governor: IGovernor, corpus: ComposerCorpus): BuiltTool {
  const def: ToolDef = {
    name: 'ComposerIngestTool',
    description: `Manages the Composer corpus: ingest files, list what is ingested, promote a file into the standing library, or clear a corpus.

Reads almost anything: PDF (text layer, falling back to OCR per page), scans and photographs, handwritten notes, Word, Excel, PowerPoint, CSV, Markdown, source code, JSON/YAML, and any other file whose bytes are text. Archives, executables, audio and video are refused.

# Instructions
- **Ingest is work, not a lookup.** OCR on a scanned document costs seconds per page. Ingest when the user gives you files or points at a folder; do not ingest speculatively.
- **"session" vs "library".** Files for the task at hand go to \`session\` (the default). Standing references an organisation queries for months — SOPs, equipment history, manuals, standards — belong in \`library\`, either ingested there directly or promoted later.
- **Report what did NOT go in.** The result lists skipped files with reasons. Pass that on: a user who believes 200 reports were read, when 9 were unreadable scans, will act on an incomplete picture.`,
    schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['ingest', 'list', 'promote', 'clear', 'stats'],
          description: 'What to do. Default "ingest".',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute or project-relative paths to ingest (action "ingest").',
        },
        scope: {
          type: 'string',
          enum: ['session', 'library'],
          description: 'Target corpus. Default "session".',
        },
        target: { type: 'string', description: 'File name or path to promote (action "promote").' },
      },
      required: [],
    },
    isDestructive: false,
    isConcurrencySafe: false,
    execute: async (args: { action?: string; files?: string[]; scope?: string; target?: string }) => {
      const scope: CorpusScope = args.scope === 'library' ? 'library' : 'session';
      const action = args.action || 'ingest';

      if (action === 'stats') {
        const stats = await corpus.stats();
        return `Composer corpus: ${stats.session} session document(s), ${stats.library} library document(s), ${stats.chunks} indexed passages.`;
      }

      if (action === 'list') {
        const entries = await corpus.list(args.scope as CorpusScope | undefined);
        if (!entries.length) return 'The Composer corpus is empty. Nothing has been ingested yet.';
        return entries.map((entry) =>
          `${entry.name} [${entry.scope}] — ${entry.chunks} passage(s), ${entry.bytes} bytes${entry.ocr ? ', OCR' : ''}`
          + `${entry.note ? ` (${entry.note})` : ''}\n  ${entry.file}`,
        ).join('\n');
      }

      if (action === 'promote') {
        if (!args.target) return 'promote needs `target`: the file name or path to move into the library.';
        const promoted = await corpus.promote(args.target);
        return promoted
          ? `Promoted ${promoted.name} into the standing library (${promoted.chunks} passages).`
          : `No session document matched "${args.target}". Use action:"list" to see what is ingested.`;
      }

      if (action === 'clear') {
        const removed = await corpus.clear(scope);
        return `Cleared the ${scope} corpus (${removed} passage(s) removed).`;
      }

      const files = args.files || [];
      if (!files.length) return 'ingest needs `files`: one or more paths to read.';
      const report = await corpus.ingest(files, scope);

      const lines: string[] = [];
      lines.push(
        `Ingested ${report.ingested.length} file(s) into the ${scope} corpus `
        + `(${report.chunks} passages${report.unchanged ? `, ${report.unchanged} already current` : ''}).`,
      );
      for (const entry of report.ingested) {
        lines.push(`  ${entry.name} — ${entry.chunks} passage(s)${entry.ocr ? ', OCR used' : ''}${entry.note ? ` (${entry.note})` : ''}`);
      }
      if (report.skipped.length) {
        // Surfaced, never swallowed: silently dropping unreadable files is how a user ends up
        // signing an assessment based on 191 of the 200 reports they believe were read.
        lines.push(`Skipped ${report.skipped.length} file(s):`);
        for (const skip of report.skipped) lines.push(`  ${skip.file} — ${skip.reason}`);
      }
      return lines.join('\n');
    },
  };
  return buildTool(def, governor);
}
