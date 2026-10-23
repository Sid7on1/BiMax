import { useContext } from 'react';
import React, { useEffect, useMemo, useState } from 'react';
import {
  Streamdown,
  defaultComponents,
  defaultRehypePlugins,
  defaultRemarkPlugins,
  type Components,
  type PluginConfig,
} from 'streamdown';
import hljs from 'highlight.js/lib/common';
import { Copy, Check } from 'lucide-react';
import { PathLinkContext, looksLikePath } from './path.links';
import { copyText } from './copy.text';
import 'katex/dist/katex.min.css';

let loadedMath: PluginConfig['math'];
let loadingMath: Promise<void> | undefined;
let loadedCode: PluginConfig['code'];
let loadedMermaid: PluginConfig['mermaid'];
let loadingCode: Promise<void> | undefined;
let loadingMermaid: Promise<void> | undefined;
// Raw HTML remains visible text, as in Bimax's original renderer. Never enable rehype-raw.
function literalHtml() {
  return (tree: any) => {
    const walk = (node: any) => {
      if (node.type === 'html') node.type = 'text';
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}
const rehypePlugins = [defaultRehypePlugins.sanitize];
const remarkPluginsExtra = literalHtml;
const safeUrl = (url: string) => (/^(https?:\/\/|#[\w:-]+)/i.test(url) ? url : '');
function RichInlineCode(props: any): React.ReactElement {
  const links = useContext(PathLinkContext);
  const value = typeof props.children === 'string' ? props.children : '';
  if (!props.className && !value.includes('\n') && links && looksLikePath(value)) {
    return (
      <button
        type="button"
        className="md-path"
        title="Open with Quick Look · ⌘-click to show in Finder"
        onClick={(e) => links.open(value, e.metaKey ? 'reveal' : 'preview')}
      >
        {value}
      </button>
    );
  }
  return React.createElement(defaultComponents.code, props);
}
function ControlledImage({ src, alt }: any): React.ReactElement {
  // Rendering model-authored URLs must never send automatic tracking/network requests.
  if (
    typeof src === 'string' &&
    /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(src) &&
    src.length < 2_800_000
  )
    return <img src={src} alt={alt || 'Output image'} className="rich-image" loading="lazy" />;
  return (
    <span className="rich-media-placeholder">
      {alt || 'Image'}
      {typeof src === 'string' && /^https?:\/\//i.test(src) ? (
        <>
          {' '}
          ·{' '}
          <a href={src} target="_blank" rel="noreferrer">
            Open image link
          </a>
        </>
      ) : (
        ' · image unavailable'
      )}
    </span>
  );
}
function RichPre(props: any): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const [keepState, setKeepState] = useState('');
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const child = props.node?.children?.find((node: any) => node.tagName === 'code');
  const code = child?.children?.map((node: any) => node.value || '').join('');
  const language =
    child?.properties?.className?.find((value: string) => value.startsWith('language-'))?.slice(9) || '';
  return (
    <div className="rich-code-output">
      {React.createElement(defaultComponents.pre, props)}
      {typeof code === 'string' && code.length <= 192 * 1024 && (
        <>
          <button
            type="button"
            className="keep-output"
            title="Copy Code"
            aria-label="Copy Code"
            onClick={() => void copyText(code).then((ok) => setCopied(ok))}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>{' '}
          <button
            type="button"
            className="keep-output"
            disabled={keepState === 'Saving…'}
            title={keepState}
            onClick={() => {
              setKeepState('Saving…');
              window.dispatchEvent(
                new CustomEvent('bimax:keep-output', {
                  detail: {
                    key: crypto.randomUUID(),
                    content: code,
                    language,
                    complete: (error?: string) => setKeepState(error || 'Saved'),
                  },
                }),
              );
            }}
          >
            {keepState === 'Saving…' ? keepState : keepState === 'Saved' ? 'Saved' : 'Keep output'}
          </button>
          {keepState && !['Saving…', 'Saved'].includes(keepState) && (
            <span role="alert" className="output-error">
              {keepState}
            </span>
          )}
        </>
      )}
    </div>
  );
}
const components: Components = {
  code: RichInlineCode,
  pre: RichPre,
  a: ({ href, children }: any) =>
    href && safeUrl(href) ? (
      <a href={href} target={href.startsWith('#') ? undefined : '_blank'} rel="noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ControlledImage,
  h1: ({ children }: any) => <h3 className="md-h md-h1">{children}</h3>,
  h2: ({ children }: any) => <h4 className="md-h md-h2">{children}</h4>,
};
const mermaidOptions = {
  config: {
    securityLevel: 'strict' as const,
    startOnLoad: false,
    maxTextSize: 50_000,
    maxEdges: 500,
    flowchart: { htmlLabels: false },
  },
};

/** Streaming and saved answers share one safe renderer; completed blocks keep stable identities. */
export const Markdown = React.memo(function Markdown({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}): React.ReactElement {
  const [, invalidate] = useState(0);
  const wantsMath = /\$|\\\[|\\\(/.test(text);
  const wantsCode = /(?:^|\n)```/.test(text);
  const wantsMermaid = /(?:^|\n)```mermaid\b/.test(text);
  useEffect(() => {
    let live = true;
    const changed = () => {
      if (live) invalidate((v) => v + 1);
    };
    if (wantsMath && !loadedMath) {
      loadingMath ??= import('@streamdown/math').then((m) => {
        loadedMath = m.createMathPlugin({ singleDollarTextMath: true });
      });
      void loadingMath.then(changed).catch(() => {});
    }
    if (wantsCode && !loadedCode) {
      loadingCode ??= import('@streamdown/code').then((m) => {
        loadedCode = m.code;
      });
      void loadingCode.then(changed).catch(() => {});
    }
    if (wantsMermaid && !loadedMermaid) {
      loadingMermaid ??= import('@streamdown/mermaid').then((m) => {
        loadedMermaid = m.createMermaidPlugin(mermaidOptions);
      });
      void loadingMermaid.then(changed).catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [wantsCode, wantsMermaid, wantsMath]);
  const plugins = useMemo(
    () => ({ math: loadedMath, code: loadedCode, mermaid: loadedMermaid }),
    [loadedCode, loadedMermaid, loadedMath],
  );
  const remarkPlugins = useMemo(() => [...Object.values(defaultRemarkPlugins), remarkPluginsExtra], []);
  return (
    <div className="md rich-markdown">
      <Streamdown
        mode={streaming ? 'streaming' : 'static'}
        isAnimating={streaming}
        animated={false}
        components={components}
        plugins={plugins}
        rehypePlugins={rehypePlugins}
        remarkPlugins={remarkPlugins}
        urlTransform={(url, key) => (key === 'src' ? url : safeUrl(url))}
        mermaid={mermaidOptions}
        lineNumbers={false}
        linkSafety={{ enabled: false }}
        controls={{
          code: { copy: false, download: false },
          table: { copy: true, download: true },
          mermaid: true,
        }}
      >
        {text}
      </Streamdown>
    </div>
  );
});

export function CodeBlock({ code, lang }: { code: string; lang: string }): React.ReactElement {
  const [copied, setCopied] = useState(false);
  // Copy feedback and unrelated parent updates must not run language detection again.
  const html = useMemo(() => {
    try {
      return lang && hljs.getLanguage(lang)
        ? hljs.highlight(code, { language: lang }).value
        : hljs.highlightAuto(code).value;
    } catch {
      return '';
    }
  }, [code, lang]);
  const copy = (): void => {
    void copyText(code).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
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
