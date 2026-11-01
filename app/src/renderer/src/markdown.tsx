import { useContext } from 'react';
import { PathLinkContext, looksLikePath } from './path.links';
import React, { createContext, memo, useEffect, useMemo, useRef, useState } from 'react';
import { marked, Token, Tokens } from 'marked';
import hljs from 'highlight.js/lib/common';
import { Copy, Check } from 'lucide-react';
import { copyText } from './copy.text';
import { loadFormula, loadDiagram } from './markdown.addons';
import 'katex/dist/katex.min.css';
import './markdown.classic.css';

/**
 * Full markdown for chat messages: marked's lexer produces tokens, and we render tokens straight
 * to React nodes — never raw HTML, so there is no injection surface (`html` tokens render as
 * plain text). Code fences get highlight.js with a copy button; the Moonlight hljs theme lives in
 * styles.css.
 */
export interface MarkdownHost {
  copy(text: string): Promise<boolean>;
  keepOutput: boolean;
}
const desktopHost: MarkdownHost = { copy: copyText, keepOutput: true };
const MarkdownHostContext = createContext<MarkdownHost>(desktopHost);
export const Markdown = memo(function Markdown({
  text,
  streaming = false,
  host,
}: {
  text: string;
  streaming?: boolean;
  host?: MarkdownHost;
}): React.ReactElement {
  const cached = useRef<Token[]>([]);
  const references = useRef('');
  const tokens = useMemo(() => {
    let next: ReturnType<typeof marked.lexer>;
    try {
      next = marked.lexer(text);
    } catch {
      return null;
    }
    const definitions = JSON.stringify(next.links);
    if (definitions !== references.current) {
      cached.current = [];
      references.current = definitions;
    }
    let i = 0;
    while (
      i < cached.current.length &&
      i < next.length &&
      cached.current[i].type === next[i].type &&
      cached.current[i].raw === next[i].raw
    ) {
      next[i] = cached.current[i];
      i++;
    }
    cached.current = next;
    return next;
  }, [text]);
  return (
    <MarkdownHostContext.Provider value={host ?? desktopHost}>
      <div className="md" data-classic-markdown>
        {tokens ? (
          tokens.map((t, i) => <Block key={i} token={t} streaming={streaming} />)
        ) : (
          <span className="md-text whitespace-pre-wrap">{text}</span>
        )}
      </div>
    </MarkdownHostContext.Provider>
  );
});

