import { globalCommandRegistry } from './registry';
import { getRecentToolCalls } from '../toolHistory';
import type { ToolCallEntry } from '../events';

const TOOL_LABELS: Record<string, string> = {
  BashTool: 'Bash', ReadFileTool: 'Read', WriteFileTool: 'Write', EditFileTool: 'Edit',
  MultiEditTool: 'MultiEdit', GrepTool: 'Grep', GlobTool: 'Glob', WebFetchTool: 'Fetch',
  WebSearchTool: 'Search', GraphQueryTool: 'Graph',
};

/** Short, human label for a tool call: "Bash(npm test)". */
function summarize(call: ToolCallEntry): string {
  const label = TOOL_LABELS[call.toolName] || call.toolName.replace(/Tool$/, '');
  let arg = '';
  try {
    const p = JSON.parse(call.input);
    const c = p.command || p.filePath || p.path || p.pattern || p.glob || p.url || p.query || p.name;
    if (typeof c === 'string') arg = c;
  } catch { arg = (call.input || '').replace(/\n/g, ' '); }
  arg = arg.length > 44 ? arg.slice(0, 41) + '…' : arg;
  return arg ? `${label}(${arg})` : label;
}

/** BashTool stores {stdout,stderr} as JSON — show the real text, not the wrapper. */
function fullOutput(call: ToolCallEntry): string {
  const raw = call.output || '';
  if (call.toolName === 'BashTool') {
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === 'object' && ('stdout' in o || 'stderr' in o)) {
        return [o.stdout && String(o.stdout), o.stderr && `[stderr]\n${o.stderr}`].filter(Boolean).join('\n').trim() || '(no output)';
      }
    } catch { /* not JSON — fall through */ }
  }
  return raw.trim() || '(no output)';
}

// /output — the full-output viewer. The transcript truncates long tool output (and can't expand in
// place because committed rows live in Ink's write-once <Static>); this lets you pull up the
// COMPLETE output of any recent tool call from the toolHistory ring buffer. Delivers the value of
// collapse/expand without the <Static> rewrite. Registry-derived → also in the Ctrl+G palette.
globalCommandRegistry.register({
  name: '/output',
  aliases: ['/tools', '/out'],
  category: 'Code & Intelligence',
  description: 'View the full, untruncated output of a recent tool call',
  execute: async (_args, context) => {
    const calls = getRecentToolCalls();
    if (calls.length === 0) {
      return { type: 'message', level: 'info', content: 'No tool output captured yet this session.' };
    }
    return {
      type: 'menu',
      title: 'Tool Output — pick a call to view its full output',
      options: calls.map(c => {
        const lines = (c.output || '').split('\n').length;
        return {
          label: summarize(c),
          value: c.id,
          desc: `${lines} line${lines === 1 ? '' : 's'} · ${c.status}${c.agentLabel ? ` · ${c.agentLabel}` : ''}`,
          category: 'Recent tool calls',
        };
      }),
      onSelect: (opt: any) => {
        const call = calls.find(c => c.id === opt.value);
        if (call) context.addSystemMessage(call.status === 'error' ? 'error' : 'info', `${summarize(call)}\n\n${fullOutput(call)}`);
      },
    };
  },
});
