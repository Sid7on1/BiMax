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

describe('optional prompt blocks (flaw list E40)', () => {
  afterEach(() => jest.restoreAllMocks());

  test('a block that throws is left out, the prompt still builds, and the failure is logged once', () => {
    const { Logger } = require('../utils/logger');
    const warn = jest.spyOn(Logger, 'warn').mockImplementation(() => {});
    jest.spyOn(require('../mind/harness.tuner'), 'getHarnessTuner').mockImplementation(() => { throw new Error('tuner store unreadable'); });
    const p = persona();
    const first = p.getSystemPromptParts({ memory: 'm' });
    p.getSystemPromptParts({ memory: 'm' });
    expect(first.turnContext).toContain('m');
    const lines = warn.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('harnessPatches'));
    expect(lines).toEqual(['Prompt block "harnessPatches" left out: tuner store unreadable']);
  });

  test('each of the thirteen optional blocks reaches the prompt — the journal included, dropped since PR4', () => {
    const block = (name: string) => ({ getPromptBlock: () => `<<${name}>>`, getSystemPromptBlock: () => `<<${name}>>`, contextBlock: () => `<<${name}>>`, promptBlock: () => `<<${name}>>` });
    jest.spyOn(require('../mind/policy.arms'), 'getPolicyArms').mockReturnValue({ decide: () => ({ show: true }) });
    jest.spyOn(require('../memory/goal.manager'), 'getGoalManager').mockReturnValue(block('goals'));
    jest.spyOn(require('../core/workspace.manager'), 'tryGetWorkspace').mockReturnValue(block('workspace'));
    jest.spyOn(require('../tools/implementations/todo.tool'), 'getTodoPromptBlock').mockReturnValue('<<todos>>');
    jest.spyOn(require('../outcome/outcome.manager'), 'getOutcomeManager').mockReturnValue(block('outcome'));
    jest.spyOn(require('../outcome/completion.check'), 'getCompletionChecks').mockReturnValue(block('completionCheck'));
    jest.spyOn(require('../engine/agentMode'), 'agentModePromptSection').mockReturnValue('<<agentMode>>');
    jest.spyOn(require('../mind/self.model'), 'getSelfModel').mockReturnValue(block('selfKnowledge'));
    jest.spyOn(require('../mind/habit.compiler'), 'getHabitMiner').mockReturnValue(block('habits'));
    jest.spyOn(require('../mind/user.model'), 'getUserModel').mockReturnValue(block('userModel'));
    jest.spyOn(require('../mind/daily.journal'), 'journalPreloadBlock').mockReturnValue('<<journal>>');
    jest.spyOn(require('../mind/drives.engine'), 'getDrivesEngine').mockReturnValue(block('drives'));
    jest.spyOn(require('../mind/epistemic.ledger'), 'getEpistemicLedger').mockReturnValue(block('calibration'));
    jest.spyOn(require('../mind/harness.tuner'), 'getHarnessTuner').mockReturnValue(block('harnessPatches'));
    const parts = persona().getSystemPromptParts({});
    const prompt = [parts.staticPrefix, parts.dynamicSuffix, parts.turnContext].join('\n');
    const names = ['goals', 'workspace', 'todos', 'outcome', 'completionCheck', 'agentMode', 'selfKnowledge', 'habits',
      'userModel', 'journal', 'drives', 'calibration', 'harnessPatches'];
    expect(names.filter((name) => !prompt.includes(`<<${name}>>`))).toEqual([]);
    expect(parts.turnContext).toContain('<<journal>>');
  });

  test('every section the persona builds is placed in one of the three segments', () => {
    const fs = require('fs') as typeof import('fs');
    const source = fs.readFileSync(require.resolve('../engine/personas/base.persona'), 'utf8');
    const built = new Set<string>([
      ...[...source.matchAll(/sections\.(\w+)\s*\+?=/g)].map((m) => m[1]!),
      ...[...source.matchAll(/^\s*\['(\w+)', \(\) =>/gm)].map((m) => m[1]!),
      ...[...source.matchAll(/^ {6}(\w+): `###/gm)].map((m) => m[1]!),
    ]);
    expect(built.size).toBeGreaterThan(25);
    const sections = Object.fromEntries([...built].map((key) => [key, `<<${key}>>`]));
    const parts = (persona() as any).splitPrompt(sections);
    const joined = [parts.staticPrefix, parts.dynamicSuffix, parts.turnContext].join('\n');
    expect([...built].filter((key) => !joined.includes(`<<${key}>>`))).toEqual([]);
  });
});
