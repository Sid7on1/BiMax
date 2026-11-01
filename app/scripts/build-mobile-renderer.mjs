import { build } from 'esbuild';
import { compile, optimize } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { mobileLink } from './mobile.integration.mjs';
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mobile = mobileLink().mobileRoot;
const target = path.join(mobile, 'apps/mobile/generated/chat-renderer.json');
const options = { absWorkingDir: app, bundle: true, write: false, minify: true, platform: 'browser', format: 'iife', target: 'safari16', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' }, legalComments: 'inline', metafile: true, outfile: 'renderer.js' };
const inputs = new Set();
function collect(result) { for (const name of Object.keys(result.metafile.inputs)) if (!name.startsWith('<') && !name.startsWith('offline:')) inputs.add(path.resolve(app, name)); }
const base = await build({ ...options, entryPoints: ['src/mobile-renderer/index.tsx'], plugins: [{ name: 'offline-plugins', setup(b) {
 b.onResolve({filter:/^\.\/markdown\.addons$/},()=>({path:'addons',namespace:'offline'}));
 b.onLoad({filter:/.*/,namespace:'offline'},()=>({contents:`export const loadFormula=()=>window.BimaxTranscript.plugin('math');export const loadDiagram=()=>window.BimaxTranscript.plugin('mermaid');`,loader:'ts'}));
 b.onLoad({filter:/katex\.min\.css$/},()=>({contents:'',loader:'css'}));
}}] });
collect(base);
const parts = (r, ext) => r.outputFiles.filter((f) => f.path.endsWith(ext)).map((f) => f.text).join('\n');
const plugins = {};
for (const name of ['math','mermaid']) {
 const fn=name==='math'?'loadFormula':'loadDiagram';
 const result=await build({...options,stdin:{contents:`import {${fn}} from './src/renderer/src/markdown.addons';${name==='math'?"import 'katex/dist/katex.min.css';":''}${fn}().then(p=>window.BimaxTranscript.registerPlugin('${name}',p));`,resolveDir:app,loader:'ts'}});
 collect(result);plugins[name]={js:parts(result,'.js'),css:parts(result,'.css')};
}
const styles = readFileSync(path.join(app,'src/renderer/src/styles.css'),'utf8');
const dark = styles.match(/\.theme-moonlight\s*\{([\s\S]*?--color-bg:[\s\S]*?)\n\}/)[1];
const tokens = Object.fromEntries([...dark.matchAll(/(--color-[\w-]+):\s*(#[\da-f]+)/gi)].map((m)=>[m[1],m[2]]));
// Use the same Tailwind compiler and Streamdown utility source as the Mac build.
const classicStart=styles.indexOf('@layer components {\n  /* Generated chat content');
const classicEnd=styles.indexOf('\n@utility no-drag',classicStart);
if(classicStart<0||classicEnd<0)throw Error('Classic chat styles moved; update extraction');
const classicCss=styles.slice(classicStart,classicEnd);
const compiler = await compile(`@import "tailwindcss"; @theme { --font-mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace; --color-border:var(--color-line);--color-muted-foreground:var(--color-dim);--color-muted:var(--color-hover);--color-background:var(--color-bg);--color-foreground:var(--color-ink);--color-primary:var(--color-ink); --color-faint:${tokens["--color-faint"]};--color-dim:${tokens["--color-dim"]};--color-ink:${tokens["--color-ink"]};--color-ember:${tokens["--color-ember"]};--color-hover:${tokens["--color-hover"]}; } ${classicCss}`, {base:app,onDependency:(f)=>inputs.add(f)});
const scanner = new Scanner({sources:[{base:path.join(app,'src/renderer/src'),pattern:'markdown.tsx',negated:false},{base:path.join(app,'node_modules/streamdown/dist'),pattern:'**/*.js',negated:false},{base:path.join(app,'src/renderer/src/components'),pattern:'{ConversationMessage,ThinkingIndicator}.tsx',negated:false}]});
const utilityCss = optimize(compiler.build(scanner.scan()),{minify:true}).code;
for (const f of scanner.files) inputs.add(f);
const thinkingStart=styles.indexOf('.thinking-verb {');
const thinkingEnd=styles.indexOf('/* ══ ⌘2',thinkingStart);
if(thinkingStart<0||thinkingEnd<0)throw Error('Desktop thinking styles changed; update the shared renderer contract');
const thinkingCss=styles.slice(thinkingStart,thinkingEnd)+(styles.match(/:root\[data-render-mode='quiet'\] \.thinking-verb \{[\s\S]*?\}/)?.[0]??'');
const fontPath=path.join(app,'node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2');
const fontLicensePath=path.join(app,'node_modules/@fontsource-variable/inter/LICENSE');
inputs.add(fontPath);inputs.add(fontLicensePath);
const licenses={Inter:readFileSync(fontLicensePath,'utf8')};
const font = readFileSync(fontPath).toString('base64');
const codeTheme=styles.slice(styles.indexOf(':root, .theme-moonlight {\n  --code-ink'),styles.indexOf('\n.theme-starlight {',styles.indexOf(':root, .theme-moonlight {\n  --code-ink')));
const css = `@font-face{font-family:'Inter Variable';font-style:normal;font-weight:100 900;src:url(data:font/woff2;base64,${font}) format('woff2')} :root{${Object.entries(tokens).map(([k,v])=>`${k}:${v}`).join(';')};--code-block:rgba(0,0,0,.22)}${codeTheme}${utilityCss}${parts(base,'.css')}${thinkingCss}`;
const nonce = 'bimax-offline-renderer';
const script = parts(base,'.js').replace(/<\/script/gi,'<\\/script');
const html = `<!doctype html><html class="theme-moonlight"><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=5"><meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'nonce-${nonce}' 'wasm-unsafe-eval';style-src 'unsafe-inline';font-src data:;img-src data:;connect-src 'none';object-src 'none';frame-src 'none';base-uri 'none';form-action 'none'"><style>${css}</style></head><body><div id="root"></div><script nonce="${nonce}">${script}</script></body></html>`;
inputs.add(path.join(app,'src/renderer/src/markdown.addons.ts')); inputs.add(path.join(app,'src/renderer/src/styles.css')); inputs.add(fileURLToPath(import.meta.url)); inputs.add(path.join(app,'package-lock.json'));
const sha = value=>createHash('sha256').update(value).digest('hex');
const sources = Object.fromEntries([...inputs].sort().map((f)=>[path.relative(app,f),sha(readFileSync(f))]));
const artifact = JSON.stringify({ schema:1, sources, hash:sha(html+JSON.stringify(plugins)), licenses, tokens, nonce, html, plugins });
if (process.argv.includes('--check')) {
  if (!existsSync(target) || readFileSync(target,'utf8') !== artifact) throw new Error('Phone renderer is stale. Run app/scripts/build-mobile-renderer.mjs in the linked Desktop repository.');
} else { mkdirSync(path.dirname(target),{recursive:true}); writeFileSync(target,artifact); writeFileSync(path.join(mobile,'.bimax-desktop-link.json'),JSON.stringify({desktopRoot:path.dirname(app)})); }
console.log(JSON.stringify({target,hash:sha(html+JSON.stringify(plugins)),baseBytes:Buffer.byteLength(html),plugins:Object.fromEntries(Object.entries(plugins).map(([k,v])=>[k,Buffer.byteLength(v.js+v.css)]))}));
