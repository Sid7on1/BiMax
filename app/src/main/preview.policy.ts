/** Generated code has no authority: both CSP and the isolated session deny network access. */
export const PREVIEW_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'";
export const PREVIEW_IMPORTS = new Set(['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime']);
export function previewBounds(raw: unknown, width: number, height: number) {
  const r = raw as Record<string, number>;
  if (!r || ['x', 'y', 'width', 'height'].some((k) => !Number.isFinite(r[k])))
    throw new Error('Invalid preview bounds.');
  const x = Math.max(0, Math.min(width, Math.round(r.x))),
    y = Math.max(0, Math.min(height, Math.round(r.y)));
  return {
    x,
    y,
    width: Math.max(0, Math.min(width - x, Math.round(r.width))),
    height: Math.max(0, Math.min(height - y, Math.round(r.height))),
  };
}
export function previewHtml(body: string): string {
  // The first policy is host-owned; user markup cannot relax it with another meta element.
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:14px system-ui;margin:20px;color:#202020;background:#fafafa}*{box-sizing:border-box}</style></head><body>${body}</body></html>`;
}