const Block = memo(function Block({
  token,
  streaming = false,
}: {
  token: Token;
  streaming?: boolean;
}): React.ReactElement | null {
  switch (token.type) {
    case 'heading': {
      const t = token as Tokens.Heading;
      const Tag = `h${Math.min(t.depth + 2, 6)}` as 'h3'; // h1 in chat renders as h3-scale
      return (
        <Tag className={`md-h md-h${t.depth}`}>
          <Inline tokens={t.tokens} />
        </Tag>
      );
    }
    case 'paragraph':
      if (
        (token as Tokens.Paragraph).text.trim().startsWith('$$') &&
        (token as Tokens.Paragraph).text.trim().endsWith('$$')
      )
        return <Formula text={(token as Tokens.Paragraph).text.trim().slice(2, -2)} display />;
      return (
        <p>
          <Inline tokens={(token as Tokens.Paragraph).tokens} />
        </p>
      );
    case 'code':
      if ((token as Tokens.Code).lang === 'mermaid' && !streaming)
        return <Diagram source={(token as Tokens.Code).text} />;
      return (
        <CodeBlock code={(token as Tokens.Code).text} lang={(token as Tokens.Code).lang || ''} streaming={streaming} />
      );
    case 'blockquote':
      return (
        <blockquote className="my-2 border-l-2 border-ember/50 pl-3 text-dim">
          {(token as Tokens.Blockquote).tokens.map((t, i) => (
            <Block key={i} token={t} streaming={streaming} />
          ))}
        </blockquote>
      );
    case 'list': {
      const t = token as Tokens.List;
      const Tag = t.ordered ? 'ol' : 'ul';
      return (
        <Tag className={t.ordered ? 'my-1.5 list-decimal pl-5' : 'my-1.5 list-disc pl-5'}>
          {t.items.map((item, i) => (
            <li key={i} className="my-0.5">
              {item.task ? <span className="mr-1.5 text-faint">{item.checked ? '☑' : '☐'}</span> : null}
              {item.tokens.map((tt, j) =>
                tt.type === 'text' && (tt as Tokens.Text).tokens ? (
                  <Inline key={j} tokens={(tt as Tokens.Text).tokens!} />
                ) : (
                  <Block key={j} token={tt} streaming={streaming} />
                ),
              )}
            </li>
          ))}
        </Tag>
      );
    }
    case 'table': {
      const t = token as Tokens.Table;
      return (
        <div className="my-2 overflow-x-auto rounded-lg border border-line">
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="border-b border-line bg-raise">
                {t.header.map((h, i) => (
                  <th key={i} className="px-3 py-1.5 text-left font-medium text-dim">
                    <Inline tokens={h.tokens} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {t.rows.map((row, i) => (
                <tr key={i} className="border-b border-line/50 last:border-0">
                  {row.map((cell, j) => (
                    <td key={j} className="px-3 py-1.5 align-top">
                      <Inline tokens={cell.tokens} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case 'hr':
      return <hr className="my-3 border-line" />;
    case 'space':
      return null;
    case 'html':
      return <span className="whitespace-pre-wrap">{(token as Tokens.HTML).text}</span>;
    default:
      return 'tokens' in token && Array.isArray((token as { tokens?: Token[] }).tokens) ? (
        <Inline tokens={(token as { tokens: Token[] }).tokens} />
      ) : (
        <span className="whitespace-pre-wrap">{'raw' in token ? String((token as { raw: string }).raw) : ''}</span>
      );
  }
});

/** Inline code. On a surface that provides path links (the ⌘2 bar), a path becomes a link: Quick Look, or ⌘-click for Finder. */
function InlineCode({ code }: { code: string }): React.ReactElement {
  const links = useContext(PathLinkContext);
  if (links && looksLikePath(code)) {
    return (
      <button
        type="button"
        className="md-path rounded border border-line bg-raise px-1 font-mono text-[0.92em]"
        title="Open with Quick Look · ⌘-click to show in Finder"
        onClick={(e) => links.open(code, e.metaKey ? 'reveal' : 'preview')}
      >
        {code}
      </button>
    );
  }
  return <code className="rounded border border-line bg-raise px-1 font-mono text-[0.92em]">{code}</code>;
}

function Inline({ tokens }: { tokens?: Token[] }): React.ReactElement | null {
  if (!tokens) return null;
  return (
    <>
      {tokens.map((t, i) => {
        switch (t.type) {
          case 'text': {
            const tt = t as Tokens.Text;
            return tt.tokens ? (
              <Inline key={i} tokens={tt.tokens} />
            ) : (
              <InlineText
                key={i}
                text={tt.text
                  .replace(/&amp;/g, '&')
                  .replace(/&lt;/g, '<')
                  .replace(/&gt;/g, '>')
                  .replace(/&quot;/g, '"')
                  .replace(/&#39;/g, "'")}
              />
            );
          }
          case 'strong':
            return (
              <strong key={i}>
                <Inline tokens={(t as Tokens.Strong).tokens} />
              </strong>
            );
          case 'em':
            return (
              <em key={i}>
                <Inline tokens={(t as Tokens.Em).tokens} />
              </em>
            );
          case 'del':
            return (
              <del key={i}>
                <Inline tokens={(t as Tokens.Del).tokens} />
              </del>
            );
          case 'codespan':
            return (
              <InlineCode
                key={i}
                code={(t as Tokens.Codespan).text
                  .replace(/&amp;/g, '&')
                  .replace(/&lt;/g, '<')
                  .replace(/&gt;/g, '>')
                  .replace(/&quot;/g, '"')
                  .replace(/&#39;/g, "'")}
              />
            );
          case 'link': {
            const lt = t as Tokens.Link;
            const safe = /^https?:\/\//i.test(lt.href);
            return safe ? (
              <a key={i} href={lt.href} target="_blank" rel="noreferrer">
                <Inline tokens={lt.tokens} />
              </a>
            ) : (
              <span key={i}>
                <Inline tokens={lt.tokens} />
              </span>
            );
          }
          case 'checkbox':
            return null; // The list row owns the task indicator.
          case 'br':
            return <br key={i} />;
          case 'escape':
            return <React.Fragment key={i}>{(t as Tokens.Escape).text}</React.Fragment>;
          default:
            return (
              <span key={i} className="whitespace-pre-wrap">
                {'raw' in t ? String((t as { raw: string }).raw) : ''}
              </span>
            );
        }
      })}
    </>
  );
}

export const CodeBlock = memo(function CodeBlock({
  code,
  lang,
  streaming = false,
}: {
  code: string;
  lang: string;
  streaming?: boolean;
}): React.ReactElement {
  const [copied, setCopied] = useState(false),
    [keepState, setKeepState] = useState('');
  const host = useContext(MarkdownHostContext);
  const keepKey = useRef<string>();
  useEffect(() => {
    keepKey.current = undefined;
    setKeepState('');
  }, [code, lang]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const html = useMemo(() => {
    if (code.length > 128 * 1024 || (streaming && (code.length > 16 * 1024 || !lang || !hljs.getLanguage(lang))))
      return '';
    try {
      return lang && hljs.getLanguage(lang)
        ? hljs.highlight(code, { language: lang }).value
        : hljs.highlightAuto(code).value;
    } catch {
      return '';
    }
  }, [code, lang, streaming]);
  const copy = (): void => {
    void host.copy(code).then((ok) => {
      if (!ok) return;
      setCopied(true);
    });
  };
  return (
    <div className="group relative my-2">
      <pre className="overflow-x-auto rounded-lg border border-line bg-[var(--code-block)] px-3.5 py-3 font-mono text-xs leading-normal whitespace-pre">
        {html ? (
          // hljs output is generated from escaped text by our own local library — not remote HTML.
          <code dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <code>{code}</code>
        )}
      </pre>
      <div className="absolute top-1.5 right-2 flex items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100">
        {lang ? <span className="text-[10px] text-faint uppercase">{lang}</span> : null}
        <button
          title="Copy code"
          aria-label="Copy code"
          onClick={copy}
          className="flex size-6 cursor-pointer items-center justify-center rounded border border-line bg-raise text-dim hover:text-ink"
        >
          {copied ? <Check size={12} className="text-moss" /> : <Copy size={12} />}
        </button>
        {host.keepOutput && !streaming && code.length <= 192 * 1024 && (
          <button
            className="classic-keep-output text-[10px] text-faint"
            disabled={keepState === 'Saving…' || keepState === 'Saved'}
            onClick={() => {
              const key = (keepKey.current ??= crypto.randomUUID());
              setKeepState('Saving…');
              window.dispatchEvent(
                new CustomEvent('bimax:keep-output', {
                  detail: {
                    key,
                    content: code,
                    language: lang,
                    complete: (error?: string) => {
                      if (keepKey.current === key) setKeepState(error || 'Saved');
                    },
                  },
                }),
              );
            }}
          >
            {keepState || 'Keep output'}
          </button>
        )}
      </div>
    </div>
  );
});

let formulaRuntime: Promise<Awaited<ReturnType<typeof loadFormula>>> | undefined;
let diagramSerial = 0;
let diagramRuntime: Promise<Awaited<ReturnType<typeof loadDiagram>>> | undefined;
function Formula({ text, display = false }: { text: string; display?: boolean }) {
  const [html, setHtml] = useState('');
  useEffect(() => {
    let active = true;
    if (text.length > 8192) return;
    formulaRuntime ??= loadFormula();
    void formulaRuntime
      .then((api) => {
        const rendered = api.renderToString(text, {
          displayMode: display,
          throwOnError: false,
          trust: false,
          maxExpand: 1000,
        });
        if (active) setHtml(rendered);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [text, display]);
  const Tag = display ? 'div' : 'span';
  return html ? (
    <Tag className={display ? 'classic-math-display' : undefined} dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <Tag>
      {display ? '$$' : '$'}
      {text}
      {display ? '$$' : '$'}
    </Tag>
  );
}
function InlineText({ text }: { text: string }) {
  const nodes: React.ReactNode[] = [];
  let from = 0,
    i = 0;
  while (i < text.length) {
    if (text[i] !== '$' || (i > 0 && text[i - 1] === '\\')) {
      i++;
      continue;
    }
    let end = i + 1;
    while (end < text.length && (text[end] !== '$' || text[end - 1] === '\\') && text[end] !== '\n') end++;
    if (
      end >= text.length ||
      text[end] !== '$' ||
      end === i + 1 ||
      /\s/.test(text[i + 1]) ||
      /\s/.test(text[end - 1])
    ) {
      i++;
      continue;
    }
    nodes.push(text.slice(from, i), <Formula key={i} text={text.slice(i + 1, end)} />);
    i = end + 1;
    from = i;
  }
  nodes.push(text.slice(from));
  return <>{nodes}</>;
}
const Diagram = memo(function Diagram({ source }: { source: string }) {
  const [svg, setSvg] = useState(''),
    [id] = useState(() => `diagram-${++diagramSerial}`);
  useEffect(() => {
    let active = true;
    if (source.length > 50000) return;
    diagramRuntime ??= loadDiagram();
    void diagramRuntime
      .then((api) => api.render(id, source))
      .then((result) => {
        if (active) setSvg(result.svg);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [id, source]);
  return svg ? (
    <div className="classic-diagram" dangerouslySetInnerHTML={{ __html: svg }} />
  ) : (
    <CodeBlock code={source} lang="mermaid" />
  );
});

/** Unified-diff body with +/- line tinting (for kind:'diff' approval requests). */
export function DiffView({ diff }: { diff: string }): React.ReactElement {
  return (
    <pre className="mb-3.5 max-h-[40vh] overflow-auto rounded-lg border border-line bg-well px-3 py-2.5 font-mono text-xs leading-normal">
      {diff.split('\n').map((line, i) => {
        let cls = '';
        if (line.startsWith('+') && !line.startsWith('+++')) cls = 'bg-moss/15 text-moss';
        else if (line.startsWith('-') && !line.startsWith('---')) cls = 'bg-rust/15 text-rust';
        else if (line.startsWith('@@')) cls = 'text-ember';
        return (
          <div className={cls} key={i}>
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}
