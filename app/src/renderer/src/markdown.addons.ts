/** Optional rich blocks; ordinary text/code never loads these runtimes. */
export const loadFormula = async () => import('katex');
export const loadDiagram = async () =>
  (await import('@streamdown/mermaid'))
    .createMermaidPlugin({
      config: {
        securityLevel: 'strict',
        startOnLoad: false,
        maxTextSize: 50_000,
        maxEdges: 500,
        flowchart: { htmlLabels: false },
      },
    })
    .getMermaid();
