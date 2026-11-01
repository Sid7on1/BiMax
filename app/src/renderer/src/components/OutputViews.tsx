import React, { useEffect, useRef, useState } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { javascript } from '@codemirror/lang-javascript';
import { html } from '@codemirror/lang-html';
import { json } from '@codemirror/lang-json';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';

export function OutputSource({
  content,
  format,
  onChange,
}: {
  content: string;
  format: string;
  onChange: (text: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    change = useRef(onChange);
  change.current = onChange;
  useEffect(() => {
    if (!host.current) return;
    const language = ['table', 'form', 'vega-lite'].includes(format)
      ? json()
      : ['document', 'html'].includes(format)
        ? html()
        : format === 'markdown'
          ? markdown()
          : javascript({ jsx: true, typescript: true });
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: content,
        extensions: [
          basicSetup,
          language,
          EditorView.lineWrapping,
          EditorView.theme({
            '&': { height: '100%', background: 'transparent', color: 'var(--color-ink)' },
            '.cm-scroller': { overflow: 'auto' },
            '.cm-gutters': { background: 'transparent', color: 'var(--color-faint)', border: 'none' },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) change.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    return () => view.destroy();
    // The parent keys this editor by exact saved version. Do not reset the caret on every keystroke.
  }, []);
  return <div className="output-source" ref={host} />;
}

/** Tiptap receives inert, client-owned HTML only. External media and arbitrary attributes are discarded. */
export function documentHtml(source: string): string {
  const template = document.createElement('template');
  template.innerHTML = source;
  const allowed = new Set([
    'P',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'UL',
    'OL',
    'LI',
    'STRONG',
    'EM',
    'S',
    'CODE',
    'PRE',
    'BLOCKQUOTE',
    'BR',
    'HR',
    'TABLE',
    'THEAD',
    'TBODY',
    'TR',
    'TH',
    'TD',
  ]);
  function clean(node: Node): Node {
    if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent || '');
    const fragment = document.createDocumentFragment();
    if (!(node instanceof Element)) return fragment;
    if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'SVG', 'MATH'].includes(node.tagName)) return fragment;
    const target = allowed.has(node.tagName) ? document.createElement(node.tagName.toLowerCase()) : fragment;
    node.childNodes.forEach((child) => target.appendChild(clean(child)));
    return target;
  }
  const result = document.createElement('div');
  template.content.childNodes.forEach((node) => result.appendChild(clean(node)));
  return result.innerHTML;
}
export function OutputDocumentEditor({
  content,
  onChange,
}: {
  content: string;
  onChange: (text: string) => void;
}) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: false }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
    ],
    content: documentHtml(content),
    editorProps: { attributes: { class: 'output-document', 'aria-label': 'Edit output document' } },
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
  });
  return (
    <div>
      <div className="output-toolbar">
        {['bold', 'italic', 'bulletList', 'orderedList'].map((mark) => (
          <button
            key={mark}
            type="button"
            aria-label={mark}
            onClick={() => {
              if (mark === 'bold') editor?.chain().focus().toggleBold().run();
              else if (mark === 'italic') editor?.chain().focus().toggleItalic().run();
              else if (mark === 'bulletList') editor?.chain().focus().toggleBulletList().run();
              else editor?.chain().focus().toggleOrderedList().run();
            }}
          >
            {mark.replace('List', ' list')}
          </button>
        ))}
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}

export function OutputChart({ content, onSelect }: { content: string; onSelect: (text: string) => void }) {
  const chartRef = useRef<any>(null),
    vegaRef = useRef<any>(null);
  let linkedRows: Record<string, unknown>[] = [];
  try {
    const rows = JSON.parse(content)?.data?.values;
    if (
      Array.isArray(rows) &&
      rows.length <= 5000 &&
      rows.every((row) => row && typeof row === 'object' && !Array.isArray(row))
    )
      linkedRows = rows;
  } catch {}
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true,
      view: { finalize: () => void } | undefined;
    setError('');
    void (async () => {
      const spec = JSON.parse(content);
      let count = 0;
      const inspect = (v: unknown, depth = 0) => {
        if (++count > 50_000 || depth > 40) throw new Error('Chart exceeds the local complexity limit.');
        if (!v || typeof v !== 'object') return;
        for (const [key, value] of Object.entries(v)) {
          if (['url', 'href', 'image', 'element'].includes(key))
            throw new Error('Charts use inline data only; external resources are blocked.');
          inspect(value, depth + 1);
        }
      };
      inspect(spec);
      const [vega, lite, interpreter] = await Promise.all([
        import('vega'),
        import('vega-lite'),
        import('vega-interpreter'),
      ]);
      if (!live || !host.current) return;
      vegaRef.current = vega;
      if (linkedRows.length) spec.data = { ...spec.data, name: 'bimax_rows' };
      const theme = getComputedStyle(host.current),
        ink = theme.getPropertyValue('--color-ink').trim() || '#202020',
        dim = theme.getPropertyValue('--color-dim').trim() || '#555',
        line = theme.getPropertyValue('--color-line').trim() || '#ddd';
      const config = {
        ...spec.config,
        axis: {
          ...spec.config?.axis,
          labelColor: dim,
          titleColor: ink,
          gridColor: line,
          domainColor: line,
          tickColor: line,
        },
        legend: { ...spec.config?.legend, labelColor: dim, titleColor: ink },
        title: { ...spec.config?.title, color: ink },
      };
      const runtime = vega.parse(
        lite.compile({
          ...spec,
          config,
          background: 'transparent',
          height: Math.max(100, Math.min(600, typeof spec.height === 'number' ? spec.height : 300)),
          width: Math.max(160, host.current.clientWidth - 70),
        }).spec,
        undefined,
        { ast: true },
      );
      const chart = new vega.View(runtime, {
        renderer: 'svg',
        expr: interpreter.expressionInterpreter,
        loader: {
          ...vega.loader(),
          load: async () => {
            throw new Error('Network data is blocked.');
          },
          sanitize: async () => {
            throw new Error('Chart links are blocked.');
          },
        },
      }).initialize(host.current);
      view = chart;
      chartRef.current = chart;
      await chart.runAsync();
    })().catch((error) => {
      if (live) setError(String(error));
    });
    return () => {
      live = false;
      view?.finalize();
      chartRef.current = null;
    };
  }, [content]);
  return (
    <>
      <div ref={host} className="output-chart" />
      {error && <p role="alert">Chart unavailable: {error}. Source remains available.</p>}
      {linkedRows.length > 0 && (
        <OutputTable
          value={linkedRows}
          onSelect={onSelect}
          onRowsChanged={(indices) => {
            const chart = chartRef.current,
              vega = vegaRef.current;
            if (!chart || !vega) return;
            void chart
              .change(
                'bimax_rows',
                vega
                  .changeset()
                  .remove(() => true)
                  .insert(indices.length ? indices.map((i) => linkedRows[i]) : linkedRows),
              )
              .runAsync()
              .catch((e: unknown) => setError(String(e)));
          }}
        />
      )}
    </>
  );
}

