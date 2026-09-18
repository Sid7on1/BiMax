import '../engine/commands/output';
import { globalCommandRegistry } from '../engine/commands/registry';
import { recordToolCall, getRecentToolCalls, clearToolHistory } from '../engine/toolHistory';
import type { ToolCallEntry } from '../engine/events';

function getCmd(name: string): any {
  return (globalCommandRegistry as any).commands.get(name);
}

function call(id: string, toolName: string, input: string, output: string, status: any = 'success'): ToolCallEntry {
  return { id, toolName, input, output, status, startTime: new Date() } as ToolCallEntry;
}

describe('toolHistory ring buffer', () => {
  beforeEach(() => clearToolHistory());

  it('records calls and returns them most-recent-first', () => {
    recordToolCall(call('a', 'BashTool', '{"command":"ls"}', 'one'));
    recordToolCall(call('b', 'ReadFileTool', '{"path":"x.ts"}', 'two'));
    expect(getRecentToolCalls().map(c => c.id)).toEqual(['b', 'a']);
  });

  it('updates an existing call in place by id (no duplicate)', () => {
    recordToolCall(call('a', 'BashTool', '{}', 'running', 'running'));
    recordToolCall(call('a', 'BashTool', '{}', 'done', 'success'));
    const recent = getRecentToolCalls();
    expect(recent).toHaveLength(1);
    expect(recent[0].output).toBe('done');
  });

  it('caps the buffer (oldest evicted)', () => {
    for (let i = 0; i < 60; i++) recordToolCall(call(`c${i}`, 'BashTool', '{}', `${i}`));
    const recent = getRecentToolCalls();
    expect(recent.length).toBe(50);
    expect(recent[0].id).toBe('c59');        // newest kept
    expect(recent.some(c => c.id === 'c0')).toBe(false); // oldest evicted
  });
});

describe('/output — full-output viewer', () => {
  beforeEach(() => clearToolHistory());

  it('registers with /tools + /out aliases', () => {
    expect(getCmd('/output')).toBeDefined();
    expect(getCmd('/tools')).toBe(getCmd('/output'));
    expect(getCmd('/out')).toBe(getCmd('/output'));
  });

  it('reports when nothing has been captured', async () => {
    const res = await getCmd('/output').execute([], { addSystemMessage: jest.fn() } as any);
    expect(res.type).toBe('message');
    expect(res.content).toMatch(/no tool output/i);
  });

  it('lists recent calls and shows full bash output (stdout/stderr unwrapped) on select', async () => {
    recordToolCall(call('a', 'BashTool', '{"command":"npm test"}', JSON.stringify({ stdout: 'PASS\nall good', stderr: '' })));
    const addSystemMessage = jest.fn();
    const res = await getCmd('/output').execute([], { addSystemMessage } as any);
    expect(res.type).toBe('menu');
    expect(res.options[0].label).toBe('Bash(npm test)');
    res.onSelect({ value: 'a' });
    expect(addSystemMessage).toHaveBeenCalled();
    const shown = addSystemMessage.mock.calls[0][1] as string;
    expect(shown).toContain('PASS');
    expect(shown).toContain('all good');
    expect(shown).not.toContain('stdout'); // JSON wrapper unwrapped, not shown raw
  });
});
