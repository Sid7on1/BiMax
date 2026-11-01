import React, { useState } from '../../../../app/node_modules/react';
import { createRoot } from '../../../../app/node_modules/react-dom/client';
import { flushSync } from '../../../../app/node_modules/react-dom';
import { marked } from '../../../../app/node_modules/marked/lib/marked.esm.js';
import hljs from '../../../../app/node_modules/highlight.js/lib/common';
import { Markdown, CodeBlock } from '../../../../app/src/renderer/src/markdown';
import { PathLinkContext } from '../../../../app/src/renderer/src/path.links';
import { useEngine } from '../../../../app/src/renderer/src/useEngine';
import { initialEngineState } from '../../../../app/src/renderer/src/engine.state';

const host = window as any;
const callbacks = { messages: new Set<Function>(), states: new Set<Function>(), projects: new Set<Function>(), selected: new Set<Function>() };
const subscribe = (set: Set<Function>, callback: Function) => { set.add(callback); return () => set.delete(callback); };
const requests: any[] = [];
const clipboard: string[] = [];
const metrics = { lex: 0, highlight: 0 };
const lexer = marked.lexer.bind(marked);
marked.lexer = ((...args: Parameters<typeof marked.lexer>) => { metrics.lex++; return lexer(...args); }) as typeof marked.lexer;
const highlight = hljs.highlightAuto.bind(hljs);
hljs.highlightAuto = (...args) => { metrics.highlight++; return highlight(...args); };
let approvalDone: ((ok: boolean) => void) | undefined;
host.bimax = {
  onMessage: (cb: Function) => subscribe(callbacks.messages, cb),
  onEngineState: (cb: Function) => subscribe(callbacks.states, cb),
  onProject: (cb: Function) => subscribe(callbacks.projects, cb), rendererReady: () => {},
  send: (msg: unknown) => { requests.push(msg); },
  clipboard: { writeText: async (text: string) => { clipboard.push(text); return true; } },
  threads: { onSelected: (cb: Function) => subscribe(callbacks.selected, cb),
    reply: () => new Promise<boolean>(done => { approvalDone = done; }), approvals: async () => [] },
};

const code = Array.from({ length: 200 }, (_, i) => `const value${i} = ${i}; // fixture only`).join('\n');
const original = `# Saved chat\n\nA **verified** answer with \`src/file.ts\`.\n\n\`\`\`\n${code}\n\`\`\``;
let engine: ReturnType<typeof useEngine>;
function Fixture() {
  const [tick, setTick] = useState(0);
  const [text, setText] = useState(original);
  const [lang, setLang] = useState('');
  const [sampleCode, setSampleCode] = useState('<img src=x onerror=alert(1)>\nconst safe = true;');
  const [linkVersion, setLinkVersion] = useState(0);
  engine = useEngine();
  host.probe = {
    metrics, clipboard, requests,
    listeners: () => callbacks.messages.size,
    emit: (kind: keyof typeof callbacks, ...args: any[]) => { for (const cb of callbacks[kind]) cb(...args); },
    renderSame: () => flushSync(() => setTick(value => value + 1)),
    changeText: () => flushSync(() => setText('A different **chat**.')),
    changeLang: () => flushSync(() => setLang('plaintext')),
    changeCode: () => flushSync(() => setSampleCode('function changed() { return "fresh chat"; }')),
    changeLink: () => flushSync(() => setLinkVersion(value => value + 1)),
    replyDone: (ok: boolean) => approvalDone?.(ok),
    engine: () => engine,
  };
  return <div>
    <label>Composer <input id="composer" defaultValue="kept draft" /></label>
    <output id="status">{tick}</output>
    <output id="thread">{engine.state.threadId}</output>
    <output id="approval">{engine.state.request?.id}</output>
    <PathLinkContext.Provider value={{ open: () => { host.lastLink = linkVersion; } }}>
      <section id="markdown"><Markdown text={text} /></section>
    </PathLinkContext.Provider>
    <section id="standalone"><CodeBlock code={sampleCode} lang={lang} /></section>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
host.selectChat = (id: string) => {
  for (const cb of callbacks.selected) cb({ id, state: { ...initialEngineState, threadId: id } });
};