export function OutputTable({
  value,
  onSelect,
  onRowsChanged,
}: {
  value: unknown;
  onSelect: (text: string) => void;
  onRowsChanged?: (indices: number[]) => void;
}) {
  const [sort, setSort] = useState(''),
    [selected, setSelected] = useState<number[]>([]);
  if (
    !Array.isArray(value) ||
    value.length > 5000 ||
    value.some((row) => !row || typeof row !== 'object' || Array.isArray(row))
  )
    return <p>Use an array of at most 5,000 row objects. Source remains available.</p>;
  const rows = value as Record<string, unknown>[];
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))].slice(0, 30);
  const indexed = rows.map((row, index) => ({ row, index }));
  if (sort)
    indexed.sort((a, b) =>
      typeof a.row[sort] === 'number' && typeof b.row[sort] === 'number'
        ? Number(a.row[sort]) - Number(b.row[sort])
        : String(a.row[sort] ?? '').localeCompare(String(b.row[sort] ?? '')),
    );
  return (
    <>
      <div className="output-toolbar">
        <span>
          {rows.length} rows · {selected.length} selected
        </span>
        <button
          disabled={!selected.length}
          onClick={() => onSelect(JSON.stringify(selected.map((i) => rows[i])).slice(0, 12000))}
        >
          Ask about selected rows
        </button>
      </div>
      <div className="output-table">
        <table>
          <thead>
            <tr>
              <th>Select</th>
              {keys.map((key) => (
                <th key={key}>
                  <button onClick={() => setSort(key)}>
                    {key}
                    {sort === key ? ' ↑' : ''}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {indexed.map(({ row, index }) => (
              <tr key={index}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Select row ${index + 1}`}
                    checked={selected.includes(index)}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...selected, index]
                        : selected.filter((i) => i !== index);
                      setSelected(next);
                      onRowsChanged?.(next);
                    }}
                  />
                </td>
                {keys.map((key) => (
                  <td key={key}>
                    {typeof row[key] === 'object' ? JSON.stringify(row[key]) : String(row[key] ?? '')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
export function OutputForm({ content, onSelect }: { content: string; onSelect: (text: string) => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  let fields: any[];
  try {
    fields = JSON.parse(content).fields;
    if (
      !Array.isArray(fields) ||
      fields.length > 20 ||
      fields.some(
        (f) =>
          !f ||
          typeof f.name !== 'string' ||
          typeof f.label !== 'string' ||
          !['text', 'number', 'select'].includes(f.type) ||
          (f.type === 'select' &&
            (!Array.isArray(f.options) ||
              f.options.some((v: unknown) => typeof v !== 'string') ||
              f.options.length > 50)),
      )
    )
      throw new Error();
  } catch {
    return <p>Invalid form. Inspect Source to correct it.</p>;
  }
  return (
    <form
      className="output-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSelect(JSON.stringify(values));
      }}
    >
      {fields.map((field, i) => (
        <label key={i}>
          {field.label}
          {field.type === 'select' ? (
            <select
              value={values[field.name] || ''}
              onChange={(e) => setValues({ ...values, [field.name]: e.target.value })}
            >
              <option value="">Choose…</option>
              {field.options.map((v: string) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          ) : (
            <input
              type={field.type}
              value={values[field.name] || ''}
              maxLength={2000}
              onChange={(e) => setValues({ ...values, [field.name]: e.target.value })}
            />
          )}
        </label>
      ))}
      <button type="submit">Use these answers in chat</button>
    </form>
  );
}
