import {
  SocketConfig, QueryTemplate, ConnectorConfig, loadSocketConfig, bindParams,
  SocketConfigError, MAX_RESULT_CHARS,
} from './contract';
import { Adapter, createAdapter, assertReadOnly, SocketQueryError } from './adapters';
import { recordEgress } from '../security/egress.ledger';
import { classifyDestination, isSovereign, refusalFor } from '../security/sovereign';

/**
 * Open Socket registry — loads operator config, enforces the gate, runs templates, writes the ledger.
 *
 * The gate is applied in a fixed order, and the order is the design:
 *
 *   1. **Is this template declared?**  An undeclared name is refused. There is no "ad hoc" path.
 *   2. **Is the statement a read?**    Checked at LOAD, so a bad template cannot reach a server at all.
 *   3. **Do the parameters fit?**      Typed, length-capped, pattern-checked — this bounds what can
 *                                      leave, which the read-only property by itself does not.
 *   4. **Is the host permitted?**      Under `--sovereign` an external host is refused outright; a
 *                                      private-LAN historian is allowed. The refusal is recorded.
 *   5. **Run, then ledger.**           Template, host, bytes out, rows in — allowed or refused.
 *
 * Step 4 deserves a note. A refinery's historian is on the plant LAN, so it classifies as
 * `private-lan` and sovereign mode permits it: sovereignty means "nothing leaves the premises", not
 * "no sockets". A socket pointed at a public cloud endpoint under `--sovereign` is exactly what the
 * mode exists to stop, and it is stopped here rather than by asking the operator to be careful.
 */

export interface SocketCallResult {
  template: string;
  connector: string;
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  bytesOut: number;
}

export class SocketRegistry {
  private config: SocketConfig | null = null;
  private loaded = false;
  private loadError: string | null = null;
  private readonly adapters = new Map<string, Adapter>();

  constructor(private readonly configPath?: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.config = await loadSocketConfig(this.configPath);
      if (!this.config) return;
      // Every template is validated NOW. A read-only violation in config is a startup failure, not
      // a runtime surprise on someone's production historian.
      for (const template of this.config.templates) {
        const connector = this.connectorFor(template);
        assertReadOnly(template, connector.kind);
      }
    } catch (error) {
      this.config = null;
      this.loadError = (error as Error).message;
    }
  }

  private connectorFor(template: QueryTemplate): ConnectorConfig {
    const connector = this.config?.connectors.find((candidate) => candidate.name === template.connector);
    if (!connector) throw new SocketConfigError(`template "${template.name}" names unknown connector "${template.connector}"`);
    return connector;
  }

  async available(): Promise<boolean> {
    await this.load();
    return Boolean(this.config && this.config.templates.length);
  }

  async describe(): Promise<string> {
    await this.load();
    if (this.loadError) return `Open Socket config is invalid and no socket is available: ${this.loadError}`;
    if (!this.config) return 'No Open Socket is configured. An operator declares connectors and read-only query templates in .breakglass/sockets.json.';
    const lines: string[] = [];
    for (const template of this.config.templates) {
      const connector = this.config.connectors.find((c) => c.name === template.connector);
      const params = template.params.map((param) => {
        const bits = [`${param.name}:${param.type}`];
        if (param.pattern) bits.push(`~${param.pattern}`);
        if (param.values) bits.push(`one of ${param.values.join('|')}`);
        return bits.join(' ');
      }).join(', ');
      lines.push(
        `${template.name} [${connector?.kind}/${template.connector}] — ${template.description}\n`
        + `    parameters: ${params || '(none)'}`,
      );
    }
    return lines.join('\n');
  }

  private adapterFor(connector: ConnectorConfig): Adapter {
    let adapter = this.adapters.get(connector.name);
    if (!adapter) { adapter = createAdapter(connector); this.adapters.set(connector.name, adapter); }
    return adapter;
  }

  /**
   * Invoke one declared template. Throws `SocketQueryError`/`SocketConfigError` with a message the
   * model can act on — a refusal must say WHY, or the model "fixes" the wrong thing.
   */
  async call(name: string, args: Record<string, unknown>): Promise<SocketCallResult> {
    await this.load();
    if (this.loadError) throw new SocketConfigError(`Open Socket config is invalid: ${this.loadError}`);
    if (!this.config) throw new SocketConfigError('No Open Socket is configured on this deployment.');

    const template = this.config.templates.find((candidate) => candidate.name === name);
    if (!template) {
      throw new SocketConfigError(
        `no such query template: "${name}". Declared templates: `
        + `${this.config.templates.map((t) => t.name).join(', ') || '(none)'}`,
      );
    }
    const connector = this.connectorFor(template);
    const bound = bindParams(template, args);

    const destination = classifyDestination(connector.host);
    const sovereign = isSovereign();
    if (sovereign && destination === 'external') {
      recordEgress({
        at: new Date().toISOString(), host: connector.host, destination,
        verdict: 'refused', subsystem: 'OpenSocket', purpose: `template ${template.name}`, sovereign,
      });
      throw new SocketQueryError(refusalFor(connector.host, 'OpenSocket'));
    }

    const adapter = this.adapterFor(connector);
    try {
      const result = await adapter.query(template, bound);
      recordEgress({
        at: new Date().toISOString(), host: connector.host, destination,
        verdict: 'allowed', subsystem: 'OpenSocket',
        // The parameters are recorded, not just the template name: "what did we ever send?" must be
        // answerable exactly, and the parameters ARE the variable part of the payload.
        purpose: `template ${template.name} (${result.bytesOut}B out, ${result.rowCount} rows) params=${JSON.stringify(args)}`,
        sovereign,
      });
      return {
        template: template.name, connector: connector.name,
        rows: result.rows, rowCount: result.rowCount,
        truncated: result.truncated, bytesOut: result.bytesOut,
      };
    } catch (error) {
      recordEgress({
        at: new Date().toISOString(), host: connector.host, destination,
        verdict: 'refused', subsystem: 'OpenSocket',
        purpose: `template ${template.name} failed: ${(error as Error).message}`, sovereign,
      });
      throw error;
    }
  }

  async close(): Promise<void> {
    for (const adapter of this.adapters.values()) await adapter.close();
    this.adapters.clear();
  }
}

/** Render rows as a compact table the model reads well, bounded so one query cannot flood context. */
export function renderRows(result: SocketCallResult): string {
  if (result.rowCount === 0) {
    return `${result.template}: no rows matched. This is a result, not an error — report it as "no record found" rather than substituting an assumption.`;
  }
  const columns = [...new Set(result.rows.flatMap((row) => Object.keys(row)))];
  const header = columns.join('\t');
  const body = result.rows.map((row) => columns.map((column) => {
    const value = row[column];
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return value.toISOString();
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }).join('\t'));

  let text = [header, ...body].join('\n');
  let note = '';
  if (text.length > MAX_RESULT_CHARS) {
    text = text.slice(0, MAX_RESULT_CHARS);
    note = `\n[truncated at ${MAX_RESULT_CHARS} characters]`;
  }
  if (result.truncated) note += `\n[row cap reached — narrow the query rather than assuming these are all the records]`;
  return `${result.template} via ${result.connector} — ${result.rowCount} row(s)\n${text}${note}`;
}

let globalRegistry: SocketRegistry | null = null;
export function setSocketRegistry(registry: SocketRegistry | null): void { globalRegistry = registry; }
export function getSocketRegistry(): SocketRegistry | null { return globalRegistry; }
