import { globalCommandRegistry } from './registry';
import {
  doclingAvailable, installDocling, doclingVenv, helperScript as doclingHelper,
} from '../../documents/docling';
import {
  visualRetrievalAvailable, installVisualRetrieval, colqwenVenv, serverScript,
  isVisualRetrievalRunning, visualRetrievalPort,
} from '../../memory/colqwen.sidecar';
import { findSystemPython } from '../../sidecar/python.env';
import { storageEstimate } from '../../memory/visual.retrieval';

/**
 * `/sidecars` — the optional Python-backed capabilities, and whether they are actually here.
 *
 * Two things in this product are worth more than the built-in path and cost more than it: layout
 * -aware document conversion, and visual page retrieval. Both are Python, both are large, and both
 * are therefore installed only when somebody asks. That combination is exactly the shape that goes
 * wrong silently — a capability that is *supposed* to be optional is indistinguishable from one that
 * failed to install, and the product keeps working either way while quietly doing the lesser thing.
 *
 * So the install is a command a human runs, and the status is a thing a human can read. Neither
 * capability ever provisions itself from a read path: a few hundred megabytes of wheels because
 * someone dropped a PDF would be a surprise on a metered link and an outage on a full disk.
 */

function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

async function status(): Promise<string> {
  const python = await findSystemPython();
  const [docling, visual] = await Promise.all([doclingAvailable(), visualRetrievalAvailable()]);

  const lines = [
    `Python:  ${python ? `${python} found` : 'NOT FOUND — neither capability can be installed'}`,
    '',
    `Docling (layout-aware conversion): ${docling ? 'installed' : 'not installed'}`,
    `  What it adds:  tables recovered as rows instead of a run of adjacent numbers, and reading`,
    `                 order on multi-column pages. The built-in extractors keep working without it.`,
    `  venv:          ${doclingVenv().dir}`,
    `  helper:        ${doclingHelper()}`,
    '',
    `Visual retrieval (ColQwen2):       ${visual ? 'installed' : 'not installed'}`
      + `${isVisualRetrievalRunning() ? ` · running on 127.0.0.1:${visualRetrievalPort()}` : ''}`,
    `  What it adds:  pages searched as images, with no OCR in the path — the failure mode this`,
    `                 removes is a photocopy whose recognizer output is confidently wrong.`,
    `  Costs:         a multi-gigabyte model, and ~${bytes(storageEstimate(1))} of vectors PER PAGE`,
    `                 (${bytes(storageEstimate(10_000))} for 10,000 pages) against ~8.6 KB densely.`,
    `  venv:          ${colqwenVenv().dir}`,
    `  server:        ${serverScript()}`,
  ];

  if (!docling || !visual) {
    lines.push('', 'Install with: /sidecars install docling | /sidecars install visual');
  }
  return lines.join('\n');
}

globalCommandRegistry.register({
  name: '/sidecars',
  aliases: ['/sidecar'],
  category: 'Configuration',
  description: 'Optional Python-backed capabilities — layout conversion and visual page retrieval',
  execute: async (args) => {
    const sub = (args[0] || 'status').toLowerCase();

    if (sub === 'status') {
      return { type: 'message', level: 'info', content: await status() };
    }

    if (sub === 'install') {
      const which = (args[1] || '').toLowerCase();
      if (which !== 'docling' && which !== 'visual') {
        return {
          type: 'message', level: 'error',
          content: 'Usage: /sidecars install <docling|visual>\n\n'
            + 'docling — a few hundred MB of wheels, CPU-only, no GPU needed.\n'
            + 'visual  — pulls torch and a multi-gigabyte model. Wants a GPU to be worth running.',
        };
      }
      if (!(await findSystemPython())) {
        return {
          type: 'message', level: 'error',
          content: 'No python3 on PATH, so neither capability can be installed. Everything else '
            + 'continues to work — these are upgrades to the built-in readers, not requirements.',
        };
      }

      const ok = which === 'docling' ? await installDocling() : await installVisualRetrieval();
      return {
        type: 'message',
        level: ok ? 'success' : 'error',
        content: ok
          ? `Installed.\n\n${await status()}`
          : `Install failed. The log above names the pip error. Nothing was half-enabled — the `
            + `capability reports unavailable and the built-in path is unchanged.`,
      };
    }

    return {
      type: 'message', level: 'error',
      content: 'Usage: /sidecars [status | install <docling|visual>]',
    };
  },
});
