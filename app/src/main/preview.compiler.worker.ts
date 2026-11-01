import { parentPort, workerData } from 'node:worker_threads';
import { build } from 'esbuild';
import { PREVIEW_IMPORTS } from './preview.policy';
void (async () => {
  try {
    const result = await build({
      stdin: {
        contents:
          'import Component from "bimax:component"; import React from "react"; import {createRoot} from "react-dom/client"; createRoot(document.getElementById("root")).render(React.createElement(Component));',
        loader: 'tsx',
        sourcefile: 'output.tsx',
        resolveDir: workerData.resolveDir,
      },
      bundle: true,
      write: false,
      format: 'iife',
      globalName: 'BimaxOutput',
      platform: 'browser',
      jsx: 'automatic',
      target: 'es2022',
      minify: true,
      define: { 'process.env.NODE_ENV': '"production"' },
      plugins: [
        {
          name: 'catalog',
          setup(api) {
            api.onResolve({ filter: /.*/ }, (args) => {
              if (args.pluginData?.catalog) return undefined;
              if (
                args.path === 'bimax:component' &&
                args.namespace === 'file' &&
                args.importer.endsWith('/output.tsx')
              )
                return { path: 'output.tsx', namespace: 'component' };
              if (args.namespace === 'component' && !PREVIEW_IMPORTS.has(args.path))
                return {
                  errors: [{ text: `Import denied: ${args.path}. Available: react, react-dom/client.` }],
                };
              if (PREVIEW_IMPORTS.has(args.path))
                return api.resolve(args.path, {
                  resolveDir: workerData.resolveDir,
                  kind: args.kind,
                  pluginData: { catalog: true },
                });
              return undefined;
            });
            api.onLoad({ filter: /.*/, namespace: 'component' }, () => ({
              contents: workerData.content,
              loader: 'tsx',
              resolveDir: workerData.resolveDir,
            }));
          },
        },
      ],
    });
    parentPort?.postMessage({ code: result.outputFiles[0].text });
  } catch (error) {
    parentPort?.postMessage({ error: String(error) });
  }
})();
