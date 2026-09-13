import { useContext } from 'react';
import { PathLinkContext, looksLikePath } from './path.links';
import React, { useState } from 'react';
import { marked, Token, Tokens } from 'marked';
import hljs from 'highlight.js/lib/common';
import { Copy, Check } from 'lucide-react';

/**
 * Full markdown for chat messages: marked's lexer produces tokens, and we render tokens straight
 * to React nodes — never raw HTML, so there is no injection surface (`html` tokens render as
 * plain text). Code fences get highlight.js with a copy button; the Moonlight hljs theme lives in
 * styles.css.
 */
export function Markdown({ text }: { text: string }): React.ReactElement {
  let tokens: Token[];
  try {
    tokens = marked.lexer(text);
  } catch {
    return <div className="md whitespace-pre-wrap">{text}</div>;
  }
  return <div className="md">{tokens.map((t, i) => <Block key={i} token={t} />)}</div>;
}

function Block({ token }: { token: Token }): React.ReactElement | null {
  switch (token.type) {
    case 'heading': {
      const t = token as Tokens.Heading;
      const Tag = (`h${Math.min(t.depth + 2, 6)}`) as 'h3'; // h1 in chat renders as h3-scale
      return <Tag className={`md-h md-h${t.depth}`}><Inline tokens={t.tokens} /></Tag>;
    }
    case 'paragraph':
      return <p><Inline tokens={(token as Tokens.Paragraph).tokens} /></p>;
    case 'code':
      return <CodeBlock code={(token as Tokens.Code).text} lang={(token as Tokens.Code).lang || ''} />;
    case 'blockquote':
      return (
        <blockquote className="my-2 border-l-2 border-ember/50 pl-3 text-dim">
          {(token as Tokens.Blockquote).tokens.map((t, i) => <Block key={i} token={t} />)}
        </blockquote>
      );
    case 'list': {
      const t = token as Tokens.List;
      const Tag = t.ordered ? 'ol' : 'ul';
      return (
        <Tag className={t.ordered ? 'my-1.5 list-decimal pl-5' : 'my-1.5 list-disc pl-5'}>
          {t.items.map((item, i) => (
            <li key={i} className="my-0.5">
              {item.task ? (
                <span className="mr-1.5 text-faint">{item.checked ? '☑' : '☐'}</span>
              ) : null}
              {item.tokens.map((tt, j) =>
                tt.type === 'text' && (tt as Tokens.Text).tokens
                  ? <Inline key={j} tokens={(tt as Tokens.Text).tokens!} />
                  : <Block key={j} token={tt} />,
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
      return 'tokens' in token && Array.isArray((token as { tokens?: Token[] }).tokens)
        ? <Inline tokens={(token as { tokens: Token[] }).tokens} />
        : <span className="whitespace-pre-wrap">{'raw' in token ? String((token as { raw: string }).raw) : ''}</span>;
  }
}

/** Inline code. On a surface that provides path links (the ⌘2 bar), a path becomes a link: Quick Look, or ⌘-click for Finder. */
function InlineCode({ code }: { code: string }): React.ReactElement {
  const links = useContext(PathLinkContext);
  if (links && looksLikePath(code)) {
    return (
      <button type="button" className="md-path rounded border border-line bg-raise px-1 font-mono text-[0.92em]" title="Open with Quick Look · ⌘-click to show in Finder" onClick={(e) => links.open(code, e.metaKey ? 'reveal' : 'preview')}>
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
            return tt.tokens ? <Inline key={i} tokens={tt.tokens} /> : <React.Fragment key={i}>{tt.text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")}</React.Fragment>;
          }
          case 'strong':
            return <strong key={i}><Inline tokens={(t as Tokens.Strong).tokens} /></strong>;
          case 'em':
            return <em key={i}><Inline tokens={(t as Tokens.Em).tokens} /></em>;
          case 'del':
            return <del key={i}><Inline tokens={(t as Tokens.Del).tokens} /></del>;
          case 'codespan':
            return <InlineCode key={i} code={(t as Tokens.Codespan).text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")} />;
          case 'link': {
            const lt = t as Tokens.Link;
            const safe = /^https?:\/\//i.test(lt.href);
            return safe ? (
              <a key={i} href={lt.href} target="_blank" rel="noreferrer">
                <Inline tokens={lt.tokens} />
              </a>
            ) : (
              <span key={i}><Inline tokens={lt.tokens} /></span>
            );
          }
          case 'br':
            return <br key={i} />;
          case 'escape':
            return <React.Fragment key={i}>{(t as Tokens.Escape).text}</React.Fragment>;
          default:
            return <span key={i} className="whitespace-pre-wrap">{'raw' in t ? String((t as { raw: string }).raw) : ''}</span>;
        }
      })}
    </>
  );
}

export function CodeBlock({ code, lang }: { code: string; lang: string }): React.ReactElement {
  const [copied, setCopied] = useState(false);
  let html = '';
  try {
    html = lang && hljs.getLanguage(lang)
      ? hljs.highlight(code, { language: lang }).value
      : hljs.highlightAuto(code).value;
  } catch {
    html = '';
  }
  const copy = (): void => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="group relative my-2">
      <pre className="overflow-x-auto rounded-lg border border-line bg-well px-3.5 py-3 font-mono text-xs leading-normal whitespace-pre">
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
          onClick={copy}
          className="flex size-6 cursor-pointer items-center justify-center rounded border border-line bg-raise text-dim hover:text-ink"
        >
          {copied ? <Check size={12} className="text-moss" /> : <Copy size={12} />}
        </button>
      </div>
    </div>
  );
}

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
