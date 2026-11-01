/** Each host loads the same plugins; phone builds package these as offline lazy assets. */
export const mermaidOptions = {
  config: { securityLevel: 'strict' as const, startOnLoad: false, maxTextSize: 50_000, maxEdges: 500, flowchart: { htmlLabels: false } },
};
export const loadMath = async () => (await import('@streamdown/math')).createMathPlugin({ singleDollarTextMath: true });
export const loadCode = async () => (await import('@streamdown/code')).code;
export const loadMermaid = async () => (await import('@streamdown/mermaid')).createMermaidPlugin(mermaidOptions);
