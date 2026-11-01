import { randomUUID } from 'node:crypto';
import type { EmbeddedToolsBinding } from './embedded.tools';
import { OutputsStore } from './outputs.store';

/** This host tool can publish only managed snapshots; it cannot write a project or export a file. */
export function outputBinding(
  store: OutputsStore,
  owner: string,
  run: () => string,
  changed: () => void,
): EmbeddedToolsBinding {
  let closed = false;
  return {
    tools: [
      {
        name: 'OutputTool',
        description:
          'Create useful outputs beside chat. Publish a complete bounded Markdown/document (HTML), code, Mermaid, Vega-Lite JSON, table JSON (array of objects), form JSON ({fields:[{name,label,type:text|number|select,options?:string[]}]}), HTML or React app. React must default-export a component; only react and react-dom imports are available. HTML/React run offline in an isolated browser, never Node. Use a stable key per output; a revision requires outputId and exact baseVersion. Read/list only this conversation’s outputs. Saved means bytes retained, not correctness verified. Do not use for Computer Use.',
        schema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['publish', 'list', 'read'] },
            key: { type: 'string' },
            title: { type: 'string' },
            format: {
              type: 'string',
              enum: [
                'markdown',
                'document',
                'code',
                'html',
                'react',
                'vega-lite',
                'mermaid',
                'table',
                'form',
              ],
            },
            content: { type: 'string' },
            language: { type: 'string' },
            outputId: { type: 'string' },
            baseVersion: { type: 'string' },
            versionId: { type: 'string' },
          },
          required: ['action'],
        },
      },
    ],
    async execute(_name, raw, signal) {
      if (closed || signal.aborted) throw new Error('Output producer stopped.');
      const args = raw as Record<string, unknown>;
      if (args.action === 'list') return JSON.stringify(await store.list(owner));
      if (args.action === 'read') {
        const document = await store.read(
          String(args.outputId),
          typeof args.versionId === 'string' ? args.versionId : undefined,
        );
        if (document.record.ownerThreadId !== owner)
          throw new Error('Output belongs to another conversation.');
        return JSON.stringify(document);
      }
      if (args.action !== 'publish') throw new Error('Unknown output action.');
      const document = await store.publish(owner, run(), raw, () => !closed && !signal.aborted);
      // Bytes may commit before Stop; never represent an unacknowledged commit as rolled back.
      changed();
      if (closed || signal.aborted)
        throw new Error(
          'Output saved, but its producer stopped before acknowledgement. Reopen Outputs to inspect it.',
        );
      const receipt = {
        id: document.record.id,
        versionId: document.version.id,
        state: document.state,
        title: document.record.title,
        sha256: document.version.sha256,
      };
      return {
        __typedOutcome: true,
        status: 'ok',
        confidence: 'high',
        text: JSON.stringify(receipt),
        presentation: [
          {
            kind: 'output',
            id: randomUUID(),
            outputId: receipt.id,
            versionId: receipt.versionId,
            title: receipt.title,
          },
        ],
      };
    },
    close() {
      closed = true;
    },
  };
}
export function combineBindings(...bindings: (EmbeddedToolsBinding | undefined)[]): EmbeddedToolsBinding {
  const active = bindings.filter((v): v is EmbeddedToolsBinding => !!v);
  const tools = active.flatMap((b) => b.tools);
  if (new Set(tools.map((t) => t.name)).size !== tools.length)
    throw new Error('Duplicate embedded tool name.');
  return {
    tools,
    execute(name, args, signal) {
      const binding = active.find((b) => b.tools.some((t) => t.name === name));
      if (!binding) throw new Error('Unknown embedded tool.');
      return binding.execute(name, args, signal);
    },
    close() {
      active.forEach((b) => b.close());
    },
  };
}
