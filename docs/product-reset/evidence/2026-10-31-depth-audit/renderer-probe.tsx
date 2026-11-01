import React, { useState } from '../../../../app/node_modules/react';
import { createRoot } from '../../../../app/node_modules/react-dom/client';
import { flushSync } from '../../../../app/node_modules/react-dom';
import { marked } from '../../../../app/node_modules/marked/lib/marked.esm.js';
import { Markdown } from '../../../../app/src/renderer/src/markdown';

const host = window as any;
const lexer = marked.lexer.bind(marked);
host.audit = { charsLexed: 0, lexCalls: 0, lexMs: 0 };
marked.lexer = ((...args: Parameters<typeof marked.lexer>) => {
  const start = performance.now();
  const result = lexer(...args);
  host.audit.charsLexed += args[0].length;
  host.audit.lexCalls++;
  host.audit.lexMs += performance.now() - start;
  return result;
}) as typeof marked.lexer;
function Fixture() {
  const [text, setText] = useState('');
  host.audit.render = (value: string) => flushSync(() => setText(value));
  return <Markdown text={text} streaming />;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
