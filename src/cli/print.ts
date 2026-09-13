import { capabilitySnapshot, capabilityMessage } from '../core/capability.status';
import { ToolRegistry } from '../tools/tool.registry';
import { LlmAdapter } from '../core/llm.adapter';
import { Governor } from '../governor/governor';
import { TaskPipeline } from '../task';
import { CodebaseIndexer } from '../graph/indexer';
import { GraphStore } from '../graph/graph.store';
import { cliEvents, ToolCallEntry } from './events';

export async function executePrintMode(prompt: string, options: {
  agent: string;
  model?: string;
  theme: string;
  verbose: boolean;
  outputFormat: string;
  printWithTools?: boolean;
  toolRegistry: ToolRegistry;
  llmAdapter: LlmAdapter;
  governor: Governor;
  taskPipeline: TaskPipeline;
  codebaseIndexer: CodebaseIndexer;
  graphStore: GraphStore;
}) {
  const { agent, toolRegistry, llmAdapter } = options;

  const { BiMaxPersona, HermesPersona, OpenCodePersona, OpenClawPersona } = await import('./personas/implementations');

  const personaMap: Record<string, any> = {
    hermes: HermesPersona,
    opencode: OpenCodePersona,
    openclaw: OpenClawPersona,
  };
  const PersonaClass = personaMap[agent] || BiMaxPersona;
  const persona = new PersonaClass(toolRegistry, llmAdapter);

  // Surface tool activity on stderr so stdout stays clean for piping
  const onToolStart = (tc: ToolCallEntry) => {
    if (options.printWithTools || options.verbose) {
      process.stderr.write(`⏺ ${tc.toolName} ${tc.input.slice(0, 120)}\n`);
    }
  };
  const onToolResult = (tc: ToolCallEntry) => {
    if (options.printWithTools || options.verbose) {
      const firstLine = (tc.output || '').split('\n')[0].slice(0, 120);
      process.stderr.write(`  ⎿ ${tc.status === 'error' ? '✗' : '✓'} ${firstLine}\n`);
    }
  };
  const onCapability = (message: any) => {
    if (message?.payload?.capabilityStatus) process.stderr.write(`${message.content}\n`);
  };
  cliEvents.on('message', onCapability);
  for (const status of capabilitySnapshot().filter(s => s.state !== 'ready')) onCapability(capabilityMessage(status));
  cliEvents.on('tool_call', onToolStart);
  cliEvents.on('tool_call_result', onToolResult);

  const originalLog = console.log;
  console.log = (...args) => {
    process.stderr.write(args.join(' ') + '\n');
  };
  try {
    await persona.execute(prompt, (token: string) => {
      process.stdout.write(token);
    });
    process.stdout.write('\n');
  } finally {
    console.log = originalLog;
    cliEvents.off('message', onCapability);
    cliEvents.off('tool_call', onToolStart);
    cliEvents.off('tool_call_result', onToolResult);
  }
}
