import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The engine is deliberately NOT a build input here.
 *
 * Adding `../src/index.ts` as a second `main` entry bundles cleanly (14.4 MB, no build errors) and
 * still does not work: the engine uses a bare CJS `require('./relative/path')` in 79 places for lazy
 * and cycle-breaking loads, and rollup leaves `require` untouched in an ESM source. Measured on the
 * produced bundle: ~30 distinct source-relative specifiers survive unrewritten and then resolve
 * against out/main/chunks/ at runtime, where nothing of that name exists. `require('./boot.status')`
 * in protocol/headless.entry.ts is the one that fires first, four lines into headless boot.
 *
 * Converting those 79 call sites to static imports is not a rename — several are lazy precisely to
 * break an import cycle, so hoisting them changes evaluation order in the container and the agent
 * loop. The engine is therefore compiled by `tsc` to dist/ instead, where the module graph is
 * preserved and every one of those requires resolves exactly as written. That is also the layout
 * core/subagent.manager.ts already reaches for (dist/engine/worker.entry.js).
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    // The renderer imports the engine's wire contract (src/protocol/protocol.ts) and evidence
    // vocabulary (src/evidence/schema.ts) DIRECTLY — one definition, no generated mirror. Both sit
    // above this config's root, so the dev server has to be told they are inside the project.
    // Production builds don't care; `npm run dev` 403s without it.
    server: { fs: { allow: [resolve(__dirname, '..')] } },
  },
});
