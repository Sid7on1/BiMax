import { IGovernor } from '../core/interfaces';
import { ToolRegistry } from '../tools/tool.registry';
import { LlmAdapter } from '../core/llm.adapter';
import { BiMaxPersona } from '../engine/personas/implementations';
import { AgentPersona } from '../engine/personas/base.persona';
import { createBashTool } from '../tools/implementations/bash.tool';
import { createReadFileTool } from '../tools/implementations/file.tool';
import { createWebFetchTool } from '../tools/implementations/webfetch.tool';
import { BuiltTool } from '../tools/tool.factory';

const deferredTool: BuiltTool = {
  name: 'MemoryQueryTool', description: 'Searches long-term memory.',
  schema: { type: 'object', properties: {} }, isDestructive: false, isConcurrencySafe: true,
  execute: async () => 'ok',
};
const governor = { approveTaskExecution: jest.fn().mockResolvedValue(undefined) } as unknown as IGovernor;

function persona(): BiMaxPersona {
  const registry = new ToolRegistry();
  [createBashTool(governor), createReadFileTool(governor), createWebFetchTool(governor), deferredTool]
    .forEach(tool => registry.register(tool));
  return new BiMaxPersona(registry, {} as LlmAdapter);
}

describe('Persona system prompt cache split', () => {
  test('keeps the static prefix stable while volatile memory remains in turn context', () => {
    const p = persona();
    const a = p.getSystemPromptParts({ memory: 'fact A', planMode: false });
    const b = p.getSystemPromptParts({ memory: 'fact B', planMode: true });
    expect(a.staticPrefix).toBe(b.staticPrefix);
    expect(a.staticPrefix).not.toContain('fact A');
    expect(a.turnContext).toContain('fact A');
    expect(b.dynamicSuffix).toContain('PLAN MODE');
  });

  test('keeps deferred tools discoverable without sending them in the core working set', () => {
    expect(persona().getSystemPromptParts({ contextMode: 'smart' }).dynamicSuffix)
      .toContain('MemoryQueryTool');
  });

  test('joins the three prompt segments exactly', () => {
    const p = persona();
    const parts = p.getSystemPromptParts({ memory: 'm' });
    expect(p.getSystemPrompt({ memory: 'm' }))
      .toBe([parts.staticPrefix, parts.dynamicSuffix, parts.turnContext].filter(Boolean).join('\n\n'));
  });
});

describe('injectTurnContext', () => {
  test('replaces the old block immediately before the latest user message', () => {
    const messages: any[] = [
      { role: 'system', content: '[TurnContext]\nstale' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'second' },
    ];
    AgentPersona.injectTurnContext(messages, 'fresh');
    const blocks = messages.filter(message => String(message.content).startsWith('[TurnContext]'));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toContain('fresh');
    expect(messages[messages.length - 1].content).toBe('second');
  });

  test('removes stale context when the new turn has no context', () => {
    const messages: any[] = [
      { role: 'system', content: '[TurnContext]\nstale' },
      { role: 'user', content: 'task' },
    ];
    AgentPersona.injectTurnContext(messages, '');
    expect(messages).toEqual([{ role: 'user', content: 'task' }]);
  });
});
