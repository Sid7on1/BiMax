import { ToolDef, buildTool, BuiltTool } from '../tool.factory';
import { IGovernor } from '../../core/interfaces';
import { FactStore, Fact } from '../../memory/facts';

/**
 * Numeric questions over ingested documents.
 *
 * This tool exists because retrieval cannot answer them. In a vector index numbers are tokens, not
 * quantities — nothing makes 7.8 rank below 8.0 — and error analysis of text-and-table retrieval
 * puts 73% of residual failures in table structure and 20% in numerical reasoning. "Which vessels
 * are below minimum thickness" is a `SELECT`, not a similarity search, and pretending otherwise is
 * how a plausible-looking wrong number ends up in an engineering assessment.
 *
 * The model does not write SQL. It selects a subject, a property and a comparison, which are bound
 * as parameters — the same discipline as the Open Socket, pointed at local facts instead of a
 * remote datastore.
 */

function renderFacts(facts: Fact[]): string {
  if (!facts.length) {
    return 'No matching facts. This is a result, not an error: report "no recorded measurement matches" '
      + 'rather than estimating a value. If you expected data here, call action:"schema" to see which '
      + 'subjects and properties were actually extracted from the ingested documents.';
  }
  const lines = facts.map((fact) => {
    const unit = fact.unit ? ` ${fact.unit}` : '';
    const when = fact.measuredOn ? ` on ${fact.measuredOn}` : '';
    const where = fact.locator ? ` · ${fact.locator}` : '';
    return `${fact.subject}\t${fact.property}\t${fact.value}${unit}${when}\t[${fact.sourceName}${where}]`;
  });
  return `subject\tproperty\tvalue\tsource\n${lines.join('\n')}`;
}

export function createFactQueryTool(governor: IGovernor, facts: FactStore): BuiltTool {
  const def: ToolDef = {
    name: 'FactQueryTool',
    description: `Queries the MEASUREMENTS extracted from documents you have ingested — by equipment tag, by property, and by numeric comparison. Use this whenever a question involves comparing, ranking, thresholding or listing numbers.

ComposerSearchTool finds passages; this finds values. A question like "which exchangers are below 8 mm" cannot be answered by searching text, because a text index treats 7.8 as a word, not as a number smaller than 8.

# Instructions
- **Discover first.** \`action: "schema"\` lists the subjects (equipment tags) and properties actually extracted. Do not guess a property name — use one that exists.
- **Comparisons are the point.** Pass \`property\`, \`op\` (lt/lte/gt/gte/eq) and \`value\` to answer threshold questions. \`subject\` narrows to one equipment tag.
- **Every value carries its source.** The result names the file and the sheet/page each number came from. Carry that into your answer; a figure in an assessment without a source cannot be signed off.
- **Never invent a missing value.** An empty result means the documents recorded nothing matching. Say that. Do not estimate, interpolate, or reuse a number from a different equipment tag.
- **Units are only what the document stated.** If a unit is absent, say it is unstated rather than assuming one.
- **Derived quantities are your work, in the open.** If a corrosion rate is needed and only thicknesses and dates are recorded, compute it from the returned facts and show the arithmetic — do not present it as if the document stated it.`,
    schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['query', 'schema'],
          description: 'Use "schema" to list available subjects and properties. Default "query".',
        },
        subject: { type: 'string', description: 'Equipment or instrument tag, e.g. "E-204".' },
        property: { type: 'string', description: 'Measured property, e.g. "measured" or "thickness". Matched loosely.' },
        op: {
          type: 'string',
          enum: ['lt', 'lte', 'gt', 'gte', 'eq'],
          description: 'Numeric comparison applied to `value`.',
        },
        value: { type: 'number', description: 'The number to compare against.' },
        limit: { type: 'number', description: 'Maximum facts to return (default 100, max 500).' },
      },
      required: [],
    },
    isDestructive: false,
    isConcurrencySafe: true,
    execute: async (args: {
      action?: string; subject?: string; property?: string;
      op?: 'lt' | 'lte' | 'gt' | 'gte' | 'eq'; value?: number; limit?: number;
    }) => {
      if (!facts.available()) {
        return 'The fact store is unavailable on this runtime, so numeric queries cannot run. '
          + 'Retrieval still works — use ComposerSearchTool and read the values out of the passages, '
          + 'stating that they were read from text rather than compared as data.';
      }

      if (args.action === 'schema') {
        const { subjects, properties } = facts.schema();
        if (!subjects.length && !properties.length) {
          return 'No facts have been extracted yet. Facts come from tables in ingested documents '
            + '(spreadsheets, and tabular pages of reports). Ingest a document with measurements first.';
        }
        return [
          `subjects (${subjects.length}): ${subjects.join(', ') || '(none)'}`,
          'properties:',
          ...properties.map((p) => `  ${p.property}${p.unit ? ` (${p.unit})` : ''} — ${p.count} value(s)`),
        ].join('\n');
      }

      if (args.op && typeof args.value !== 'number') {
        return 'A comparison needs `value`: e.g. { property: "measured", op: "lt", value: 8 }.';
      }
      return renderFacts(facts.query({
        subject: args.subject, property: args.property,
        op: args.op, value: args.value, limit: args.limit,
      }));
    },
  };
  return buildTool(def, governor);
}
