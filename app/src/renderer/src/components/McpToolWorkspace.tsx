import React, { useEffect, useRef, useState } from 'react';
export default function McpToolWorkspace({
  threadId,
  grant,
  onClose,
}: {
  threadId: string | null | undefined;
  grant: string;
  onClose: () => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    token = useRef<string | null>(null),
    generation = useRef(0);
  const [error, setError] = useState(''),
    [running, setRunning] = useState(false);
  const bounds = () => {
    const r = host.current!.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  const stop = () => {
    generation.current++;
    const current = token.current;
    token.current = null;
    setRunning(false);
    if (threadId)
      void (
        current
          ? window.bimax.outputs?.stop(threadId, current)
          : window.bimax.outputs?.cancelPreview(threadId)
      )?.catch(() => {});
  };
  useEffect(() => {
    const halt = () => stop();
    window.addEventListener('bimax:stop-preview', halt);
    return () => window.removeEventListener('bimax:stop-preview', halt);
  }, [threadId]);
  const start = async () => {
    if (!threadId || !host.current) return;
    stop();
    const current = ++generation.current;
    setError('');
    try {
      const value = await window.bimax.outputs?.app(threadId, grant, bounds());
      if (current !== generation.current) {
        if (value) void window.bimax.outputs?.stop(threadId, value);
        return;
      }
      token.current = value || null;
      setRunning(!!value);
    } catch (error) {
      if (current === generation.current) setError(String(error));
    }
  };
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      if (token.current && threadId) void window.bimax.outputs?.resize(threadId, token.current, bounds());
    });
    if (host.current) observer.observe(host.current);
    return () => {
      observer.disconnect();
      generation.current++;
      if (threadId) void window.bimax.outputs?.cancelPreview(threadId).catch(() => {});
    };
  }, [threadId, grant]);
  return (
    <section className="outputs-workspace">
      <div className="output-toolbar">
        <button onClick={() => void start()}>{running ? 'Restart' : 'Open tool interface'}</button>
        <button disabled={!running} onClick={stop}>
          Stop
        </button>
        <button
          onClick={() => {
            stop();
            onClose();
          }}
        >
          Saved outputs
        </button>
        <span>Offline · isolated tool interface</span>
      </div>
      {error && (
        <p role="alert" className="output-error">
          {error}
        </p>
      )}
      <div ref={host} className="output-preview">
        <p>
          Tools retain their normal approvals. External links, downloads and automatic chat messages are
          disabled.
        </p>
      </div>
    </section>
  );
}
