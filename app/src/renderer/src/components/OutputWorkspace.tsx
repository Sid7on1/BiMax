import React, { useEffect, useRef, useState } from 'react';
import type { OutputDocument, OutputRecord, OutputFormat, PreviewEvent } from '../../../shared/outputs';
import { Markdown } from '../markdown';
import { insertIntoComposer } from './FilesPanel';
import { OutputSource, OutputDocumentEditor, OutputChart, OutputTable, OutputForm } from './OutputViews';

type Mode = 'preview' | 'source' | 'compare' | 'console';
export default function OutputWorkspace({
  threadId,
  requested,
}: {
  threadId?: string | null;
  requested?: { id: string; version?: string; nonce: number } | null;
}) {
  const api = window.bimax.outputs;
  const [records, setRecords] = useState<OutputRecord[]>([]),
    [document, setDocument] = useState<OutputDocument | null>(null),
    [source, setSource] = useState(''),
    [mode, setMode] = useState<Mode>('preview'),
    [error, setError] = useState(''),
    [search, setSearch] = useState(''),
    [previous, setPrevious] = useState<OutputDocument | null>(null),
    [pending, setPending] = useState<{ id: string; version?: string } | null>(null);
  const pendingPreview = useRef(false);
  const [token, setToken] = useState<string | null>(null),
    [events, setEvents] = useState<PreviewEvent[]>([]);
  const previewHost = useRef<HTMLDivElement>(null),
    epoch = useRef(0),
    tokenRef = useRef<string | null>(null),
    ownerRef = useRef(threadId);
  ownerRef.current = threadId;
  const draftKey =
    document && threadId
      ? `bimax:output-draft:${threadId}:${document.record.id}:${document.version.id}`
      : null;
  useEffect(() => {
    if (!draftKey || !document) return;
    try {
      if (source !== document.content) localStorage.setItem(draftKey, source);
      else localStorage.removeItem(draftKey);
    } catch {
      setError('The draft could not be retained locally. Save or export it before closing.');
    }
  }, [draftKey, source]);
  const dirty = !!document && source !== document.content;
  const stop = () => {
    pendingPreview.current = false;
    epoch.current++;
    const current = tokenRef.current;
    tokenRef.current = null;
    setToken(null);
    if (threadId)
      void (current ? api?.stop(threadId, current) : api?.cancelPreview(threadId))?.catch(() => {});
  };
  useEffect(() => {
    const halt = () => stop();
    window.addEventListener('bimax:stop-preview', halt);
    return () => window.removeEventListener('bimax:stop-preview', halt);
  }, [threadId]);
  const load = async (id: string, version?: string, discard = false) => {
    if (dirty && !discard) {
      setPending({ id, version });
      return;
    }
    if (discard && draftKey) {
      try {
        localStorage.removeItem(draftKey);
      } catch {}
    }
    stop();
    const generation = ++epoch.current;
    setError('');
    setPending(null);
    try {
      const value = await api?.read(id, version);
      if (epoch.current !== generation) return;
      if (!value) throw new Error('Output unavailable.');
      setDocument(value);
      let retained: string | null = null;
      try {
        retained = localStorage.getItem(
          `bimax:output-draft:${threadId}:${value.record.id}:${value.version.id}`,
        );
      } catch {}
      setSource(retained !== null && retained.length <= 192 * 1024 ? retained : value.content);
      setPrevious(null);
      setMode('preview');
    } catch (error) {
      if (epoch.current === generation) setError(String(error));
    }
  };
  useEffect(() => {
    if (!api) return;
    let live = true;
    const refresh = () => {
      void api
        .list()
        .then((value) => {
          if (live) setRecords(value);
        })
        .catch((error) => {
          if (live) setError(String(error));
        });
    };
    refresh();
    const off = api.onChanged(refresh),
      log = api.onPreview((event) => {
        if (
          event.ownerThreadId === ownerRef.current &&
          (event.token === tokenRef.current || pendingPreview.current)
        )
          setEvents((list) => [...list, event].slice(-200));
      });
    return () => {
      live = false;
      off();
      log();
      epoch.current++;
      if (ownerRef.current) void api.cancelPreview(ownerRef.current).catch(() => {});
    };
  }, []);
  useEffect(() => {
    stop();
    setDocument(null);
    setSource('');
    setPending(null);
  }, [threadId]);
  useEffect(() => {
    if (requested) void load(requested.id, requested.version);
  }, [requested?.nonce]);
  const bounds = () => {
    const r = previewHost.current!.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  useEffect(() => {
    if (!token || !threadId || !previewHost.current) return;
    const resize = () => {
      void api?.resize(threadId, token, bounds()).catch(() => {});
    };
    const observer = new ResizeObserver(resize);
    observer.observe(previewHost.current);
    window.addEventListener('resize', resize);
    resize();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', resize);
    };
  }, [token, threadId]);
  const start = async () => {
    if (!api || !threadId || !document || dirty || !previewHost.current) return;
    stop();
    const generation = ++epoch.current,
      owner = threadId;
    pendingPreview.current = true;
    setEvents([]);
    setError('');
    try {
      const current = await api.preview(owner, document.record.id, document.version.id, bounds());
      if (generation !== epoch.current || owner !== ownerRef.current) {
        if (current) await api.stop(owner, current);
        return;
      }
      tokenRef.current = current;
      pendingPreview.current = false;
      setEvents((list) => list.filter((e) => e.token === current));
      setToken(current);
    } catch (error) {
      if (generation === epoch.current) {
        pendingPreview.current = false;
        setError(String(error));
      }
    }
  };
  const save = async (asCopy = false) => {
    if (!api || !threadId || !document) return;
    const owner = threadId;
    stop();
    const savingEpoch = epoch.current;
    try {
      const value = await api.save(owner, {
        key: asCopy ? crypto.randomUUID() : 'edit',
        title: asCopy ? `${document.record.title.slice(0, 110)} copy` : document.record.title,
        format: document.record.format,
        content: source,
        ...(asCopy ? {} : { outputId: document.record.id, baseVersion: document.version.id }),
        language: document.record.language,
      });
      if (savingEpoch !== epoch.current || owner !== ownerRef.current) return;
      if (!value) throw new Error('Output was not saved.');
      if (draftKey) localStorage.removeItem(draftKey);
      setDocument(value);
      setSource(value.content);
    } catch (error) {
      setError(String(error));
    }
  };
  const create = async () => {
    if (!api || !threadId) return;
    const owner = threadId;
    try {
      const value = await api.save(owner, {
        key: crypto.randomUUID(),
        title: 'Untitled document',
        format: 'markdown',
        content: '# Untitled\n\nStart writing here.\n',
      });
      if (value && owner === ownerRef.current) {
        setDocument(value);
        setSource(value.content);
        setMode('source');
      }
    } catch (error) {
      setError(String(error));
    }
  };
  const followup = (selection: string) => {
    if (ownerRef.current !== threadId) return;
    insertIntoComposer(
      `About saved output “${document?.record.title}” (output ${document?.record.id}, exact version ${document?.version.id}):\n\nSelected content (quoted data):\n${selection.slice(0, 12000)}\n\n`,
    );
  };
  const compare = async () => {
    stop();
    setMode('compare');
    const index = document?.record.versions.findIndex((v) => v.id === document.version.id) ?? -1;
    if (index > 0 && document) {
      const generation = epoch.current;
      const value = await api?.read(document.record.id, document.record.versions[index - 1].id);
      if (epoch.current === generation) setPrevious(value || null);
    }
  };
  let tableValue: unknown;
  try {
    tableValue = JSON.parse(source);
  } catch {
    tableValue = null;
  }
  const format: OutputFormat | undefined = document?.record.format;
  return (
    <section className="outputs-workspace" aria-label="Saved outputs">
      <div className="output-toolbar">
        <input
          aria-label="Find outputs"
          placeholder="Find saved outputs…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button disabled={!threadId || dirty} onClick={() => void create()}>
          New
        </button>
      </div>
      <div className="output-catalog">
        {records
          .filter((r) => r.title.toLowerCase().includes(search.toLowerCase()))
          .map((r) => (
            <button key={r.id} aria-pressed={document?.record.id === r.id} onClick={() => void load(r.id)}>
              <span>{r.title}</span>
              <small>
                {r.format} · {r.versions.length} version{r.versions.length === 1 ? '' : 's'}
                {r.ownerThreadId !== threadId ? ' · another conversation' : ''}
              </small>
            </button>
          ))}
      </div>
      {pending && (
        <div role="alert" className="output-toolbar">
          Unsaved draft.{' '}
          <button onClick={() => void load(pending.id, pending.version, true)}>Discard and open</button>
          <button onClick={() => setPending(null)}>Keep editing</button>
        </div>
      )}
      {error && (
        <p role="alert" className="output-error">
          {error}
        </p>
      )}
      {!document ? (
        <div className="output-empty">
          <h3>Useful work, kept beside chat</h3>
          <p>
            Ask Bimax for a document, chart, diagram or small app. Saved outputs stay here after the producing
            engine stops.
          </p>
          <p>Or keep a code block from chat using its “Keep output” control.</p>
        </div>
      ) : (
        <>
          <div className="output-heading">
            <strong>{document.record.title}</strong>
            <span>
              {dirty
                ? 'Draft'
                : document.state === 'available'
                  ? 'Available'
                  : document.state === 'missing'
                    ? 'Missing'
                    : 'Changed'}{' '}
              · correctness unchecked
            </span>
            <select
              aria-label="Saved version"
              value={document.version.id}
              onChange={(e) => void load(document.record.id, e.target.value)}
            >
              {document.record.versions.map((v, i) => (
                <option key={v.id} value={v.id}>
                  Version {i + 1} · {new Date(v.createdAt).toLocaleString()}
                </option>
              ))}
            </select>
          </div>
          <div className="output-toolbar">
            {(['preview', 'source', 'compare', 'console'] as Mode[]).map((m) => (
              <button
                key={m}
                aria-pressed={mode === m}
                onClick={() => {
                  if (m === 'compare') void compare();
                  else {
                    stop();
                    setMode(m);
                  }
                }}
              >
                {m[0].toUpperCase() + m.slice(1)}
              </button>
            ))}
            <button
              disabled={!dirty || document.record.ownerThreadId !== threadId}
              onClick={() => void save()}
            >
              Save version
            </button>
            {document.record.ownerThreadId !== threadId && (
              <button disabled={!threadId} onClick={() => void save(true)}>
                Save a copy here
              </button>
            )}
            <button
              disabled={document.state !== 'available'}
              onClick={() =>
                void api?.export(document.record.id, document.version.id).catch((e) => setError(String(e)))
              }
            >
              Export
            </button>
          </div>
          {document.state !== 'available' ? (
            <p role="alert">
              Retained bytes are {document.state}. No replacement was substituted. Inspect another saved
              version.
            </p>
          ) : mode === 'source' ? (
            <OutputSource
              key={`${document.record.id}:${document.version.id}`}
              content={source}
              format={format!}
              onChange={setSource}
            />
          ) : mode === 'compare' ? (
            <div className="output-compare">
              {previous ? (
                <>
                  <div>
                    <h4>Previous saved version</h4>
                    <pre>{previous.state === 'available' ? previous.content : previous.state}</pre>
                  </div>
                  <div>
                    <h4>{dirty ? 'Current draft' : 'Selected saved version'}</h4>
                    <pre>{source}</pre>
                  </div>
                </>
              ) : (
                <p>No earlier saved version.</p>
              )}
            </div>
          ) : mode === 'console' ? (
            <>
              <div className="output-toolbar">
                <button
                  disabled={!events.some((e) => e.level === 'error')}
                  onClick={() =>
                    followup(
                      events
                        .filter((e) => e.level === 'error')
                        .map((e) => e.text)
                        .join('\n'),
                    )
                  }
                >
                  Use errors in next request
                </button>
              </div>
              <pre className="output-console">
                {events.length
                  ? events.map((e, i) => (
                      <div key={i} data-level={e.level}>
                        {e.text}
                      </div>
                    ))
                  : 'No preview events. Run the saved app from Preview.'}
              </pre>
            </>
          ) : (
            <>
              <div className="output-toolbar">
                <button
                  onClick={() => {
                    const selection = window.getSelection()?.toString();
                    if (selection) followup(selection);
                  }}
                >
                  Ask about selection
                </button>
                {['html', 'react'].includes(format!) && (
                  <>
                    <button disabled={!threadId || dirty} onClick={() => void start()}>
                      {token ? 'Restart' : 'Run saved preview'}
                    </button>
                    <button disabled={!token} onClick={stop}>
                      Stop
                    </button>
                    <span>Offline · browser only</span>
                  </>
                )}
              </div>
              <div className="output-preview" ref={previewHost}>
                {format === 'document' ? (
                  <OutputDocumentEditor
                    key={`${document.record.id}:${document.version.id}`}
                    content={source}
                    onChange={setSource}
                  />
                ) : format === 'vega-lite' ? (
                  <OutputChart key={document.version.id} content={source} onSelect={followup} />
                ) : format === 'table' ? (
                  <OutputTable key={document.version.id} value={tableValue} onSelect={followup} />
                ) : format === 'form' ? (
                  <OutputForm key={document.version.id} content={source} onSelect={followup} />
                ) : format === 'mermaid' ? (
                  <Markdown text={'```mermaid\n' + source + '\n```'} />
                ) : ['html', 'react'].includes(format!) ? (
                  <p>
                    {token
                      ? 'Running isolated preview.'
                      : 'Run this saved version to preview it. Use Source to inspect or edit it first.'}
                  </p>
                ) : format === 'code' ? (
                  <Markdown text={'```' + (document.record.language || '') + '\n' + source + '\n```'} />
                ) : (
                  <Markdown text={source} />
                )}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
